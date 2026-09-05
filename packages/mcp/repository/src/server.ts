import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertEditable, assertSafeRelativePath, resolveInside } from "@bugpilot/policy";

const root = path.resolve(process.env.BUGPILOT_REPO_ROOT ?? "");
if (!process.env.BUGPILOT_REPO_ROOT) throw new Error("BUGPILOT_REPO_ROOT is required");
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
});

async function run(command: string, args: string[]) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, shell: false });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 20_000) }),
    );
  });
}

function globPattern(pattern: string) {
  return new RegExp(
    `^${pattern
      .replaceAll("\\", "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", "§§")
      .replaceAll("*", "[^/]*")
      .replaceAll("§§", ".*")
      .replaceAll("?", ".")}$`,
  );
}
async function fallbackSearch(query: string, glob?: string) {
  const matches: string[] = [];
  let chars = 0,
    files = 0;
  const matcher = glob ? globPattern(glob) : undefined;
  async function walk(dir: string) {
    if (files >= 2000 || chars >= 60_000) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", ".next", "coverage"].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name),
        relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (matcher && !matcher.test(relative) && !matcher.test(entry.name)) continue;
      files++;
      const content = await readFile(absolute, "utf8").catch(() => "");
      if (!content || content.includes("\0")) continue;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (line.includes(query)) {
          const item = `${relative}:${index + 1}:${line}\n`;
          matches.push(item);
          chars += item.length;
          if (chars >= 60_000) return;
        }
      }
    }
  }
  await walk(root);
  return matches.join("") || "No matches";
}

const server = new McpServer({ name: "bugpilot-repository", version: "0.1.0" });
server.tool(
  "list_tree",
  "List repository files without dependencies or Git internals",
  { depth: z.number().int().min(1).max(8).default(4) },
  async ({ depth }) => {
    const found: string[] = [];
    async function walk(dir: string, level: number) {
      if (level > depth || found.length >= 2000) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", "dist", ".next", "coverage"].includes(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(root, absolute).replaceAll("\\", "/");
        found.push(relative + (entry.isDirectory() ? "/" : ""));
        if (entry.isDirectory()) await walk(absolute, level + 1);
      }
    }
    await walk(root, 1);
    return text(found.join("\n"));
  },
);
server.tool(
  "search_code",
  "Search source text with ripgrep",
  { query: z.string().min(1).max(300), glob: z.string().max(120).optional() },
  async ({ query, glob }) => {
    const args = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.git/**",
    ];
    if (glob) args.push("--glob", glob);
    args.push("--", query, ".");
    try {
      const result = await run("rg", args);
      return text((result.stdout || result.stderr || "No matches").slice(0, 60_000));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return text(await fallbackSearch(query, glob));
    }
  },
);
server.tool("read_file", "Read a bounded UTF-8 source file", { path: z.string() }, async (input) => {
  const safe = assertSafeRelativePath(input.path);
  const content = await readFile(resolveInside(root, safe), "utf8");
  return text(content.slice(0, 80_000));
});
server.tool(
  "read_range",
  "Read a bounded line range",
  { path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() },
  async (input) => {
    if (input.endLine < input.startLine || input.endLine - input.startLine > 500)
      throw new Error("Line range must contain at most 500 lines");
    const safe = assertSafeRelativePath(input.path),
      content = await readFile(resolveInside(root, safe), "utf8");
    return text(
      content
        .split("\n")
        .slice(input.startLine - 1, input.endLine)
        .map((line, index) => `${input.startLine + index}: ${line}`)
        .join("\n")
        .slice(0, 80_000),
    );
  },
);
server.tool(
  "apply_patch",
  "Replace one exact, unique text block in a source file",
  { path: z.string(), oldText: z.string().min(1).max(120_000), newText: z.string().max(120_000) },
  async ({ path: requested, oldText, newText }) => {
    const safe = assertEditable(requested);
    const absolute = resolveInside(root, safe),
      content = await readFile(absolute, "utf8");
    const variants = [oldText, oldText.replace(/\r?\n/g, "\r\n"), oldText.replace(/\r\n/g, "\n")],
      matched = variants.find((candidate) => content.includes(candidate));
    if (!matched) throw new Error("Patch context was not found");
    const first = content.indexOf(matched);
    if (content.indexOf(matched, first + 1) >= 0) throw new Error("Patch context is ambiguous");
    const replacement = content.includes("\r\n")
        ? newText.replace(/\r?\n/g, "\r\n")
        : newText.replace(/\r\n/g, "\n"),
      updated = content.slice(0, first) + replacement + content.slice(first + matched.length);
    await writeFile(absolute, updated, "utf8");
    return text({ patched: safe, removedChars: matched.length, addedChars: replacement.length });
  },
);
await server.connect(new StdioServerTransport());
