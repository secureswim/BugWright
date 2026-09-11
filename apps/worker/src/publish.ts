import { randomUUID } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { assertTaskLease, db, transactionWithTaskLease, withTaskLease } from "@bugwright/database";
import { assertEditable, sha256 } from "@bugwright/policy";
import { validateReviewPackage } from "@bugwright/agent";

async function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n");
  if (!appId || !installationId || !privateKey) throw new Error("GitHub App credentials are missing");
  const auth = createAppAuth({ appId, installationId, privateKey });
  return (await auth({ type: "installation" })).token;
}

class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function gh<T>(route: string, accessToken: string, init?: RequestInit): Promise<T> {
  await assertTaskLease();
  const response = await fetch(`https://api.github.com${route}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "BugWright/0.2",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new GitHubError(
      response.status,
      `GitHub ${response.status}: ${(await response.text()).slice(0, 1200)}`,
    );
  }
  await assertTaskLease();
  return (await response.json()) as T;
}

async function optional<T>(request: Promise<T>) {
  try {
    return await request;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

/** Publish one approved artifact under a fenced lease. A durable idempotency
 * record and deterministic branch let a replacement worker recover after any
 * GitHub side effect without opening a duplicate pull request. */
export async function publishTask(taskId: string, owner = `publisher:${process.pid}:${randomUUID()}`) {
  const result = await withTaskLease(taskId, owner, ["PUBLISHING"], async () => {
    try {
      await executePublication(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await transactionWithTaskLease(taskId, async (transaction) => {
        await transaction.task.update({
          where: { id: taskId },
          data: { state: "FAILED", currentAgent: null, error: message },
        });
        await transaction.publicationAttempt.updateMany({
          where: { taskId, status: { not: "COMPLETED" } },
          data: { lastError: message },
        });
        await transaction.taskEvent.create({
          data: { taskId, type: "PUBLISH_FAILED", title: "Draft PR publishing failed", detail: message },
        });
      }).catch(() => {});
      throw error;
    }
  });
  return result.claimed;
}

async function executePublication(taskId: string) {
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { testRuns: true, approvals: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } },
  });
  if (
    task.state !== "PUBLISHING" ||
    !task.approvedAt ||
    task.approvals[0]?.decision !== "APPROVED" ||
    task.approvals[0]?.hash !== task.approvalHash
  ) {
    throw new Error("A matching human approval is required");
  }
  if (!task.workspacePath || !task.baseCommit) throw new Error("Workspace is unavailable");

  const { artifact } = await validateReviewPackage(task);
  const owner = task.repositoryOwner;
  const repo = task.repositoryName;
  const branch = `bugwright/issue-${task.issueNumber}-${task.id.slice(-6)}`;
  const ref = `refs/heads/${branch}`;
  const idempotencyKey = sha256(`${task.id}\0${artifact.hash}\0${task.repositoryUrl}\0${task.baseBranch}`);
  const attempt = await transactionWithTaskLease(taskId, (transaction) =>
    transaction.publicationAttempt.upsert({
      where: { idempotencyKey },
      create: { taskId, artifactHash: artifact.hash, idempotencyKey, status: "STARTED", branch },
      update: {},
    }),
  );
  if (attempt.artifactHash !== artifact.hash || attempt.branch !== branch)
    throw new Error("Publication idempotency record does not match this artifact");
  if (attempt.status === "COMPLETED" && attempt.pullRequestUrl) {
    await finishPublication(taskId, attempt.id, attempt.pullRequestUrl, true);
    return;
  }

  const entries = artifact.files.map((file) => ({ ...file, path: assertEditable(file.path) }));
  if (!entries.length) throw new Error("Nothing to publish: the approved artifact is empty");
  const accessToken = await token();
  const base = await gh<{ tree: { sha: string } }>(
    `/repos/${owner}/${repo}/git/commits/${artifact.baseCommit}`,
    accessToken,
  );
  const existingRef = await optional(
    gh<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      accessToken,
    ),
  );

  let commitSha = attempt.commitSha;
  if (commitSha) {
    const recorded = await gh<{ tree: { sha: string } }>(
      `/repos/${owner}/${repo}/git/commits/${commitSha}`,
      accessToken,
    );
    if (recorded.tree.sha !== artifact.tree)
      throw new Error("Recorded publication commit does not match the reviewed artifact");
  } else if (existingRef) {
    const recovered = await gh<{ tree: { sha: string }; parents?: Array<{ sha: string }> }>(
      `/repos/${owner}/${repo}/git/commits/${existingRef.object.sha}`,
      accessToken,
    );
    if (
      recovered.tree.sha !== artifact.tree ||
      !recovered.parents?.some((p) => p.sha === artifact.baseCommit)
    )
      throw new Error("The existing BugWright branch diverged from this reviewed artifact");
    commitSha = existingRef.object.sha;
    await checkpointPublication(taskId, attempt.id, {
      status: "COMMIT_CREATED",
      commitSha,
      lastError: null,
    });
  }

  if (!commitSha) {
    type TreeEntry = { path: string; mode: "100644" | "100755"; type: "blob"; sha?: string | null };
    const tree: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.content === null) {
        tree.push({ path: entry.path, mode: entry.mode, type: "blob", sha: null });
        continue;
      }
      const blob = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, accessToken, {
        method: "POST",
        body: JSON.stringify({ content: entry.content, encoding: "base64" }),
      });
      tree.push({ path: entry.path, mode: entry.mode, type: "blob", sha: blob.sha });
    }
    const createdTree = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, accessToken, {
      method: "POST",
      body: JSON.stringify({ base_tree: base.tree.sha, tree }),
    });
    if (createdTree.sha !== artifact.tree)
      throw new Error("Published tree does not match the verified artifact");
    await checkpointPublication(taskId, attempt.id, { status: "TREE_CREATED" });

    const commit = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, accessToken, {
      method: "POST",
      body: JSON.stringify({
        message: `fix: ${task.issueTitle ?? `issue #${task.issueNumber}`}\n\nFixes #${task.issueNumber}`,
        tree: createdTree.sha,
        parents: [task.baseCommit],
      }),
    });
    commitSha = commit.sha;
    await checkpointPublication(taskId, attempt.id, {
      status: "COMMIT_CREATED",
      commitSha,
      lastError: null,
    });
  }

  if (existingRef) {
    if (existingRef.object.sha !== commitSha)
      throw new Error("The existing BugWright branch changed during publication");
  } else {
    await gh(`/repos/${owner}/${repo}/git/refs`, accessToken, {
      method: "POST",
      body: JSON.stringify({ ref, sha: commitSha }),
    });
  }
  await checkpointPublication(taskId, attempt.id, { status: "BRANCH_UPDATED" });

  const open = await gh<Array<{ html_url: string }>>(
    `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
    accessToken,
  );
  const pr = open.length
    ? open[0]
    : await gh<{ html_url: string }>(`/repos/${owner}/${repo}/pulls`, accessToken, {
        method: "POST",
        body: JSON.stringify({
          title: `fix: ${task.issueTitle ?? `issue #${task.issueNumber}`}`,
          body:
            `Fixes #${task.issueNumber}\n\n${task.summary ?? "Patch generated by BugWright."}\n\n` +
            "Reviewed by an independent agent and authorized by a human against a " +
            "SHA-256 fingerprint of this exact diff and its test evidence.",
          head: branch,
          base: task.baseBranch,
          draft: true,
        }),
      });
  await finishPublication(taskId, attempt.id, pr.html_url, Boolean(open.length));
}

async function finishPublication(
  taskId: string,
  attemptId: string,
  pullRequestUrl: string,
  recovered: boolean,
) {
  await transactionWithTaskLease(taskId, async (transaction) => {
    await transaction.task.update({
      where: { id: taskId },
      data: { state: "COMPLETED", pullRequestUrl, currentAgent: null },
    });
    await transaction.publicationAttempt.update({
      where: { id: attemptId },
      data: { status: "COMPLETED", pullRequestUrl, lastError: null },
    });
    await transaction.taskEvent.create({
      data: {
        taskId,
        type: "PR_CREATED",
        title: recovered ? "Existing draft pull request recovered" : "Draft pull request created",
        detail: pullRequestUrl,
      },
    });
  });
}

async function checkpointPublication(
  taskId: string,
  attemptId: string,
  data: { status: string; commitSha?: string; lastError?: string | null },
) {
  await transactionWithTaskLease(taskId, (transaction) =>
    transaction.publicationAttempt.update({ where: { id: attemptId }, data }),
  );
}
