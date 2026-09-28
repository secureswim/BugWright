import { tagContent, summarizeForManager, quarantineData } from "./quarantine.js";
import {
  AttemptRecord,
  PatchProposal,
  ReproductionReport,
  ResearchReport,
  ResearchTask,
  ReviewReport,
  TestReport,
} from "@bugwright/shared";

/**
 * What each role is allowed to see.
 *
 * Contexts are constructed rather than inherited: no agent receives another
 * agent's hidden reasoning or model history, only the validated report fields
 * its job needs. The Reviewer's context in particular is assembled from the
 * issue, research, diff and test evidence in a fresh conversation, which is
 * what stops the Coder from reviewing its own work.
 */

export const researchContext = (issue: unknown, task: ResearchTask) => ({
  issue: wrapIssue(issue),
  researchTask: task,
});

export const reproducerContext = (
  issue: unknown,
  reports: ResearchReport[],
  /** Read from the project's test config and existing tests, not guessed. */
  testConventions?: unknown,
) => ({
  issue: wrapIssue(issue),
  researchReports: reports,
  testConventions:
    testConventions === undefined ? null : quarantineData(testConventions, "repository.test_config"),
  constraints: {
    writeTestsOnly: true,
    mustFailBeforeFix: true,
    noSourceEdits: true,
    noExecution: true,
  },
});

export const coderContext = (
  issue: unknown,
  researchReports: ResearchReport[],
  options: {
    reproduction?: ReproductionReport | null;
    revisionEvidence?: TestReport | ReviewReport;
    /** Every previous attempt, so the Coder does not repeat a failed approach. */
    attempts?: AttemptRecord[];
  } = {},
) => ({
  issue: wrapIssue(issue),
  researchReports,
  reproduction: quarantineReproduction(options.reproduction),
  revisionEvidence: options.revisionEvidence
    ? quarantineData(options.revisionEvidence, "verification_evidence")
    : null,
  previousAttempts: options.attempts ?? [],
  codingConstraints: {
    minimalPatch: true,
    noExecution: true,
    noPublishing: true,
    stayWithinResearchedFiles: true,
    doNotEditTheReproductionTest: true,
  },
});

export const testerContext = (issue: unknown, patch: PatchProposal, diff: string) => ({
  issue: wrapIssue(issue),
  codeChangeSummary: patch,
  currentDiff: quarantineData(diff.slice(0, 50_000), "git.diff"),
});

export const reviewerContext = (
  issue: unknown,
  researchReports: ResearchReport[],
  diff: string,
  tests: TestReport,
  reproduction?: ReproductionReport | null,
) => ({
  originalIssue: wrapIssue(issue),
  researchReports,
  currentDiff: quarantineData(diff, "git.diff"),
  testReport: quarantineData(tests, "runner.test_report"),
  reproduction: quarantineReproduction(reproduction),
});

export function wrapIssue(issue: unknown) {
  if (!issue || typeof issue !== "object") return quarantineData(issue, "issue");
  return Object.fromEntries(
    Object.entries(issue).map(([key, value]) => [
      key,
      typeof value === "string" || (value !== null && typeof value === "object")
        ? quarantineData(value, `issue_${key}`)
        : value,
    ]),
  );
}

function quarantineReproduction(report?: ReproductionReport | null) {
  return report
    ? {
        ...report,
        ...(report.failureOutput
          ? { failureOutput: quarantineData(report.failureOutput, "runner.reproduction_before") }
          : {}),
      }
    : null;
}

export function managerPlanContext(issue: unknown) {
  const value = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
  return {
    issue: Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key + "Summary",
        summarizeForManager(
          tagContent(
            typeof item === "string" ? item : (JSON.stringify(item) ?? ""),
            "untrusted",
            `issue_${key}`,
          ),
        ),
      ]),
    ),
  };
}
