import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (input: Record<string, unknown>) => Promise<unknown>>());
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: (input: Record<string, unknown>) => Promise<unknown>,
    ) {
      handlers.set(name, handler);
    }
    async connect() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
let root: string;
let outside: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bugwright-mcp-test-"));
  outside = await mkdtemp(path.join(tmpdir(), "bugwright-mcp-outside-test-"));
  await writeFile(path.join(root, "repro.test.js"), "assert.equal(add(1, 2), 3)");
  await writeFile(path.join(root, "source.js"), "const answer = 0;");
  await writeFile(path.join(outside, "secret.test.js"), "private data");
  await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv("BUGWRIGHT_REPO_ROOT", root);
  vi.stubEnv("BUGWRIGHT_PROTECTED_TEST", "repro.test.js");
  vi.stubEnv("BUGWRIGHT_ALLOWED_TOOLS", "apply_patch,write_test_file,read_file,read_range,list_tree");
  await import("./server.js");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
const call = (tool: string, input: Record<string, unknown>) => handlers.get(tool)!(input);

describe("repository MCP integrity controls", () => {
  it.each(["repro.test.js", "./repro.test.js", "REPRO.test.js"])(
    "denies a direct patch to protected test %s",
    async (name) => {
      await expect(call("apply_patch", { path: name, oldText: "3", newText: "999" })).rejects.toThrow(
        /protected/,
      );
      expect(await readFile(path.join(root, "repro.test.js"), "utf8")).toContain("3");
    },
  );
  it("denies replacing the protected test through the reproduction tool", async () => {
    await expect(
      call("write_test_file", { path: "repro.test.js", content: "assert.ok(true)" }),
    ).rejects.toThrow(/protected/);
  });
  it("continues to allow source fixes", async () => {
    await call("apply_patch", {
      path: "source.js",
      oldText: "const answer = 0;",
      newText: "const answer = 42;",
    });
    expect(await readFile(path.join(root, "source.js"), "utf8")).toBe("const answer = 42;");
  });
  it.each(["read_file", "read_range", "apply_patch", "write_test_file"])(
    "blocks symlink escape through %s",
    async (tool) => {
      await expect(
        call(tool, {
          path: "escape/secret.test.js",
          startLine: 1,
          endLine: 2,
          oldText: "private",
          newText: "public",
          content: "replacement",
        }),
      ).rejects.toThrow(/Symlink/);
      expect(await readFile(path.join(outside, "secret.test.js"), "utf8")).toBe("private data");
    },
  );
  it("blocks creating a file through a symlinked parent", async () => {
    await expect(call("write_test_file", { path: "escape/new.test.js", content: "new" })).rejects.toThrow(
      /Symlink/,
    );
    await expect(readFile(path.join(outside, "new.test.js"))).rejects.toThrow();
  });
});
