import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAppAuth } from "@octokit/auth-app";
import { db } from "@bugpilot/database";
import { assertEditable } from "@bugpilot/policy";
import { McpTools, changedFilesFromNameStatus } from "@bugpilot/agent";

async function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n");
  if (!appId || !installationId || !privateKey) throw new Error("GitHub App credentials are missing");
  const auth = createAppAuth({ appId, installationId, privateKey });
  return (await auth({ type: "installation" })).token;
}

async function gh<T>(route: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${route}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "BugPilot/0.2",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 1200)}`);
  }
  return (await response.json()) as T;
}

/**
 * Publishes the approved patch as a draft pull request.
 *
 * Idempotent by construction, because it is a retryable background job:
 *
 *  - The whole patch becomes ONE commit built through the Git Data API (blobs,
 *    a tree, a commit, then a ref update) rather than a sequence of Contents
 *    API calls. A crash halfway through no longer leaves a partially written
 *    branch, and a 10-file patch costs a handful of requests instead of twenty.
 *  - An existing branch is reused and fast-forwarded rather than re-created.
 *  - An open pull request from the same head is reused rather than duplicated.
 *
 * This is ordinary trusted backend code. No agent can reach it, and it refuses
 * to run without a persisted human approval matching the current fingerprint.
 */
export async function publishTask(taskId: string) {
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { approvals: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  if (task.state !== "PUBLISHING" || !task.approvedAt || task.approvals[0]?.hash !== task.approvalHash) {
    throw new Error("A matching human approval is required");
  }
  if (!task.workspacePath || !task.baseCommit) throw new Error("Workspace is unavailable");

  const accessToken = await token();
  const owner = task.repositoryOwner;
  const repo = task.repositoryName;
  const branch = `bugpilot/issue-${task.issueNumber}-${task.id.slice(-6)}`;
  const ref = `refs/heads/${branch}`;

  /* ---- collect the changed files ---- */
  const mcp = new McpTools(task.id, task.workspacePath);
  await mcp.connect(["git"], ["REVIEWER"]);
  let nameStatus = "";
  try {
    const raw = await mcp.callTrusted("git", "get_changed_files");
    nameStatus = (JSON.parse(raw) as { stdout: string }).stdout;
  } finally {
    await mcp.close();
  }

  const entries = nameStatus
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...parts] = line.split("\t");
      return { deleted: status.startsWith("D"), file: assertEditable(parts.at(-1) ?? "") };
    });
  if (!entries.length) throw new Error("Nothing to publish: the approved diff is empty");

  /* ---- one tree, one commit ---- */
  type TreeEntry = {
    path: string;
    mode: "100644";
    type: "blob";
    sha?: string | null;
    content?: string;
  };
  const tree: TreeEntry[] = [];

  for (const entry of entries) {
    if (entry.deleted) {
      // A null sha in a tree deletes the path.
      tree.push({ path: entry.file, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const content = await readFile(path.join(task.workspacePath, entry.file));
    // Blobs are uploaded base64 so binary files survive the round trip.
    const blob = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, accessToken, {
      method: "POST",
      body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }),
    });
    tree.push({ path: entry.file, mode: "100644", type: "blob", sha: blob.sha });
  }

  const createdTree = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, accessToken, {
    method: "POST",
    body: JSON.stringify({ base_tree: task.baseCommit, tree }),
  });

  const commit = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      message: `fix: ${task.issueTitle ?? `issue #${task.issueNumber}`}\n\nFixes #${task.issueNumber}`,
      tree: createdTree.sha,
      parents: [task.baseCommit],
    }),
  });

  /* ---- create or fast-forward the branch ---- */
  const existingRef = await gh<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    accessToken,
  ).catch(() => null);

  if (existingRef) {
    await gh(`/repos/${owner}/${repo}/git/${ref}`, accessToken, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: true }),
    });
  } else {
    await gh(`/repos/${owner}/${repo}/git/refs`, accessToken, {
      method: "POST",
      body: JSON.stringify({ ref, sha: commit.sha }),
    });
  }

  /* ---- create or reuse the pull request ---- */
  const open = await gh<Array<{ html_url: string }>>(
    `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
    accessToken,
  ).catch(() => []);

  const pr = open.length
    ? open[0]
    : await gh<{ html_url: string }>(`/repos/${owner}/${repo}/pulls`, accessToken, {
        method: "POST",
        body: JSON.stringify({
          title: `fix: ${task.issueTitle ?? `issue #${task.issueNumber}`}`,
          body:
            `Fixes #${task.issueNumber}\n\n${task.summary ?? "Patch generated by BugPilot."}\n\n` +
            "Reviewed by an independent agent and authorized by a human against a " +
            "SHA-256 fingerprint of this exact diff and its test evidence.",
          head: branch,
          base: task.baseBranch,
          draft: true,
        }),
      });

  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: { state: "COMPLETED", pullRequestUrl: pr.html_url },
    }),
    db.taskEvent.create({
      data: {
        taskId: task.id,
        type: "PR_CREATED",
        title: open.length ? "Draft pull request updated" : "Draft pull request created",
        detail: pr.html_url,
      },
    }),
  ]);
}
