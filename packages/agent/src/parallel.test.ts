import { describe, expect, it } from "vitest";
import { runBoundedParallel } from "./parallel.js";
describe("bounded parallel research", () => {
  it("runs independent work concurrently and preserves order", async () => {
    let active = 0,
      max = 0;
    const values = await runBoundedParallel([30, 10, 20], 2, async (value) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, value));
      active--;
      return value;
    });
    expect(values).toEqual([30, 10, 20]);
    expect(max).toBe(2);
  });
  it("waits for sibling work to settle before reporting a batch failure", async () => {
    const completed: number[] = [];
    await expect(
      runBoundedParallel([1, 2], 2, async (value) => {
        if (value === 1) throw new Error("temporary failure");
        await new Promise((r) => setTimeout(r, 20));
        completed.push(value);
        return value;
      }),
    ).rejects.toThrow("1 parallel task(s) failed");
    expect(completed).toEqual([2]);
  });
  it("rejects invalid concurrency", async () =>
    await expect(runBoundedParallel([1], 0, async (x) => x)).rejects.toThrow());
});
