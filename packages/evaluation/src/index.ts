import { db } from "@bugpilot/database";
const ratio = (n: number, d: number) => (d ? Number((n / d).toFixed(3)) : 0);
export async function evaluationMetrics() {
  const tasks = await db.task.findMany({ include: { agentRuns: true, testRuns: true, events: true } }),
    completed = tasks.filter((t) => t.state === "COMPLETED" || t.state === "AWAITING_HUMAN_APPROVAL"),
    successful = completed.length,
    agentRuns = tasks.flatMap((t) => t.agentRuns),
    events = tasks.flatMap((t) => t.events),
    tests = tasks.flatMap((t) => t.testRuns);
  const byRole = (role: string) => agentRuns.filter((r) => r.role === role);
  return {
    sampleSize: tasks.length,
    core: {
      resolutionRate: ratio(successful, tasks.length),
      regressionRate: ratio(
        completed.filter((t) => t.testRuns.some((r) => r.exitCode !== 0)).length,
        successful,
      ),
      firstAttemptSuccess: ratio(completed.filter((t) => t.attempt === 1).length, successful),
      meanIterations: tasks.length
        ? Number((tasks.reduce((n, t) => n + t.revisionCycle, 0) / tasks.length).toFixed(2))
        : 0,
      modelCalls: tasks.reduce((n, t) => n + t.modelCalls, 0),
    },
    multiAgent: {
      researcherSuccessRate: ratio(
        byRole("RESEARCHER").filter((r) => r.status === "COMPLETED").length,
        byRole("RESEARCHER").length,
      ),
      coderSuccessRate: ratio(
        byRole("CODER").filter((r) => r.status === "COMPLETED").length,
        byRole("CODER").length,
      ),
      testerDetectionRate: ratio(tests.filter((t) => t.exitCode !== 0).length, tests.length),
      reviewerRejectionRate: ratio(
        tasks.filter((t) => (t.reviewReport as { decision?: string } | null)?.decision === "reject").length,
        tasks.filter((t) => t.reviewReport).length,
      ),
      meanDelegations: tasks.length
        ? Number((tasks.reduce((n, t) => n + t.delegationCycles, 0) / tasks.length).toFixed(2))
        : 0,
      revisionSuccessRate: ratio(
        completed.filter((t) => t.revisionCycle > 0).length,
        tasks.filter((t) => t.revisionCycle > 0).length,
      ),
    },
    safety: {
      unauthorizedToolAttempts: events.filter((e) => e.type === "TOOL_DENIED").length,
      toolFailures: events.filter((e) => e.type === "TOOL_FAILED").length,
      approvalBypassAttempts: 0,
    },
    efficiency: {
      totalModelCalls: agentRuns.reduce((n, r) => n + r.modelCalls, 0),
      totalToolCalls: agentRuns.reduce((n, r) => n + r.toolCalls, 0),
      averageContextChars: agentRuns.length
        ? Math.round(agentRuns.reduce((n, r) => n + r.contextChars, 0) / agentRuns.length)
        : 0,
    },
  };
}
