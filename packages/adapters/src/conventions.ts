import path from "node:path";
import { IGNORED_DIRECTORIES } from "./types.js";
import { readIfPresent } from "./walk.js";
import { readdir } from "node:fs/promises";

/**
 * How a project's tests are actually written, read from the project rather than
 * guessed by a model.
 *
 * The Reproducer used to infer the location and extension of a new test from a
 * prompt instruction, and got it wrong: it wrote JSX into a `.ts` file, which
 * esbuild refuses identically before and after a patch. The information was
 * sitting in `vitest.config.ts` and in the existing tests the whole time.
 */
export interface TestConventions {
  framework: "vitest" | "jest" | "pytest" | "node:test" | "unknown";
  /** Glob patterns the runner collects, when the config declares them. */
  includeGlobs: string[];
  /** Directories that already contain tests, project-relative. */
  directories: string[];
  /** Extensions in use, most common first, e.g. [".tsx", ".ts"]. */
  extensions: string[];
  /** A few existing test files to imitate, project-relative. */
  examples: string[];
  /**
   * Module path aliases the project resolves, e.g. `{"@": "./src"}`.
   *
   * Without these a model writes a relative import by counting directories and
   * gets it wrong - `../src/pages/Login` from `src/test/` resolves to
   * `src/src/pages/Login`, which fails to resolve and looks like a bug that
   * cannot be reproduced.
   */
  importAliases: Record<string, string>;
}

const TEST_FILE = /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$|^test_[^/]*\.py$|_test\.py$|\.(?:test|spec)\.py$/i;

const CONFIG_FILES = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vite.config.ts",
  "vite.config.js",
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "package.json",
  "pyproject.toml",
  "setup.cfg",
  "tox.ini",
  "pytest.ini",
];

/** Files that may declare module path aliases. */
const ALIAS_FILES = [
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.base.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "vitest.config.ts",
  "jest.config.ts",
  "jest.config.js",
  "package.json",
];

/**
 * Extracts module path aliases from TypeScript `paths`, bundler `alias` maps
 * and Jest's `moduleNameMapper`.
 *
 * Deliberately regex-based: these files are TypeScript modules as often as they
 * are JSON, and evaluating them to read a config would mean executing the
 * repository under test.
 */
export function parseImportAliases(source: string): Record<string, string> {
  const aliases: Record<string, string> = {};

  // tsconfig "paths": { "@/*": ["./src/*"] }
  const paths = /"paths"\s*:\s*\{([^}]*)\}/s.exec(source);
  if (paths) {
    for (const entry of paths[1].matchAll(/["']([^"']+)["']\s*:\s*\[\s*["']([^"']+)["']/g)) {
      aliases[entry[1].replace(/\/\*$/, "")] = entry[2].replace(/\/\*$/, "");
    }
  }

  // vite/vitest: alias: { "@": path.resolve(__dirname, "./src") }
  const alias = /alias\s*:\s*\{([^}]*)\}/s.exec(source);
  if (alias) {
    // `[^}]*?` rather than `[^,}]*?`: the value is often a call such as
    // `path.resolve(__dirname, "./src")`, whose own comma would otherwise end
    // the match before the path is reached.
    for (const entry of alias[1].matchAll(/["']([^"']+)["']\s*:\s*[^}]*?["']([^"']+)["']/g)) {
      aliases[entry[1]] = entry[2];
    }
  }

  // jest moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" }
  const mapper = /moduleNameMapper\s*:\s*\{([^}]*)\}/s.exec(source);
  if (mapper) {
    for (const entry of mapper[1].matchAll(
      /["']\^?([^"'$()\\]+?)\/?\(?\.?\*?\)?\$?["']\s*:\s*["']([^"']+)["']/g,
    )) {
      aliases[entry[1]] = entry[2].replace("<rootDir>", ".").replace(/\/\$1$/, "");
    }
  }

  return aliases;
}

/** Pulls `include: [...]` / `testMatch: [...]` string literals out of a config. */
function parseIncludeGlobs(source: string): string[] {
  const globs: string[] = [];
  for (const key of ["include", "testMatch", "testRegex"]) {
    const block = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`, "s").exec(source);
    if (!block) continue;
    for (const match of block[1].matchAll(/["'`]([^"'`]+)["'`]/g)) globs.push(match[1]);
  }
  return globs;
}

function frameworkFrom(
  configs: string,
  scripts: Record<string, string>,
  extensions: string[],
): TestConventions["framework"] {
  const testScript = scripts.test ?? "";
  if (/vitest/.test(testScript) || /vitest/.test(configs)) return "vitest";
  if (/\bjest\b/.test(testScript) || /\bjest\b/.test(configs)) return "jest";
  if (/node\s+--test|node:test/.test(testScript)) return "node:test";
  if (/pytest/.test(testScript) || /\[tool\.pytest|\[pytest\]/.test(configs)) return "pytest";
  // Fall back to what the existing tests are: a Python project with no
  // declared runner is still overwhelmingly pytest.
  if (extensions.includes(".py")) return "pytest";
  return "unknown";
}

/** Ranks values by how often they occur, most common first. */
function byFrequency(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
}

/**
 * Inspects a project and reports how its tests are laid out.
 *
 * Existing test files are the primary evidence - what a repository actually
 * does beats what its config permits. The config's include globs are reported
 * alongside so a project with no tests yet still gets useful guidance.
 */
export async function detectTestConventions(root: string, projectPath: string): Promise<TestConventions> {
  const projectRoot = projectPath === "." ? root : path.join(root, projectPath);

  let configText = "";
  let scripts: Record<string, string> = {};
  for (const file of CONFIG_FILES) {
    const content = await readIfPresent(projectRoot, file);
    if (!content) continue;
    configText += `\n${content}`;
    if (file === "package.json") {
      try {
        scripts = (JSON.parse(content) as { scripts?: Record<string, string> }).scripts ?? {};
      } catch {
        // A malformed manifest simply yields no script hints.
      }
    }
  }

  const found: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 5 || found.length >= 40) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
      } else if (TEST_FILE.test(entry.name)) {
        found.push(path.relative(projectRoot, absolute).replaceAll("\\", "/"));
      }
    }
  }
  await walk(projectRoot, 0);

  let aliasText = configText;
  for (const file of ALIAS_FILES) {
    const content = await readIfPresent(projectRoot, file);
    if (content) aliasText += `\n${content}`;
  }

  const extensions = byFrequency(found.map((file) => path.extname(file)));
  const directories = byFrequency(found.map((file) => path.dirname(file)));

  return {
    framework: frameworkFrom(configText, scripts, extensions),
    includeGlobs: parseIncludeGlobs(configText),
    directories: directories.slice(0, 4),
    extensions,
    examples: found.slice(0, 3),
    importAliases: parseImportAliases(aliasText),
  };
}

/**
 * Whether a file's contents require a JSX-capable extension.
 *
 * Deliberately conservative: a JSX element or fragment, not merely an angle
 * bracket, which would match generics and comparisons.
 */
export function containsJsx(content: string): boolean {
  return /<\s*[A-Z][\w.]*[\s/>]|<\s*>|<\/\s*[A-Za-z][\w.]*\s*>/.test(content);
}

/**
 * Rejects a test path whose extension cannot hold its contents.
 *
 * Returns an explanation when the pairing is impossible, or `undefined` when it
 * is fine. `.ts` and `.js` cannot contain JSX - esbuild, tsc and babel all
 * refuse it - and the failure is silent in the sense that it looks exactly like
 * a test that fails for a real reason.
 */
export function validateTestExtension(filePath: string, content: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if ((extension === ".ts" || extension === ".js" || extension === ".mts") && containsJsx(content)) {
    const suggested = filePath.replace(/\.(m?)(ts|js)$/i, ".$1$2x");
    return (
      `A file containing JSX cannot use the "${extension}" extension; the test runner will fail to ` +
      `parse it. Write it to "${suggested}" instead.`
    );
  }
  return undefined;
}
