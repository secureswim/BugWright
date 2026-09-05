import path from "node:path";
import {
  CacheMount,
  DetectedProject,
  LanguageAdapter,
  LintOptions,
  Operation,
  TestOptions,
  configured,
  notConfigured,
  workdirFor,
} from "./types.js";
import { fileExists, findProjectDirectories, readIfPresent } from "./walk.js";
import { detectTestConventions } from "./conventions.js";

type PackageManager = "npm" | "pnpm" | "yarn";

const LOCKFILES: Record<PackageManager, string> = {
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  npm: "package-lock.json",
};

const FIVE_MINUTES = 5 * 60_000;
const TEN_MINUTES = 10 * 60_000;

function runScript(manager: PackageManager, script: string): string[] {
  // `npm test` and `yarn test` are shorthands; everything else needs `run`.
  if (script === "test") return manager === "npm" ? ["npm", "test"] : [manager, "test"];
  if (manager === "yarn") return ["yarn", script];
  return [manager, "run", script];
}

export class NodeAdapter implements LanguageAdapter {
  readonly id = "node";
  readonly image = process.env.BUGWRIGHT_RUNNER_IMAGE_NODE ?? "bugwright-runner-node:latest";

  async detect(root: string): Promise<DetectedProject[]> {
    const directories = await findProjectDirectories(root, ["package.json"]);
    const projects: DetectedProject[] = [];

    for (const projectPath of directories) {
      const prefix = projectPath === "." ? "" : `${projectPath}/`;
      const raw = await readIfPresent(root, path.join(prefix, "package.json"));
      if (!raw) continue;

      let scripts: Record<string, string> = {};
      try {
        scripts = ((JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {}) as Record<
          string,
          string
        >;
      } catch {
        // An unparseable package.json is not a Node project we can verify.
        continue;
      }

      let packageManager: PackageManager = "npm";
      for (const candidate of ["pnpm", "yarn"] as const) {
        if (await fileExists(root, path.join(prefix, LOCKFILES[candidate]))) packageManager = candidate;
      }
      const hasLockfile = await fileExists(root, path.join(prefix, LOCKFILES[packageManager]));

      projects.push({
        adapter: this.id,
        projectPath,
        packageManager,
        hasLockfile,
        available: {
          test: Boolean(scripts.test),
          typecheck: Boolean(scripts.typecheck ?? scripts["type-check"] ?? scripts.tsc),
          lint: Boolean(scripts.lint),
        },
        evidence: `package.json with ${packageManager}${hasLockfile ? " and a lockfile" : " and no lockfile"}`,
        testConventions: await detectTestConventions(root, projectPath),
      });
    }
    return projects;
  }

  install(project: DetectedProject): Operation {
    const manager = project.packageManager as PackageManager;
    if (!project.hasLockfile) {
      return notConfigured(`No ${LOCKFILES[manager]}; a reproducible locked install is not possible`);
    }
    // `--ignore-scripts` matters: lifecycle hooks are arbitrary code from the
    // repository under test, and this is the one step with network access.
    const argv =
      manager === "pnpm"
        ? ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]
        : manager === "yarn"
          ? ["yarn", "install", "--immutable", "--mode=skip-build"]
          : ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    return configured({
      argv,
      network: "bridge",
      timeoutMs: TEN_MINUTES,
      projectPath: project.projectPath,
    });
  }

  test(project: DetectedProject, options: TestOptions = {}): Operation {
    if (!project.available.test) {
      return notConfigured("package.json defines no test script");
    }
    const manager = project.packageManager as PackageManager;
    const argv = runScript(manager, "test");
    // `--` forwards the path to the underlying test runner rather than to npm.
    if (options.only) argv.push("--", options.only);
    return configured({
      argv,
      network: "none",
      timeoutMs: FIVE_MINUTES,
      projectPath: project.projectPath,
    });
  }

  typecheck(project: DetectedProject): Operation {
    if (!project.available.typecheck) {
      return notConfigured("package.json defines no typecheck script");
    }
    return configured({
      argv: runScript(project.packageManager as PackageManager, "typecheck"),
      network: "none",
      timeoutMs: FIVE_MINUTES,
      projectPath: project.projectPath,
    });
  }

  lint(project: DetectedProject, options: LintOptions = {}): Operation {
    if (!project.available.lint) {
      return notConfigured("package.json defines no lint script");
    }
    const argv = runScript(project.packageManager as PackageManager, "lint");
    // Scope to the changed files. A repository's pre-existing lint debt is not
    // evidence about this patch, and chasing it wastes revision cycles.
    const scoped = scopeToProject(project.projectPath, options.changedFiles ?? []);
    if (scoped.length) argv.push("--", ...scoped);
    return configured({
      argv,
      network: "none",
      timeoutMs: FIVE_MINUTES,
      projectPath: project.projectPath,
    });
  }

  cacheMounts(project: DetectedProject): CacheMount[] {
    const workdir = workdirFor(project.projectPath);
    const mounts: CacheMount[] = [{ key: "node-modules", containerPath: `${workdir}/node_modules` }];
    if (project.packageManager === "pnpm") {
      mounts.push({ key: "pnpm-store", containerPath: "/workspace/.pnpm-store" });
    }
    return mounts;
  }
}

/** Rewrites repository-relative paths as project-relative, dropping outsiders. */
export function scopeToProject(projectPath: string, files: string[]): string[] {
  if (projectPath === ".") return files;
  const prefix = `${projectPath}/`;
  return files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
}
