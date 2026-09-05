import {
  AttemptRecord,
  PatchProposal,
  ReproductionReport,
  ResearchReport,
  ResearchTask,
  ReviewReport,
  TestReport,
} from "@bugpilot/shared";

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
  issue,
  researchTask: task,
});

export const reproducerContext = (issue: unknown, reports: ResearchReport[]) => ({
  issue,
  researchReports: reports,
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
  issue,
  researchReports,
  reproduction: options.reproduction ?? null,
  revisionEvidence: options.revisionEvidence ?? null,
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
  issue,
  codeChangeSummary: patch,
  currentDiff: diff.slice(0, 50_000),
});

export const reviewerContext = (
  issue: unknown,
  researchReports: ResearchReport[],
  diff: string,
  tests: TestReport,
  reproduction?: ReproductionReport | null,
) => ({
  originalIssue: issue,
  researchReports,
  currentDiff: diff,
  testReport: tests,
  reproduction: reproduction ?? null,
});
