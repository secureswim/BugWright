import { describe, expect, it } from "vitest";
import { approvalHash, assertEditable, assertToolAllowed, resolveInside } from "./index.js";

describe("policy", () => {
  it("rejects workspace escapes and secrets", () => {
    expect(() => resolveInside("C:/tasks/a", "../b")).toThrow();
    expect(() => assertEditable(".env.local")).toThrow();
  });
  it("enforces least-privilege role capabilities", () => {
    expect(() => assertToolAllowed("RESEARCHER", "repository", "apply_patch")).toThrow();
    expect(() => assertToolAllowed("CODER", "runner", "run_test")).toThrow();
    expect(assertToolAllowed("REVIEWER", "git", "get_diff")).toBe("git.get_diff");
    expect(() => assertToolAllowed("MANAGER", "repository", "read_file")).toThrow();
  });
  it("binds approvals to the reviewed diff", () => {
    const input = {
      taskId: "1",
      repository: "r",
      targetBranch: "main",
      baseCommit: "a",
      diff: "x",
      tests: [],
    };
    expect(approvalHash(input)).not.toBe(approvalHash({ ...input, diff: "y" }));
  });
});
