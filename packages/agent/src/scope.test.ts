import { describe, expect, it } from "vitest";
import { ResearchReport } from "@bugpilot/shared";
import { assessScope, changedFilesFromDiff, changedFilesFromNameStatus } from "./scope.js";

const report = (over: Partial<ResearchReport> = {}): ResearchReport => ({
  diagnosis: "add() subtracts",
  evidence: [{ path: "src/calculator.js", line: 2, observation: "returns a - b" }],
  relevantFiles: ["src/calculator.js"],
  relevantTests: ["test/calculator.test.js"],
  proposedApproach: "return a + b",
  risks: [],
  confidence: 0.9,
  ...over,
});

describe("changed file parsing", () => {
  it("reads git name-status output", () => {
    expect(changedFilesFromNameStatus("M\tsrc/a.ts\nA\ttest/b.test.ts\n")).toEqual([
      "src/a.ts",
      "test/b.test.ts",
    ]);
  });

  it("reads a unified diff", () => {
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-x\n+y\n--- a/src/b.ts\n+++ b/src/b.ts\n";
    expect(changedFilesFromDiff(diff)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns nothing for an empty diff", () => {
    expect(changedFilesFromDiff("")).toEqual([]);
    expect(changedFilesFromNameStatus("")).toEqual([]);
  });
});

describe("assessScope", () => {
  it("accepts a patch confined to researched files", () => {
    const verdict = assessScope(["src/calculator.js"], [report()]);
    expect(verdict.withinScope).toBe(true);
    expect(verdict.unrelatedFiles).toEqual([]);
  });

  it("rejects a patch that touched an unresearched file", () => {
    const verdict = assessScope(["src/calculator.js", "src/billing.js"], [report()]);
    expect(verdict.withinScope).toBe(false);
    expect(verdict.unrelatedFiles).toEqual(["src/billing.js"]);
  });

  it("always allows the reproduction test", () => {
    const verdict = assessScope(["src/calculator.js", "test/repro.test.js"], [report()], {
      reproductionTestPath: "test/repro.test.js",
    });
    expect(verdict.withinScope).toBe(true);
  });

  it("allows test files generally, since a fix may need its own test", () => {
    expect(assessScope(["tests/test_math.py"], [report()]).withinScope).toBe(true);
  });

  it("accepts a research path recorded without its directory", () => {
    const verdict = assessScope(["src/calculator.js"], [report({ relevantFiles: ["calculator.js"] })]);
    expect(verdict.withinScope).toBe(true);
  });

  it("normalises leading ./ and backslashes", () => {
    const verdict = assessScope(["src/calculator.js"], [report({ relevantFiles: ["./src\\calculator.js"] })]);
    expect(verdict.withinScope).toBe(true);
  });

  it("unions the surface across several research reports", () => {
    const verdict = assessScope(
      ["src/a.js", "src/b.js"],
      [
        report({ relevantFiles: ["src/a.js"], relevantTests: [], evidence: [] }),
        report({ relevantFiles: ["src/b.js"], relevantTests: [], evidence: [] }),
      ],
    );
    expect(verdict.withinScope).toBe(true);
  });

  it("fails open when there is no research surface to compare against", () => {
    // A false rejection costs a revision cycle and teaches the Coder nothing,
    // so with nothing to enforce the guard stands down and says so.
    const verdict = assessScope(
      ["src/anything.js"],
      [report({ relevantFiles: [], relevantTests: [], evidence: [] })],
    );
    expect(verdict.withinScope).toBe(true);
    expect(verdict.reason).toMatch(/could not be constrained/);
  });

  it("reports every unrelated file, not just the first", () => {
    const verdict = assessScope(["src/calculator.js", "src/x.js", "src/y.js"], [report()]);
    expect(verdict.unrelatedFiles).toEqual(["src/x.js", "src/y.js"]);
  });
});
