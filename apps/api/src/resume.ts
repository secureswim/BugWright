export type ResumeCheckpoint =
  "QUEUED" | "RESEARCHING" | "REPRODUCING" | "CODING" | "TESTING" | "REVIEWING" | "AWAITING_HUMAN_APPROVAL";

type CheckpointTask = {
  managerPlan: unknown;
  researchReport: unknown;
  reproductionReport: unknown;
  patchProposal: unknown;
  testReport: unknown;
  reviewReport: unknown;
  diff: string | null;
  approvalHash: string | null;
};

/**
 * The latest stage whose output is persisted and still valid.
 *
 * Resuming from here re-runs only what is missing rather than repeating
 * completed model work and test runs. Ordered most-advanced first, and each
 * branch demands the *whole* artifact set that stage produces - a patch with
 * no diff is not a completed coding stage.
 */
export function resumeCheckpoint(task: CheckpointTask): ResumeCheckpoint {
  const testReport = task.testReport as {
    passed?: boolean;
    reproductionFixed?: string;
  } | null;
  const reviewReport = task.reviewReport as { decision?: string } | null;
  const reproduction = task.reproductionReport as {
    reproduced?: boolean;
  } | null;

  // A test run only counts as verified when it also showed the bug was fixed.
  const verified = Boolean(testReport?.passed === true && testReport.reproductionFixed === "passed");

  if (reviewReport?.decision === "approve" && verified && task.diff && task.approvalHash) {
    return "AWAITING_HUMAN_APPROVAL";
  }
  if (verified && task.patchProposal && task.diff) return "REVIEWING";
  if (task.patchProposal && task.diff) return "TESTING";
  // Coding cannot start until a failing test exists to verify the fix against.
  if (reproduction?.reproduced) return "CODING";
  if (task.researchReport) return "REPRODUCING";
  if (task.managerPlan) return "RESEARCHING";
  return "QUEUED";
}
