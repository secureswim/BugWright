import { ResearchReport, ScopeVerdict } from "@bugpilot/shared";

/** Parses `git diff --name-status` output into repository-relative paths. */
export function changedFilesFromNameStatus(raw: string): string[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1)?.trim() ?? "")
    .filter(Boolean);
}

/** Parses `+++ b/<path>` headers out of a unified diff. */
export function changedFilesFromDiff(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
}

const isTestPath = (file: string) =>
  /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.py$/.test(
    file,
  );

/**
 * Checks that a patch only touched files the research implicated.
 *
 * Deterministic and free: no model call, no argument, no way for the agent that
 * wrote the patch to talk its way past it. This is what stops the Coder
 * "helpfully" fixing adjacent things it noticed on the way, which is the single
 * most annoying real-world agent behaviour and the one reviewers most often
 * reject a PR for.
 *
 * The reproduction test is always in scope: the Reproducer created it, and it
 * is the reason the patch can be verified at all.
 */
export function assessScope(
  changedFiles: string[],
  reports: ResearchReport[],
  options: { reproductionTestPath?: string } = {},
): ScopeVerdict {
  const allowed = new Set<string>();
  for (const report of reports) {
    for (const file of [...report.relevantFiles, ...report.relevantTests]) {
      allowed.add(file.replaceAll("\\", "/").replace(/^\.\//, ""));
    }
    for (const item of report.evidence) {
      allowed.add(item.path.replaceAll("\\", "/").replace(/^\.\//, ""));
    }
  }
  if (options.reproductionTestPath) allowed.add(options.reproductionTestPath);

  // With no research surface to compare against there is nothing to enforce;
  // failing open here is correct, because a false rejection costs a revision
  // cycle and teaches the Coder nothing.
  if (allowed.size === 0) {
    return {
      withinScope: true,
      changedFiles,
      unrelatedFiles: [],
      reason: "No research surface was recorded, so scope could not be constrained.",
    };
  }

  const unrelatedFiles = changedFiles.filter((file) => {
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
    if (allowed.has(normalized)) return false;
    // A test covering a file that is in scope is itself in scope.
    if (isTestPath(normalized)) return false;
    // Accept a research path recorded as a suffix (e.g. "calculator.js" for
    // "src/calculator.js"), which models produce often enough to matter.
    return ![...allowed].some(
      (candidate) => normalized.endsWith(`/${candidate}`) || candidate.endsWith(`/${normalized}`),
    );
  });

  return {
    withinScope: unrelatedFiles.length === 0,
    changedFiles,
    unrelatedFiles,
    reason: unrelatedFiles.length
      ? `${unrelatedFiles.length} changed file(s) were not identified by any research report.`
      : "Every changed file was identified by research.",
  };
}
