/**
 * Distinguishing "the test failed" from "no test ran".
 *
 * Both exit non-zero, and conflating them is dangerous in a pipeline whose
 * central claim is that a patch is verified by a test that failed before it:
 *
 *  - Before the patch, a runner error looks like a successful reproduction, so
 *    the system believes it proved a bug it never executed.
 *  - After the patch, the same error looks like the bug is still present, so
 *    the Coder is sent to revise a change that was already correct.
 *
 * A non-zero exit is therefore only treated as a real test failure when the
 * runner actually collected something to run.
 */

/** Signals that a runner started, found nothing to execute, and gave up. */
const NO_TESTS_PATTERNS: RegExp[] = [
  /No test files found/i, // vitest
  /No tests found/i, // jest
  /no tests ran/i, // pytest
  /collected 0 items/i, // pytest
  /ERROR: file or directory not found/i, // pytest, bad path
  /Could not find any test files/i, // node --test
  /^tests 0$/im, // node --test summary
  /Pattern:.*- 0 matches/i, // jest pattern miss
];

export function detectNoTestsCollected(output: string): boolean {
  if (!output.trim()) return false;
  return NO_TESTS_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * Rewrites a repository-relative path as project-relative.
 *
 * Paths reach the runner relative to the repository root (`git diff` and the
 * Reproducer both speak that language), but commands execute with the working
 * directory set to the project. Passing an unrewritten path to a test runner
 * makes it look for `frontend/src/x.test.tsx` inside `/workspace/frontend`,
 * which silently collects nothing.
 *
 * A path that is already project-relative is returned unchanged, so the
 * conversion is safe to apply twice.
 */
export function relativeToProject(projectPath: string, file: string): string {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (projectPath === "." || !projectPath) return normalized;
  const prefix = `${projectPath}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}
