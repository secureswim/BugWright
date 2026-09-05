import "dotenv/config";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { db } from "@bugwright/database";
import { McpTools } from "@bugwright/agent";
const project = path.resolve(process.env.BUGWRIGHT_PROJECT_ROOT ?? process.cwd()),
  workspace = path.join(project, "workspaces", "mcp-smoke");
await rm(workspace, { recursive: true, force: true });
await mkdir(path.dirname(workspace), { recursive: true });
await cp(path.join(project, "fixtures", "calculator-bug"), workspace, { recursive: true });
const task = await db.task.create({
    data: {
      repositoryUrl: "https://github.com/bugwright/mcp-smoke",
      repositoryOwner: "bugwright",
      repositoryName: "mcp-smoke",
      issueNumber: 1,
      issueTitle: "MCP smoke test",
      baseBranch: "main",
      demoMode: true,
      state: "TESTING",
      workspacePath: workspace,
    },
  }),
  mcp = new McpTools(task.id, workspace);
await mcp.connect(["repository", "runner"]);
let denied = false;
try {
  await mcp.call("RESEARCHER", "repository", "apply_patch", {
    path: "src/calculator.js",
    oldText: "return a - b;",
    newText: "return a + b;",
  });
} catch {
  denied = true;
}
await mcp.call("RESEARCHER", "repository", "read_range", {
  path: "src/calculator.js",
  startLine: 1,
  endLine: 8,
});
await mcp.call("CODER", "repository", "apply_patch", {
  path: "src/calculator.js",
  oldText: "return a - b;",
  newText: "return a + b;",
});
const detected = JSON.parse(await mcp.call("TESTER", "runner", "detect_project"));
const test = JSON.parse(
  await mcp.call("TESTER", "runner", "run_test", { packageManager: detected.packageManager }),
);
await mcp.close();
console.log(
  JSON.stringify(
    {
      leastPrivilegeDenied: denied,
      detection: detected,
      test: { exitCode: test.exitCode, command: test.command, stdout: test.stdout.trim() },
    },
    null,
    2,
  ),
);
await db.$disconnect();
if (!denied || test.exitCode !== 0) process.exit(1);
