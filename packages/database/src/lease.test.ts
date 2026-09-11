import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  task: {
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
  },
  taskEvent: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("./client.js", () => ({ db: database }));

import {
  LeaseLostError,
  claimTaskLease,
  transactionWithTaskLease,
  updateTaskWithLease,
  withTaskLease,
} from "./lease.js";

beforeEach(() => {
  vi.clearAllMocks();
  database.task.updateMany.mockResolvedValue({ count: 1 });
  database.task.findUniqueOrThrow.mockResolvedValue({ leaseOwner: "worker-a", leaseGeneration: 7 });
  database.task.findFirst.mockResolvedValue({ id: "task" });
  database.taskEvent.create.mockResolvedValue({});
});

describe("fenced task leases", () => {
  it("allows only one worker to claim an active task", async () => {
    database.task.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const first = await claimTaskLease("task", "worker-a", ["TESTING"]);
    const second = await claimTaskLease("task", "worker-b", ["TESTING"]);
    expect(first).toEqual({ taskId: "task", owner: "worker-a", generation: 7 });
    expect(second).toBeNull();
    expect(database.task.updateMany.mock.calls[0][0].where).toMatchObject({
      id: "task",
      state: { in: ["TESTING"] },
    });
  });

  it("rejects a stale worker write using owner, generation, and expiry", async () => {
    database.task.updateMany.mockImplementation(async ({ data }) => {
      if (data.leaseOwner === "worker-a" || data.leaseOwner === null) return { count: 1 };
      if (data.summary === "stale") return { count: 0 };
      return { count: 1 };
    });
    await expect(
      withTaskLease("task", "worker-a", ["TESTING"], async () => {
        await updateTaskWithLease("task", { summary: "stale" });
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    const guardedWrite = database.task.updateMany.mock.calls.find(
      ([input]) => input.data.summary === "stale",
    )![0];
    expect(guardedWrite.where).toMatchObject({
      id: "task",
      leaseOwner: "worker-a",
      leaseGeneration: 7,
      leaseExpiresAt: { gt: expect.any(Date) },
    });
  });

  it("does not invoke work when the lease cannot be claimed", async () => {
    database.task.updateMany.mockResolvedValue({ count: 0 });
    const work = vi.fn();
    await expect(withTaskLease("task", "worker-b", ["CODING"], work)).resolves.toEqual({
      claimed: false,
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("checks the fence inside final-state transactions", async () => {
    database.$transaction.mockImplementation(async (work) =>
      work({ task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } }),
    );
    await expect(
      withTaskLease("task", "worker-a", ["PUBLISHING"], async () => {
        await transactionWithTaskLease("task", vi.fn());
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });
});
