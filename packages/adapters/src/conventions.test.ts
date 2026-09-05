import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsJsx,
  detectTestConventions,
  parseImportAliases,
  validateTestExtension,
} from "./conventions.js";

async function scaffold(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bugpilot-conventions-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

/**
 * The Reproducer wrote JSX into a `.ts` file because it was inferring the
 * project's conventions from a prompt instruction. The answer was in
 * `vitest.config.ts` and in the neighbouring tests all along, so it is now read
 * from the project and handed to the model instead of guessed.
 */
describe("detectTestConventions", () => {
  it("reads the framework, include globs and real layout of a vite project", async () => {
    const root = await scaffold({
      "frontend/package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "frontend/vitest.config.ts": `export default { test: { include: ["src/**/*.{test,spec}.{ts,tsx}"] } }`,
      "frontend/src/test/example.test.ts": "",
      "frontend/src/test/dashboard.test.tsx": "",
      "frontend/src/test/login.test.tsx": "",
    });
    const conventions = await detectTestConventions(root, "frontend");

    expect(conventions.framework).toBe("vitest");
    expect(conventions.includeGlobs).toContain("src/**/*.{test,spec}.{ts,tsx}");
    expect(conventions.directories).toContain("src/test");
    // Most common first: two .tsx against one .ts, which is the signal the
    // Reproducer needs to pick .tsx for a component test.
    expect(conventions.extensions[0]).toBe(".tsx");
    expect(conventions.examples.length).toBeGreaterThan(0);
  });

  it("detects pytest layout", async () => {
    const root = await scaffold({
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "tests/test_ranges.py": "",
      "tests/test_dates.py": "",
    });
    const conventions = await detectTestConventions(root, ".");
    expect(conventions.framework).toBe("pytest");
    expect(conventions.directories).toContain("tests");
    expect(conventions.extensions).toContain(".py");
  });

  it("still reports config globs for a project with no tests yet", async () => {
    const root = await scaffold({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "vitest.config.ts": `export default { test: { include: ["test/**/*.spec.ts"] } }`,
    });
    const conventions = await detectTestConventions(root, ".");
    expect(conventions.includeGlobs).toContain("test/**/*.spec.ts");
    expect(conventions.examples).toEqual([]);
  });

  it("ignores tests inside node_modules", async () => {
    const root = await scaffold({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/a.test.ts": "",
      "node_modules/left-pad/index.test.js": "",
    });
    const conventions = await detectTestConventions(root, ".");
    expect(conventions.examples).toEqual(["src/a.test.ts"]);
  });

  it("recognises node --test", async () => {
    const root = await scaffold({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "test/calculator.test.js": "",
    });
    expect((await detectTestConventions(root, ".")).framework).toBe("node:test");
  });
});

describe("containsJsx", () => {
  it.each([
    ["a component element", "render(<Login />);"],
    ["a closing tag", "return <div>hello</div>;"],
    ["a fragment", "const x = <>text</>;"],
  ])("detects %s", (_label, content) => {
    expect(containsJsx(content)).toBe(true);
  });

  it.each([
    ["a generic", "const x = new Map<string, number>();"],
    ["a comparison", "if (a < b && c > d) return;"],
    ["an arrow function", "const f = (a: number) => a < 10;"],
    ["plain assertions", "expect(days_between(a, b)).toBe(1);"],
  ])("does not misread %s as JSX", (_label, content) => {
    expect(containsJsx(content)).toBe(false);
  });
});

describe("validateTestExtension", () => {
  it("rejects JSX written to a .ts file and names the fix", () => {
    const problem = validateTestExtension("src/test/login.test.ts", "render(<Login />);");
    expect(problem).toMatch(/cannot use the "\.ts" extension/);
    expect(problem).toContain("src/test/login.test.tsx");
  });

  it("rejects JSX written to a .js file", () => {
    expect(validateTestExtension("test/a.test.js", "<App />")).toBeDefined();
  });

  it("accepts JSX in a .tsx file", () => {
    expect(validateTestExtension("src/test/login.test.tsx", "render(<Login />);")).toBeUndefined();
  });

  it("accepts a plain .ts test with no JSX", () => {
    expect(validateTestExtension("src/a.test.ts", "expect(add(1, 2)).toBe(3);")).toBeUndefined();
  });

  it("accepts a python test", () => {
    expect(validateTestExtension("tests/test_x.py", "assert add(1, 2) == 3")).toBeUndefined();
  });
});

/**
 * A model that has to work out `../../pages/Login` by counting directories gets
 * it wrong, and the resulting unresolved import looks exactly like a bug that
 * cannot be reproduced. The project already declares the answer.
 */
describe("parseImportAliases", () => {
  it("reads a vite resolve alias", () => {
    const source = `resolve: { alias: { "@": path.resolve(__dirname, "./src") } }`;
    expect(parseImportAliases(source)).toEqual({ "@": "./src" });
  });

  it("reads tsconfig paths and strips the glob", () => {
    const source = `{ "compilerOptions": { "paths": { "@/*": ["./src/*"], "~lib/*": ["./lib/*"] } } }`;
    expect(parseImportAliases(source)).toEqual({ "@": "./src", "~lib": "./lib" });
  });

  it("reads a jest moduleNameMapper", () => {
    const source = `moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" }`;
    expect(parseImportAliases(source)["@"]).toBe("./src");
  });

  it("returns nothing for a project with no aliases", () => {
    expect(parseImportAliases(`export default { test: { globals: true } }`)).toEqual({});
  });
});

describe("detectTestConventions aliases", () => {
  it("surfaces the alias a vite project resolves", async () => {
    const root = await scaffold({
      "frontend/package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "frontend/vitest.config.ts": `export default { resolve: { alias: { "@": path.resolve(__dirname, "./src") } } }`,
      "frontend/src/test/a.test.tsx": "",
    });
    const conventions = await detectTestConventions(root, "frontend");
    expect(conventions.importAliases).toEqual({ "@": "./src" });
  });
});
