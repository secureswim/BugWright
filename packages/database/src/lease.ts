import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, TaskState } from "@prisma/client";
import { db } from "./client.js";

const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

export interface TaskLease {
  taskId: string;
  owner: string;
  generation: number;
}

export class LeaseLostError extends Error {
  constructor(taskId: string) {
    super(`Execution lease for task ${taskId} was lost`);
    this.name = "LeaseLostError";
  }
}

const context = new AsyncLocalStorage<TaskLease>();

function duration(name: string, fallback: number, minimum: number) {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

export function currentTaskLease() {
  return context.getStore();
}

export async function claimTaskLease(taskId: string, owner: string, states: TaskState[]) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + duration("BUGWRIGHT_LEASE_MS", DEFAULT_LEASE_MS, 5_000));
  const claimed = await db.task.updateMany({
    where: {
      id: taskId,
      state: { in: states },
      OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      leaseOwner: owner,
      leaseExpiresAt,
      heartbeatAt: now,
      leaseGeneration: { increment: 1 },
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return null;
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { leaseOwner: true, leaseGeneration: true },
  });
  if (task.leaseOwner !== owner) return null;
  const lease = { taskId, owner, generation: task.leaseGeneration } satisfies TaskLease;
  await db.taskEvent
    .create({
      data: {
        taskId,
        type: "LEASE_ACQUIRED",
        title: "Worker acquired the execution lease",
        detail: `${owner} generation ${lease.generation}`,
        status: "COMPLETED",
      },
    })
    .catch(() => {});
  return lease;
}

export async function renewTaskLease(lease: TaskLease) {
  const now = new Date();
  const renewed = await db.task.updateMany({
    where: {
      id: lease.taskId,
      leaseOwner: lease.owner,
      leaseGeneration: lease.generation,
      leaseExpiresAt: { gt: now },
    },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + duration("BUGWRIGHT_LEASE_MS", DEFAULT_LEASE_MS, 5_000)),
    },
  });
  return renewed.count === 1;
}

export async function assertTaskLease(taskId = currentTaskLease()?.taskId) {
  const lease = currentTaskLease();
  if (!lease || !taskId || lease.taskId !== taskId) throw new LeaseLostError(taskId ?? "unknown");
  const now = new Date();
  const task = await db.task.findFirst({
    where: {
      id: taskId,
      leaseOwner: lease.owner,
      leaseGeneration: lease.generation,
      leaseExpiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (!task) throw new LeaseLostError(taskId);
  return lease;
}

export async function updateTaskWithLease(taskId: string, data: Prisma.TaskUpdateManyMutationInput) {
  const lease = currentTaskLease();
  if (!lease || lease.taskId !== taskId) throw new LeaseLostError(taskId);
  const updated = await db.task.updateMany({
    where: {
      id: taskId,
      leaseOwner: lease.owner,
      leaseGeneration: lease.generation,
      leaseExpiresAt: { gt: new Date() },
    },
    data: { ...data, version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new LeaseLostError(taskId);
}

export async function transactionWithTaskLease<T>(
  taskId: string,
  work: (transaction: Prisma.TransactionClient, lease: TaskLease) => Promise<T>,
) {
  const lease = currentTaskLease();
  if (!lease || lease.taskId !== taskId) throw new LeaseLostError(taskId);
  return db.$transaction(async (transaction) => {
    const guarded = await transaction.task.updateMany({
      where: {
        id: taskId,
        leaseOwner: lease.owner,
        leaseGeneration: lease.generation,
        leaseExpiresAt: { gt: new Date() },
      },
      data: { version: { increment: 1 } },
    });
    if (guarded.count !== 1) throw new LeaseLostError(taskId);
    return work(transaction, lease);
  });
}

export async function releaseTaskLease(lease: TaskLease) {
  const released = await db.task.updateMany({
    where: { id: lease.taskId, leaseOwner: lease.owner, leaseGeneration: lease.generation },
    data: { leaseOwner: null, leaseExpiresAt: null, heartbeatAt: new Date(), version: { increment: 1 } },
  });
  if (released.count === 1)
    await db.taskEvent
      .create({
        data: {
          taskId: lease.taskId,
          type: "LEASE_RELEASED",
          title: "Worker released the execution lease",
          detail: `${lease.owner} generation ${lease.generation}`,
          status: "COMPLETED",
        },
      })
      .catch(() => {});
}

export async function withTaskLease<T>(
  taskId: string,
  owner: string,
  states: TaskState[],
  work: (lease: TaskLease) => Promise<T>,
): Promise<{ claimed: false } | { claimed: true; value: T }> {
  const lease = await claimTaskLease(taskId, owner, states);
  if (!lease) return { claimed: false };

  let renewing = false;
  const timer = setInterval(
    () => {
      if (renewing) return;
      renewing = true;
      void renewTaskLease(lease).finally(() => {
        renewing = false;
      });
    },
    duration("BUGWRIGHT_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS, 1_000),
  );
  timer.unref();

  try {
    const value = await context.run(lease, () => work(lease));
    await context.run(lease, () => assertTaskLease(taskId));
    return { claimed: true, value };
  } finally {
    clearInterval(timer);
    await releaseTaskLease(lease).catch(() => {});
  }
}
