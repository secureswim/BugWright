import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildRunArgs } from "./sandbox.js";
import {
  CommandSpec,
  DetectedProject,
  Operation,
  adapterFor,
  detectNoTestsCollected,
  detectProjects,
  relativeToProject,
  selectProject,
} from "@bugwright/adapters";

const root = path.resolve(process.env.BUGWRIGHT_REPO_ROOT ?? "");
if (!process.env.BUGWRIGHT_REPO_ROOT) throw new Error("BUGWRIGHT_REPO_ROOT is required");
const dockerBin = process.env.BUGWRIGHT_DOCKER_BIN ?? "docker";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/** The unprivileged user the runner images execute as. */
const RUNNER_UID = "10001";

/** Cache volumes already known to be writable by that user, per server process. */
const preparedVolumes = new Set<string>();

/**
 * Make a named cache volume writable by the unprivileged runner user.
 *
 * Docker seeds a named volume from the image when the mount point exists there,
 * preserving its ownership - which is why `/workspace/node_modules` works: the
 * Dockerfile creates and chowns it. A project nested inside the repository
 * mounts at `/workspace/<project>/node_modules`, a path no image can know in
 * advance, so Docker creates an empty volume owned by root and the install
 * fails with EACCES the moment it tries to write.
 *
 * A short root container fixes the ownership once per volume. Nothing from the
 * repository under test runs in it: no workspace mount, no network, a fixed
 * argv, and only the volume attached.
 */
async function prepareVolume(image: string, volume: string, containerPath: string): Promise<void> {
  if (preparedVolumes.has(volume)) return;
  preparedVolumes.add(volume);
  await new Promise<void>((resolve) => {
    const child = spawn(
      dockerBin,
      [
        "run",
        "--rm",
        "--user",
        "0:0",
        "--network",
        "none",
        "-v",
        `${volume}:${containerPath}`,
        image,
        "chown",
        "-R",
        `${RUNNER_UID}:${RUNNER_UID}`,
        containerPath,
      ],
      { windowsHide: true, shell: false },
    );
    // Best effort: if this fails the real command still runs and reports the
    // permission error itself, which is more informative than failing here.
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

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
  const mounts = adapter
    .cacheMounts(project)
    .map((mount) => ({ volume: `bugwright-${mount.key}-${scope}`, containerPath: mount.containerPath }));

  for (const mount of mounts) {
    await prepareVolume(adapter.image, mount.volume, mount.containerPath);
  }

  const args = buildRunArgs({ image: adapter.image, root, workdir, command, mounts, readOnly });

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
async function execute(
  operation: Operation,
  project: DetectedProject,
  readOnly = true,
  extra: Record<string, unknown> = {},
) {
  if (!operation.configured) {
    return text({ status: "not_configured", reason: operation.reason, projectPath: project.projectPath });
  }
  const result = await run(project, operation.command, readOnly);
  // A runner that collected nothing also exits non-zero. Reporting that
  // separately is what keeps "no test ran" from being read as "the test
  // failed" - which, before a patch, would look like a successful
  // reproduction of a bug that was never executed.
  const noTestsCollected =
    result.exitCode !== 0 && detectNoTestsCollected(`${result.stdout}\n${result.stderr}`);
  return text({ status: "ran", projectPath: project.projectPath, noTestsCollected, ...extra, ...result });
}

const projectInput = { projectPath: z.string().default(".") };

const server = new McpServer({ name: "bugwright-runner", version: "0.2.0" });

server.tool("detect_project", "Detect every verifiable project in the repository", {}, async () => {
  const projects = await detectProjects(root);
  if (!projects.length) {
    return text({
      status: "unsupported",
      reason:
        "No Node or Python project was detected. BugWright can read and patch this repository but cannot verify it.",
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
    // Callers speak repository-relative paths; the command runs with the
    // working directory set to the project, so the path must be rewritten or
    // the runner silently collects nothing.
    const scoped = only ? relativeToProject(project.projectPath, only) : undefined;
    return execute(adapterFor(project.adapter).test(project, { only: scoped }), project, true, {
      requestedOnly: only,
      resolvedOnly: scoped,
    });
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
