import { config } from "dotenv";
import { fileURLToPath } from "node:url";
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import Fastify from "fastify";
import cors from "@fastify/cors";
import PgBoss from "pg-boss";
import { spawn } from "node:child_process";
import { db } from "@bugpilot/database";
import { evaluationMetrics } from "@bugpilot/evaluation";
import { createTaskSchema } from "@bugpilot/shared";
import { approvalHash, parseGitHubRepository } from "@bugpilot/policy";
import { McpTools } from "@bugpilot/agent";
import { resumeCheckpoint } from "./resume.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" });
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const boss = new PgBoss({ connectionString });
await boss.start();
await boss.createQueue("run-task");
await boss.createQueue("publish-task");
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

async function dockerAvailable() {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(
      process.env.BUGPILOT_DOCKER_BIN ?? "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { windowsHide: true, shell: false },
    );
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

app.get("/health", async () => {
  let database = true;
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    database = false;
  }
  return {
    ok: database,
    database,
    docker: await dockerAvailable(),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    github: Boolean(
      process.env.GITHUB_TOKEN ||
      (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY && process.env.GITHUB_INSTALLATION_ID),
    ),
  };
});
app.get("/tasks", async () =>
  json(await db.task.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { testRuns: true } })),
);
app.get("/metrics", async () => evaluationMetrics());
app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
  const task = await db.task.findUnique({
    where: { id: req.params.id },
    include: {
      events: { orderBy: { id: "asc" } },
      testRuns: true,
      approvals: true,
      messages: { orderBy: { createdAt: "asc" } },
      agentRuns: { orderBy: { startedAt: "asc" } },
    },
  });
  if (!task) return reply.code(404).send({ error: "Task not found" });
  return json(task);
});
app.post("/tasks", async (req, reply) => {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const input = parsed.data;
  const repo = parseGitHubRepository(input.repositoryUrl);
  const task = await db.task.create({
    data: { ...input, repositoryOwner: repo.owner, repositoryName: repo.name },
  });
  await db.taskEvent.create({
    data: { taskId: task.id, type: "TASK_CREATED", title: "Task queued for BugPilot" },
  });
  await boss.send("run-task", { taskId: task.id }, { singletonKey: task.id, retryLimit: 0 });
  return reply.code(201).send(json(task));
});
app.post<{ Params: { id: string } }>("/tasks/:id/resume", async (req, reply) => {
  const task = await db.task.findUnique({
    where: { id: req.params.id },
    include: { testRuns: true, approvals: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!task) return reply.code(404).send({ error: "Task not found" });
  if (!["FAILED", "NEEDS_ATTENTION"].includes(task.state))
    return reply.code(409).send({ error: "Only stopped tasks can be resumed" });
  const approval = task.approvals[0];
  if (approval?.decision === "APPROVED" && approval.hash === task.approvalHash && task.approvedAt) {
    if (!task.workspacePath || !task.baseCommit || !task.diff || !task.approvalHash)
      return reply.code(409).send({ error: "The approved review package is incomplete" });
    const mcp = new McpTools(task.id, task.workspacePath);
    await mcp.connect(["git"]);
    let currentDiff = "";
    try {
      const raw = await mcp.callTrusted("git", "get_diff");
      currentDiff = (JSON.parse(raw) as { stdout: string }).stdout;
    } finally {
      await mcp.close();
    }
    const expected = approvalHash({
      taskId: task.id,
      repository: task.repositoryUrl,
      targetBranch: task.baseBranch,
      baseCommit: task.baseCommit,
      diff: currentDiff,
      tests: task.testRuns.map((t) => ({
        command: t.command,
        exitCode: t.exitCode,
        stdout: t.stdout,
        stderr: t.stderr,
        durationMs: t.durationMs,
      })),
    });
    if (expected !== approval.hash)
      return reply
        .code(409)
        .send({ error: "The approved diff or evidence changed; a fresh review is required" });
    await db.$transaction([
      db.task.update({
        where: { id: task.id },
        data: { state: "PUBLISHING", currentAgent: null, error: null },
      }),
      db.taskEvent.create({
        data: { taskId: task.id, type: "TASK_RESUMED", title: "Resumed from approved publishing checkpoint" },
      }),
    ]);
    await boss.send("publish-task", { taskId: task.id }, { singletonKey: task.id, retryLimit: 0 });
    return { ok: true, resumeFrom: "PUBLISHING" };
  }
  const next = resumeCheckpoint(task);
  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: {
        state: next,
        currentAgent: null,
        error: null,
        ...(next === "TESTING" || next === "CODING" ? { attempt: 0, revisionCycle: 0 } : {}),
      },
    }),
    db.taskEvent.create({
      data: {
        taskId: task.id,
        type: "TASK_RESUMED",
        title: `Resumed from ${next.toLowerCase().replaceAll("_", " ")} checkpoint`,
      },
    }),
  ]);
  if (next !== "AWAITING_HUMAN_APPROVAL")
    await boss.send("run-task", { taskId: task.id }, { singletonKey: task.id, retryLimit: 0 });
  return { ok: true, resumeFrom: next };
});
app.post<{ Params: { id: string }; Body: { decision?: string; note?: string } }>(
  "/tasks/:id/decision",
  async (req, reply) => {
    const task = await db.task.findUnique({ where: { id: req.params.id }, include: { testRuns: true } });
    if (!task) return reply.code(404).send({ error: "Task not found" });
    if (task.state !== "AWAITING_HUMAN_APPROVAL")
      return reply.code(409).send({ error: "Task is not awaiting human approval" });
    const decision = req.body?.decision;
    if (decision !== "approve" && decision !== "reject")
      return reply.code(400).send({ error: "Decision must be approve or reject" });
    if (decision === "reject") {
      await db.$transaction([
        db.approval.create({
          data: { taskId: task.id, hash: task.approvalHash ?? "", decision: "REJECTED", note: req.body.note },
        }),
        db.task.update({ where: { id: task.id }, data: { state: "REJECTED", rejectedAt: new Date() } }),
        db.taskEvent.create({
          data: {
            taskId: task.id,
            type: "REJECTED",
            title: "Patch rejected by reviewer",
            detail: req.body.note,
          },
        }),
      ]);
      return { ok: true };
    }
    if (!task.workspacePath || !task.baseCommit || !task.diff || !task.approvalHash)
      return reply.code(409).send({ error: "Review package is incomplete" });
    const mcp = new McpTools(task.id, task.workspacePath);
    await mcp.connect(["git"]);
    let currentDiff = "";
    try {
      const raw = await mcp.callTrusted("git", "get_diff");
      currentDiff = (JSON.parse(raw) as { stdout: string }).stdout;
    } finally {
      await mcp.close();
    }
    const expected = approvalHash({
      taskId: task.id,
      repository: task.repositoryUrl,
      targetBranch: task.baseBranch,
      baseCommit: task.baseCommit,
      diff: currentDiff,
      tests: task.testRuns.map((t) => ({
        command: t.command,
        exitCode: t.exitCode,
        stdout: t.stdout,
        stderr: t.stderr,
        durationMs: t.durationMs,
      })),
    });
    if (expected !== task.approvalHash)
      return reply
        .code(409)
        .send({ error: "The diff or evidence changed after review. Run the task again." });
    await db.$transaction([
      db.approval.create({
        data: { taskId: task.id, hash: expected, decision: "APPROVED", note: req.body.note },
      }),
      db.task.update({ where: { id: task.id }, data: { state: "PUBLISHING", approvedAt: new Date() } }),
      db.taskEvent.create({
        data: {
          taskId: task.id,
          type: "APPROVED",
          title: "Exact reviewed patch approved",
          detail: `Fingerprint ${expected.slice(0, 12)}`,
        },
      }),
    ]);
    await boss.send("publish-task", { taskId: task.id }, { singletonKey: task.id, retryLimit: 0 });
    return { ok: true };
  },
);
app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
  "/tasks/:id/events",
  async (req, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": process.env.WEB_ORIGIN ?? "http://localhost:3000",
    });
    let after = BigInt(req.query.after ?? 0);
    const send = async () => {
      const events = await db.taskEvent.findMany({
        where: { taskId: req.params.id, id: { gt: after } },
        orderBy: { id: "asc" },
      });
      for (const item of events) {
        after = item.id;
        reply.raw.write(`id: ${item.id}\ndata: ${JSON.stringify(json(item))}\n\n`);
      }
    };
    await send();
    const timer = setInterval(() => send().catch(() => {}), 1000);
    req.raw.on("close", () => clearInterval(timer));
  },
);
app.addHook("onClose", async () => {
  await boss.stop();
  await db.$disconnect();
});
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await app.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({ port: Number(process.env.API_PORT ?? 4000), host: process.env.API_HOST ?? "127.0.0.1" });
