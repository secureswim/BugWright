import { createHash } from "node:crypto";
import path from "node:path";

export function parseGitHubRepository(url: string) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error("Only public HTTPS GitHub repository URLs are supported");
  return { owner: match[1], name: match[2] };
}

export function resolveInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Path escapes the task workspace");
  }
  return resolved;
}

export function assertSafeRelativePath(value: string) {
  if (!value || path.isAbsolute(value) || value.includes("..") || value.includes("\0")) {
    throw new Error("Unsafe repository path");
  }
  return value.replaceAll("\\", "/");
}

export function approvalHash(input: {
  taskId: string;
  repository: string;
  targetBranch: string;
  baseCommit: string;
  diff: string;
  tests: unknown;
}) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Role and tool authority                                                     */
/* -------------------------------------------------------------------------- */

export type ToolRole = "MANAGER" | "RESEARCHER" | "REPRODUCER" | "CODER" | "TESTER" | "REVIEWER";

const READ_TOOLS = [
  "repository.list_tree",
  "repository.search_code",
  "repository.read_file",
  "repository.read_range",
] as const;

const GIT_INSPECTION = ["git.get_status", "git.get_diff", "git.get_changed_files"] as const;

/**
 * The authoritative role/tool matrix.
 *
 * This is enforced twice, and the two enforcements are different in kind. Here
 * it is an access check with an audit trail. In `McpTools.connect` it becomes
 * structural: each role gets its own server process with only these tools
 * registered, so an unauthorised call fails because the tool does not exist in
 * that session rather than because a caller-side guard chose to refuse.
 */
export const roleToolPermissions: Record<ToolRole, ReadonlySet<string>> = {
  // The Manager orchestrates and has no repository access at all.
  MANAGER: new Set(),
  RESEARCHER: new Set([...READ_TOOLS, ...GIT_INSPECTION, "git.get_history"]),
  // The Reproducer may create test files, but cannot touch application source
  // and cannot execute anything. See `assertTestPath`.
  REPRODUCER: new Set([...READ_TOOLS, ...GIT_INSPECTION, "repository.write_test_file"]),
  CODER: new Set([...READ_TOOLS, ...GIT_INSPECTION, "repository.apply_patch"]),
  TESTER: new Set([
    "runner.detect_project",
    "runner.select_project",
    "runner.prepare_dependencies",
    "runner.run_test",
    "runner.run_typecheck",
    "runner.run_lint",
  ]),
  REVIEWER: new Set([...READ_TOOLS, ...GIT_INSPECTION, "git.get_history"]),
};

export function assertToolAllowed(role: ToolRole, server: string, tool: string) {
  const key = `${server}.${tool}`;
  if (!roleToolPermissions[role].has(key)) {
    throw new Error(`${role} is not authorized to call ${key}`);
  }
  return key;
}

/** MCP servers a role is permitted to connect to at all. */
export function serversForRole(role: ToolRole): string[] {
  const servers = new Set<string>();
  for (const key of roleToolPermissions[role]) servers.add(key.split(".")[0]);
  return [...servers];
}

/** Tool names a role may use on one server, for per-role server construction. */
export function toolsForRole(role: ToolRole, server: string): string[] {
  const prefix = `${server}.`;
  return [...roleToolPermissions[role]]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

/* -------------------------------------------------------------------------- */
/* Protected paths                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Files no agent may write, whatever the patch claims to be doing.
 *
 * The CI and package-manifest entries are not incidental. BugPilot's output is
 * a pull request against someone's repository; a patch that edits
 * `.github/workflows/` or a `package.json` lifecycle script is arbitrary code
 * execution on whatever machine merges it. That is a supply-chain path, so it
 * is closed structurally rather than left to the Reviewer to notice.
 */
export const blockedFiles: RegExp[] = [
  /^\.env(?:\.|$)/,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)\.git\//,
  /(?:^|\/)(?:id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc)$/,
  /(?:^|\/)\.github\/workflows\//,
  /(?:^|\/)\.github\/actions\//,
  /(?:^|\/)(?:\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|\.circleci\/)/,
  /(?:^|\/)(?:Dockerfile|docker-compose\.ya?ml)$/,
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock)$/,
  /(?:^|\/)\.husky\//,
];

/**
 * `package.json` is editable, but its executable surface is not.
 *
 * A postinstall hook runs on every `npm install` downstream, so changing one is
 * indistinguishable from shipping a payload. Blocking the whole file instead
 * would stop legitimate dependency or version fixes, so the check is on the
 * fields that execute.
 */
const EXECUTABLE_MANIFEST_FIELDS = ["scripts", "bin", "gypfile"] as const;

export function assertManifestSafe(pathname: string, before: string, after: string) {
  if (!/(?:^|\/)package\.json$/.test(pathname)) return;
  let previous: Record<string, unknown> = {};
  let next: Record<string, unknown> = {};
  try {
    previous = JSON.parse(before) as Record<string, unknown>;
    next = JSON.parse(after) as Record<string, unknown>;
  } catch {
    throw new Error("A package.json edit must leave valid JSON");
  }
  for (const field of EXECUTABLE_MANIFEST_FIELDS) {
    if (JSON.stringify(previous[field] ?? null) !== JSON.stringify(next[field] ?? null)) {
      throw new Error(`Editing package.json "${field}" is blocked by policy: it executes on install`);
    }
  }
}

export function assertEditable(pathname: string) {
  const safe = assertSafeRelativePath(pathname);
  if (blockedFiles.some((pattern) => pattern.test(safe))) {
    throw new Error("This file is protected by policy");
  }
  return safe;
}

/** Paths that look like tests, which is all the Reproducer may create. */
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.py$/;

/**
 * The Reproducer writes a failing test and nothing else.
 *
 * Restricting it to test paths is what keeps "prove the bug exists" from
 * quietly becoming "change the code until it passes".
 */
export function assertTestPath(pathname: string) {
  const safe = assertEditable(pathname);
  if (!TEST_PATH.test(safe)) {
    throw new Error(`The Reproducer may only create test files; "${safe}" does not look like a test path`);
  }
  return safe;
}

/* -------------------------------------------------------------------------- */
/* Secret scoping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Environment variables each MCP server is allowed to see.
 *
 * Every server used to be spawned with a copy of the whole parent environment,
 * which handed the repository and runner servers the Gemini key, the GitHub
 * token and the database URL - none of which they use, and all of which the
 * README claims the model side never receives. A server now gets only what it
 * needs to do its job.
 */
const SERVER_ENV_ALLOWLIST: Record<string, string[]> = {
  repository: ["BUGPILOT_REPO_ROOT"],
  git: ["BUGPILOT_REPO_ROOT"],
  runner: [
    "BUGPILOT_REPO_ROOT",
    "BUGPILOT_DOCKER_BIN",
    "BUGPILOT_RUNNER_IMAGE_NODE",
    "BUGPILOT_RUNNER_IMAGE_PYTHON",
  ],
  github: ["GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_PRIVATE_KEY"],
};

/** Always needed for Node itself to start, plus the per-role tool gate. */
const BASE_ENV = [
  "PATH",
  "HOME",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "NODE_OPTIONS",
  "TZ",
  "BUGPILOT_ALLOWED_TOOLS",
];

/**
 * Reads the tool gate an MCP server was started with.
 *
 * A server process is spawned per role with `BUGPILOT_ALLOWED_TOOLS` set to
 * exactly the tools that role may call, and registers only those. This is what
 * turns the permission matrix from an access check into a capability boundary:
 * the Tester's repository server has no `read_file` to call, so a violation is
 * not refused - it is unrepresentable.
 *
 * With no gate set every tool is registered, which is what the standalone smoke
 * script and manual runs need.
 */
export function toolGate(environment: NodeJS.ProcessEnv = process.env): (tool: string) => boolean {
  const raw = environment.BUGPILOT_ALLOWED_TOOLS;
  if (raw === undefined) return () => true;
  const allowed = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  return (tool: string) => allowed.has(tool);
}

export function environmentForServer(
  server: string,
  source: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const allowed = new Set([...BASE_ENV, ...(SERVER_ENV_ALLOWLIST[server] ?? [])]);
  const environment: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === "string") environment[key] = value;
  }
  return { ...environment, ...extra };
}
