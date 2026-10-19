import { describe, expect, it } from "vitest";
import { reproductionContract } from "./roles.js";

const report = {
  reproduced: true,
  testPath: "tests/reproduction.test.ts",
  explanation: "Verifies the reported behavior",
  confidence: 0.8,
};

describe("reproduction report normalization", () => {
  it("accepts null optional fields as omitted", () => {
    expect(reproductionContract.parse({ ...report, blockedReason: null, failureOutput: null })).toEqual(
      report,
    );
  });

  it("preserves actual failure and blocking evidence", () => {
    expect(
      reproductionContract.parse({
        ...report,
        blockedReason: "Cannot collect tests",
        failureOutput: "trace",
      }),
    ).toMatchObject({ blockedReason: "Cannot collect tests", failureOutput: "trace" });
  });

  it("still rejects malformed non-null fields", () => {
    expect(() => reproductionContract.parse({ ...report, blockedReason: 42 })).toThrow();
    expect(() => reproductionContract.parse({ ...report, testPath: 42 })).toThrow();
  });

  it("accepts a refusal that names no test", () => {
    expect(
      reproductionContract.parse({ reproduced: false, blockedReason: "Nothing assertable", confidence: 0.2 }),
    ).toMatchObject({ reproduced: false, testPath: "", explanation: "Nothing assertable" });
    expect(reproductionContract.parse({ ...report, reproduced: false, testPath: null })).toMatchObject({
      testPath: "",
    });
  });
});
