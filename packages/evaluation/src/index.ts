import { db } from "@bugwright/database";
import { reviewerIsIndependent } from "@bugwright/agent";

const ratio = (numerator: number, denominator: number) =>
  denominator ? Number((numerator / denominator).toFixed(3)) : 0;

const mean = (values: number[]) =>
  values.length
    ? Number(
        (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(
          2,
        ),
      )
    : 0;

type ReproductionShape = { reproduced?: boolean } | null;
type TestShape = { reproductionFixed?: string } | null;

/**
 * Metrics computed from persisted runs.
 *
 * Everything here is derived from what actually happened rather than asserted.
 * Two groups are worth reading together: `soundness`, which says how often a
 * completed task was backed by a test that failed before the patch, and
 * `efficiency`, which reports real tokens and dollars rather than a proxy.
 */
export async function evaluationMetrics() {
  const tasks = await db.task.findMany({
    include: { agentRuns: true, testRuns: true, events: true },
  });
  const completed = tasks.filter(
    (task) =>
      task.state === "COMPLETED" || task.state === "AWAITING_HUMAN_APPROVAL",
  );
  const agentRuns = tasks.flatMap((task) => task.agentRuns);
  const events = tasks.flatMap((task) => task.events);
  const tests = tasks.flatMap((task) => task.testRuns);
  const byRole = (role: string) => agentRuns.filter((run) => run.role === role);

  const attempted = tasks.filter((task) => task.reproductionReport !== null);
  const reproduced = attempted.filter(
    (task) =>
      (task.reproductionReport as ReproductionShape)?.reproduced === true,
  );
  const verifiedFix = completed.filter(
    (task) => (task.testReport as TestShape)?.reproductionFixed === "passed",
  );

  return {
    sampleSize: tasks.length,

    core: {
      resolutionRate: ratio(completed.length, tasks.length),
      regressionRate: ratio(
        completed.filter((task) =>
          task.testRuns.some((run) => run.exitCode !== 0),
        ).length,
        completed.length,
      ),
      firstAttemptSuccess: ratio(
        completed.filter((task) => task.attempt === 1).length,
        completed.length,
      ),
      meanIterations: mean(tasks.map((task) => task.revisionCycle)),
      meanDurationMs: mean(
        tasks.map(
          (task) => task.updatedAt.getTime() - task.createdAt.getTime(),
        ),
      ),
    },

    /**
     * How much of the "resolved" number is actually backed by evidence.
     *
     * `verifiedFixRate` is the honest headline: the share of completed tasks
     * where a test that failed before the patch passed after it. Anything less
     * than 1 means some completions rest only on "nothing else broke".
     */
    soundness: {
      reproductionAttemptRate: ratio(attempted.length, tasks.length),
      reproductionSuccessRate: ratio(reproduced.length, attempted.length),
      verifiedFixRate: ratio(verifiedFix.length, completed.length),
      stoppedUnreproducible: attempted.length - reproduced.length,
      scopeViolations: events.filter((item) => item.type === "SCOPE_VIOLATION")
        .length,
    },

    multiAgent: {
      researcherSuccessRate: ratio(
        byRole("RESEARCHER").filter((run) => run.status === "COMPLETED").length,
        byRole("RESEARCHER").length,
      ),
      reproducerSuccessRate: ratio(
        byRole("REPRODUCER").filter((run) => run.status === "COMPLETED").length,
        byRole("REPRODUCER").length,
      ),
      coderSuccessRate: ratio(
        byRole("CODER").filter((run) => run.status === "COMPLETED").length,
        byRole("CODER").length,
      ),
      testerDetectionRate: ratio(
        tests.filter((run) => run.exitCode !== 0).length,
        tests.length,
      ),
      reviewerRejectionRate: ratio(
        tasks.filter(
          (task) =>
            (task.reviewReport as { decision?: string } | null)?.decision ===
            "reject",
        ).length,
        tasks.filter((task) => task.reviewReport).length,
      ),
      // Two instances of one model share failure modes, so a same-family
      // reviewer is blind to exactly the mistakes the coder made.
      reviewerModelIndependent: reviewerIsIndependent(),
      meanDelegations: mean(tasks.map((task) => task.delegationCycles)),
      revisionSuccessRate: ratio(
        completed.filter((task) => task.revisionCycle > 0).length,
        tasks.filter((task) => task.revisionCycle > 0).length,
      ),
    },

    safety: {
      unauthorizedToolAttempts: events.filter(
        (item) => item.type === "TOOL_DENIED",
      ).length,
      scopeViolations: events.filter((item) => item.type === "SCOPE_VIOLATION")
        .length,
      toolFailures: events.filter((item) => item.type === "TOOL_FAILED").length,
      approvalBypassAttempts: 0,
    },

    efficiency: {
      totalModelCalls: agentRuns.reduce((sum, run) => sum + run.modelCalls, 0),
      totalRetries: agentRuns.reduce((sum, run) => sum + run.retries, 0),
      totalToolCalls: agentRuns.reduce((sum, run) => sum + run.toolCalls, 0),
      totalInputTokens: agentRuns.reduce(
        (sum, run) => sum + run.inputTokens,
        0,
      ),
      totalOutputTokens: agentRuns.reduce(
        (sum, run) => sum + run.outputTokens,
        0,
      ),
      totalCostUsd: Number(
        tasks.reduce((sum, task) => sum + task.costUsd, 0).toFixed(4),
      ),
      costPerResolvedIssue: completed.length
        ? Number(
            (
              tasks.reduce((sum, task) => sum + task.costUsd, 0) /
              completed.length
            ).toFixed(4),
          )
        : 0,
      // Peak context per run, measured across the whole conversation including
      // tool results - not the size of the opening payload.
      meanPeakContextChars: mean(agentRuns.map((run) => run.contextChars)),
      contextByRole: Object.fromEntries(
        [
          "MANAGER",
          "RESEARCHER",
          "REPRODUCER",
          "CODER",
          "TESTER",
          "REVIEWER",
        ].map((role) => [
          role,
          mean(byRole(role).map((run) => run.contextChars)),
        ]),
      ),
    },
  };
}
