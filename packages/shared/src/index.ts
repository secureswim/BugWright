import { z } from "zod";

export const createTaskSchema = z.object({
  repositoryUrl: z
    .string()
    .url()
    .refine(
      (url) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(url),
      "Use a public GitHub repository URL",
    ),
  issueNumber: z.coerce.number().int().positive(),
  issueTitle: z.string().min(3).max(240).optional(),
  issueBody: z.string().max(20_000).optional(),
  baseBranch: z
    .string()
    .regex(/^[\w./-]+$/)
    .default("main"),
  demoMode: z.boolean().default(false),
  executionMode: z.enum(["MULTI_AGENT", "SINGLE_AGENT"]).default("MULTI_AGENT"),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const taskStates = [
  "QUEUED",
  "PREPARING",
  "RESEARCHING",
  "PLANNING",
  "REPRODUCING",
  "CODING",
  "TESTING",
  "RE_RESEARCHING",
  "RE_CODING",
  "REVIEWING",
  "REVISION_REQUESTED",
  "AWAITING_HUMAN_APPROVAL",
  "PUBLISHING",
  "COMPLETED",
  "NEEDS_ATTENTION",
  "FAILED",
  "REJECTED",
] as const;
export type TaskState = (typeof taskStates)[number];

export const agentRoles = ["MANAGER", "RESEARCHER", "REPRODUCER", "CODER", "TESTER", "REVIEWER"] as const;
export type AgentRole = (typeof agentRoles)[number];

export type ResearchTaskType = "implementation" | "tests" | "history";
export interface ResearchTask {
  type: ResearchTaskType;
  objective: string;
}

export type Evidence = { path: string; line?: number; observation: string };

export interface ResearchReport {
  taskType?: ResearchTaskType;
  objective?: string;
  diagnosis: string;
  evidence: Evidence[];
  relevantFiles: string[];
  relevantTests: string[];
  proposedApproach: string;
  risks: string[];
  confidence: number;
}

/**
 * The Reproducer's output: a test that captures the reported bug.
 *
 * `reproduced` is only true once the test has been *observed to fail* against
 * the unpatched code. A test that passes before the fix proves the diagnosis
 * was wrong, which is a useful result rather than a failure to hide.
 */
export interface ReproductionReport {
  /** True only when the new test was executed and failed on the unpatched code. */
  reproduced: boolean;
  /** Repository-relative path of the test that was written. */
  testPath: string;
  /** What the test asserts, and why that captures the reported behaviour. */
  explanation: string;
  /** Observed failure output from the pre-patch run, as evidence. */
  failureOutput?: string;
  /** Why reproduction was not possible, when `reproduced` is false. */
  blockedReason?: string;
  confidence: number;
}

export interface PatchProposal {
  summary: string;
  filesChanged: string[];
  rationale: string;
  riskNotes: string[];
}

export interface TestFailure {
  command: string;
  message: string;
  relevantOutput: string;
  category?: "code" | "infrastructure" | "pre-existing";
}

/** Outcome of a check the project may or may not define. */
export type CheckStatus = "passed" | "failed" | "not-configured" | "not-run";

/**
 * The two questions a Tester answers, kept separate on purpose.
 *
 * `reproductionFixed` answers "is the reported bug actually fixed?" and can
 * only be answered by a test that failed before the patch. `regression`
 * answers "did anything else break?".
 *
 * Collapsing these into one boolean is what made the old pipeline unsound off
 * its own fixture: on a real repository the existing suite passes before the
 * patch and after it, so a green run said nothing at all about the fix.
 */
export interface TestReport {
  passed: boolean;
  reproductionFixed: CheckStatus;
  regression: CheckStatus;
  typecheck: CheckStatus;
  lint: CheckStatus;
  testsRun: string[];
  failures: TestFailure[];
  /** Checks the project does not define, so they were skipped rather than failed. */
  notConfigured: string[];
  summary: string;
  suggestedNextAction?: "RESEARCHER" | "CODER" | "NEEDS_ATTENTION";
}

export interface Finding {
  severity: "info" | "warning" | "blocking";
  title: string;
  evidence: string;
}

export interface ReviewReport {
  decision: "approve" | "reject";
  findings: Finding[];
  scopeAssessment: "minimal" | "acceptable" | "too-broad";
  regressionRisk: "low" | "medium" | "high";
  reasoning: string;
}

export interface ManagerPlan {
  objective: string;
  researchTasks: ResearchTask[];
  steps: Array<{ role: AgentRole; goal: string }>;
  risks: string[];
}

export interface ManagerDecision {
  next: "RESEARCHER" | "REPRODUCER" | "CODER" | "TESTER" | "REVIEWER" | "HUMAN_APPROVAL" | "NEEDS_ATTENTION";
  reason: string;
  targetAgent?: AgentRole;
  inputArtifactIds?: string[];
  iterationNumber?: number;
}

export interface AgentMessage<T = unknown> {
  taskId: string;
  from: AgentRole;
  to: AgentRole;
  type: string;
  payload: T;
  timestamp: string;
  iteration: number;
}

/**
 * One prior attempt at fixing the issue.
 *
 * The Coder receives the whole list, not just the most recent evidence. Given
 * only the latest failure it re-proposes approaches it already tried and that
 * already failed - the standard revision-loop failure.
 */
export interface AttemptRecord {
  revision: number;
  summary: string;
  filesChanged: string[];
  outcome: "tests-failed" | "review-rejected";
  evidence: string;
}

/** Result of the deterministic check that a patch stayed within researched scope. */
export interface ScopeVerdict {
  withinScope: boolean;
  changedFiles: string[];
  /** Changed files no research report identified as relevant. */
  unrelatedFiles: string[];
  reason: string;
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

export const researchReportSchema = z.object({
  taskType: z.enum(["implementation", "tests", "history"]).optional(),
  objective: z.string().optional(),
  diagnosis: z.string(),
  evidence: z.array(z.object({ path: z.string(), line: z.number().optional(), observation: z.string() })),
  relevantFiles: z.array(z.string()),
  relevantTests: z.array(z.string()),
  proposedApproach: z.string(),
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export const reproductionReportSchema = z.object({
  reproduced: z.boolean(),
  testPath: z.string(),
  explanation: z.string(),
  failureOutput: z.string().optional(),
  blockedReason: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export const managerPlanSchema = z.object({
  objective: z.string(),
  researchTasks: z
    .array(z.object({ type: z.enum(["implementation", "tests", "history"]), objective: z.string() }))
    .min(1)
    .max(3),
  steps: z.array(z.object({ role: z.enum(agentRoles), goal: z.string() })),
  risks: z.array(z.string()),
});

export const managerDecisionSchema = z.object({
  next: z.enum([
    "RESEARCHER",
    "REPRODUCER",
    "CODER",
    "TESTER",
    "REVIEWER",
    "HUMAN_APPROVAL",
    "NEEDS_ATTENTION",
  ]),
  reason: z.string(),
  targetAgent: z.enum(agentRoles).optional(),
  inputArtifactIds: z.array(z.string()).optional(),
  iterationNumber: z.number().int().optional(),
});

export const patchProposalSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()),
  rationale: z.string(),
  riskNotes: z.array(z.string()),
});

export const reviewReportSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  findings: z.array(
    z.object({
      severity: z.enum(["info", "warning", "blocking"]),
      title: z.string(),
      evidence: z.string(),
    }),
  ),
  scopeAssessment: z.enum(["minimal", "acceptable", "too-broad"]),
  regressionRisk: z.enum(["low", "medium", "high"]),
  reasoning: z.string(),
});

export type AgentEventPayload = {
  type: string;
  title: string;
  detail?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
};
