import { describe, expect, it } from "vitest";
import {
  detectNoTestsCollected,
  detectTransformError,
  implicatesAnyFile,
  relativeToProject,
} from "./outcome.js";

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

/**
 * A reproduction test containing JSX saved as `.ts` fails to parse identically
 * before and after the patch, which looks exactly like a bug that will not go
 * away - so the Coder revises a correct change until the revision limit stops
 * the run.
 */
describe("detectTransformError", () => {
  it.each([
    ["esbuild JSX in a .ts file", "Error: Transform failed with 1 error:\nsrc/test/login.test.ts:13:12"],
    ["a syntax error", "SyntaxError: Unexpected end of input"],
    ["an unresolved import", 'Error: Failed to resolve import "@/pages/Login" from src/test/a.test.tsx'],
    ["a missing module", "Cannot find module '@/context/AuthContext'"],
    ["a vite load failure", "Failed to load url /src/pages/Login (resolved id: ...)"],
  ])("recognises %s", (_label, output) => {
    expect(detectTransformError(output)).toBe(true);
  });

  it.each([
    ["an assertion failure", "AssertionError: expected null not to be null\n  1 failed"],
    ["a passing run", "Test Files  1 passed (1)"],
    ["an empty run", "No test files found"],
  ])("does not misread %s as a transform error", (_label, output) => {
    expect(detectTransformError(output)).toBe(false);
  });
});

/**
 * Many real repositories carry pre-existing lint or type errors. Treating those
 * as evidence about a patch blocks every patch forever, however correct it is -
 * and a script defined as `eslint .` ignores any files passed to it, so
 * scoping the command is a request rather than a guarantee.
 */
describe("implicatesAnyFile", () => {
  const eslintOutput = [
    "/workspace/frontend/src/components/ui/command.tsx",
    "  24:11  error  An interface declaring no members ...",
    "/workspace/frontend/src/pages/Reports.tsx",
    "  104:60  error  Unexpected any ...",
  ].join("\n");

  it("is true when the output names a changed file", () => {
    expect(implicatesAnyFile(eslintOutput, ["src/pages/Reports.tsx"])).toBe(true);
  });

  it("is false when every complaint is about untouched files", () => {
    expect(implicatesAnyFile(eslintOutput, ["src/pages/Login.tsx"])).toBe(false);
  });

  it("matches an absolute container path by its project-relative suffix", () => {
    expect(
      implicatesAnyFile("/workspace/frontend/src/pages/Login.tsx\n 1:1 error", ["src/pages/Login.tsx"]),
    ).toBe(true);
  });

  it("normalises backslashes in the output", () => {
    expect(implicatesAnyFile("C:\\work\\src\\pages\\Login.tsx error", ["src/pages/Login.tsx"])).toBe(true);
  });

  it("is false with nothing changed, rather than blaming the patch", () => {
    expect(implicatesAnyFile(eslintOutput, [])).toBe(false);
  });

  it("is false for empty output", () => {
    expect(implicatesAnyFile("", ["src/a.ts"])).toBe(false);
  });
});

/**
 * The failure this guards, verbatim from a real run.
 *
 * npm echoes the script it is about to run, and the scoping arguments are part
 * of that echo. Matching against it made every lint run claim it had failed on
 * a changed file, which sent the Coder to fix lint errors in files it had never
 * touched, four revisions in a row, until the run was stopped.
 */
describe("implicatesAnyFile ignores the package manager's command echo", () => {
  const realOutput = [
    "",
    "> vite_react_shadcn_ts@0.0.0 lint",
    "> eslint . src/pages/Login.tsx",
    "",
    "",
    "/workspace/frontend/src/components/ui/command.tsx",
    "  24:11  error  An interface declaring no members is equivalent to its supertype",
    "",
    "/workspace/frontend/src/pages/Reports.tsx",
    "  104:60   error  Unexpected any. Specify a different type",
    "",
    "/workspace/frontend/tailwind.config.ts",
    "  104:13  error  A `require()` style import is forbidden",
    "",
    "✖ 32 problems (24 errors, 8 warnings)",
  ].join("\n");

  it("does not treat the echoed command as a diagnostic", () => {
    expect(implicatesAnyFile(realOutput, ["src/pages/Login.tsx"])).toBe(false);
  });

  it("still sees a file that genuinely appears in the diagnostics", () => {
    expect(implicatesAnyFile(realOutput, ["src/pages/Reports.tsx"])).toBe(true);
  });

  it("ignores a yarn-style echo too", () => {
    const yarn = ["$ eslint . src/pages/Login.tsx", "", "src/pages/Other.tsx", "  1:1 error"].join("\n");
    expect(implicatesAnyFile(yarn, ["src/pages/Login.tsx"])).toBe(false);
    expect(implicatesAnyFile(yarn, ["src/pages/Other.tsx"])).toBe(true);
  });

  it("does not drop a diagnostic line that merely mentions >", () => {
    const output = "src/a.ts\n  3:1  error  Expected a > b comparison";
    expect(implicatesAnyFile(output, ["src/a.ts"])).toBe(true);
  });
});
