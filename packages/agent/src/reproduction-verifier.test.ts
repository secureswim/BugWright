import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  record: vi.fn(async () => ({ id: "before-run" })),
  current: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => Buffer.from("test")) }));
vi.mock("@bugwright/database", () => ({ db: { testRun: { create: mocks.record } } }));
vi.mock("@bugwright/policy", () => ({
  captureArtifact: vi.fn(async () => ({
    hash: "before",
    files: [{ path: "bug.test.ts", sha256: "testhash" }],
  })),
  assertArtifactCurrent: mocks.current,
  resolveInside: (root: string, path: string) => `${root}/${path}`,
  sha256: () => "testhash",
}));
vi.mock("./mcp.js", () => ({ McpTools: class {}, parseToolJson: (value: string) => JSON.parse(value) }));
import { McpTools } from "./mcp.js";
import { createReproductionVerifier } from "./reproduction-verifier.js";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.call.mockReset();
});
const verifier = (exitCode: number, noTestsCollected = false) => {
  mocks.call
    .mockResolvedValueOnce(JSON.stringify({ status: "selected", project: { projectPath: "." } }))
    .mockResolvedValueOnce(JSON.stringify({ status: "ran", exitCode: 0 }))
    .mockResolvedValueOnce(
      JSON.stringify({ status: "ran", exitCode, noTestsCollected, stdout: "assertion output" }),
    );
  const onProof = vi.fn();
  return {
    verify: createReproductionVerifier("task", "/repo", "base", { call: mocks.call } as unknown as McpTools, {
      onProof,
      onBaseline: vi.fn(),
    }),
    onProof,
  };
};
it("records failure proof only from an observed failing runner exit code", async () => {
  const { verify, onProof } = verifier(1);
  expect(await verify("bug.test.ts")).toMatchObject({ ran: true, failed: true });
  expect(onProof).toHaveBeenCalledWith({
    path: "bug.test.ts",
    sha256: "testhash",
    baselineArtifactHash: "before",
    testRunId: "before-run",
  });
  expect(mocks.call.mock.calls.every(([role]) => role === "TESTER")).toBe(true);
  expect(mocks.current).toHaveBeenCalledOnce();
});
it("does not create failure proof for a passing test", async () => {
  const { verify, onProof } = verifier(0);
  expect(await verify("bug.test.ts")).toMatchObject({ ran: true, failed: false });
  expect(onProof).not.toHaveBeenCalled();
});
it("does not accept test collection failures as a reproduction", async () => {
  const { verify, onProof } = verifier(1, true);
  expect(await verify("bug.test.ts")).toMatchObject({ ran: false, failed: false });
  expect(onProof).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});
