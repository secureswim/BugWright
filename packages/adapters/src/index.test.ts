import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeAdapter, PythonAdapter, detectProjects, selectProject } from "./index.js";
import { DetectedProject } from "./types.js";

async function scaffold(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bugwright-adapters-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

describe("NodeAdapter detection", () => {
  it("finds a project at the repository root", async () => {
    const root = await scaffold({ "package.json": pkg({ test: "vitest" }) });
    const [project] = await new NodeAdapter().detect(root);
    expect(project.projectPath).toBe(".");
    expect(project.available.test).toBe(true);
    expect(project.available.typecheck).toBe(false);
  });

  it("finds projects nested inside a monorepo", async () => {
    // The regression this guards: detection used to scan the root plus one
    // level, so most real TypeScript monorepos looked like empty repositories.
    const root = await scaffold({
      "package.json": pkg({}),
      "packages/api/package.json": pkg({ test: "vitest", typecheck: "tsc --noEmit" }),
      "packages/web/nested/package.json": pkg({ test: "vitest" }),
    });
    const paths = (await new NodeAdapter().detect(root)).map((project) => project.projectPath);
    expect(paths).toContain("packages/api");
    expect(paths).toContain("packages/web/nested");
  });

  it("never descends into node_modules", async () => {
    const root = await scaffold({
      "package.json": pkg({ test: "vitest" }),
      "node_modules/left-pad/package.json": pkg({ test: "oops" }),
    });
    const paths = (await new NodeAdapter().detect(root)).map((project) => project.projectPath);
    expect(paths).toEqual(["."]);
  });

  it("identifies the package manager from the lockfile", async () => {
    const root = await scaffold({ "package.json": pkg({ test: "x" }), "pnpm-lock.yaml": "" });
    const [project] = await new NodeAdapter().detect(root);
    expect(project.packageManager).toBe("pnpm");
    expect(project.hasLockfile).toBe(true);
  });
});

describe("NodeAdapter commands", () => {
  const adapter = new NodeAdapter();
  const project = (over: Partial<DetectedProject> = {}): DetectedProject => ({
    adapter: "node",
    projectPath: ".",
    packageManager: "npm",
    hasLockfile: true,
    available: { test: true, typecheck: true, lint: true },
    evidence: "test",
    ...over,
  });

  it("reports a missing script as not configured rather than as a failure", () => {
    // Running `npm run typecheck` where no such script exists exits non-zero,
    // which the Tester previously read as a real failure and sent back to the
    // Coder. "Not configured" and "failed" are different facts.
    const result = adapter.typecheck(project({ available: { test: true, typecheck: false, lint: true } }));
    expect(result.configured).toBe(false);
    if (!result.configured) expect(result.reason).toMatch(/no typecheck script/i);
  });

  it("builds argv arrays rather than shell strings", () => {
    const result = adapter.test(project());
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.command.argv).toEqual(["npm", "test"]);
      expect(result.command.argv.join(" ")).not.toContain("&&");
    }
  });

  it("grants network only to dependency installation", () => {
    const install = adapter.install(project());
    const test = adapter.test(project());
    expect(install.configured && install.command.network).toBe("bridge");
    expect(test.configured && test.command.network).toBe("none");
  });

  it("disables lifecycle scripts during install", () => {
    const result = adapter.install(project());
    expect(result.configured && result.command.argv).toContain("--ignore-scripts");
  });

  it("refuses to install without a lockfile", () => {
    const result = adapter.install(project({ hasLockfile: false }));
    expect(result.configured).toBe(false);
  });

  it("narrows a test run to a single file when asked", () => {
    const result = adapter.test(project(), { only: "test/repro.test.js" });
    expect(result.configured && result.command.argv).toEqual(["npm", "test", "--", "test/repro.test.js"]);
  });

  it("scopes lint to the changed files", () => {
    const result = adapter.lint(project(), { changedFiles: ["src/a.ts", "src/b.ts"] });
    expect(result.configured && result.command.argv).toEqual([
      "npm",
      "run",
      "lint",
      "--",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("uses yarn and pnpm invocation styles correctly", () => {
    expect(adapter.test(project({ packageManager: "yarn" })).configured).toBe(true);
    const pnpm = adapter.typecheck(project({ packageManager: "pnpm" }));
    expect(pnpm.configured && pnpm.command.argv).toEqual(["pnpm", "run", "typecheck"]);
  });
});

describe("PythonAdapter", () => {
  it("detects a poetry project and offers pytest", async () => {
    const root = await scaffold({
      "pyproject.toml": "[tool.poetry]\nname='x'\n[tool.ruff]\n",
      "poetry.lock": "",
    });
    const [project] = await new PythonAdapter().detect(root);
    expect(project.packageManager).toBe("poetry");
    expect(project.available.test).toBe(true);
    expect(project.available.lint).toBe(true);
    const test = new PythonAdapter().test(project);
    expect(test.configured && test.command.argv).toEqual(["poetry", "run", "pytest", "-q"]);
  });

  it("detects a bare requirements.txt project", async () => {
    const root = await scaffold({ "requirements.txt": "pytest\n" });
    const [project] = await new PythonAdapter().detect(root);
    expect(project.packageManager).toBe("pip");
    const install = new PythonAdapter().install(project);
    expect(install.configured && install.command.argv).toContain("-r");
  });

  it("reports typecheck as not configured without mypy settings", async () => {
    const root = await scaffold({ "requirements.txt": "" });
    const [project] = await new PythonAdapter().detect(root);
    expect(new PythonAdapter().typecheck(project).configured).toBe(false);
  });
});

describe("detectProjects and selectProject", () => {
  it("finds Node and Python projects in one repository", async () => {
    const root = await scaffold({
      "frontend/package.json": pkg({ test: "vitest" }),
      "service/pyproject.toml": "[tool.poetry]\n",
    });
    const projects = await detectProjects(root);
    expect(projects.map((project) => project.adapter).sort()).toEqual(["node", "python"]);
  });

  it("selects the deepest project that the diff touches", async () => {
    const root = await scaffold({
      "package.json": pkg({ test: "x" }),
      "packages/api/package.json": pkg({ test: "x" }),
    });
    const projects = await detectProjects(root);
    const selected = selectProject(projects, ["packages/api/src/handler.ts"]);
    expect(selected?.projectPath).toBe("packages/api");
  });

  it("falls back to a project when the diff matches nothing", async () => {
    const root = await scaffold({ "package.json": pkg({ test: "x" }) });
    const projects = await detectProjects(root);
    expect(selectProject(projects, ["unrelated/file.md"])?.projectPath).toBe(".");
  });

  it("returns undefined for a repository in no supported language", () => {
    expect(selectProject([], ["main.rs"])).toBeUndefined();
  });
});
