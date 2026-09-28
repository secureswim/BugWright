import { describe, expect, it } from "vitest";
import { evaluateOracle, observedReproductionIds } from "../oracle.js";
const instance = {
  instance_id: "owner__repo-12",
  repo: "owner/repo",
  base_commit: "a".repeat(40),
  problem_statement: "Fix bug",
  hints_text: "",
  test_patch: "gold",
  patch: "gold",
  version: "1",
  FAIL_TO_PASS: '["bug"]',
  PASS_TO_PASS: '["existing"]',
  environment_setup_commit: "",
};
describe("gold oracle", () => {
  it("requires exact observed test identities before and after", () => {
    expect(observedReproductionIds(["bug", "missing"], "bug FAILED [100%]", "bug PASSED [100%]")).toEqual([
      "bug",
    ]);
    expect(observedReproductionIds(["bug"], "the bug FAILED earlier", "bug PASSED")).toEqual([]);
    expect(observedReproductionIds(["bug"], "bug PASSED", "bug PASSED")).toEqual([]);
  });
  it("compares observed identities and requires all gold and regression tests", () => {
    const task = {
      state: "AWAITING_HUMAN_APPROVAL",
      reproductionFixed: "passed",
      reproductionTestIds: ["bug"],
    };
    expect(evaluateOracle(instance, task, { passed: ["bug", "existing"], failed: [] })).toMatchObject({
      resolved: true,
      verifiedResolved: true,
      oracleMatch: true,
      goldPassed: true,
      falsePositive: false,
    });
    expect(evaluateOracle(instance, task, { passed: ["bug"], failed: ["existing"] }).falsePositive).toBe(
      true,
    );
    expect(evaluateOracle(instance, task, { passed: ["existing"], failed: ["bug"] }).goldPassed).toBe(false);
  });
  it("does not treat missing evidence or matching filenames as gold verification", () => {
    expect(evaluateOracle(instance, { state: "COMPLETED", reproductionFixed: "passed" })).toMatchObject({
      oracleAvailable: false,
      goldPassed: false,
      oracleMatch: false,
      falsePositive: false,
    });
    expect(
      evaluateOracle(instance, { state: "NEEDS_ATTENTION", reproductionFixed: "passed" }).verifiedResolved,
    ).toBe(false);
    expect(evaluateOracle(instance, { state: "COMPLETED", reproductionFixed: "failed" }).falsePositive).toBe(
      true,
    );
  });
});
