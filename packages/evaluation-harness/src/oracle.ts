import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SWEBenchInstance, OracleEvidence, OracleResult } from "@bugwright/shared";
import { parseTestIds } from "./swebench.js";

export interface OracleTask {
  state: string;
  reproductionFixed?: string;
  /** Only observed test identities qualify; test paths and model prose do not. */
  reproductionTestIds?: string[];
}

/** Conservative parsing of verbose pytest/unittest identities. Quiet output
 * has no identities and therefore cannot establish a gold coverage match. */
export function observedReproductionIds(goldIds: string[], before: string, after: string): string[] {
  const stripAnsi = (text: string) =>
    text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  const linesBefore = stripAnsi(before).split(/\r?\n/);
  const linesAfter = stripAnsi(after).split(/\r?\n/);
  const hasStatus = (lines: string[], id: string, statuses: string[]) =>
    lines.some((line) => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `^\\s*${escaped}\\s+(?:\\.\\.\\.\\s+)?(?:${statuses.join("|")})(?:\\s+\\[.*\\])?\\s*$`,
      ).test(line);
    });
  return goldIds.filter(
    (id) =>
      hasStatus(linesBefore, id, ["FAILED", "FAIL", "ERROR"]) && hasStatus(linesAfter, id, ["PASSED", "ok"]),
  );
}
export function evaluateOracle(
  instance: SWEBenchInstance,
  task: OracleTask,
  evidence?: OracleEvidence,
): OracleResult {
  const failToPass = parseTestIds(instance.FAIL_TO_PASS);
  const passToPass = parseTestIds(instance.PASS_TO_PASS);
  const resolved = ["COMPLETED", "AWAITING_HUMAN_APPROVAL"].includes(task.state);
  const verifiedResolved = resolved && task.reproductionFixed === "passed";
  const oracleAvailable = evidence !== undefined;
  const goldPassed =
    oracleAvailable &&
    failToPass.length > 0 &&
    failToPass.every((id) => evidence.passed.includes(id) && !evidence.failed.includes(id)) &&
    passToPass.every((id) => evidence.passed.includes(id) && !evidence.failed.includes(id));
  const oracleMatch = (task.reproductionTestIds ?? []).some((id) => failToPass.includes(id));
  return {
    resolved,
    verifiedResolved,
    oracleMatch,
    oracleAvailable,
    goldPassed,
    // Unknown evidence is reported separately rather than called a false positive.
    falsePositive: resolved && (task.reproductionFixed !== "passed" || (oracleAvailable && !goldPassed)),
  };
}

/** Executes the official Docker evaluator on a separate copy of the benchmark.
 * Gold patches/tests never enter the BugWright workspace or agent context. */
export async function runOfficialOracle(
  instance: SWEBenchInstance,
  modelPatch: string,
  directory: string,
  python = "python",
): Promise<OracleEvidence> {
  const runId = `bugwright-oracle-${randomUUID()}`;
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  const dataset = path.join(root, `${runId}-dataset.json`);
  const predictions = path.join(root, `${runId}-predictions.jsonl`);
  await writeFile(dataset, JSON.stringify([instance]));
  await writeFile(
    predictions,
    JSON.stringify({
      instance_id: instance.instance_id,
      model_name_or_path: "bugwright",
      model_patch: modelPatch,
    }) + "\n",
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      python,
      [
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        dataset,
        "--predictions_path",
        predictions,
        "--max_workers",
        "1",
        "--run_id",
        runId,
      ],
      { cwd: root, shell: false, windowsHide: true, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Official SWE-bench evaluator exited ${code}`)),
    );
  });
  const report: unknown = JSON.parse(
    await readFile(
      path.join(root, "logs", "evaluation", runId, "bugwright", instance.instance_id, "report.json"),
      "utf8",
    ),
  );
  const entry = (
    report as Record<string, { tests_status?: Record<string, { success?: string[]; failure?: string[] }> }>
  )[instance.instance_id];
  if (!entry?.tests_status) throw new Error("Official oracle report is missing test status evidence");
  const groups = [entry.tests_status.FAIL_TO_PASS, entry.tests_status.PASS_TO_PASS];
  if (groups.some((group) => !group || !Array.isArray(group.success) || !Array.isArray(group.failure)))
    throw new Error("Invalid oracle test status report");
  return {
    passed: groups.flatMap((group) => group.success ?? []),
    failed: groups.flatMap((group) => group.failure ?? []),
  };
}
