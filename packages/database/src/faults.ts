export type FaultPoint =
  | "after_lease_claim"
  | "after_coding_checkpoint"
  | "during_testing"
  | "after_github_commit"
  | "after_branch_creation"
  | "after_pr_creation";

const triggered = new Set<string>();

/** Controlled fault injection for spawned reliability tests. It is inert
 * unless explicitly enabled and cannot be activated accidentally in a normal
 * production process. */
export async function injectFault(point: FaultPoint) {
  if (process.env.BUGWRIGHT_ENABLE_FAULT_INJECTION !== "1") return;
  if (process.env.NODE_ENV === "production" && process.env.BUGWRIGHT_ALLOW_PRODUCTION_FAULTS !== "1") {
    throw new Error("Fault injection is disabled in production");
  }
  if (process.env.BUGWRIGHT_FAULT_POINT !== point || triggered.has(point)) return;
  triggered.add(point);

  const mode = process.env.BUGWRIGHT_FAULT_MODE ?? "throw";
  const configuredDuration = Number(process.env.BUGWRIGHT_FAULT_DURATION_MS ?? 10_000);
  const durationMs = Number.isFinite(configuredDuration) ? Math.max(0, configuredDuration) : 10_000;
  process.stderr.write(`${JSON.stringify({ type: "BUGWRIGHT_FAULT", point, mode, pid: process.pid })}\n`);

  if (mode === "throw") throw new Error(`Injected fault at ${point}`);
  if (mode === "exit") process.exit(86);
  if (mode === "block") {
    // Blocking the event loop intentionally suppresses lease heartbeats. This
    // models a wedged runtime more faithfully than an awaited timer.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
    return;
  }
  if (mode === "pause") {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return;
  }
  throw new Error(`Unknown fault mode: ${mode}`);
}

export function resetFaultsForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("Fault reset is test-only");
  triggered.clear();
}
