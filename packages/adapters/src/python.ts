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
} from "./types.js";
import { fileExists, findProjectDirectories, readIfPresent } from "./walk.js";
import { detectTestConventions } from "./conventions.js";
import { scopeToProject } from "./node.js";

type PythonManager = "uv" | "poetry" | "pip";

const FIVE_MINUTES = 5 * 60_000;
const TEN_MINUTES = 10 * 60_000;

const MARKERS = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "tox.ini"];

/** Prefix that runs a tool inside the project's environment. */
function runner(manager: PythonManager): string[] {
  if (manager === "poetry") return ["poetry", "run"];
  if (manager === "uv") return ["uv", "run"];
  return [];
}

export class PythonAdapter implements LanguageAdapter {
  readonly id = "python";
  readonly image = process.env.BUGPILOT_RUNNER_IMAGE_PYTHON ?? "bugpilot-runner-python:latest";

  async detect(root: string): Promise<DetectedProject[]> {
    const directories = await findProjectDirectories(root, MARKERS);
    const projects: DetectedProject[] = [];

    for (const projectPath of directories) {
      const prefix = projectPath === "." ? "" : `${projectPath}/`;
      const pyproject = await readIfPresent(root, path.join(prefix, "pyproject.toml"));
      const hasRequirements = await fileExists(root, path.join(prefix, "requirements.txt"));
      const setupCfg = await readIfPresent(root, path.join(prefix, "setup.cfg"));
      const toxIni = await readIfPresent(root, path.join(prefix, "tox.ini"));
      const hasSetupPy = await fileExists(root, path.join(prefix, "setup.py"));
      // Presence, not content: an empty requirements.txt is still a marker.
      if (
        pyproject === undefined &&
        !hasRequirements &&
        !hasSetupPy &&
        setupCfg === undefined &&
        toxIni === undefined
      ) {
        continue;
      }

      const hasUvLock = await fileExists(root, path.join(prefix, "uv.lock"));
      const hasPoetryLock = await fileExists(root, path.join(prefix, "poetry.lock"));
      const manager: PythonManager = hasUvLock
        ? "uv"
        : hasPoetryLock || /\[tool\.poetry\]/.test(pyproject ?? "")
          ? "poetry"
          : "pip";

      const config = `${pyproject ?? ""}\n${setupCfg ?? ""}\n${toxIni ?? ""}`;
      // pytest is the near-universal default, so treat a Python project as
      // testable unless it declares a different runner. The container reports
      // "no tests ran" honestly if there is nothing to collect.
      const hasPytest = !/\[tool\.nose\]|unittest discover/.test(config);

      projects.push({
        adapter: this.id,
        projectPath,
        packageManager: manager,
        hasLockfile: hasUvLock || hasPoetryLock || hasRequirements,
        available: {
          test: hasPytest,
          typecheck: /\[tool\.mypy\]|\[mypy\]|\[tool\.pyright\]/.test(config),
          lint: /\[tool\.ruff\]|\[flake8\]|\[tool\.flake8\]/.test(config),
        },
        evidence: pyproject ? `pyproject.toml managed by ${manager}` : "requirements.txt / setup.py",
        testConventions: await detectTestConventions(root, projectPath),
      });
    }
    return projects;
  }

  install(project: DetectedProject): Operation {
    const manager = project.packageManager as PythonManager;
    if (manager === "uv") {
      return configured({
        argv: ["uv", "sync", "--frozen"],
        network: "bridge",
        timeoutMs: TEN_MINUTES,
        projectPath: project.projectPath,
      });
    }
    if (manager === "poetry") {
      return configured({
        argv: ["poetry", "install", "--no-interaction", "--no-root"],
        network: "bridge",
        timeoutMs: TEN_MINUTES,
        projectPath: project.projectPath,
      });
    }
    if (!project.hasLockfile) {
      return notConfigured("No requirements.txt, uv.lock or poetry.lock to install from");
    }
    return configured({
      argv: ["pip", "install", "--no-input", "--disable-pip-version-check", "-r", "requirements.txt"],
      network: "bridge",
      timeoutMs: TEN_MINUTES,
      projectPath: project.projectPath,
    });
  }

  test(project: DetectedProject, options: TestOptions = {}): Operation {
    if (!project.available.test) {
      return notConfigured("No pytest-compatible test configuration was detected");
    }
    const argv = [...runner(project.packageManager as PythonManager), "pytest", "-q"];
    if (options.only) argv.push(options.only);
    return configured({
      argv,
      network: "none",
      timeoutMs: FIVE_MINUTES,
      projectPath: project.projectPath,
    });
  }

  typecheck(project: DetectedProject): Operation {
    if (!project.available.typecheck) {
      return notConfigured("No mypy or pyright configuration was detected");
    }
    return configured({
      argv: [...runner(project.packageManager as PythonManager), "mypy", "."],
      network: "none",
      timeoutMs: FIVE_MINUTES,
      projectPath: project.projectPath,
    });
  }

  lint(project: DetectedProject, options: LintOptions = {}): Operation {
    if (!project.available.lint) {
      return notConfigured("No ruff or flake8 configuration was detected");
    }
    const scoped = scopeToProject(project.projectPath, options.changedFiles ?? []).filter((file) =>
      file.endsWith(".py"),
    );
    const argv = [...runner(project.packageManager as PythonManager), "ruff", "check"];
    argv.push(...(scoped.length ? scoped : ["."]));
    return configured({
      argv,
      network: "none",
      timeoutMs: FIVE_MINUTES,
      projectPath: project.projectPath,
    });
  }

  cacheMounts(project: DetectedProject): CacheMount[] {
    const manager = project.packageManager as PythonManager;
    if (manager === "pip") return [{ key: "pip-cache", containerPath: "/home/runner/.cache/pip" }];
    if (manager === "uv") return [{ key: "uv-cache", containerPath: "/home/runner/.cache/uv" }];
    return [{ key: "poetry-cache", containerPath: "/home/runner/.cache/pypoetry" }];
  }
}
