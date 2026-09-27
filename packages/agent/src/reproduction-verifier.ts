import { readFile } from "node:fs/promises";
import { db } from "@bugwright/database";
import {
  captureArtifact,
  assertArtifactCurrent,
  resolveInside,
  sha256,
  type ReproductionProof,
  type ReviewArtifact,
} from "@bugwright/policy";
import { detectTransformError } from "@bugwright/adapters";
import { McpTools, parseToolJson } from "./mcp.js";

/** The same deterministic before-patch verifier for both execution modes. */
export function createReproductionVerifier(
  taskId: string,
  repoRoot: string,
  base: string,
  mcp: McpTools,
  options: {
    onBaseline: (artifact: ReviewArtifact) => void;
    onProof: (proof: ReproductionProof) => void;
  },
) {
  return async (testPath: string) => {
    const baseline = await captureArtifact(repoRoot, base);
    options.onBaseline(baseline);
    const testHash = sha256(await readFile(resolveInside(repoRoot, testPath)));
    if (!baseline.files.some((file) => file.path === testPath && file.sha256 === testHash)) {
      throw new Error("The reproduction test must be a captured, non-ignored change");
    }
    const selection = parseToolJson<{ status: string; project?: { projectPath: string } }>(
      await mcp.call("TESTER", "runner", "select_project", { changedFiles: [testPath] }, 0),
    );
    if (selection.status !== "selected" || !selection.project) {
      return { failed: false, output: "No verifiable project detected", ran: false };
    }
    const projectPath = selection.project.projectPath;
    await mcp.call("TESTER", "runner", "prepare_dependencies", { projectPath }, 0);
    const result = parseToolJson<{
      status: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      noTestsCollected?: boolean;
      command?: string;
      durationMs?: number;
    }>(await mcp.call("TESTER", "runner", "run_test", { projectPath, only: testPath }, 0));
    if (result.status !== "ran") {
      return { failed: false, output: "The reproduction test could not be executed", ran: false };
    }
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    await assertArtifactCurrent(repoRoot, baseline);
    // A runner that collected no tests also exits non-zero. Treating that
    // as a failing test would record a reproduction that never ran.
    if (result.noTestsCollected || detectTransformError(output)) {
      return {
        failed: false,
        output:
          `The test runner could not collect or parse ${testPath}, so it never ran. ` +
          `Check that the file extension matches its contents.\n${output}`,
        ran: false,
      };
    }
    if (typeof result.exitCode !== "number" || result.exitCode < 0) {
      return { failed: false, output: "No valid test exit status", ran: false };
    }
    const evidence = await db.testRun.create({
      data: {
        taskId,
        artifactHash: baseline.hash,
        kind: "reproduction-before",
        command: result.command ?? "reproduction",
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        durationMs: result.durationMs ?? 0,
      },
    });
    if (result.exitCode !== 0)
      options.onProof({
        path: testPath,
        sha256: testHash,
        baselineArtifactHash: baseline.hash,
        testRunId: evidence.id,
      });
    return { failed: result.exitCode !== 0, output, ran: true };
  };
}
