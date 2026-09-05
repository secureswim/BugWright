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
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep))
    throw new Error("Path escapes the task workspace");
  return resolved;
}

export function assertSafeRelativePath(value: string) {
  if (!value || path.isAbsolute(value) || value.includes("..") || value.includes("\0"))
    throw new Error("Unsafe repository path");
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

export type ToolRole = "MANAGER" | "RESEARCHER" | "CODER" | "TESTER" | "REVIEWER";
export const roleToolPermissions: Record<ToolRole, ReadonlySet<string>> = {
  MANAGER: new Set(),
  RESEARCHER: new Set([
    "repository.list_tree",
    "repository.search_code",
    "repository.read_file",
    "repository.read_range",
    "git.get_history",
    "git.get_status",
    "git.get_diff",
    "git.get_changed_files",
  ]),
  CODER: new Set([
    "repository.list_tree",
    "repository.search_code",
    "repository.read_file",
    "repository.read_range",
    "repository.apply_patch",
    "git.get_status",
    "git.get_diff",
    "git.get_changed_files",
  ]),
  TESTER: new Set([
    "runner.detect_project",
    "runner.prepare_dependencies",
    "runner.run_test",
    "runner.run_typecheck",
    "runner.run_lint",
  ]),
  REVIEWER: new Set([
    "repository.list_tree",
    "repository.search_code",
    "repository.read_file",
    "repository.read_range",
    "git.get_diff",
    "git.get_changed_files",
    "git.get_status",
    "git.get_history",
  ]),
};
export function assertToolAllowed(role: ToolRole, server: string, tool: string) {
  const key = `${server}.${tool}`;
  if (!roleToolPermissions[role].has(key)) throw new Error(`${role} is not authorized to call ${key}`);
  return key;
}

export const blockedFiles = [/^\.env(?:\.|$)/, /(?:^|\/)\.git\//, /(?:^|\/)(?:id_rsa|id_ed25519)$/];
export function assertEditable(pathname: string) {
  const safe = assertSafeRelativePath(pathname);
  if (blockedFiles.some((pattern) => pattern.test(safe))) throw new Error("This file is protected by policy");
  return safe;
}
