import { describe, expect, it } from "vitest";
import { coderContext, researchContext, reviewerContext, testerContext } from "./context.js";
const issue = { title: "bug" },
  research = {
    diagnosis: "x",
    evidence: [],
    relevantFiles: [],
    relevantTests: [],
    proposedApproach: "x",
    risks: [],
    confidence: 1,
  },
  patch = { summary: "x", filesChanged: [], rationale: "private coder claim", riskNotes: [] },
  tests = { passed: true, testsRun: [], failures: [], summary: "ok" };
describe("agent context isolation", () => {
  it("research receives only its objective", () =>
    expect(Object.keys(researchContext(issue, { type: "tests", objective: "locate tests" }))).toEqual([
      "issue",
      "researchTask",
    ]));
  it("tester receives the change summary without research history", () =>
    expect(testerContext(issue, patch, "diff")).not.toHaveProperty("researchReports"));
  it("reviewer receives evidence but not coder rationale or hidden context", () => {
    const value = reviewerContext(issue, [research], "diff", tests);
    expect(value).not.toHaveProperty("coderContext");
    expect(JSON.stringify(value)).not.toContain("private coder claim");
  });
  it("coder receives reports but cannot inherit reviewer context", () =>
    expect(coderContext(issue, [research])).not.toHaveProperty("reviewReport"));
});
