import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessResults } from "@bugwright/shared";
const mocks = vi.hoisted(() => ({ tasks: vi.fn() }));
vi.mock("@bugwright/database", () => ({ db: { task: { findMany: mocks.tasks } } }));
vi.mock("@bugwright/agent", () => ({ reviewerIsIndependent: () => true }));
import { evaluationMetrics } from "./index.js";
const task = (mode: string, cost: number, state = "COMPLETED") => ({
  executionMode: mode,
  state,
  costUsd: cost,
  createdAt: new Date(0),
  updatedAt: new Date(100),
  agentRuns: [],
  testRuns: [],
  events: [],
  attempt: 1,
  revisionCycle: 0,
  delegationCycles: 0,
  reproductionReport: { reproduced: true },
  testReport: { reproductionFixed: "passed" },
});
beforeEach(() => vi.clearAllMocks());
describe("evaluation extensions", () => {
  it("omits comparison without both arms", async () => {
    mocks.tasks.mockResolvedValue([task("SINGLE_AGENT", 2)]);
    expect(await evaluationMetrics()).not.toHaveProperty("baseline");
  });
  it("computes arm rates and counts audited graph and trust items", async () => {
    mocks.tasks.mockResolvedValue([
      {
        ...task("MULTI_AGENT", 4),
        events: [
          { type: "TOOL_COMPLETED", tool: "knowledge-graph.query_entity", output: { trust: "untrusted" } },
        ],
      },
      task("SINGLE_AGENT", 2),
      task("SINGLE_AGENT", 2, "FAILED"),
    ]);
    const metrics = await evaluationMetrics();
    expect(metrics.baseline).toMatchObject({
      multiAgent: { count: 1, resolvedRate: 1, meanCostUsd: 4 },
      singleAgent: { count: 2, resolvedRate: 0.5 },
      delta: { resolvedRateDiff: 0.5, costRatio: 2 },
    });
    expect(metrics.multiAgent.knowledgeGraphQueries).toBe(1);
    expect(metrics.quarantine).toMatchObject({ untrustedContentItems: 1, managerRawContentExposures: 0 });
  });
  it("adds supplied benchmark metrics", async () => {
    mocks.tasks.mockResolvedValue([]);
    const harness = {
      dataset: "swe-bench-verified",
      resolvedRate: 0.5,
      verifiedResolvedRate: 0.4,
      oracleMatchRate: 0.2,
      falsePositiveRate: 0.1,
    } as HarnessResults;
    expect((await evaluationMetrics(harness)).benchmark).toEqual(harness);
  });
});
