import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CommandSpec,
  DetectedProject,
  Operation,
  adapterFor,
  detectProjects,
  selectProject,
} from "@bugpilot/adapters";

const root = path.resolve(process.env.BUGPILOT_REPO_ROOT ?? "");
if (!process.env.BUGPILOT_REPO_ROOT) throw new Error("BUGPILOT_REPO_ROOT is required");
const dockerBin = process.env.BUGPILOT_DOCKER_BIN ?? "docker";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/**
 * The model supplies an operation and a project path that detection already
 * returned. It never supplies a command, an image, a mount, or a flag. Every
 * argv is built here from the adapter, and executed directly rather than
 * through `sh -lc`, so there is no shell to inject into.
 */
async function run(project: DetectedProject, command: CommandSpec, readOnly: boolean) {
  const adapter = adapterFor(project.adapter);
  const workdir = command.projectPath === "." ? "/workspace" : `/workspace/${command.projectPath}`;
  const scope = createHash("sha256").update(`${root}\0${command.projectPath}`).digest("hex").slice(0, 20);

  const args = [
    "run",
    "--rm",
    "--network",
    command.network,
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--pids-limit",
    "256",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    // The repository is mounted read-only and a writable overlay is layered on
    // top for anything the toolchain needs to create. A hostile test suite in
    // an untrusted repository therefore cannot rewrite the source under review,
    // or the .git directory the diff is computed from.
    "-v",
    `${root}:/workspace${readOnly ? ":ro" : ""}`,
    ...(readOnly ? ["--tmpfs", "/tmp:rw,noexec,nosuid,size=256m"] : []),
    ...adapter
      .cacheMounts(project)
      .flatMap((mount) => ["-v", `bugpilot-${mount.key}-${scope}:${mount.containerPath}`]),
    "-w",
    workdir,
    adapter.image,
    ...command.argv,
  ];

  const started = Date.now();
  return await new Promise<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>((resolve, reject) => {
    const child = spawn(dockerBin, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), command.timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: command.argv.join(" "),
        exitCode: code ?? -1,
        stdout: stdout.slice(-100_000),
        stderr: stderr.slice(-50_000),
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Re-detects to resolve a project path the caller named. */
async function resolveProject(projectPath: string): Promise<DetectedProject> {
  const projects = await detectProjects(root);
  const match = projects.find((project) => project.projectPath === projectPath);
  if (!match) throw new Error(`No detected project at "${projectPath}"`);
  return match;
}

/**
 * Turns "this project does not define that operation" into a first-class,
 * successful result rather than a non-zero exit the Tester would misread as a
 * genuine failure.
 */
async function execute(operation: Operation, project: DetectedProject, readOnly = true) {
  if (!operation.configured) {
    return text({ status: "not_configured", reason: operation.reason, projectPath: project.projectPath });
  }
  const result = await run(project, operation.command, readOnly);
  return text({ status: "ran", projectPath: project.projectPath, ...result });
}

const projectInput = { projectPath: z.string().default(".") };

const server = new McpServer({ name: "bugpilot-runner", version: "0.2.0" });

server.tool("detect_project", "Detect every verifiable project in the repository", {}, async () => {
  const projects = await detectProjects(root);
  if (!projects.length) {
    return text({
      status: "unsupported",
      reason:
        "No Node or Python project was detected. BugPilot can read and patch this repository but cannot verify it.",
      projects: [],
    });
  }
  return text({ status: "detected", projects });
});

server.tool(
  "select_project",
  "Choose the project a set of changed files belongs to",
  { changedFiles: z.array(z.string()).default([]) },
  async ({ changedFiles }) => {
    const projects = await detectProjects(root);
    const selected = selectProject(projects, changedFiles);
    if (!selected) return text({ status: "unsupported", reason: "No verifiable project detected" });
    return text({ status: "selected", project: selected });
  },
);

server.tool(
  "prepare_dependencies",
  "Install locked dependencies with lifecycle scripts disabled and temporary network access",
  projectInput,
  async ({ projectPath }) => {
    const project = await resolveProject(projectPath);
    // Installation is the one step that writes into the workspace, so it runs
    // without the read-only mount.
    return execute(adapterFor(project.adapter).install(project), project, false);
  },
);

server.tool(
  "run_test",
  "Run the project's test suite in an isolated container",
  { ...projectInput, only: z.string().max(400).optional() },
  async ({ projectPath, only }) => {
    const project = await resolveProject(projectPath);
    return execute(adapterFor(project.adapter).test(project, { only }), project);
  },
);

server.tool("run_typecheck", "Run the project's type checker", projectInput, async ({ projectPath }) => {
  const project = await resolveProject(projectPath);
  return execute(adapterFor(project.adapter).typecheck(project), project);
});

server.tool(
  "run_lint",
  "Lint the changed files only",
  { ...projectInput, changedFiles: z.array(z.string()).default([]) },
  async ({ projectPath, changedFiles }) => {
    const project = await resolveProject(projectPath);
    return execute(adapterFor(project.adapter).lint(project, { changedFiles }), project);
  },
);

await server.connect(new StdioServerTransport());
