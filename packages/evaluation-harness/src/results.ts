import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessResults, HarnessInstanceResult } from "@bugwright/shared";
export type { HarnessResults, HarnessInstanceResult } from "@bugwright/shared";
export const safeRunId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid run ID");
  return id;
};
export function aggregateResults(
  runId: string,
  executionMode: HarnessResults["executionMode"],
  dataset: HarnessResults["dataset"],
  results: HarnessInstanceResult[],
): HarnessResults {
  const rate = (count: number) => (results.length ? count / results.length : 0);
  const sum = (field: "costUsd" | "durationMs" | "modelCalls") =>
    results.reduce((total, item) => total + item[field], 0);
  const resolved = results.filter((item) => item.resolved).length;
  const verifiedResolved = results.filter((item) => item.verifiedResolved).length;
  return {
    runId: safeRunId(runId),
    executionMode,
    dataset,
    instanceCount: results.length,
    resolved,
    resolvedRate: rate(resolved),
    verifiedResolved,
    verifiedResolvedRate: rate(verifiedResolved),
    oracleMatchRate: rate(results.filter((item) => item.oracleMatch).length),
    falsePositiveRate: rate(results.filter((item) => item.falsePositive).length),
    oracleEvaluatedCount: results.filter((item) => item.oracleAvailable).length,
    goldResolvedRate: rate(results.filter((item) => item.goldPassed).length),
    meanCostUsd: rate(sum("costUsd")),
    meanDurationMs: rate(sum("durationMs")),
    meanModelCalls: rate(sum("modelCalls")),
    perInstance: results,
  };
}
export async function writeResults(results: HarnessResults, directory = "evaluations/results") {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${safeRunId(results.runId)}.json`);
  await writeFile(file, JSON.stringify(results, null, 2) + "\n");
  return file;
}
export async function readResults(runId: string, directory = "evaluations/results"): Promise<HarnessResults> {
  return JSON.parse(
    await readFile(path.join(directory, `${safeRunId(runId)}.json`), "utf8"),
  ) as HarnessResults;
}
export function comparisonReport(runs: HarnessResults[]): string {
  const rows: Array<[string, (run: HarnessResults) => string | number]> = [
    ["Mode", (r) => r.executionMode],
    ["Instances", (r) => r.instanceCount],
    ["Resolved rate", (r) => r.resolvedRate],
    ["Verified resolved rate", (r) => r.verifiedResolvedRate],
    ["Gold resolved rate", (r) => r.goldResolvedRate],
    ["Oracle evaluated", (r) => r.oracleEvaluatedCount],
    ["Oracle match rate", (r) => r.oracleMatchRate],
    ["False positive rate", (r) => r.falsePositiveRate],
    ["Mean cost USD", (r) => r.meanCostUsd],
    ["Mean duration ms", (r) => r.meanDurationMs],
    ["Mean model calls", (r) => r.meanModelCalls],
  ];
  return [
    `| Metric | ${runs.map((r) => r.runId).join(" | ")} |`,
    `| --- | ${runs.map(() => "---").join(" | ")} |`,
    ...rows.map(([label, value]) => `| ${label} | ${runs.map(value).join(" | ")} |`),
  ].join("\n");
}
