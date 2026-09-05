import path from "node:path";
import { fileURLToPath } from "node:url";

const inferredProjectRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export function projectRoot() {
  const configured = process.env.BUGWRIGHT_PROJECT_ROOT;
  return configured ? path.resolve(inferredProjectRoot, configured) : inferredProjectRoot;
}

export function workspaceRoot() {
  const configured = process.env.BUGWRIGHT_WORKSPACE_ROOT ?? "workspaces";
  return path.resolve(projectRoot(), configured);
}
