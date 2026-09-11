import { randomUUID } from "node:crypto";
import { access, cp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  assertTaskLease,
  db,
  injectFault,
  LeaseLostError,
  Prisma,
  TaskState,
  updateTaskWithLease,
  withTaskLease,
} from "@bugwright/database";
import {
  AttemptRecord,
  ManagerPlan,
  PatchProposal,
  ReproductionReport,
  ResearchReport,
  ReviewReport,
  TestReport,
} from "@bugwright/shared";
import {
  resolveInside,
  captureArtifact,
  assertArtifactCurrent,
  restoreArtifact,
  assertReproduction,
  artifactApprovalHash,
  sha256,
  type ReproductionProof,
  type ReviewArtifact,
} from "@bugwright/policy";
import { McpTools, parseToolJson } from "./mcp.js";
import {
  coder,
  managerDecide,
  managerPlan,
  managerSynthesize,
  reproducer,
  researcher,
  reviewer,
  tester,
} from "./roles.js";
import {
  routeAfterReproduction,
  routeAfterReview,
  routeAfterScopeCheck,
  routeAfterTest,
} from "./state-machine.js";
import { assessScope } from "./scope.js";
import { detectTransformError } from "@bugwright/adapters";
import { runBoundedParallel } from "./parallel.js";
import { projectRoot, workspaceRoot as configuredWorkspaceRoot } from "./runtime.js";

async function exists(value: string) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function event(taskId: string, type: string, title: string, detail?: string, iteration = 0) {
  await assertTaskLease(taskId);
  await db.taskEvent.create({
    data: { taskId, type, title, detail, agentRole: "MANAGER", status: "COMPLETED", iteration },
  });
}

async function state(taskId: string, next: TaskState, title: string, iteration = 0) {
  await updateTaskWithLease(taskId, { state: next, currentAgent: "MANAGER" });
  await event(taskId, "STATE_CHANGED", title, undefined, iteration);
}

async function command(executable: string, args: string[], cwd: string) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function prepare(
  task: Awaited<ReturnType<typeof db.task.findUniqueOrThrow>>,
  repoRoot: string,
  workspaceRoot: string,
) {
  if (task.workspacePath === repoRoot && task.baseCommit && (await exists(path.join(repoRoot, ".git")))) {
    return task.baseCommit;
  }
  await rm(repoRoot, { recursive: true, force: true });

  if (task.demoMode) {
    const fixture = path.join(projectRoot(), "fixtures", "calculator-bug");
    await cp(fixture, repoRoot, { recursive: true });
    await command("git", ["init", "-b", "main"], repoRoot);
    await command("git", ["add", "."], repoRoot);
    await command(
      "git",
      ["-c", "user.name=BugWright", "-c", "user.email=bugwright@local", "commit", "-m", "fixture"],
      repoRoot,
    );
  } else {
    const cloned = await command(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "clone",
        "--depth",
        "1",
        "--branch",
        task.baseBranch,
        "--",
        task.repositoryUrl,
        repoRoot,
      ],
      workspaceRoot,
    );
    if (cloned.code !== 0) throw new Error(`Clone failed: ${cloned.stderr.slice(-2000)}`);
  }

  const head = await command("git", ["rev-parse", "HEAD"], repoRoot);
  if (head.code !== 0) throw new Error("Could not resolve base commit");
  return head.stdout.trim();
}

/** Rebuilds the attempt log from persisted messages, so resume keeps it. */
async function attemptHistory(taskId: string): Promise<AttemptRecord[]> {
  const messages = await db.agentMessage.findMany({
    where: { taskId, type: { in: ["CODE_CHANGE_SUMMARY", "TEST_REPORT", "REVIEW_REPORT"] } },
    orderBy: { createdAt: "asc" },
  });

  const attempts: AttemptRecord[] = [];
  let pending: { revision: number; summary: string; filesChanged: string[] } | undefined;

  for (const record of messages) {
    if (record.type === "CODE_CHANGE_SUMMARY") {
      const patch = record.payload as unknown as PatchProposal;
      pending = { revision: record.iteration, summary: patch.summary, filesChanged: patch.filesChanged };
      continue;
    }
    if (!pending) continue;
    if (record.type === "TEST_REPORT") {
      const report = record.payload as unknown as TestReport;
      if (report.passed) continue;
      attempts.push({
        ...pending,
        outcome: "tests-failed",
        evidence: report.failures.map((failure) => failure.message).join("; ") || report.summary,
      });
      pending = undefined;
    } else {
      const report = record.payload as unknown as ReviewReport;
      if (report.decision === "approve") continue;
      attempts.push({
        ...pending,
        outcome: "review-rejected",
        evidence: report.findings.map((finding) => finding.title).join("; ") || report.reasoning,
      });
      pending = undefined;
    }
  }
  return attempts;
}

const RUNNABLE_STATES: TaskState[] = [
  "QUEUED",
  "PREPARING",
  "RESEARCHING",
  "PLANNING",
  "REPRODUCING",
  "CODING",
  "TESTING",
  "RE_RESEARCHING",
  "RE_CODING",
  "REVIEWING",
  "REVISION_REQUESTED",
];

export async function runTask(taskId: string, owner = `direct:${process.pid}:${randomUUID()}`) {
  const result = await withTaskLease(taskId, owner, RUNNABLE_STATES, async () => {
    await injectFault("after_lease_claim");
    await executeTask(taskId);
  });
  return result.claimed;
}

async function executeTask(taskId: string) {
  const runStarted = Date.now();
  let task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const resumeState = task.state;
  const startingModelCalls = task.modelCalls;
  const startingAgentRuns = await db.agentRun.count({ where: { taskId } });

  if (task.executionMode === "SINGLE_AGENT") {
    await state(
      taskId,
      "NEEDS_ATTENTION",
      "Single-agent baseline runner is scaffolded for evaluation but not enabled yet",
    );
    return;
  }

  const workspaceRoot = configuredWorkspaceRoot();
  const repoRoot = resolveInside(workspaceRoot, task.id);
  let mcp: McpTools | undefined;

  try {
    await state(taskId, "PREPARING", "Manager is preparing a resumable task workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const base = await prepare(task, repoRoot, workspaceRoot);
    if (resumeState !== "QUEUED" && task.reviewArtifact) {
      const recoveryStarted = Date.now();
      await restoreArtifact(repoRoot, task.reviewArtifact);
      await assertTaskLease(taskId);
      await db.taskEvent.create({
        data: {
          taskId,
          type: "CHECKPOINT_RECOVERED",
          title: "Manager restored the last verified artifact before resuming",
          status: "COMPLETED",
          durationMs: Date.now() - recoveryStarted,
        },
      });
    }
    await updateTaskWithLease(taskId, { workspacePath: repoRoot, baseCommit: base, error: null });

    mcp = new McpTools(taskId, repoRoot);
    await mcp.connect(["repository", "git", "runner", ...(!task.issueTitle ? (["github"] as const) : [])]);

    let title = task.issueTitle;
    let body = task.issueBody ?? "";
    if (!title) {
      const issue = parseToolJson<{ title: string; body: string }>(
        await mcp.callTrusted("github", "read_issue", {
          owner: task.repositoryOwner,
          repo: task.repositoryName,
          issueNumber: task.issueNumber,
        }),
      );
      title = issue.title;
      body = issue.body;
      await updateTaskWithLease(taskId, { issueTitle: title, issueBody: body });
    }

    const issue = {
      repository: `${task.repositoryOwner}/${task.repositoryName}`,
      number: task.issueNumber,
      title: title!,
      body,
      baseBranch: task.baseBranch,
    };

    task = await db.task.findUniqueOrThrow({ where: { id: taskId } });

    /* ---------------------------------------------------------------- plan */
    let plan = task.managerPlan as unknown as ManagerPlan | null;
    let managerRunId = "";
    if (!plan) {
      await state(taskId, "PLANNING", "Manager is creating the dynamic delegation plan");
      const planned = await managerPlan(taskId, issue, mcp);
      plan = planned.plan;
      managerRunId = planned.runId;
      await updateTaskWithLease(taskId, { managerPlan: plan as never, plan: plan.objective });
    } else {
      managerRunId =
        (
          await db.agentRun.findFirst({
            where: { taskId, role: "MANAGER" },
            orderBy: { startedAt: "asc" },
          })
        )?.id ?? "";
    }

    /* ------------------------------------------------------------ research */
    let research = task.researchReport as unknown as ResearchReport | null;
    let reports: ResearchReport[] = [];
    let researchArtifacts: string[] = [];

    if (!research) {
      const stored = await db.agentMessage.findMany({
        where: { taskId, type: { startsWith: "RESEARCH_REPORT:" } },
        orderBy: { createdAt: "asc" },
      });
      const completedByObjective = new Map<string, { report: ResearchReport; artifactId: string }>();
      for (const item of stored) {
        const report = item.payload as unknown as ResearchReport;
        const key = report.objective ?? `${report.taskType}:${item.id}`;
        if (!completedByObjective.has(key)) completedByObjective.set(key, { report, artifactId: item.id });
      }
      const completedObjectives = new Set([...completedByObjective.keys()]);
      const pending = plan.researchTasks.filter((item) => !completedObjectives.has(item.objective));

      await state(taskId, "RESEARCHING", `Manager launched ${pending.length} remaining research task(s)`, 0);

      const outcomes = await runBoundedParallel(pending, 3, async (researchTask) => {
        try {
          return await researcher(taskId, issue, researchTask, mcp!, 0, managerRunId);
        } catch (error) {
          // A silently dropped researcher used to leave the run proceeding on
          // partial evidence with no record of what was missing.
          await event(
            taskId,
            "RESEARCH_FAILED",
            `Research task failed: ${researchTask.objective}`,
            error instanceof Error ? error.message : String(error),
          );
          return null;
        }
      });

      const successful = outcomes.filter((item): item is NonNullable<typeof item> => item !== null);
      reports = [...completedByObjective.values()]
        .map((item) => item.report)
        .concat(successful.map((item) => item.report));
      researchArtifacts = [...completedByObjective.values()]
        .map((item) => item.artifactId)
        .concat(successful.map((item) => item.artifactId));

      if (!reports.length) throw new Error("All research agents failed before producing evidence");

      const synthesis = await managerSynthesize(
        taskId,
        issue,
        reports,
        researchArtifacts,
        mcp,
        managerRunId,
        0,
      );
      research = synthesis.report;
      researchArtifacts.push(synthesis.artifactId);
      await updateTaskWithLease(taskId, { researchReport: research as never });
    } else {
      const stored = await db.agentMessage.findMany({
        where: { taskId, type: { startsWith: "RESEARCH_REPORT:" } },
        orderBy: { createdAt: "asc" },
      });
      reports = stored.map((item) => item.payload as unknown as ResearchReport);
      researchArtifacts = stored.map((item) => item.id);
      if (!reports.length) reports = [research];
    }

    /* --------------------------------------------------------- reproduction */
    let reproduction = task.reproductionReport as unknown as ReproductionReport | null;
    let reproductionProof = task.reproductionProof as unknown as ReproductionProof | null;
    let reproductionBaseline: ReviewArtifact | null = null;
    if (!reproduction) {
      await state(taskId, "REPRODUCING", "Manager delegated reproduction before any code is written");

      // Verification runs through the Tester's runner authority, invoked by the
      // Manager. The Reproducer writes the test; it cannot execute anything,
      // so it cannot certify its own work.
      const verify = async (testPath: string) => {
        const baseline = await captureArtifact(repoRoot, base);
        reproductionBaseline = baseline;
        const testHash = sha256(await readFile(resolveInside(repoRoot, testPath)));
        if (!baseline.files.some((file) => file.path === testPath && file.sha256 === testHash)) {
          throw new Error("The reproduction test must be a captured, non-ignored change");
        }
        const selection = parseToolJson<{ status: string; project?: { projectPath: string } }>(
          await mcp!.call("TESTER", "runner", "select_project", { changedFiles: [testPath] }, 0),
        );
        if (selection.status !== "selected" || !selection.project) {
          return { failed: false, output: "No verifiable project detected", ran: false };
        }
        const projectPath = selection.project.projectPath;
        await mcp!.call("TESTER", "runner", "prepare_dependencies", { projectPath }, 0);
        const result = parseToolJson<{
          status: string;
          exitCode?: number;
          stdout?: string;
          stderr?: string;
          noTestsCollected?: boolean;
          command?: string;
          durationMs?: number;
        }>(await mcp!.call("TESTER", "runner", "run_test", { projectPath, only: testPath }, 0));
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
          reproductionProof = {
            path: testPath,
            sha256: testHash,
            baselineArtifactHash: baseline.hash,
            testRunId: evidence.id,
          };
        return { failed: result.exitCode !== 0, output, ran: true };
      };

      // Read the project's test layout before writing anything, so the
      // Reproducer is told where tests live rather than guessing.
      // Select the project from what research implicated, not from nothing.
      // With an empty file list select_project falls back to an arbitrary
      // project, so a two-project repository handed the Reproducer the
      // conventions of whichever one sorted first - and it dutifully wrote a
      // backend test for a frontend bug.
      const researchFiles = [
        ...new Set(
          reports.flatMap((report) => [
            ...report.relevantFiles,
            ...report.relevantTests,
            ...report.evidence.map((item) => item.path),
          ]),
        ),
      ].filter(Boolean);
      const detected = parseToolJson<{
        status: string;
        project?: { projectPath: string; testConventions?: Record<string, unknown> };
      }>(await mcp.call("TESTER", "runner", "select_project", { changedFiles: researchFiles }, 0));
      const conventions = detected.project
        ? { ...detected.project.testConventions, projectPath: detected.project.projectPath }
        : undefined;
      const produced = await reproducer(
        taskId,
        issue,
        reports,
        mcp,
        0,
        researchArtifacts,
        verify,
        conventions,
      );
      reproduction = produced.report;
      researchArtifacts.push(produced.artifactId);
      await updateTaskWithLease(taskId, {
        reproductionReport: reproduction as never,
        reproductionProof: reproductionProof ? (reproductionProof as never) : Prisma.DbNull,
        reviewArtifact: reproductionBaseline ? (reproductionBaseline as never) : Prisma.DbNull,
      });

      const decision = routeAfterReproduction(reproduction);
      await event(taskId, "MANAGER_DECISION", `Manager selected ${decision.next}`, decision.reason, 0);
      if (decision.next !== "CODER") {
        await state(taskId, "NEEDS_ATTENTION", decision.reason, 0);
        return;
      }
    }

    const reproductionTestPath = reproduction?.reproduced ? reproduction.testPath : undefined;
    if (!reproductionTestPath || !reproductionProof || reproductionProof.path !== reproductionTestPath) {
      throw new Error(
        "A recorded failing reproduction with a protected test is required; start a fresh task",
      );
    }
    await assertReproduction(repoRoot, reproductionProof);
    await mcp.protectReproduction(reproductionTestPath);

    /* -------------------------------------------------- code / test / review */
    let revision = task.revisionCycle;
    let testAttempts = task.attempt;
    let patch = task.patchProposal as unknown as PatchProposal | null;
    let diff = task.diff ?? "";
    let reuseExistingPatch = Boolean(
      patch && diff && (resumeState === "TESTING" || resumeState === "REVIEWING"),
    );
    let reuseVerifiedTests = Boolean(
      resumeState === "REVIEWING" &&
      task.reviewArtifact &&
      task.testReport &&
      (task.testReport as unknown as TestReport).passed === true &&
      (task.testReport as unknown as TestReport).reproductionFixed === "passed" &&
      (task.testReport as unknown as TestReport).artifactHash ===
        (task.reviewArtifact as unknown as ReviewArtifact).hash,
    );
    let verifiedArtifact: ReviewArtifact | undefined;
    if (reuseVerifiedTests) verifiedArtifact = await assertArtifactCurrent(repoRoot, task.reviewArtifact);
    let lastEvidence: TestReport | ReviewReport | undefined;
    let attempts = await attemptHistory(taskId);

    while (revision <= task.maxRevisions && testAttempts < task.maxAttempts) {
      const usage = await db.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { _count: { select: { agentRuns: true } } },
      });
      if (
        usage.modelCalls - startingModelCalls >= usage.maxModelCalls ||
        usage._count.agentRuns - startingAgentRuns >= usage.maxAgentRuns ||
        Date.now() - runStarted > usage.timeoutMs
      ) {
        await state(
          taskId,
          "NEEDS_ATTENTION",
          "Manager stopped at the configured run, model, or wall-clock budget",
          revision,
        );
        return;
      }

      const resumedTests = reuseVerifiedTests;
      let testReport: TestReport;
      let testArtifactId = "";

      if (reuseVerifiedTests) {
        testReport = task.testReport as unknown as TestReport;
        testArtifactId =
          (
            await db.agentMessage.findFirst({
              where: { taskId, type: "TEST_REPORT" },
              orderBy: { createdAt: "desc" },
            })
          )?.id ?? "";
        reuseVerifiedTests = false;
        reuseExistingPatch = false;
      } else {
        let codeArtifactIds = researchArtifacts;

        if (reuseExistingPatch) {
          await state(
            taskId,
            "TESTING",
            "Manager resumed empirical verification of the existing patch",
            revision,
          );
          reuseExistingPatch = false;
        } else {
          await state(
            taskId,
            revision ? "RE_CODING" : "CODING",
            revision
              ? "Manager requested a scoped code revision"
              : "Manager delegated implementation to the Coder",
            revision,
          );
          const coded = await coder(taskId, issue, reports, mcp, revision, researchArtifacts, {
            reproduction,
            previous: lastEvidence,
            attempts,
          });
          patch = coded.report;
          await assertReproduction(repoRoot, reproductionProof);
          const codedArtifact = await captureArtifact(repoRoot, base, reproductionProof);
          diff = codedArtifact.diff;
          if (!diff.trim()) throw new Error("Coder returned without a patch");
          await updateTaskWithLease(taskId, {
            patchProposal: patch as never,
            reviewArtifact: codedArtifact as never,
            diff,
            summary: patch.summary,
          });
          await injectFault("after_coding_checkpoint");
          codeArtifactIds = [coded.artifactId];

          /* ---- deterministic scope guard, before spending a test run ---- */
          const verdict = assessScope(
            codedArtifact.files.map((file) => file.path),
            reports,
            { reproductionTestPath },
          );
          await db.taskEvent.create({
            data: {
              taskId,
              type: verdict.withinScope ? "SCOPE_OK" : "SCOPE_VIOLATION",
              title: verdict.withinScope
                ? "Patch stayed within the researched surface"
                : `Patch touched ${verdict.unrelatedFiles.length} unrelated file(s)`,
              detail: verdict.reason,
              agentRole: "MANAGER",
              status: verdict.withinScope ? "COMPLETED" : "DENIED",
              iteration: revision,
              output: verdict as never,
            },
          });

          const scopeDecision = routeAfterScopeCheck(verdict, {
            revisionCycle: revision,
            maxRevisions: task.maxRevisions,
          });
          if (scopeDecision.next !== "TESTER") {
            await event(
              taskId,
              "MANAGER_DECISION",
              `Manager selected ${scopeDecision.next}`,
              scopeDecision.reason,
              revision,
            );
            if (scopeDecision.next === "NEEDS_ATTENTION") {
              await state(taskId, "NEEDS_ATTENTION", scopeDecision.reason, revision);
              return;
            }
            attempts = [
              ...attempts,
              {
                revision,
                summary: patch.summary,
                filesChanged: patch.filesChanged,
                outcome: "review-rejected",
                evidence: scopeDecision.reason,
              },
            ];
            revision++;
            await updateTaskWithLease(taskId, { revisionCycle: revision });
            continue;
          }

          await state(taskId, "TESTING", "Manager delegated empirical verification to the Tester", revision);
        }

        testAttempts++;
        // The workspace is writable during test runs, because a read-only
        // mount breaks any project whose test config is TypeScript. The
        // property that mattered is preserved by checking it instead: if the
        // repository's own test suite modified the tree, the diff a human
        // would approve is not the diff that was tested.
        const artifact = await captureArtifact(repoRoot, base, reproductionProof);
        diff = artifact.diff;
        await updateTaskWithLease(taskId, {
          reviewArtifact: artifact as never,
          diff,
          testReport: Prisma.DbNull,
          reviewReport: Prisma.DbNull,
          approvalHash: null,
          approvedAt: null,
        });
        await injectFault("during_testing");
        const tested = await tester(
          taskId,
          issue,
          patch!,
          diff,
          mcp,
          testAttempts,
          codeArtifactIds,
          reproductionTestPath,
          { root: repoRoot, artifact },
        );
        testReport = tested.report;
        testArtifactId = tested.artifactId;
        await updateTaskWithLease(taskId, { testReport: testReport as never, attempt: testAttempts });

        const afterTests = await captureArtifact(repoRoot, base, reproductionProof);
        if (afterTests.hash !== artifact.hash) {
          await event(
            taskId,
            "WORKSPACE_TAMPERED",
            "The test run modified the workspace",
            "Running the repository's tests changed tracked files, so the tested tree is not the " +
              "reviewed tree. Stopping rather than asking a human to approve a diff that was never tested.",
            revision,
          );
          await state(
            taskId,
            "NEEDS_ATTENTION",
            "The repository's test suite modified the working tree during verification",
            revision,
          );
          return;
        }
        diff = artifact.diff;
        verifiedArtifact = artifact;
      }

      /* ---- routing after tests ---- */
      const testsAccepted = testReport.passed === true && testReport.reproductionFixed === "passed";
      if (!testsAccepted) {
        const infrastructureFailure = testReport.suggestedNextAction === "NEEDS_ATTENTION";
        const advisory = infrastructureFailure
          ? undefined
          : await managerDecide(taskId, { testReport, revisionCycle: revision }, mcp, revision);
        const decision = routeAfterTest(testReport, advisory, revision, task.maxRevisions);
        await event(
          taskId,
          "MANAGER_DECISION",
          `Manager selected ${decision.next}`,
          decision.reason,
          revision,
        );

        lastEvidence = testReport;
        if (patch) {
          attempts = [
            ...attempts,
            {
              revision,
              summary: patch.summary,
              filesChanged: patch.filesChanged,
              outcome: "tests-failed",
              evidence:
                testReport.failures.map((failure) => failure.message).join("; ") || testReport.summary,
            },
          ];
        }

        if (decision.next === "RESEARCHER" && revision < task.maxRevisions) {
          await state(taskId, "RE_RESEARCHING", "Manager requested targeted re-investigation", revision + 1);
          const extra = await researcher(
            taskId,
            issue,
            { type: "implementation", objective: `Investigate failed checks: ${testReport.summary}` },
            mcp,
            revision + 1,
            managerRunId,
            testReport,
          );
          reports.push(extra.report);
          researchArtifacts.push(extra.artifactId);
        } else if (decision.next !== "CODER") {
          await state(taskId, "NEEDS_ATTENTION", decision.reason, revision);
          return;
        }
        revision++;
        await updateTaskWithLease(taskId, { revisionCycle: revision });
        continue;
      }

      /* ---- review ---- */
      await state(
        taskId,
        "REVIEWING",
        resumedTests
          ? "Manager resumed from verified tests and delegated review"
          : "Manager delegated an independent review",
        revision,
      );
      const reviewed = await reviewer(
        taskId,
        issue,
        reports,
        diff,
        testReport,
        mcp,
        revision,
        [...researchArtifacts, ...(testArtifactId ? [testArtifactId] : [])],
        reproduction,
      );
      const review = reviewed.report;
      await updateTaskWithLease(taskId, { reviewReport: review as never });

      const advisory =
        review.decision === "reject"
          ? await managerDecide(
              taskId,
              { testReport, reviewReport: review, revisionCycle: revision },
              mcp,
              revision,
            )
          : undefined;
      const decision = routeAfterReview(review, advisory, revision, task.maxRevisions);
      await event(taskId, "MANAGER_DECISION", `Manager selected ${decision.next}`, decision.reason, revision);

      if (decision.next !== "HUMAN_APPROVAL" && patch) {
        attempts = [
          ...attempts,
          {
            revision,
            summary: patch.summary,
            filesChanged: patch.filesChanged,
            outcome: "review-rejected",
            evidence: review.findings.map((finding) => finding.title).join("; ") || review.reasoning,
          },
        ];
      }

      if (decision.next === "RESEARCHER") {
        await state(
          taskId,
          "RE_RESEARCHING",
          "Manager requested targeted research from reviewer findings",
          revision + 1,
        );
        const extra = await researcher(
          taskId,
          issue,
          {
            type: "implementation",
            objective: `Investigate reviewer findings: ${review.reasoning.slice(0, 500)}`,
          },
          mcp,
          revision + 1,
          reviewed.runId,
        );
        reports.push(extra.report);
        researchArtifacts.push(extra.artifactId);
        lastEvidence = review;
        revision++;
        await updateTaskWithLease(taskId, { revisionCycle: revision });
        continue;
      }

      if (decision.next === "CODER") {
        await state(
          taskId,
          "REVISION_REQUESTED",
          "Reviewer rejected the patch and returned findings",
          revision,
        );
        lastEvidence = review;
        revision++;
        await updateTaskWithLease(taskId, { revisionCycle: revision });
        continue;
      }

      if (decision.next !== "HUMAN_APPROVAL") {
        await state(taskId, "NEEDS_ATTENTION", decision.reason, revision);
        return;
      }

      /* ---- human gate ---- */
      if (!verifiedArtifact) throw new Error("Verified artifact is missing");
      await assertArtifactCurrent(repoRoot, verifiedArtifact);
      const tests = await db.testRun.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
      const hash = artifactApprovalHash({
        taskId,
        repository: task.repositoryUrl,
        targetBranch: task.baseBranch,
        artifact: verifiedArtifact,
        report: testReport,
        tests,
      });

      await updateTaskWithLease(taskId, {
        state: "AWAITING_HUMAN_APPROVAL",
        currentAgent: null,
        diff,
        approvalHash: hash,
        reviewReport: review as never,
      });
      await event(
        taskId,
        "HUMAN_APPROVAL_REQUIRED",
        "Reviewer approved; exact patch awaits human authorization",
        `Fingerprint ${hash.slice(0, 16)}`,
        revision,
      );
      return;
    }

    await state(taskId, "NEEDS_ATTENTION", "Manager stopped at the configured iteration limit");
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await updateTaskWithLease(taskId, { state: "FAILED", currentAgent: null, error: message }).catch(
      () => {},
    );
    await event(taskId, "RUN_FAILED", "Multi-agent run failed", message).catch(() => {});
    throw error;
  } finally {
    await mcp?.close();
  }
}

export { McpTools } from "./mcp.js";
export { RoleModel, GeminiModel, type AgentModel } from "./model.js";
export { resolveProvider, reviewerIsIndependent, parseSpec, type ModelRole } from "./model/registry.js";
export { FakeProvider, ReplayProvider, RecordingProvider } from "./model/index.js";
export { assessScope, changedFilesFromDiff, changedFilesFromNameStatus } from "./scope.js";
export { attemptHistory };
export { validateReviewPackage } from "./review-artifact.js";
