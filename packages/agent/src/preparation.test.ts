import { describe, expect, it } from "vitest";
import { cloneArguments, pinnedCommit } from "./preparation.js";
describe("immutable benchmark preparation", () => {
  it("clones a branch for ordinary tasks", () => {
    expect(cloneArguments("https://github.com/owner/repo", "main", "/repo")).toContain("--branch");
  });
  it("avoids treating a benchmark SHA as a branch name", () => {
    const commit = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    expect(pinnedCommit(commit)).toBe(commit.toLowerCase());
    const args = cloneArguments("https://github.com/owner/repo", "main", "/repo", commit);
    expect(args).not.toContain("--branch");
    expect(args.slice(-3)).toEqual(["--", "https://github.com/owner/repo", "/repo"]);
  });
  it("rejects malformed or option-shaped commit inputs", () => {
    expect(() => pinnedCommit("--upload-pack=evil")).toThrow("full Git SHA");
    expect(() => pinnedCommit("main")).toThrow("full Git SHA");
  });
});
