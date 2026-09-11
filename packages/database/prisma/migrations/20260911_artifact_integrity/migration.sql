ALTER TABLE "Task" ADD COLUMN "reviewArtifact" JSONB,
                   ADD COLUMN "reproductionProof" JSONB;
ALTER TABLE "TestRun" ADD COLUMN "artifactHash" TEXT,
                      ADD COLUMN "kind" TEXT;
