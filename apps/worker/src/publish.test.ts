import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactApprovalHash, captureArtifact, sha256 } from "@bugwright/policy";
import { publishTask } from "./publish.js";

const database = vi.hoisted(() => ({
  task: { findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  taskEvent: { create: vi.fn() },
  publicationAttempt: { upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));
const leases = vi.hoisted(() => ({
  assert: vi.fn(),
  withLease: vi.fn(),
  updateTask: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@bugwright/database", () => ({
  db: database,
  Prisma: { DbNull: null },
  assertTaskLease: leases.assert,
  updateTaskWithLease: leases.updateTask,
  withTaskLease: leases.withLease,
  transactionWithTaskLease: leases.transaction,
}));

let root: string;
let valid: Awaited<ReturnType<typeof makeTask>>;
let requests: Array<{ url: string; method: string; body: Record<string, unknown> }>;
const source = "export const answer = 42;\n";
function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

async function makeTask() {
  root = await mkdtemp(path.join(tmpdir(), "bugwright-publish-test-"));
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  await writeFile(path.join(root, "source.js"), "export const answer = 0;\n");
  await writeFile(path.join(root, "delete.txt"), "remove me");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(path.join(root, "repro.test.js"), "assert.equal(answer, 42);\n");
  const baseline = await captureArtifact(root, base);
  const proof = {
    path: "repro.test.js",
    sha256: sha256(await readFile(path.join(root, "repro.test.js"))),
    baselineArtifactHash: baseline.hash,
    testRunId: "before",
  };
  await writeFile(path.join(root, "source.js"), source);
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 255, 1, 128]));
  await rm(path.join(root, "delete.txt"));
  const artifact = await captureArtifact(root, base, proof);
  const report = { passed: true, reproductionFixed: "passed", artifactHash: artifact.hash };
  const common = { command: "node --test", stdout: "", stderr: "", durationMs: 1 };
  const tests = [
    { ...common, id: "before", artifactHash: baseline.hash, kind: "reproduction-before", exitCode: 1 },
    { ...common, id: "after", artifactHash: artifact.hash, kind: "reproduction-after", exitCode: 0 },
  ];
  const hash = artifactApprovalHash({
    taskId: "task",
    repository: "https://github.com/example/repo",
    targetBranch: "main",
    artifact,
    report,
    tests,
  });
  return {
    id: "task",
    state: "PUBLISHING",
    approvedAt: new Date(),
    approvalHash: hash,
    approvals: [{ decision: "APPROVED", hash }],
    repositoryUrl: "https://github.com/example/repo",
    repositoryOwner: "example",
    repositoryName: "repo",
    issueNumber: 1,
    issueTitle: "Fix answer",
    summary: "verified fix",
    baseBranch: "main",
    baseCommit: base,
    workspacePath: root,
    diff: artifact.diff,
    reviewArtifact: artifact,
    testReport: report,
    reviewReport: { decision: "approve" },
    testRuns: tests,
  };
}

beforeAll(async () => {
  valid = await makeTask();
}, 30000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("GITHUB_TOKEN", "test-only-token");
  await writeFile(path.join(root, "source.js"), source);
  database.task.findUniqueOrThrow.mockResolvedValue(structuredClone(valid));
  database.task.update.mockResolvedValue({});
  database.task.updateMany.mockResolvedValue({ count: 1 });
  database.taskEvent.create.mockResolvedValue({});
  database.publicationAttempt.upsert.mockResolvedValue({
    id: "attempt",
    artifactHash: valid.reviewArtifact.hash,
    branch: "bugwright/issue-1-task",
    status: "STARTED",
    commitSha: null,
    pullRequestUrl: null,
  });
  database.publicationAttempt.update.mockResolvedValue({});
  database.publicationAttempt.updateMany.mockResolvedValue({ count: 1 });
  leases.assert.mockResolvedValue({ taskId: "task", owner: "test", generation: 1 });
  leases.updateTask.mockResolvedValue(undefined);
  leases.withLease.mockImplementation(async (_taskId, _owner, _states, work) => ({
    claimed: true,
    value: await work({ taskId: "task", owner: "test", generation: 1 }),
  }));
  leases.transaction.mockImplementation(async (_taskId, work) =>
    work(database, { taskId: "task", owner: "test", generation: 1 }),
  );
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url, method, body });
      let response: unknown = {};
      if (url.includes("/git/commits/") && method === "GET") response = { tree: { sha: "base-tree" } };
      else if (url.endsWith("/git/blobs")) {
        const bytes = Buffer.from(body.content, "base64");
        response = { sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") };
      } else if (url.endsWith("/git/trees")) response = { sha: valid.reviewArtifact.tree };
      else if (url.endsWith("/git/commits")) response = { sha: "commit" };
      else if (url.includes("/git/ref/heads/")) return new Response("not found", { status: 404 });
      else if (url.includes("/pulls?") && method === "GET") response = [];
      else if (url.endsWith("/pulls")) response = { html_url: "https://github.com/example/repo/pull/1" };
      return new Response(JSON.stringify(response), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("publisher artifact boundary", () => {
  it("publishes captured additions, binary files, deletions and reproduction evidence", async () => {
    await publishTask("task");
    const blobs = requests.filter((r) => r.url.endsWith("/git/blobs"));
    expect(blobs.map((r) => r.body.content)).toEqual(
      valid.reviewArtifact.files.filter((f) => f.content !== null).map((f) => f.content),
    );
    const tree = requests.find((r) => r.url.endsWith("/git/trees"))!;
    expect(tree.body.base_tree).toBe("base-tree");
    expect(tree.body.tree).toContainEqual({ path: "delete.txt", mode: "100644", type: "blob", sha: null });
    expect(database.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "COMPLETED",
          pullRequestUrl: "https://github.com/example/repo/pull/1",
        }),
      }),
    );
  }, 20000);

  it("performs no GitHub request if source changed after approval", async () => {
    await writeFile(path.join(root, "source.js"), "unapproved bytes");
    await expect(publishTask("task")).rejects.toThrow(/Source changed/);
    expect(fetch).not.toHaveBeenCalled();
  }, 20000);

  it("rejects a matching hash with a rejected human decision", async () => {
    database.task.findUniqueOrThrow.mockResolvedValue({
      ...valid,
      approvals: [{ hash: valid.approvalHash, decision: "REJECTED" }],
    });
    await expect(publishTask("task")).rejects.toThrow(/human approval/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a legacy approval with no captured artifact", async () => {
    database.task.findUniqueOrThrow.mockResolvedValue({ ...valid, reviewArtifact: null });
    await expect(publishTask("task")).rejects.toThrow(/versioned/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects missing baseline evidence before GitHub writes", async () => {
    database.task.findUniqueOrThrow.mockResolvedValue({ ...valid, testRuns: valid.testRuns.slice(1) });
    await expect(publishTask("task")).rejects.toThrow(/baseline/);
    expect(fetch).not.toHaveBeenCalled();
  }, 20000);

  it("uses approved bytes even if the workspace changes after initial validation", async () => {
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        await writeFile(path.join(root, "source.js"), "changed during upload");
        return original(url, init);
      }),
    );
    await publishTask("task");
    expect(requests.filter((r) => r.url.endsWith("/git/blobs")).map((r) => r.body.content)).toContain(
      Buffer.from(source).toString("base64"),
    );
    expect(
      requests.some((r) => r.body.content === Buffer.from("changed during upload").toString("base64")),
    ).toBe(false);
  }, 20000);

  it("refuses a remote tree mismatch before creating a commit or branch", async () => {
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith("/git/trees") ? new Response(JSON.stringify({ sha: "wrong" })) : original(url, init),
      ),
    );
    await expect(publishTask("task")).rejects.toThrow(/tree does not match/);
    expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/git/commits"))).toBe(false);
    expect(database.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "FAILED",
          error: expect.stringMatching(/tree does not match/),
        }),
      }),
    );
  }, 20000);

  it("finishes from a completed idempotency record without GitHub calls", async () => {
    database.publicationAttempt.upsert.mockResolvedValue({
      id: "attempt",
      artifactHash: valid.reviewArtifact.hash,
      branch: "bugwright/issue-1-task",
      status: "COMPLETED",
      commitSha: "commit",
      pullRequestUrl: "https://github.com/example/repo/pull/1",
    });
    await expect(publishTask("task")).resolves.toBe(true);
    expect(requests).toHaveLength(0);
    expect(database.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "COMPLETED" }) }),
    );
  });

  it("recovers a branch created before a worker crash without recreating Git objects or a PR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        requests.push({ url, method, body: JSON.parse(String(init?.body ?? "{}")) });
        let response: unknown;
        if (url.endsWith(`/git/commits/${valid.baseCommit}`)) response = { tree: { sha: "base-tree" } };
        else if (url.includes("/git/ref/heads/")) response = { object: { sha: "remote-commit" } };
        else if (url.endsWith("/git/commits/remote-commit"))
          response = {
            tree: { sha: valid.reviewArtifact.tree },
            parents: [{ sha: valid.baseCommit }],
          };
        else if (url.includes("/pulls?")) response = [{ html_url: "https://github.com/example/repo/pull/1" }];
        else throw new Error(`Unexpected recovery request: ${method} ${url}`);
        return new Response(JSON.stringify(response), { status: 200 });
      }),
    );

    await expect(publishTask("task")).resolves.toBe(true);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    expect(database.publicationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ commitSha: "remote-commit" }) }),
    );
  });

  it("does no work when another worker owns the publication lease", async () => {
    leases.withLease.mockResolvedValue({ claimed: false });
    await expect(publishTask("task")).resolves.toBe(false);
    expect(database.task.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
});
