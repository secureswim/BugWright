import { describe, expect, it } from "vitest";
import { buildRunArgs } from "./sandbox.js";

/**
 * The sandbox flags, asserted directly.
 *
 * Every container regression this project has hit reached a user rather than a
 * test, because the argv was built inline inside an async function that needs
 * Docker to exercise. Building it in a pure function makes the security
 * properties checkable without a daemon.
 *
 * The read-only workspace mount that used to be the default is the reason this
 * file exists: Vite writes a bundled copy of a TypeScript config *next to the
 * config* before importing it, so `vitest.config.ts` made vitest die at startup
 * with EACCES on every real project.
 */
const base = {
  image: "bugwright-runner-node:latest",
  root: "/work/task",
  workdir: "/workspace/frontend",
  command: {
    argv: ["npm", "test"],
    network: "none" as const,
    timeoutMs: 300_000,
    projectPath: "frontend",
  },
  mounts: [{ volume: "bugwright-node-modules-abc", containerPath: "/workspace/frontend/node_modules" }],
  readOnly: true,
};

const pairs = (args: string[], flag: string) =>
  args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));

describe("buildRunArgs", () => {
  it("keeps the workspace writable by default", () => {
    // Read-only broke every project with a TypeScript test config, so it is
    // now opt-in via BUGWRIGHT_RUNNER_READONLY.
    const mount = pairs(buildRunArgs(base), "-v").find((value) => value.endsWith(":/workspace"));
    expect(mount).toBe("/work/task:/workspace");
  });

  it("always mounts .git read-only, whatever the workspace mode", () => {
    // The diff a human approves is computed from this history.
    expect(pairs(buildRunArgs(base), "-v")).toContain("/work/task/.git:/workspace/.git:ro");
  });

  it("drops every capability and forbids privilege escalation", () => {
    const args = buildRunArgs(base);
    expect(pairs(args, "--cap-drop")).toContain("ALL");
    expect(pairs(args, "--security-opt")).toContain("no-new-privileges");
  });

  it("bounds cpu, memory and processes", () => {
    const args = buildRunArgs(base);
    expect(pairs(args, "--cpus")).toContain("2");
    expect(pairs(args, "--memory")).toContain("2g");
    expect(pairs(args, "--pids-limit")).toContain("256");
  });

  it("gives test runs no network", () => {
    expect(pairs(buildRunArgs(base), "--network")).toContain("none");
  });

  it("grants network only when the command asks for it", () => {
    const install = buildRunArgs({
      ...base,
      command: { ...base.command, argv: ["npm", "ci"], network: "bridge" },
    });
    expect(pairs(install, "--network")).toContain("bridge");
  });

  it("mounts the dependency cache volume", () => {
    expect(pairs(buildRunArgs(base), "-v")).toContain(
      "bugwright-node-modules-abc:/workspace/frontend/node_modules",
    );
  });

  it("provides a writable tmpfs at /tmp", () => {
    expect(pairs(buildRunArgs(base), "--tmpfs").join()).toMatch(/^\/tmp:rw/);
  });

  it("runs in the project directory, not the repository root", () => {
    expect(pairs(buildRunArgs(base), "-w")).toContain("/workspace/frontend");
  });

  it("passes the command as argv with no shell", () => {
    const args = buildRunArgs(base);
    expect(args.slice(-2)).toEqual(["npm", "test"]);
    expect(args).not.toContain("sh");
    expect(args).not.toContain("-lc");
    expect(args.join(" ")).not.toContain("&&");
  });

  it("puts the image immediately before the command", () => {
    const args = buildRunArgs(base);
    expect(args[args.length - 3]).toBe("bugwright-runner-node:latest");
  });
});
