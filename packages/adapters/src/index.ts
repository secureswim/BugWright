import { NodeAdapter } from "./node.js";
import { PythonAdapter } from "./python.js";
import { DetectedProject, LanguageAdapter } from "./types.js";

export * from "./types.js";
export { NodeAdapter, scopeToProject } from "./node.js";
export { PythonAdapter } from "./python.js";
export { findProjectDirectories } from "./walk.js";
export { detectNoTestsCollected, relativeToProject } from "./outcome.js";

/** Every adapter BugPilot ships. Order decides ties when a repo matches several. */
export const adapters: LanguageAdapter[] = [new NodeAdapter(), new PythonAdapter()];

export function adapterFor(id: string): LanguageAdapter {
  const adapter = adapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`No language adapter registered for "${id}"`);
  return adapter;
}

/**
 * Runs every adapter over the repository and returns all projects found.
 *
 * A polyglot repository legitimately yields several: a Node frontend and a
 * Python service is one repository with two verifiable projects, and the Tester
 * picks the one the patch actually touched.
 */
export async function detectProjects(root: string): Promise<DetectedProject[]> {
  const found = await Promise.all(adapters.map((adapter) => adapter.detect(root)));
  return found.flat();
}

/**
 * Chooses the project a patch belongs to.
 *
 * Prefers the deepest project that contains a changed file, because in a
 * monorepo the root `package.json` usually orchestrates rather than tests.
 * Falls back to the first detected project when the diff is empty or matches
 * nothing.
 */
export function selectProject(
  projects: DetectedProject[],
  changedFiles: string[],
): DetectedProject | undefined {
  if (!projects.length) return undefined;
  const matching = projects.filter((project) => {
    if (project.projectPath === ".") return true;
    return changedFiles.some(
      (file) => file === project.projectPath || file.startsWith(`${project.projectPath}/`),
    );
  });
  const pool = matching.length ? matching : projects;
  return [...pool].sort((a, b) => b.projectPath.split("/").length - a.projectPath.split("/").length)[0];
}
