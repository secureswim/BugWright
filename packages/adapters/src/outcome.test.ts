import { describe, expect, it } from "vitest";
import { detectNoTestsCollected, relativeToProject } from "./outcome.js";

/**
 * These guard a production failure that cost a whole run.
 *
 * The Reproducer wrote `frontend/src/test/login.test.tsx` (repository-relative)
 * and the Tester ran `npm test -- frontend/src/test/login.test.tsx` with the
 * container working directory set to `/workspace/frontend`. vitest looked for
 * `frontend/frontend/src/...`, collected nothing, and exited non-zero.
 *
 * That non-zero exit was then read as "the test failed", which means:
 *   - before the patch it looked like a successful reproduction of a bug that
 *     had never actually been executed, and
 *   - after the patch it looked like the bug was still present, so the Coder
 *     was sent to revise a change that was already correct, until the revision
 *     limit stopped the run.
 */
describe("relativeToProject", () => {
  it("strips the project prefix from a repository-relative path", () => {
    expect(relativeToProject("frontend", "frontend/src/test/login.test.tsx")).toBe("src/test/login.test.tsx");
  });

  it("is idempotent, so applying it twice is safe", () => {
    const once = relativeToProject("frontend", "frontend/src/a.test.ts");
    expect(relativeToProject("frontend", once)).toBe("src/a.test.ts");
  });

  it("leaves a path alone at the repository root", () => {
    expect(relativeToProject(".", "test/a.test.js")).toBe("test/a.test.js");
  });

  it("handles nested project paths", () => {
    expect(relativeToProject("packages/api", "packages/api/src/x.test.ts")).toBe("src/x.test.ts");
  });

  it("normalises backslashes and a leading ./", () => {
    expect(relativeToProject("frontend", "./frontend\\src\\a.test.ts")).toBe("src/a.test.ts");
  });

  it("does not mangle a path that only shares a prefix substring", () => {
    expect(relativeToProject("front", "frontend/src/a.test.ts")).toBe("frontend/src/a.test.ts");
  });
});

describe("detectNoTestsCollected", () => {
  it.each([
    ["vitest", "No test files found, exiting with code 1"],
    ["jest", "No tests found, exiting with code 1"],
    ["pytest empty", "collected 0 items\n\n=========== no tests ran in 0.01s ==========="],
    ["pytest bad path", "ERROR: file or directory not found: tests/test_missing.py"],
    ["node --test", "Could not find any test files matching the pattern"],
  ])("recognises %s", (_label, output) => {
    expect(detectNoTestsCollected(output)).toBe(true);
  });

  it.each([
    ["a genuine assertion failure", "FAIL src/a.test.ts\n  expected true to be false\n1 failed"],
    ["a compile error", "SyntaxError: Unexpected token"],
    ["a passing run", "Test Files  1 passed (1)\n     Tests  3 passed (3)"],
  ])("does not misread %s as an empty run", (_label, output) => {
    expect(detectNoTestsCollected(output)).toBe(false);
  });

  it("returns false for empty output rather than guessing", () => {
    expect(detectNoTestsCollected("")).toBe(false);
    expect(detectNoTestsCollected("   \n ")).toBe(false);
  });

  it("does not treat a suite that ran and failed as uncollected", () => {
    // The dangerous confusion runs this way round: a real failure must never
    // be downgraded to "nothing ran", or a genuine bug would be dismissed.
    const output = "Test Files  1 failed (1)\n     Tests  1 failed (1)\n  AssertionError";
    expect(detectNoTestsCollected(output)).toBe(false);
  });
});
