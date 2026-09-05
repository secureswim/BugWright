/**
 * Language adapters: how BugWright verifies a repository it has never seen.
 *
 * The runner used to hold a hardcoded allowlist of twelve npm command strings,
 * which meant the system could only ever verify Node projects. An adapter
 * replaces that with a contract: given a detected project, produce the exact
 * argv to install, test, typecheck or lint it.
 *
 * Two safety properties follow from the shape of this interface:
 *
 *  - Commands are `argv` arrays executed directly, never strings passed to a
 *    shell. There is no quoting to get wrong and no shell to inject into.
 *  - The *adapter* constructs the command. The model only ever supplies an
 *    enumerated operation and a project path that detection already returned,
 *    so it never contributes a token to a command line.
 */

export type Network = "none" | "bridge";

export interface CommandSpec {
  /** Executable and arguments, executed without a shell. */
  argv: string[];
  /** Container network. Only dependency installation is granted egress. */
  network: Network;
  timeoutMs: number;
  /** Project directory relative to the repository root; "." for the root. */
  projectPath: string;
}

/**
 * The result of asking an adapter for an operation the project does not define.
 *
 * This distinction matters more than it looks. Running `npm run typecheck` in a
 * repository with no typecheck script exits non-zero, which the Tester used to
 * read as a real failure - sending the Coder off to revise a patch that was
 * fine. "Not configured" is a different fact from "failed".
 */
export interface NotConfigured {
  configured: false;
  reason: string;
}

export interface Configured {
  configured: true;
  command: CommandSpec;
}

export type Operation = Configured | NotConfigured;

export const configured = (command: CommandSpec): Configured => ({ configured: true, command });
export const notConfigured = (reason: string): NotConfigured => ({ configured: false, reason });

/** A project discovered inside the repository. */
export interface DetectedProject {
  /** Adapter id that claimed this project, e.g. "node" or "python". */
  adapter: string;
  /** Path relative to the repository root; "." for the root. */
  projectPath: string;
  /** Package manager or toolchain within the language, e.g. "pnpm", "poetry". */
  packageManager: string;
  /** Whether a lockfile is present, which decides if a locked install is possible. */
  hasLockfile: boolean;
  /** Operations this project actually defines, for the Tester to choose from. */
  available: {
    test: boolean;
    typecheck: boolean;
    lint: boolean;
  };
  /** Human-readable evidence of how the project was identified. */
  evidence: string;
  /**
   * How this project's tests are actually written, read from its config and
   * existing test files. Given to the Reproducer so the location and extension
   * of a new test are read from the repository rather than guessed.
   */
  testConventions?: import("./conventions.js").TestConventions;
}

/** A named cache volume mounted into the container for a project. */
export interface CacheMount {
  /** Stable suffix used to name the Docker volume. */
  key: string;
  /** Absolute path inside the container. */
  containerPath: string;
}

export interface TestOptions {
  /**
   * Restrict the run to a single test file or node id.
   *
   * Used to run only the reproduction test, which is both far faster than the
   * full suite and answers a different question: "is the bug fixed?" rather
   * than "did anything break?".
   */
  only?: string;
}

export interface LintOptions {
  /** Repository-relative paths changed by the current patch. */
  changedFiles?: string[];
}

export interface LanguageAdapter {
  readonly id: string;
  /** Container image tag that provides this language's toolchain. */
  readonly image: string;

  /** Find every project of this language under `root`. */
  detect(root: string): Promise<DetectedProject[]>;

  install(project: DetectedProject): Operation;
  test(project: DetectedProject, options?: TestOptions): Operation;
  typecheck(project: DetectedProject): Operation;
  lint(project: DetectedProject, options?: LintOptions): Operation;

  /** Dependency caches to persist between runs of the same project. */
  cacheMounts(project: DetectedProject): CacheMount[];
}

/** Directories never worth walking into during detection. */
export const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "vendor",
  "target",
]);

/** Depth cap for project detection. Deep enough for the usual monorepo layouts. */
export const MAX_DETECTION_DEPTH = 4;

export const workdirFor = (projectPath: string): string =>
  projectPath === "." ? "/workspace" : `/workspace/${projectPath}`;
