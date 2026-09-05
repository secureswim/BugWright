import { config } from "dotenv";
import { fileURLToPath } from "node:url";
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import PgBoss from "pg-boss";
import { runTask } from "@bugpilot/agent";
import { db } from "@bugpilot/database";
import { publishTask } from "./publish.js";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const boss = new PgBoss({ connectionString });
await boss.start();
await boss.createQueue("run-task");
await boss.createQueue("publish-task");
await boss.work<{ taskId: string }>("run-task", { batchSize: 1 }, async (jobs) => {
  for (const job of jobs)
    try {
      await runTask(job.data.taskId);
    } catch (error) {
      console.error("BugPilot task failed", job.data.taskId, error);
    }
});
await boss.work<{ taskId: string }>("publish-task", { batchSize: 1 }, async (jobs) => {
  for (const job of jobs)
    try {
      await publishTask(job.data.taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.task.update({ where: { id: job.data.taskId }, data: { state: "FAILED", error: message } });
      await db.taskEvent.create({
        data: {
          taskId: job.data.taskId,
          type: "PUBLISH_FAILED",
          title: "Draft PR publishing failed",
          detail: message,
        },
      });
      console.error("BugPilot publish failed", job.data.taskId, error);
    }
});
const resumable = await db.task.findMany({
  where: {
    state: {
      in: [
        "QUEUED",
        "PREPARING",
        "RESEARCHING",
        "PLANNING",
        "CODING",
        "TESTING",
        "RE_RESEARCHING",
        "RE_CODING",
        "REVIEWING",
        "REVISION_REQUESTED",
      ],
    },
  },
  select: { id: true },
});
for (const task of resumable)
  await boss.send("run-task", { taskId: task.id }, { singletonKey: task.id, retryLimit: 0 });
console.log("BugPilot worker is ready");
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await boss.stop();
  await db.$disconnect();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
