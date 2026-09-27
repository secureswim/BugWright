import { describe, expect, it } from "vitest";
import { aggregateResults, safeRunId, comparisonReport } from "../results.js";
describe("results aggregation", () => {
  it("computes rates, costs, and durations using the whole arm", () => {
    const result = aggregateResults("test", "MULTI_AGENT", "swe-bench-verified", [
      {
        instanceId: "a",
        taskId: "1",
        status: "COMPLETED",
        resolved: true,
        verifiedResolved: true,
        oracleMatch: true,
        falsePositive: false,
        oracleAvailable: true,
        goldPassed: true,
        costUsd: 2,
        durationMs: 100,
        modelCalls: 4,
        revisionCycles: 0,
      },
      {
        instanceId: "b",
        taskId: "2",
        status: "FAILED",
        resolved: false,
        verifiedResolved: false,
        oracleMatch: false,
        falsePositive: false,
        oracleAvailable: false,
        goldPassed: false,
        costUsd: 4,
        durationMs: 300,
        modelCalls: 8,
        revisionCycles: 1,
      },
    ]);
    expect(result).toMatchObject({
      instanceCount: 2,
      resolvedRate: 0.5,
      verifiedResolvedRate: 0.5,
      oracleMatchRate: 0.5,
      meanCostUsd: 3,
      meanDurationMs: 200,
      meanModelCalls: 6,
    });
    expect(comparisonReport([result])).toContain("Verified resolved rate");
  });
  it("handles empty runs and rejects path traversal", () => {
    expect(aggregateResults("empty", "SINGLE_AGENT", "swe-bench-lite", []).meanCostUsd).toBe(0);
    expect(() => safeRunId("../escape")).toThrow();
  });
});
