import "dotenv/config";
import { db } from "@bugwright/database";
import { runTask } from "@bugwright/agent";
const task = await db.task.create({
  data: {
    repositoryUrl: "https://github.com/bugwright/demo",
    repositoryOwner: "bugwright",
    repositoryName: "demo",
    issueNumber: 1,
    issueTitle: "add() subtracts instead of adding",
    issueBody:
      "The add function returns the wrong result. Make the smallest correction and ensure tests pass.",
    baseBranch: "main",
    demoMode: true,
  },
});
await db.taskEvent.create({ data: { taskId: task.id, type: "TASK_CREATED", title: "Fixture task created" } });
try {
  await runTask(task.id);
} catch {}
const result = await db.task.findUniqueOrThrow({
  where: { id: task.id },
  include: { agentRuns: true, messages: true, testRuns: true },
});
console.log(
  JSON.stringify(
    {
      id: result.id,
      state: result.state,
      agents: result.agentRuns.map((r) => ({
        role: r.role,
        status: r.status,
        tools: r.toolCalls,
        models: r.modelCalls,
      })),
      messages: result.messages.length,
      tests: result.testRuns.map((t) => ({ command: t.command, exitCode: t.exitCode })),
      review: result.reviewReport,
      error: result.error,
    },
    null,
    2,
  ),
);
await db.$disconnect();
if (result.state !== "AWAITING_HUMAN_APPROVAL" && result.state !== "COMPLETED") process.exitCode = 1;
