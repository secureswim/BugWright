ALTER TYPE "TaskState" ADD VALUE IF NOT EXISTS 'REPRODUCING' AFTER 'PLANNING';

ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0,
                   ADD COLUMN IF NOT EXISTS "leaseOwner" TEXT,
                   ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3),
                   ADD COLUMN IF NOT EXISTS "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
                   ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3),
                   ADD COLUMN IF NOT EXISTS "reproductionReport" JSONB;

ALTER TABLE "Task" ALTER COLUMN "maxAttempts" SET DEFAULT 5,
                   ALTER COLUMN "maxRevisions" SET DEFAULT 4,
                   ALTER COLUMN "maxAgentRuns" SET DEFAULT 32,
                   ALTER COLUMN "maxModelCalls" SET DEFAULT 90,
                   ALTER COLUMN "timeoutMs" SET DEFAULT 1800000;

ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "retries" INTEGER NOT NULL DEFAULT 0,
                       ADD COLUMN IF NOT EXISTS "inputTokens" INTEGER NOT NULL DEFAULT 0,
                       ADD COLUMN IF NOT EXISTS "outputTokens" INTEGER NOT NULL DEFAULT 0,
                       ADD COLUMN IF NOT EXISTS "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "PublicationAttempt" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT,
    "pullRequestUrl" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PublicationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublicationAttempt_idempotencyKey_key" ON "PublicationAttempt"("idempotencyKey");
CREATE INDEX "PublicationAttempt_taskId_createdAt_idx" ON "PublicationAttempt"("taskId", "createdAt");
ALTER TABLE "PublicationAttempt" ADD CONSTRAINT "PublicationAttempt_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
