import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProvider } from "../model/providers/fake.js";
import { RoleModel } from "../model.js";

const fake = vi.hoisted(() => ({
  task: {} as Record<string, unknown>,
  events: vi.fn(async () => ({ id: "event" })),
  runs: vi.fn(async (_record: { data: { role: string } }) => ({ id: "run" })),
  updateRun: vi.fn(async () => ({})),
  message: vi.fn(async () => ({ id: "message" })),
  connect: vi.fn(async (_servers: string[], _roles: string[]) => {}),
  call: vi.fn(async () => "{}"),
  close: vi.fn(async () => {}),
  verified: vi.fn(async () => ({ failed: true, ran: true, output: "assertion failed" })),
  tester: vi.fn(),
}));
vi.mock("@bugwright/database", () => ({
  db: {
    task: { findUniqueOrThrow: vi.fn(async () => fake.task) },
    taskEvent: { create: fake.events },
    agentRun: { create: fake.runs, update: fake.updateRun, count: vi.fn(async () => 0) },
    agentMessage: { create: fake.message },
    testRun: { findMany: vi.fn(async () => []) },
  },
  assertTaskLease: vi.fn(async () => {}),
  updateTaskWithLease: vi.fn(async (_id, data) => {
    for (const [key, value] of Object.entries(data)) {
      fake.task[key] =
        value && typeof value === "object" && "increment" in value
          ? Number(fake.task[key] ?? 0) + Number(value.increment)
          : value;
    }
  }),
  LeaseLostError: class extends Error {},
  Prisma: { DbNull: null },
}));
vi.mock("@bugwright/policy", () => ({
  resolveInside: (root: string, file: string) => `${root}/${file}`,
  restoreArtifact: vi.fn(async () => {}),
  assertReproduction: vi.fn(async () => {}),
  assertArtifactCurrent: vi.fn(async () => ({})),
  captureArtifact: vi.fn(async () => ({ hash: "artifact", diff: "+fix", files: [{ path: "bug.ts" }] })),
  artifactApprovalHash: () => "approved-fingerprint",
}));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}) }));
vi.mock("../runtime.js", () => ({ workspaceRoot: () => "/workspace" }));
vi.mock("../index.js", () => ({
  prepare: vi.fn(async () => "base"),
  event: vi.fn(async () => {}),
  attemptHistory: vi.fn(async () => []),
}));
vi.mock("../mcp.js", () => ({
  McpTools: class {
    connect = fake.connect;
    call = fake.call;
    close = fake.close;
    protectReproduction = vi.fn(async () => {});
  },
  parseToolJson: (value: string) => JSON.parse(value),
}));
vi.mock("../roles.js", async (original) => ({
  ...(await original<typeof import("../roles.js")>()),
  tester: fake.tester,
}));
vi.mock("../reproduction-verifier.js", () => ({
  createReproductionVerifier:
    (
      _id: string,
      _root: string,
      _base: string,
      _mcp: unknown,
      callbacks: { onProof: (proof: unknown) => void; onBaseline: (artifact: unknown) => void },
    ) =>
    async (path: string) => {
      const result = await fake.verified();
      callbacks.onBaseline({ hash: "baseline" });
      if (result.failed)
        callbacks.onProof({
          path,
          sha256: "testhash",
          baselineArtifactHash: "baseline",
          testRunId: "before",
        });
      return result;
    },
}));
import { executeSingleAgent, SINGLE_AGENT_TOOLS, baselineCanRevise } from "../single-agent.js";
const repro = { reproduced: true, testPath: "bug.test.ts", explanation: "demonstrates bug", confidence: 1 };
const patch = { summary: "fixed bug", filesChanged: ["bug.ts"], rationale: "minimal fix", riskNotes: [] };
const passing = { passed: true, reproductionFixed: "passed", summary: "passes", failures: [] };

beforeEach(() => {
  vi.clearAllMocks();
  fake.task = {
    id: "task",
    state: "QUEUED",
    demoMode: true,
    issueTitle: "bug",
    issueBody: "details",
    repositoryOwner: "owner",
    repositoryName: "repo",
    repositoryUrl: "https://github.com/owner/repo",
    baseBranch: "main",
    modelCalls: 0,
    maxModelCalls: 30,
    maxAgentRuns: 20,
    timeoutMs: 60000,
    revisionCycle: 0,
    attempt: 0,
    maxAttempts: 3,
    maxRevisions: 2,
  };
  fake.verified.mockResolvedValue({ failed: true, ran: true, output: "assertion failed" });
  fake.tester.mockResolvedValue({ report: passing, artifactId: "tested" });
});
const model = (patches = 1) =>
  new RoleModel(
    "CODER",
    new FakeProvider([
      { text: JSON.stringify(repro) },
      ...Array.from({ length: patches }, () => ({ text: JSON.stringify(patch) })),
    ]),
  );

describe("single-agent baseline", () => {
  it("rejects source writes proposed during the reproduction phase", async () => {
    const provider = new FakeProvider([
      { toolCalls: [{ name: "apply_patch", args: { path: "bug.ts", oldText: "bug", newText: "fix" } }] },
      { text: JSON.stringify(repro) },
      { text: JSON.stringify(patch) },
    ]);
    await executeSingleAgent("task", new RoleModel("CODER", provider));
    expect(fake.call).not.toHaveBeenCalled();
    expect(fake.task.state).toBe("AWAITING_HUMAN_APPROVAL");
  });
  it("registers one unrestricted model authority pool with read, history and mutation tools", async () => {
    expect(SINGLE_AGENT_TOOLS).toEqual(
      expect.arrayContaining(["read_file", "get_history", "apply_patch", "write_test_file"]),
    );
    await executeSingleAgent("task", model());
    expect(fake.connect.mock.calls[0][1]).toEqual(["SINGLE_AGENT", "TESTER"]);
    expect(fake.task.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(fake.task.approvalHash).toBe("approved-fingerprint");
  });
  it("overwrites a model's reproduction claim when deterministic verification observes a passing test", async () => {
    fake.verified.mockResolvedValue({ failed: false, ran: true, output: "test passes" });
    await executeSingleAgent("task", model());
    expect(fake.verified).toHaveBeenCalledOnce();
    expect(fake.task.state).toBe("NEEDS_ATTENTION");
    expect((fake.task.reproductionReport as { reproduced: boolean }).reproduced).toBe(false);
    expect(fake.tester).not.toHaveBeenCalled();
  });
  it("records model telemetry with SINGLE_AGENT role through the real offline agent loop", async () => {
    await executeSingleAgent("task", model());
    expect(fake.runs.mock.calls).toHaveLength(2);
    for (const [record] of fake.runs.mock.calls) expect(record.data.role).toBe("SINGLE_AGENT");
    expect(fake.task.modelCalls).toBe(2);
  });
  it("stops failed deterministic verification at the revision limit", async () => {
    fake.task.maxRevisions = 1;
    fake.tester.mockResolvedValue({
      report: { ...passing, passed: false, reproductionFixed: "failed", summary: "still fails" },
    });
    await executeSingleAgent("task", model(2));
    expect(fake.tester).toHaveBeenCalledTimes(2);
    expect(fake.task.state).toBe("NEEDS_ATTENTION");
    expect(fake.task.revisionCycle).toBe(1);
    expect(baselineCanRevise(1, 1, { maxRevisions: 1, maxAttempts: 3 })).toBe(false);
  });
  it("never spends a model call after its configured model budget is exhausted", async () => {
    fake.task.maxModelCalls = 1;
    await executeSingleAgent("task", model());
    expect(fake.runs).toHaveBeenCalledOnce();
    expect(fake.tester).not.toHaveBeenCalled();
    expect(fake.task.state).toBe("NEEDS_ATTENTION");
  });
  it("routes exhaustion inside the model tool loop to attention instead of failure", async () => {
    fake.task.maxModelCalls = 1;
    const provider = new FakeProvider([{ toolCalls: [{ name: "read_file", args: { path: "bug.ts" } }] }]);
    await executeSingleAgent("task", new RoleModel("CODER", provider));
    expect(fake.task.state).toBe("NEEDS_ATTENTION");
    expect(fake.task.modelCalls).toBe(1);
  });
});
