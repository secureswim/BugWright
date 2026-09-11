import {
  ManagerDecision,
  ReproductionReport,
  ReviewReport,
  ScopeVerdict,
  TestReport,
} from "@bugwright/shared";

/**
 * Routing rules the model may advise on but never override.
 *
 * The Manager can propose a next step; these functions decide it. Everything
 * safety-relevant is therefore a property of ordinary code with tests, not of a
 * prompt: passing tests always reach review, reviewer approval always reaches
 * the human gate, a rejection can never become an approval, and an exhausted
 * budget always stops.
 */

export interface Limits {
  revisionCycle: number;
  maxRevisions: number;
}

const stop = (reason: string): ManagerDecision => ({ next: "NEEDS_ATTENTION", reason });

/**
 * What actually failed, appended to a stop reason.
 *
 * "The configured revision limit was reached" is true and useless: it says a
 * counter ran out without saying what the counter was counting. A run that
 * stopped for a knowable reason should say the reason.
 */
function evidence(report: TestReport): string {
  const parts: string[] = [];
  if (report.reproductionFixed === "failed") parts.push("the reproduction test still fails");
  if (report.regression === "failed") parts.push("the existing suite fails");
  if (report.typecheck === "failed") parts.push("type checking fails");
  if (report.lint === "failed") parts.push("lint fails on a changed file");
  for (const failure of report.failures.slice(0, 3)) {
    parts.push(`${failure.command}: ${failure.message}`);
  }
  if (!parts.length) parts.push(report.summary);
  return ` Last run: ${parts.join("; ")}.`;
}

/* -------------------------------------------------------------------------- */
/* After reproduction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A bug that cannot be reproduced is not a bug BugWright should try to fix.
 *
 * Stopping here is a correct outcome, not a failure: without a test that fails
 * before the patch there is no way to demonstrate afterwards that anything was
 * fixed, and a "fix" with no oracle is a guess.
 */
export function routeAfterReproduction(report: ReproductionReport): ManagerDecision {
  if (report.reproduced) {
    return { next: "CODER", reason: `Reproduced by ${report.testPath}; implementation can be verified.` };
  }
  return stop(
    report.blockedReason ??
      "The issue could not be reproduced by a failing test, so a fix could not be verified.",
  );
}

/* -------------------------------------------------------------------------- */
/* After the deterministic scope guard                                         */
/* -------------------------------------------------------------------------- */

/**
 * Rejects a patch that wandered outside the files research identified.
 *
 * This is ordinary code rather than a model call on purpose - it is free,
 * instant, and cannot be argued with by the agent whose work it is checking.
 */
export function routeAfterScopeCheck(verdict: ScopeVerdict, limits: Limits): ManagerDecision {
  if (verdict.withinScope) {
    return { next: "TESTER", reason: "Patch stays within the researched surface." };
  }
  if (limits.revisionCycle >= limits.maxRevisions) {
    return stop(`Patch touched unrelated files at the revision limit: ${verdict.unrelatedFiles.join(", ")}`);
  }
  return {
    next: "CODER",
    reason: `Patch touched files no research identified: ${verdict.unrelatedFiles.join(", ")}. Revert them.`,
  };
}

/* -------------------------------------------------------------------------- */
/* After testing                                                               */
/* -------------------------------------------------------------------------- */

export function routeAfterTest(
  report: TestReport,
  requested: ManagerDecision | undefined,
  revisionCycle: number,
  maxRevisions: number,
): ManagerDecision {
  // A patch is only accepted when the reproduction test that failed before it
  // now passes. A green regression suite alone is not evidence of a fix.
  if (report.passed && report.reproductionFixed === "failed") {
    return revisionCycle >= maxRevisions
      ? stop(
          `Nothing regressed, but the reproduction test still fails: the bug is not fixed.${evidence(report)}`,
        )
      : {
          next: "CODER",
          reason: "The regression suite is green but the reproduction test still fails.",
        };
  }

  if (report.reproductionFixed !== "passed" && report.reproductionFixed !== "failed") {
    return stop("The reproduction test has no explicit passing result; fresh verification is required.");
  }
  if (report.passed && report.reproductionFixed === "passed") {
    return { next: "REVIEWER", reason: "All selected empirical checks passed." };
  }

  if (report.suggestedNextAction === "NEEDS_ATTENTION") {
    return stop(report.summary);
  }

  if (revisionCycle >= maxRevisions) {
    return stop(`The configured revision limit was reached without a green run.${evidence(report)}`);
  }

  // The Manager may advise research over another code revision, but only within
  // the set of actions that are valid here.
  if (requested?.next === "RESEARCHER" || requested?.next === "CODER") return requested;

  return {
    next: report.suggestedNextAction ?? "CODER",
    reason: "A failed check requires a scoped investigation or code revision.",
  };
}

/* -------------------------------------------------------------------------- */
/* After review                                                                */
/* -------------------------------------------------------------------------- */

export function routeAfterReview(
  report: ReviewReport,
  requested: ManagerDecision | undefined,
  revisionCycle: number,
  maxRevisions: number,
): ManagerDecision {
  if (report.decision === "approve") {
    return { next: "HUMAN_APPROVAL", reason: "Independent technical review approved the tested patch." };
  }
  if (revisionCycle >= maxRevisions) {
    return stop("Reviewer rejected the patch at the revision limit.");
  }
  if (requested?.next === "RESEARCHER" || requested?.next === "CODER") return requested;
  return { next: "CODER", reason: "Reviewer findings require a code revision." };
}

/* -------------------------------------------------------------------------- */
/* Invariants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * States from which publishing may be reached. Publishing itself additionally
 * requires a persisted approval whose hash matches the current artifact; this
 * list is the state-machine half of that guarantee.
 */
export const PUBLISHABLE_FROM = new Set(["AWAITING_HUMAN_APPROVAL", "PUBLISHING"]);

export const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "REJECTED", "NEEDS_ATTENTION"]);

/** True when a decision hands control to a human rather than to another agent. */
export const isHumanGate = (decision: ManagerDecision): boolean => decision.next === "HUMAN_APPROVAL";
