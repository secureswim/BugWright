export type ResumeCheckpoint =
  "QUEUED" | "RESEARCHING" | "CODING" | "TESTING" | "REVIEWING" | "AWAITING_HUMAN_APPROVAL";

type CheckpointTask = {
  managerPlan: unknown;
  researchReport: unknown;
  patchProposal: unknown;
  testReport: unknown;
  reviewReport: unknown;
  diff: string | null;
  approvalHash: string | null;
};

export function resumeCheckpoint(task: CheckpointTask): ResumeCheckpoint {
  const testReport = task.testReport as { passed?: boolean } | null;
  const reviewReport = task.reviewReport as { decision?: string } | null;
  if (reviewReport?.decision === "approve" && testReport?.passed && task.diff && task.approvalHash)
    return "AWAITING_HUMAN_APPROVAL";
  if (testReport?.passed && task.patchProposal && task.diff) return "REVIEWING";
  if (task.patchProposal && task.diff) return "TESTING";
  if (task.researchReport) return "CODING";
  if (task.managerPlan) return "RESEARCHING";
  return "QUEUED";
}
