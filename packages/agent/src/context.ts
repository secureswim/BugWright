import{PatchProposal,ResearchReport,ResearchTask,ReviewReport,TestReport}from"@bugpilot/shared";
export const researchContext=(issue:unknown,task:ResearchTask)=>({issue,researchTask:task});
export const coderContext=(issue:unknown,researchReports:ResearchReport[],revisionEvidence?:TestReport|ReviewReport)=>({issue,researchReports,revisionEvidence:revisionEvidence??null,codingConstraints:{minimalPatch:true,noExecution:true,noPublishing:true}});
export const testerContext=(issue:unknown,patch:PatchProposal,diff:string)=>({issue,codeChangeSummary:patch,currentDiff:diff.slice(0,50000)});
export const reviewerContext=(issue:unknown,researchReports:ResearchReport[],diff:string,tests:TestReport)=>({originalIssue:issue,researchReports,currentDiff:diff,testReport:tests});
