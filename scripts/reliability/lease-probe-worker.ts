import "dotenv/config";
import { db, injectFault, LeaseLostError, updateTaskWithLease, withTaskLease } from "@bugwright/database";

const [taskId, owner, role, notBeforeValue] = process.argv.slice(2);

function report(type: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ type, owner, role, pid: process.pid, ...fields })}\n`);
}

async function main() {
  if (!taskId || !owner || (role !== "stale" && role !== "takeover")) {
    throw new Error("usage: lease-probe-worker <task-id> <owner> <stale|takeover>");
  }

  const notBefore = Number(notBeforeValue ?? 0);
  if (role === "takeover" && Number.isFinite(notBefore) && Date.now() < notBefore) {
    await new Promise((resolve) => setTimeout(resolve, notBefore - Date.now()));
  }

  try {
    const result = await withTaskLease(taskId, owner, ["TESTING"], async (lease) => {
      report("ACQUIRED", { generation: lease.generation, acquiredAt: Date.now() });

      if (role === "stale") {
        await injectFault("after_lease_claim");
        try {
          await updateTaskWithLease(taskId, { error: "stale worker wrote after takeover" });
          report("UNSAFE_WRITE_ACCEPTED");
        } catch (error) {
          if (!(error instanceof LeaseLostError)) throw error;
          report("STALE_WRITE_REJECTED", { rejectedAt: Date.now() });
        }
        return;
      }

      await updateTaskWithLease(taskId, { error: "takeover worker owns the task" });
      report("TAKEOVER_WRITE_ACCEPTED", { updatedAt: Date.now() });
      // Keep the new lease alive until the stale process wakes and attempts its
      // write. This proves rejection is due to fencing, not a vacant lease.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
    });
    if (!result.claimed) throw new Error(`${owner} could not claim the task lease`);
  } catch (error) {
    // The stale process also fails the final lease assertion performed by
    // withTaskLease. That is expected after its explicit stale write was denied.
    if (role === "stale" && error instanceof LeaseLostError) {
      report("STALE_EXECUTION_STOPPED");
      return;
    }
    throw error;
  }
}

main()
  .catch((error) => {
    report("FAILED", { message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
