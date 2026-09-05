import { z } from "zod";

export const createTaskSchema = z.object({
  repositoryUrl: z.string().url().refine((url) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(url), "Use a public GitHub repository URL"),
  issueNumber: z.coerce.number().int().positive(),
  issueTitle: z.string().min(3).max(240).optional(),
  issueBody: z.string().max(20_000).optional(),
  baseBranch: z.string().regex(/^[\w./-]+$/).default("main"),
  demoMode: z.boolean().default(false),
  executionMode: z.enum(["MULTI_AGENT","SINGLE_AGENT"]).default("MULTI_AGENT")
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export const taskStates = ["QUEUED","PREPARING","RESEARCHING","PLANNING","CODING","TESTING","RE_RESEARCHING","RE_CODING","REVIEWING","REVISION_REQUESTED","AWAITING_HUMAN_APPROVAL","PUBLISHING","COMPLETED","NEEDS_ATTENTION","FAILED","REJECTED"] as const;
export type TaskState = typeof taskStates[number];

export const agentRoles = ["MANAGER","RESEARCHER","CODER","TESTER","REVIEWER"] as const;
export type AgentRole = typeof agentRoles[number];
export type ResearchTaskType="implementation"|"tests"|"history";
export interface ResearchTask { type:ResearchTaskType; objective:string }
export type Evidence = { path:string; line?:number; observation:string };
export interface ResearchReport { taskType?:ResearchTaskType; objective?:string; diagnosis:string; evidence:Evidence[]; relevantFiles:string[]; relevantTests:string[]; proposedApproach:string; risks:string[]; confidence:number }
export interface PatchProposal { summary:string; filesChanged:string[]; rationale:string; riskNotes:string[] }
export interface TestFailure { command:string; message:string; relevantOutput:string; category?:"code"|"infrastructure"|"pre-existing" }
export interface TestReport { passed:boolean; testsRun:string[]; failures:TestFailure[]; typecheckPassed?:boolean; lintPassed?:boolean; summary:string; suggestedNextAction?:"RESEARCHER"|"CODER"|"NEEDS_ATTENTION" }
export interface Finding { severity:"info"|"warning"|"blocking"; title:string; evidence:string }
export interface ReviewReport { decision:"approve"|"reject"; findings:Finding[]; scopeAssessment:"minimal"|"acceptable"|"too-broad"; regressionRisk:"low"|"medium"|"high"; reasoning:string }
export interface ManagerPlan { objective:string; researchTasks:ResearchTask[]; steps:Array<{role:AgentRole;goal:string}>; risks:string[] }
export interface ManagerDecision { next:"RESEARCHER"|"CODER"|"TESTER"|"REVIEWER"|"HUMAN_APPROVAL"|"NEEDS_ATTENTION"; reason:string; targetAgent?:AgentRole; inputArtifactIds?:string[]; iterationNumber?:number }
export interface AgentMessage<T=unknown> { taskId:string; from:AgentRole; to:AgentRole; type:string; payload:T; timestamp:string; iteration:number }

export const researchReportSchema=z.object({taskType:z.enum(["implementation","tests","history"]).optional(),objective:z.string().optional(),diagnosis:z.string(),evidence:z.array(z.object({path:z.string(),line:z.number().optional(),observation:z.string()})),relevantFiles:z.array(z.string()),relevantTests:z.array(z.string()),proposedApproach:z.string(),risks:z.array(z.string()),confidence:z.number().min(0).max(1)});
export const managerPlanSchema=z.object({objective:z.string(),researchTasks:z.array(z.object({type:z.enum(["implementation","tests","history"]),objective:z.string()})).min(1).max(3),steps:z.array(z.object({role:z.enum(agentRoles),goal:z.string()})),risks:z.array(z.string())});
export const managerDecisionSchema=z.object({next:z.enum(["RESEARCHER","CODER","TESTER","REVIEWER","HUMAN_APPROVAL","NEEDS_ATTENTION"]),reason:z.string(),targetAgent:z.enum(agentRoles).optional(),inputArtifactIds:z.array(z.string()).optional(),iterationNumber:z.number().int().optional()});
export const patchProposalSchema=z.object({summary:z.string(),filesChanged:z.array(z.string()),rationale:z.string(),riskNotes:z.array(z.string())});
export const reviewReportSchema=z.object({decision:z.enum(["approve","reject"]),findings:z.array(z.object({severity:z.enum(["info","warning","blocking"]),title:z.string(),evidence:z.string()})),scopeAssessment:z.enum(["minimal","acceptable","too-broad"]),regressionRisk:z.enum(["low","medium","high"]),reasoning:z.string()});

export type AgentEventPayload = {
  type: string;
  title: string;
  detail?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
};
