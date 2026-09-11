import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolGate, captureArtifact, resolveInside } from "@bugwright/policy";

const root = path.resolve(process.env.BUGWRIGHT_REPO_ROOT ?? "");
if (!process.env.BUGWRIGHT_REPO_ROOT) throw new Error("BUGWRIGHT_REPO_ROOT is required");

/** Only the tools the connecting role may use are registered. */
const allowed = toolGate();

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
});

async function git(args: string[]) {
  resolveInside(root, ".git");
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

const server = new McpServer({ name: "bugwright-git", version: "0.2.0" });

if (allowed("get_status")) {
  server.tool("get_status", "Get machine-readable repository status", {}, async () =>
    text(await git(["status", "--short"])),
  );
}

if (allowed("get_diff")) {
  server.tool("get_diff", "Get the complete patch including new files", {}, async () => {
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const artifact = await captureArtifact(root, base);
    return text({ exitCode: 0, stdout: artifact.diff, stderr: "" });
  });
}

if (allowed("get_changed_files")) {
  server.tool("get_changed_files", "List files changed by the agent", {}, async () => {
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const artifact = await captureArtifact(root, base);
    return text(await git(["diff", "--no-renames", "--name-status", base, artifact.tree, "--"]));
  });
}

if (allowed("get_base_commit")) {
  server.tool("get_base_commit", "Get the checked-out commit SHA", {}, async () =>
    text(await git(["rev-parse", "HEAD"])),
  );
}

if (allowed("get_history")) {
  server.tool("get_history", "Read recent commit subjects", {}, async () =>
    text(await git(["log", "-n", "12", "--pretty=format:%h %s"])),
  );
}

await server.connect(new StdioServerTransport());
