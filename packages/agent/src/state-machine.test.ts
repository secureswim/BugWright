import { describe, expect, it } from "vitest";
import { routeAfterReview, routeAfterTest } from "./state-machine.js";
const passed = { passed: true, testsRun: ["npm test"], failures: [], summary: "ok" };
describe("multi-agent manager state machine", () => {
  it("routes passing tests to an independent reviewer", () =>
    expect(routeAfterTest(passed, undefined, 0, 2).next).toBe("REVIEWER"));
  it("routes reviewer approval to the distinct human gate", () =>
    expect(
      routeAfterReview(
        {
          decision: "approve",
          findings: [],
          scopeAssessment: "minimal",
          regressionRisk: "low",
          reasoning: "ok",
        },
        undefined,
        0,
        2,
      ).next,
    ).toBe("HUMAN_APPROVAL"));
  it("bounds failing revision loops", () =>
    expect(
      routeAfterTest(
        { ...passed, passed: false, failures: [{ command: "npm test", message: "x", relevantOutput: "x" }] },
        undefined,
        2,
        2,
      ).next,
    ).toBe("NEEDS_ATTENTION"));
  it("stops on infrastructure failures without spending a code revision", () =>
    expect(
      routeAfterTest(
        {
          ...passed,
          passed: false,
          summary: "Runner dependency preparation failed",
          suggestedNextAction: "NEEDS_ATTENTION",
          failures: [
            {
              command: "pnpm install",
              message: "pnpm unavailable",
              relevantOutput: "not found",
              category: "infrastructure",
            },
          ],
        },
        { next: "CODER", reason: "model guessed code" },
        0,
        2,
      ).next,
    ).toBe("NEEDS_ATTENTION"));
  it("cannot treat reviewer rejection as approval", () =>
    expect(
      routeAfterReview(
        {
          decision: "reject",
          findings: [],
          scopeAssessment: "too-broad",
          regressionRisk: "high",
          reasoning: "broad",
        },
        undefined,
        0,
        2,
      ).next,
    ).toBe("CODER"));
  it("allows Manager to request targeted research after rejection", () =>
    expect(
      routeAfterReview(
        {
          decision: "reject",
          findings: [],
          scopeAssessment: "acceptable",
          regressionRisk: "medium",
          reasoning: "unclear",
        },
        { next: "RESEARCHER", reason: "diagnosis gap" },
        0,
        2,
      ).next,
    ).toBe("RESEARCHER"));
});
