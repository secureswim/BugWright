import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const root = path.resolve(process.env.BUGPILOT_REPO_ROOT ?? "");
const image = process.env.BUGPILOT_RUNNER_IMAGE ?? "bugpilot-runner:latest";
const dockerBin = process.env.BUGPILOT_DOCKER_BIN ?? "docker";
if (!process.env.BUGPILOT_REPO_ROOT) throw new Error("BUGPILOT_REPO_ROOT is required");
const allowed = new Set([
  "npm test",
  "npm run typecheck",
  "npm run lint",
  "pnpm test",
  "pnpm run typecheck",
  "pnpm run lint",
  "yarn test",
  "yarn typecheck",
  "yarn lint",
  "npm ci --ignore-scripts --no-audit --no-fund",
  "pnpm install --frozen-lockfile --ignore-scripts",
  "yarn install --immutable --ignore-scripts",
]);
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
async function exists(file: string) {
  try {
    await access(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}
function safeProjectPath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "") || ".";
  if (path.isAbsolute(normalized) || normalized.split("/").includes(".."))
    throw new Error("Invalid project path");
  return normalized;
}
async function docker(command: string, network = "none", timeoutMs = 5 * 60_000, projectPath = ".") {
  if (!allowed.has(command)) throw new Error("Command is not on the runner allowlist");
  const project = safeProjectPath(projectPath),
    workdir = project === "." ? "/workspace" : `/workspace/${project}`,
    key = createHash("sha256").update(`${root}\0${project}`).digest("hex").slice(0, 20),
    dependencyVolume = `bugpilot-deps-${key}`,
    storeVolume = `bugpilot-store-${key}`,
    args = [
      "run",
      "--rm",
      "--network",
      network,
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
      "-v",
      `${root}:/workspace`,
      "-v",
      `${dependencyVolume}:${workdir}/node_modules`,
      "-v",
      `${storeVolume}:/workspace/.pnpm-store`,
      "-w",
      workdir,
      image,
      "sh",
      "-lc",
      command,
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
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: code ?? -1,
        stdout: stdout.slice(-100_000),
        stderr: stderr.slice(-50_000),
        durationMs: Date.now() - started,
      });
    });
  });
}
const server = new McpServer({ name: "bugpilot-runner", version: "0.1.0" });
server.tool("detect_project", "Detect package manager and available scripts", {}, async () => {
  const candidates: string[] = [];
  if (await exists("package.json")) candidates.push(".");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules" &&
      (await exists(`${entry.name}/package.json`))
    )
      candidates.push(entry.name);
  }
  if (!candidates.length) return text({ kind: "unknown", commands: [], projects: [] });
  const projects = [];
  for (const projectPath of candidates) {
    const prefix = projectPath === "." ? "" : `${projectPath}/`,
      pkg = JSON.parse(await readFile(path.join(root, prefix, "package.json"), "utf8")),
      packageManager = (await exists(`${prefix}pnpm-lock.yaml`))
        ? "pnpm"
        : (await exists(`${prefix}yarn.lock`))
          ? "yarn"
          : "npm",
      lockfile =
        packageManager === "pnpm"
          ? "pnpm-lock.yaml"
          : packageManager === "yarn"
            ? "yarn.lock"
            : "package-lock.json";
    projects.push({
      kind: "node",
      projectPath,
      packageManager,
      hasLockfile: await exists(`${prefix}${lockfile}`),
      scripts: pkg.scripts ?? {},
    });
  }
  return text({ ...projects[0], projects });
});
function commandFor(kind: "test" | "typecheck" | "lint", manager: string) {
  if (manager === "pnpm") return kind === "test" ? "pnpm test" : `pnpm run ${kind}`;
  if (manager === "yarn") return kind === "test" ? "yarn test" : `yarn ${kind}`;
  return kind === "test" ? "npm test" : `npm run ${kind}`;
}
const projectInput = {
  packageManager: z.enum(["npm", "pnpm", "yarn"]),
  projectPath: z.string().default("."),
};
server.tool(
  "prepare_dependencies",
  "Install locked dependencies with lifecycle scripts disabled and temporary network access",
  projectInput,
  async ({ packageManager, projectPath }) => {
    const command =
      packageManager === "pnpm"
        ? "pnpm install --frozen-lockfile --ignore-scripts"
        : packageManager === "yarn"
          ? "yarn install --immutable --ignore-scripts"
          : "npm ci --ignore-scripts --no-audit --no-fund";
    return text(await docker(command, "bridge", 10 * 60_000, projectPath));
  },
);
server.tool(
  "run_test",
  "Run the repository test script in Docker",
  projectInput,
  async ({ packageManager, projectPath }) =>
    text(await docker(commandFor("test", packageManager), "none", 5 * 60_000, projectPath)),
);
server.tool(
  "run_typecheck",
  "Run the repository typecheck script in Docker",
  projectInput,
  async ({ packageManager, projectPath }) =>
    text(await docker(commandFor("typecheck", packageManager), "none", 5 * 60_000, projectPath)),
);
server.tool(
  "run_lint",
  "Run the repository lint script in Docker",
  projectInput,
  async ({ packageManager, projectPath }) =>
    text(await docker(commandFor("lint", packageManager), "none", 5 * 60_000, projectPath)),
);
await server.connect(new StdioServerTransport());
