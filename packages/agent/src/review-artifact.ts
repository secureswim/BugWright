import { assertArtifactCurrent, artifactApprovalHash } from "@bugwright/policy";

/** Shared by both approval endpoints and the publisher. Old tasks without a
 * captured artifact fail closed instead of retaining their legacy approval. */
export async function validateReviewPackage(task: {
  id: string;
  repositoryUrl: string;
  baseBranch: string;
  baseCommit: string | null;
  workspacePath: string | null;
  reviewArtifact: unknown;
  testReport: unknown;
  reviewReport: unknown;
  approvalHash: string | null;
  diff: string | null;
  testRuns: Parameters<typeof artifactApprovalHash>[0]["tests"];
}) {
  if (!task.workspacePath) throw new Error("Workspace is unavailable");
  const artifact = await assertArtifactCurrent(task.workspacePath, task.reviewArtifact);
  if (
    !artifact.files.length ||
    artifact.baseCommit !== task.baseCommit ||
    artifact.diff !== task.diff ||
    (task.reviewReport as { decision?: string } | null)?.decision !== "approve"
  ) {
    throw new Error("The reviewed artifact is incomplete or changed");
  }
  const hash = artifactApprovalHash({
    taskId: task.id,
    repository: task.repositoryUrl,
    targetBranch: task.baseBranch,
    artifact,
    report: task.testReport,
    tests: task.testRuns,
  });
  if (hash !== task.approvalHash) throw new Error("The approved artifact or evidence changed; verify again");
  return { artifact, hash };
}
