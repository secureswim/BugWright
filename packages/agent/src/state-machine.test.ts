import { describe, expect, it } from "vitest";
import {
  ManagerDecision,
  ReproductionReport,
  ReviewReport,
  ScopeVerdict,
  TestReport,
} from "@bugwright/shared";
import {
  routeAfterReproduction,
  routeAfterReview,
  routeAfterScopeCheck,
  routeAfterTest,
} from "./state-machine.js";

const testReport = (over: Partial<TestReport> = {}): TestReport => ({
  passed: true,
  reproductionFixed: "passed",
  regression: "passed",
  typecheck: "passed",
  lint: "passed",
  testsRun: ["npm test"],
  failures: [],
  notConfigured: [],
  summary: "ok",
  ...over,
});

const reviewReport = (over: Partial<ReviewReport> = {}): ReviewReport => ({
  decision: "approve",
  findings: [],
  scopeAssessment: "minimal",
  regressionRisk: "low",
  reasoning: "fine",
  ...over,
});

const reproduction = (over: Partial<ReproductionReport> = {}): ReproductionReport => ({
  reproduced: true,
  testPath: "test/repro.test.js",
  explanation: "asserts add(4,3) === 7",
  confidence: 0.9,
  ...over,
});

describe("routeAfterReproduction", () => {
  it("proceeds to the Coder once a failing test exists", () => {
    expect(routeAfterReproduction(reproduction()).next).toBe("CODER");
  });

  it("stops when the bug could not be reproduced", () => {
    // Without a test that fails first, a later green run proves nothing, so
    // stopping is the correct outcome rather than guessing at a fix.
    const decision = routeAfterReproduction(
      reproduction({ reproduced: false, blockedReason: "Issue lacks reproduction steps" }),
    );
    expect(decision.next).toBe("NEEDS_ATTENTION");
    expect(decision.reason).toMatch(/reproduction steps/);
  });

  it("never reaches the human gate directly from reproduction", () => {
    for (const reproduced of [true, false]) {
      expect(routeAfterReproduction(reproduction({ reproduced })).next).not.toBe("HUMAN_APPROVAL");
    }
  });
});

describe("routeAfterScopeCheck", () => {
  const verdict = (over: Partial<ScopeVerdict> = {}): ScopeVerdict => ({
    withinScope: true,
    changedFiles: ["src/a.ts"],
    unrelatedFiles: [],
    reason: "",
    ...over,
  });

  it("proceeds to testing when the patch stayed in scope", () => {
    expect(routeAfterScopeCheck(verdict(), { revisionCycle: 0, maxRevisions: 2 }).next).toBe("TESTER");
  });

  it("sends an out-of-scope patch back to the Coder", () => {
    const decision = routeAfterScopeCheck(
      verdict({ withinScope: false, unrelatedFiles: ["src/unrelated.ts"] }),
      { revisionCycle: 0, maxRevisions: 2 },
    );
    expect(decision.next).toBe("CODER");
    expect(decision.reason).toContain("src/unrelated.ts");
  });

  it("stops rather than looping when out of scope at the revision limit", () => {
    expect(
      routeAfterScopeCheck(verdict({ withinScope: false, unrelatedFiles: ["x.ts"] }), {
        revisionCycle: 2,
        maxRevisions: 2,
      }).next,
    ).toBe("NEEDS_ATTENTION");
  });
});

describe("routeAfterTest", () => {
  it("sends a fully passing run to review", () => {
    expect(routeAfterTest(testReport(), undefined, 0, 2).next).toBe("REVIEWER");
  });

  it("refuses to approve when nothing regressed but the bug is not fixed", () => {
    // The central soundness property. A green regression suite says only that
    // nothing broke; if the reproduction test still fails, the issue is open.
    const decision = routeAfterTest(
      testReport({ passed: true, reproductionFixed: "failed" }),
      undefined,
      0,
      2,
    );
    expect(decision.next).toBe("CODER");
    expect(decision.reason).toMatch(/reproduction test still fails/);
  });

  it("stops when the bug is still unfixed at the revision limit", () => {
    expect(
      routeAfterTest(testReport({ passed: true, reproductionFixed: "failed" }), undefined, 2, 2).next,
    ).toBe("NEEDS_ATTENTION");
  });

  it("returns a failing run to the Coder", () => {
    expect(
      routeAfterTest(
        testReport({ passed: false, regression: "failed", suggestedNextAction: "CODER" }),
        undefined,
        0,
        2,
      ).next,
    ).toBe("CODER");
  });

  it("honours a Manager request for targeted re-research", () => {
    const requested: ManagerDecision = { next: "RESEARCHER", reason: "diagnosis looks wrong" };
    expect(routeAfterTest(testReport({ passed: false }), requested, 0, 2).next).toBe("RESEARCHER");
  });

  it("ignores a Manager attempt to skip straight to approval", () => {
    // The model is advisory. It cannot route around the gate by asking to.
    const requested: ManagerDecision = { next: "HUMAN_APPROVAL", reason: "looks fine to me" };
    const decision = routeAfterTest(testReport({ passed: false }), requested, 0, 2);
    expect(decision.next).not.toBe("HUMAN_APPROVAL");
    expect(decision.next).toBe("CODER");
  });

  it("ignores a Manager attempt to skip review on a failing run", () => {
    const requested: ManagerDecision = { next: "REVIEWER", reason: "close enough" };
    expect(routeAfterTest(testReport({ passed: false }), requested, 0, 2).next).toBe("CODER");
  });

  it("stops on infrastructure failure rather than revising code", () => {
    expect(
      routeAfterTest(
        testReport({ passed: false, suggestedNextAction: "NEEDS_ATTENTION", summary: "docker unavailable" }),
        undefined,
        0,
        2,
      ).next,
    ).toBe("NEEDS_ATTENTION");
  });

  it("stops at the revision limit", () => {
    expect(routeAfterTest(testReport({ passed: false }), undefined, 2, 2).next).toBe("NEEDS_ATTENTION");
  });

  it("never reaches the human gate from a failing run, at any revision", () => {
    for (let revision = 0; revision <= 5; revision++) {
      for (const requested of [
        undefined,
        { next: "HUMAN_APPROVAL", reason: "x" } as ManagerDecision,
        { next: "REVIEWER", reason: "x" } as ManagerDecision,
      ]) {
        expect(routeAfterTest(testReport({ passed: false }), requested, revision, 2).next).not.toBe(
          "HUMAN_APPROVAL",
        );
      }
    }
  });
});

describe("routeAfterReview", () => {
  it("sends an approval to the human gate", () => {
    expect(routeAfterReview(reviewReport(), undefined, 0, 2).next).toBe("HUMAN_APPROVAL");
  });

  it("never turns a rejection into an approval", () => {
    // Exhaustive over the requests a Manager could make, including one that
    // asks directly for approval.
    const requests: Array<ManagerDecision | undefined> = [
      undefined,
      { next: "HUMAN_APPROVAL", reason: "override" },
      { next: "REVIEWER", reason: "re-review" },
      { next: "TESTER", reason: "retest" },
      { next: "CODER", reason: "revise" },
      { next: "RESEARCHER", reason: "investigate" },
    ];
    for (const requested of requests) {
      for (let revision = 0; revision <= 3; revision++) {
        const decision = routeAfterReview(reviewReport({ decision: "reject" }), requested, revision, 2);
        expect(decision.next).not.toBe("HUMAN_APPROVAL");
      }
    }
  });

  it("stops on rejection at the revision limit", () => {
    expect(routeAfterReview(reviewReport({ decision: "reject" }), undefined, 2, 2).next).toBe(
      "NEEDS_ATTENTION",
    );
  });

  it("honours a Manager request to re-research after rejection", () => {
    const requested: ManagerDecision = { next: "RESEARCHER", reason: "wrong root cause" };
    expect(routeAfterReview(reviewReport({ decision: "reject" }), requested, 0, 2).next).toBe("RESEARCHER");
  });

  it("always approves through the human gate, never straight to publishing", () => {
    const decision = routeAfterReview(reviewReport(), undefined, 0, 2);
    expect(decision.next).toBe("HUMAN_APPROVAL");
  });
});

/**
 * A stop reason that says a counter ran out, without saying what the counter
 * was counting, sends the reader back to the logs. These assert the evidence
 * survives into the message a human actually sees.
 */
describe("stop reasons carry the evidence", () => {
  it("names the failing check when the revision limit is hit", () => {
    const decision = routeAfterTest(
      testReport({
        passed: false,
        regression: "failed",
        failures: [
          {
            command: "npm test",
            message: "2 tests failed in Dashboard.test.tsx",
            relevantOutput: "",
            category: "code",
          },
        ],
      }),
      undefined,
      2,
      2,
    );
    expect(decision.next).toBe("NEEDS_ATTENTION");
    expect(decision.reason).toContain("the existing suite fails");
    expect(decision.reason).toContain("2 tests failed in Dashboard.test.tsx");
  });

  it("says the reproduction test is the blocker when only it fails", () => {
    const decision = routeAfterTest(
      testReport({ passed: true, reproductionFixed: "failed" }),
      undefined,
      2,
      2,
    );
    expect(decision.reason).toContain("the reproduction test still fails");
  });

  it("falls back to the summary when no individual check is marked failed", () => {
    const decision = routeAfterTest(
      testReport({ passed: false, summary: "something unusual happened" }),
      undefined,
      2,
      2,
    );
    expect(decision.reason).toContain("something unusual happened");
  });

  it("still routes a green run to review rather than stopping", () => {
    // The property the message confusion hid: a fully passing report never
    // reaches the limit branch at all.
    expect(routeAfterTest(testReport(), undefined, 99, 2).next).toBe("REVIEWER");
  });
});
