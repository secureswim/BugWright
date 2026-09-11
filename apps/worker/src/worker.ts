import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import PgBoss from "pg-boss";
import { runTask } from "@bugwright/agent";
import { db, TaskState } from "@bugwright/database";
import { publishTask } from "./publish.js";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const boss = new PgBoss({ connectionString });
const workerId = `worker:${process.pid}:${randomUUID()}`;
await boss.start();
await boss.createQueue("run-task");
await boss.createQueue("publish-task");
await boss.work<{ taskId: string }>("run-task", { batchSize: 1 }, async (jobs) => {
  for (const job of jobs)
    try {
      const claimed = await runTask(job.data.taskId, workerId);
      if (!claimed) console.log("Skipped task without an available execution lease", job.data.taskId);
    } catch (error) {
      console.error("BugWright task failed", job.data.taskId, error);
    }
});
await boss.work<{ taskId: string }>("publish-task", { batchSize: 1 }, async (jobs) => {
  for (const job of jobs)
    try {
      const claimed = await publishTask(job.data.taskId, workerId);
      if (!claimed) console.log("Skipped publication without an available execution lease", job.data.taskId);
    } catch (error) {
      console.error("BugWright publish failed", job.data.taskId, error);
    }
});
const RUNNING_STATES: TaskState[] = [
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
];
const availableLease = () => [
  { leaseOwner: null },
  { leaseExpiresAt: null },
  { leaseExpiresAt: { lte: new Date() } },
];

async function reconcileExpiredTasks() {
  const interrupted = await db.task.findMany({
    where: { state: { in: RUNNING_STATES }, OR: availableLease() },
    select: { id: true },
  });
  for (const task of interrupted)
    await boss.send("run-task", { taskId: task.id }, { retryLimit: 3, retryDelay: 5 });

  const publications = await db.task.findMany({
    where: { state: "PUBLISHING", OR: availableLease() },
    select: { id: true },
  });
  for (const task of publications)
    await boss.send("publish-task", { taskId: task.id }, { retryLimit: 3, retryDelay: 5 });
}

await reconcileExpiredTasks();
const reconciliationTimer = setInterval(() => {
  void reconcileExpiredTasks().catch((error) => console.error("Task reconciliation failed", error));
}, 15_000);
reconciliationTimer.unref();
console.log("BugWright worker is ready");
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  clearInterval(reconciliationTimer);
  await boss.stop();
  await db.$disconnect();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
