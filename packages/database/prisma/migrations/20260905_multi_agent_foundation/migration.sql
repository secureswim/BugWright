-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('QUEUED', 'PREPARING', 'RESEARCHING', 'PLANNING', 'CODING', 'TESTING', 'RE_RESEARCHING', 'RE_CODING', 'REVIEWING', 'REVISION_REQUESTED', 'AWAITING_HUMAN_APPROVAL', 'PUBLISHING', 'COMPLETED', 'NEEDS_ATTENTION', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "repositoryOwner" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "issueTitle" TEXT,
    "issueBody" TEXT,
    "baseBranch" TEXT NOT NULL DEFAULT 'main',
    "baseCommit" TEXT,
    "workspacePath" TEXT,
    "state" "TaskState" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "revisionCycle" INTEGER NOT NULL DEFAULT 0,
    "maxRevisions" INTEGER NOT NULL DEFAULT 2,
    "maxAgentRuns" INTEGER NOT NULL DEFAULT 16,
    "maxModelCalls" INTEGER NOT NULL DEFAULT 40,
    "timeoutMs" INTEGER NOT NULL DEFAULT 900000,
    "delegationCycles" INTEGER NOT NULL DEFAULT 0,
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "currentAgent" TEXT,
    "executionMode" TEXT NOT NULL DEFAULT 'MULTI_AGENT',
    "demoMode" BOOLEAN NOT NULL DEFAULT false,
    "plan" TEXT,
    "managerPlan" JSONB,
    "researchReport" JSONB,
    "patchProposal" JSONB,
    "testReport" JSONB,
    "reviewReport" JSONB,
    "summary" TEXT,
    "diff" TEXT,
    "approvalHash" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "pullRequestUrl" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" BIGSERIAL NOT NULL,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "tool" TEXT,
    "agentRole" TEXT,
    "status" TEXT,
    "durationMs" INTEGER,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "fromRole" TEXT NOT NULL,
    "toRole" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "objective" TEXT,
    "parentRunId" TEXT,
    "status" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "toolsUsed" JSONB,
    "inputArtifactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outputArtifactId" TEXT,
    "error" TEXT,
    "contextChars" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "exitCode" INTEGER NOT NULL,
    "stdout" TEXT NOT NULL,
    "stderr" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_state_createdAt_idx" ON "Task"("state", "createdAt");

-- CreateIndex
CREATE INDEX "TaskEvent_taskId_id_idx" ON "TaskEvent"("taskId", "id");

-- CreateIndex
CREATE INDEX "AgentMessage_taskId_createdAt_idx" ON "AgentMessage"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_taskId_startedAt_idx" ON "AgentRun"("taskId", "startedAt");

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

