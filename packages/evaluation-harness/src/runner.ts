import { db } from "@bugwright/database";
import { runTask } from "@bugwright/agent";
import {
  createTaskSchema,
  type SWEBenchInstance,
  type HarnessInstanceResult,
  type HarnessResults,
  type OracleEvidence,
} from "@bugwright/shared";
import { parseGitHubRepository } from "@bugwright/policy";
import { evaluateOracle, runOfficialOracle, observedReproductionIds } from "./oracle.js";
import { aggregateResults, writeResults, safeRunId } from "./results.js";
import { parseTestIds } from "./swebench.js";

export function instanceTaskInput(
  instance: SWEBenchInstance,
  mode: HarnessResults["executionMode"],
  baseBranch: string,
) {
  return createTaskSchema.parse({
    repositoryUrl: `https://github.com/${instance.repo}`,
    issueNumber: Number(instance.instance_id.match(/-(\d+)$/)?.[1]),
    issueTitle: instance.problem_statement.split(/\r?\n/)[0].trim().slice(0, 240),
    issueBody: instance.problem_statement,
    baseBranch,
    executionMode: mode,
    demoMode: false,
  });
}

// Use the repo's actual default target branch. The separate baseCommit field
// pins checkout to the benchmark revision; commit SHAs are not branch names.
const defaultBranches = new Map<string, string>();
export async function resolveBaseBranch(repo: string): Promise<string> {
  const cached = defaultBranches.get(repo);
  if (cached) return cached;
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not resolve default branch for ${repo}: HTTP ${response.status}`);
  const data: unknown = await response.json();
  const branch = (data as { default_branch?: unknown }).default_branch;
  if (typeof branch !== "string") throw new Error("Repository has no default branch");
  defaultBranches.set(repo, branch);
  return branch;
}

export interface RunInstanceOptions {
  mode: HarnessResults["executionMode"];
  oracleDirectory?: string;
  baseBranch?: string;
  python?: string;
  /** Allows offline tests to inject observed oracle evidence. */
  oracle?: (instance: SWEBenchInstance, diff: string) => Promise<OracleEvidence>;
}

export async function runInstance(
  instance: SWEBenchInstance,
  options: RunInstanceOptions,
): Promise<HarnessInstanceResult> {
  const started = Date.now();
  const input = instanceTaskInput(
    instance,
    options.mode,
    options.baseBranch ?? (await resolveBaseBranch(instance.repo)),
  );
  const repository = parseGitHubRepository(input.repositoryUrl);
  const task = await db.task.create({
    data: {
      ...input,
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      baseCommit: instance.base_commit,
    },
  });
  await db.taskEvent.create({
    data: {
      taskId: task.id,
      type: "BENCHMARK_INSTANCE_CREATED",
      title: `Benchmark ${instance.instance_id}`,
      output: {
        instanceId: instance.instance_id,
        executionMode: options.mode,
        baseCommit: instance.base_commit,
      },
    },
  });
  let error: string | undefined;
  try {
    if (!(await runTask(task.id))) throw new Error("Benchmark task lease could not be acquired");
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const final = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    include: { testRuns: true, agentRuns: true },
  });
  const durationMs = Date.now() - started;
  let evidence: OracleEvidence | undefined;
  let oracleError: string | undefined;
  try {
    const evaluator =
      options.oracle ??
      ((item: SWEBenchInstance, diff: string) =>
        runOfficialOracle(item, diff, options.oracleDirectory ?? "evaluations/oracle", options.python));
    evidence = await evaluator(instance, final.diff ?? "");
    await db.taskEvent.create({
      data: {
        taskId: task.id,
        type: "BENCHMARK_ORACLE_COMPLETED",
        title: "Official gold test evaluation completed",
        output: evidence as never,
      },
    });
  } catch (cause) {
    oracleError = cause instanceof Error ? cause.message : String(cause);
    await db.taskEvent.create({
      data: {
        taskId: task.id,
        type: "BENCHMARK_ORACLE_FAILED",
        title: "Gold test evaluation unavailable",
        detail: oracleError,
        status: "FAILED",
      },
    });
  }
  const proofRunId = (final.reproductionProof as { testRunId?: string } | null)?.testRunId;
  const before = final.testRuns.find((run) => run.id === proofRunId && run.kind === "reproduction-before");
  const after = final.testRuns
    .filter(
      (run) =>
        run.kind === "reproduction-after" &&
        run.artifactHash === (final.testReport as { artifactHash?: string } | null)?.artifactHash,
    )
    .at(-1);
  const reproductionTestIds =
    before && after
      ? observedReproductionIds(
          parseTestIds(instance.FAIL_TO_PASS),
          `${before.stdout}\n${before.stderr}`,
          `${after.stdout}\n${after.stderr}`,
        )
      : [];
  const verdict = evaluateOracle(
    instance,
    {
      state: final.state,
      reproductionFixed: (final.testReport as { reproductionFixed?: string } | null)?.reproductionFixed,
      reproductionTestIds,
    },
    evidence,
  );
  return {
    ...verdict,
    instanceId: instance.instance_id,
    taskId: task.id,
    status: final.state,
    costUsd: final.costUsd,
    durationMs,
    modelCalls: final.agentRuns.reduce((sum, run) => sum + run.modelCalls, 0),
    revisionCycles: final.revisionCycle,
    error,
    oracleError,
  };
}

export async function runHarness(
  instances: SWEBenchInstance[],
  runId: string,
  options: RunInstanceOptions & { dataset?: HarnessResults["dataset"]; resultsDirectory?: string },
) {
  safeRunId(runId);
  const results: HarnessInstanceResult[] = [];
  for (const instance of instances) {
    try {
      results.push(await runInstance(instance, options));
    } catch (cause) {
      results.push({
        instanceId: instance.instance_id,
        taskId: "",
        status: "FAILED",
        resolved: false,
        verifiedResolved: false,
        oracleMatch: false,
        falsePositive: false,
        oracleAvailable: false,
        goldPassed: false,
        costUsd: 0,
        durationMs: 0,
        modelCalls: 0,
        revisionCycles: 0,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    // Persist after each instance so interruption preserves completed results.
    await writeResults(
      aggregateResults(runId, options.mode, options.dataset ?? "swe-bench-verified", results),
      options.resultsDirectory,
    );
  }
  const aggregated = aggregateResults(runId, options.mode, options.dataset ?? "swe-bench-verified", results);
  await writeResults(aggregated, options.resultsDirectory);
  return aggregated;
}
