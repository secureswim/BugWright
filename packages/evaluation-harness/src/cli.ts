import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { db } from "@bugwright/database";
import { loadInstances } from "./swebench.js";
import { runHarness } from "./runner.js";
import { comparisonReport, readResults } from "./results.js";

const usage =
  "Usage: harness run --dataset <jsonl> [--instances <ids>] [--repo <owner/repo>] [--mode multi_agent|single_agent] [--repeats 3]\n       harness compare --runs <id1,id2>\n       harness report --run <id>";
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dataset: { type: "string" },
      instances: { type: "string" },
      repo: { type: "string" },
      mode: { type: "string", default: "multi_agent" },
      repeats: { type: "string", default: "1" },
      runs: { type: "string" },
      run: { type: "string" },
      python: { type: "string", default: "python" },
      "dataset-kind": { type: "string", default: "swe-bench-verified" },
      "results-dir": { type: "string", default: "evaluations/results" },
    },
  });
  if (positionals.length !== 1) throw new Error(usage);
  const [command] = positionals;
  if (command === "report" || command === "compare") {
    const ids = command === "report" ? [values.run] : values.runs?.split(",");
    if (!ids || ids.some((id) => !id) || (command === "compare" && ids.length !== 2)) throw new Error(usage);
    console.log(
      comparisonReport(await Promise.all(ids.map((id) => readResults(id!, values["results-dir"])))),
    );
    return;
  }
  if (command !== "run" || !values.dataset) throw new Error(usage);
  if (!["multi_agent", "single_agent"].includes(values.mode)) throw new Error("Invalid mode");
  if (!["swe-bench-verified", "swe-bench-lite"].includes(values["dataset-kind"]))
    throw new Error("Invalid dataset kind");
  const repeats = Number(values.repeats);
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
  const instances = await loadInstances(values.dataset, {
    repo: values.repo,
    instanceIds: values.instances?.split(","),
  });
  if (!instances.length) throw new Error("No instances match the requested filters");
  for (let repeat = 0; repeat < repeats; repeat++) {
    const result = await runHarness(instances, `swebench-${randomUUID()}`, {
      mode: values.mode === "multi_agent" ? "MULTI_AGENT" : "SINGLE_AGENT",
      dataset: values["dataset-kind"] as "swe-bench-verified" | "swe-bench-lite",
      resultsDirectory: values["results-dir"],
      python: values.python,
    });
    console.log(comparisonReport([result]));
  }
}
main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
