import { describe, expect, it } from "vitest";
import { AttemptRecord, ReproductionReport, ResearchReport, TestReport } from "@bugpilot/shared";
import {
  coderContext,
  reproducerContext,
  researchContext,
  reviewerContext,
  testerContext,
} from "./context.js";

const issue = { title: "bug" };

const research: ResearchReport = {
  diagnosis: "x",
  evidence: [],
  relevantFiles: [],
  relevantTests: [],
  proposedApproach: "x",
  risks: [],
  confidence: 1,
};

const patch = {
  summary: "x",
  filesChanged: [],
  rationale: "private coder claim",
  riskNotes: [],
};

const tests: TestReport = {
  passed: true,
  reproductionFixed: "passed",
  regression: "passed",
  typecheck: "not-configured",
  lint: "not-configured",
  testsRun: [],
  failures: [],
  notConfigured: [],
  summary: "ok",
};

const reproduction: ReproductionReport = {
  reproduced: true,
  testPath: "test/repro.test.js",
  explanation: "asserts the reported behaviour",
  confidence: 0.9,
};

describe("agent context isolation", () => {
  it("research receives only its objective", () => {
    expect(Object.keys(researchContext(issue, { type: "tests", objective: "locate tests" }))).toEqual([
      "issue",
      "researchTask",
    ]);
  });

  it("tester receives the change summary without research history", () => {
    expect(testerContext(issue, patch, "diff")).not.toHaveProperty("researchReports");
  });

  it("reviewer receives evidence but not coder rationale or hidden context", () => {
    const value = reviewerContext(issue, [research], "diff", tests, reproduction);
    expect(value).not.toHaveProperty("coderContext");
    expect(JSON.stringify(value)).not.toContain("private coder claim");
  });

  it("coder receives reports but cannot inherit reviewer context", () => {
    expect(coderContext(issue, [research])).not.toHaveProperty("reviewReport");
  });

  it("reproducer is told it may only write tests and must fail first", () => {
    const value = reproducerContext(issue, [research]);
    expect(value.constraints.writeTestsOnly).toBe(true);
    expect(value.constraints.mustFailBeforeFix).toBe(true);
    expect(value.constraints.noSourceEdits).toBe(true);
  });

  it("coder receives the full attempt history, not just the latest failure", () => {
    // Given only the most recent evidence the Coder re-proposes approaches it
    // already tried; the attempt log is what breaks that loop.
    const attempts: AttemptRecord[] = [
      {
        revision: 0,
        summary: "swapped the operator",
        filesChanged: ["src/a.js"],
        outcome: "tests-failed",
        evidence: "still returns a - b",
      },
      {
        revision: 1,
        summary: "guarded the branch",
        filesChanged: ["src/a.js"],
        outcome: "review-rejected",
        evidence: "does not address the root cause",
      },
    ];
    const value = coderContext(issue, [research], { attempts });
    expect(value.previousAttempts).toHaveLength(2);
    expect(JSON.stringify(value)).toContain("swapped the operator");
  });

  it("tells the coder not to edit the reproduction test", () => {
    // Otherwise the cheapest way to make the suite green is to delete the test
    // that proves the bug.
    const value = coderContext(issue, [research], { reproduction });
    expect(value.codingConstraints.doNotEditTheReproductionTest).toBe(true);
    expect(value.reproduction).toEqual(reproduction);
  });
});
