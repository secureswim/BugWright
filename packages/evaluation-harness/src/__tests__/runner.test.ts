import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: "task" })),
  event: vi.fn(async () => ({})),
  run: vi.fn(async () => true),
  final: vi.fn(),
}));
vi.mock("@bugwright/database", () => ({
  db: { task: { create: mocks.create, findUniqueOrThrow: mocks.final }, taskEvent: { create: mocks.event } },
}));
vi.mock("@bugwright/agent", () => ({ runTask: mocks.run }));
import { instanceTaskInput, runInstance, resolveBaseBranch } from "../runner.js";
const instance = {
  instance_id: "owner__repo-12",
  repo: "owner/repo",
  base_commit: "a".repeat(40),
  problem_statement: "Fix the bug\nDetails",
  hints_text: "SECRET HINT",
  test_patch: "SECRET GOLD TEST",
  patch: "SECRET GOLD FIX",
  version: "1",
  FAIL_TO_PASS: '["bug"]',
  PASS_TO_PASS: '["existing"]',
  environment_setup_commit: "",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.final.mockResolvedValue({
    state: "AWAITING_HUMAN_APPROVAL",
    diff: "agent diff",
    costUsd: 2,
    revisionCycle: 1,
    testReport: { reproductionFixed: "passed", artifactHash: "artifact" },
    reproductionProof: { testRunId: "before" },
    testRuns: [
      {
        id: "before",
        kind: "reproduction-before",
        stdout: "bug FAILED",
        stderr: "",
        artifactHash: "baseline",
      },
      { id: "after", kind: "reproduction-after", stdout: "bug PASSED", stderr: "", artifactHash: "artifact" },
    ],
    agentRuns: [{ modelCalls: 3 }],
  });
});
describe("instance runner", () => {
  it("resolves a repository's target branch once across repeated instances", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ default_branch: "master" }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await resolveBaseBranch("cache/test")).toBe("master");
      expect(await resolveBaseBranch("cache/test")).toBe("master");
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("pins checkout and keeps all gold material out of task input", async () => {
    expect(instanceTaskInput(instance, "SINGLE_AGENT", "master")).toMatchObject({
      issueNumber: 12,
      issueTitle: "Fix the bug",
      issueBody: instance.problem_statement,
      baseBranch: "master",
      executionMode: "SINGLE_AGENT",
    });
    const oracle = vi.fn(async () => ({ passed: ["bug", "existing"], failed: [] }));
    const result = await runInstance(instance, { mode: "SINGLE_AGENT", baseBranch: "master", oracle });
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain("SECRET");
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ baseCommit: instance.base_commit }),
    });
    expect(mocks.run).toHaveBeenCalledWith("task");
    expect(oracle).toHaveBeenCalledWith(instance, "agent diff");
    expect(result).toMatchObject({
      verifiedResolved: true,
      goldPassed: true,
      oracleMatch: true,
      modelCalls: 3,
      costUsd: 2,
    });
  });
  it("records unavailable oracle evidence without claiming a gold pass", async () => {
    const result = await runInstance(instance, {
      mode: "MULTI_AGENT",
      baseBranch: "main",
      oracle: async () => {
        throw new Error("Docker unavailable");
      },
    });
    expect(result).toMatchObject({
      oracleAvailable: false,
      goldPassed: false,
      oracleError: "Docker unavailable",
    });
    expect(mocks.event).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "BENCHMARK_ORACLE_FAILED" }),
    });
  });
});
