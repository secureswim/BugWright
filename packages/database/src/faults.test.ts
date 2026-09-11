import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { injectFault, resetFaultsForTest } from "./faults.js";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  resetFaultsForTest();
});
afterEach(() => vi.unstubAllEnvs());

describe("fault injection", () => {
  it("is inert unless explicitly enabled", async () => {
    vi.stubEnv("BUGWRIGHT_FAULT_POINT", "during_testing");
    await expect(injectFault("during_testing")).resolves.toBeUndefined();
  });

  it("throws once at the selected point", async () => {
    vi.stubEnv("BUGWRIGHT_ENABLE_FAULT_INJECTION", "1");
    vi.stubEnv("BUGWRIGHT_FAULT_POINT", "during_testing");
    vi.stubEnv("BUGWRIGHT_FAULT_MODE", "throw");
    await expect(injectFault("during_testing")).rejects.toThrow(/Injected fault/);
    await expect(injectFault("during_testing")).resolves.toBeUndefined();
  });

  it("rejects production activation without a second explicit override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BUGWRIGHT_ENABLE_FAULT_INJECTION", "1");
    vi.stubEnv("BUGWRIGHT_FAULT_POINT", "during_testing");
    await expect(injectFault("during_testing")).rejects.toThrow(/disabled in production/);
  });
});
