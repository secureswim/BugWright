import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const root = path.resolve(process.env.BUGPILOT_REPO_ROOT ?? "");
if (!process.env.BUGPILOT_REPO_ROOT) throw new Error("BUGPILOT_REPO_ROOT is required");
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
async function git(args: string[]) {
  return await new Promise<{exitCode:number;stdout:string;stderr:string}>((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true, shell: false });
    let stdout="", stderr="";
    child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
    child.on("error", reject); child.on("close", code => resolve({exitCode:code ?? -1,stdout:stdout.slice(0,200_000),stderr:stderr.slice(0,30_000)}));
  });
}
const server = new McpServer({name:"bugpilot-git",version:"0.1.0"});
server.tool("get_status", "Get machine-readable repository status", {}, async () => text(await git(["status","--short"])));
server.tool("get_diff", "Get the complete working-tree patch", {}, async () => text(await git(["diff","--no-ext-diff","--binary","--"] )));
server.tool("get_changed_files", "List files changed by the agent", {}, async () => text(await git(["diff","--name-status","--"] )));
server.tool("get_base_commit", "Get the checked-out commit SHA", {}, async () => text(await git(["rev-parse","HEAD"])));
server.tool("get_history", "Read recent commit subjects", {}, async () => text(await git(["log","-n","12","--pretty=format:%h %s"])));
await server.connect(new StdioServerTransport());
