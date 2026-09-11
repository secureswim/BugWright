import "dotenv/config";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "@bugwright/database";

type ProbeEvent = Record<string, unknown> & { type: string };

const workerScript = fileURLToPath(new URL("./lease-probe-worker.ts", import.meta.url));
const shim = fileURLToPath(new URL("../windows-user-shim.cjs", import.meta.url));

function probe(taskId: string, owner: string, role: "stale" | "takeover", notBefore?: number) {
  const child = spawn(
    process.execPath,
    ["--require", shim, "--import", "tsx", workerScript, taskId, owner, role, String(notBefore ?? 0)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BUGWRIGHT_LEASE_MS: "5000",
        BUGWRIGHT_HEARTBEAT_MS: "1500",
        ...(role === "stale"
          ? {
              BUGWRIGHT_ENABLE_FAULT_INJECTION: "1",
              BUGWRIGHT_FAULT_POINT: "after_lease_claim",
              BUGWRIGHT_FAULT_MODE: "block",
              BUGWRIGHT_FAULT_DURATION_MS: "15000",
            }
          : {
              BUGWRIGHT_ENABLE_FAULT_INJECTION: "0",
            }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return observe(child, owner);
}

function observe(child: ChildProcessWithoutNullStreams, owner: string) {
  const events: ProbeEvent[] = [];
  const waiters = new Map<string, Array<(event: ProbeEvent) => void>>();
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as ProbeEvent;
      events.push(parsed);
      for (const resolve of waiters.get(parsed.type) ?? []) resolve(parsed);
      waiters.delete(parsed.type);
    }
  });

  const completion = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${owner} exceeded the 35-second probe deadline\n${stderr}`));
    }, 35_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${owner} exited ${code}\n${stderr}`));
    });
  });

  function waitFor(type: string, timeoutMs = 15_000) {
    const existing = events.find((event) => event.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise<ProbeEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${owner}:${type}\n${stderr}`)),
        timeoutMs,
      );
      const wrapped = (event: ProbeEvent) => {
        clearTimeout(timer);
        resolve(event);
      };
      waiters.set(type, [...(waiters.get(type) ?? []), wrapped]);
    });
  }

  return { child, events, completion, waitFor };
}

function requiredEvent(events: ProbeEvent[], type: string) {
  const event = events.find((item) => item.type === type);
  if (!event) throw new Error(`Missing probe event: ${type}`);
  return event;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the reliability probe");

  const task = await db.task.create({
    data: {
      repositoryUrl: "https://github.com/example/reliability-probe.git",
      repositoryOwner: "example",
      repositoryName: "reliability-probe",
      issueNumber: 1,
      issueTitle: "Verify stale-worker fencing",
      state: "TESTING",
    },
  });

  let stale: ReturnType<typeof probe> | undefined;
  let takeover: ReturnType<typeof probe> | undefined;
  try {
    stale = probe(task.id, "probe-stale", "stale");
    const first = await stale.waitFor("ACQUIRED");
    // Load the replacement immediately, but wait to claim until generation 1
    // has expired. Loader speed therefore cannot consume the takeover window.
    takeover = probe(task.id, "probe-takeover", "takeover", Number(first.acquiredAt) + 5_500);
    const second = await takeover.waitFor("ACQUIRED");
    await Promise.all([stale.completion, takeover.completion]);

    requiredEvent(stale.events, "STALE_WRITE_REJECTED");
    requiredEvent(stale.events, "STALE_EXECUTION_STOPPED");
    requiredEvent(takeover.events, "TAKEOVER_WRITE_ACCEPTED");

    const persisted = await db.task.findUniqueOrThrow({
      where: { id: task.id },
      include: { events: true },
    });
    if (persisted.error !== "takeover worker owns the task") {
      throw new Error(`Incorrect final value: ${persisted.error ?? "null"}`);
    }
    if (persisted.leaseOwner !== null) throw new Error("Takeover lease was not released");
    if (Number(second.generation) <= Number(first.generation)) {
      throw new Error("Lease generation did not advance during takeover");
    }

    const staleWritesRejected = persisted.events.filter(
      (event) => event.type === "STALE_WRITE_REJECTED",
    ).length;
    if (!staleWritesRejected) throw new Error("No stale-write rejection was persisted");

    process.stdout.write(
      `${JSON.stringify(
        {
          passed: true,
          scenario: "expired lease takeover fences a stalled worker",
          firstGeneration: first.generation,
          takeoverGeneration: second.generation,
          takeoverLatencyMs: Number(second.acquiredAt) - Number(first.acquiredAt),
          staleWritesRejected,
          finalOwner: persisted.leaseOwner,
          finalValue: persisted.error,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    stale?.child.kill();
    takeover?.child.kill();
    await db.task.delete({ where: { id: task.id } }).catch(() => {});
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
