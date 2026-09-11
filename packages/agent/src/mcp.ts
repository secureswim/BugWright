import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { db } from "@bugwright/database";
import {
  ToolRole,
  assertToolAllowed,
  environmentForServer,
  serversForRole,
  toolsForRole,
  assertReproductionEditable,
} from "@bugwright/policy";
import { projectRoot } from "./runtime.js";

export type ServerName = "repository" | "git" | "runner" | "github";

/** Roles that connect to MCP servers. The Manager has no tools at all. */
const TOOL_ROLES: ToolRole[] = ["RESEARCHER", "REPRODUCER", "CODER", "TESTER", "REVIEWER"];

/** Long arguments are hashed rather than stored, to keep source out of the audit log. */
function sanitizeInput(args: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) =>
      typeof value === "string" && value.length > 240
        ? [
            key,
            {
              redacted: true,
              chars: value.length,
              sha256: createHash("sha256").update(value).digest("hex").slice(0, 16),
            },
          ]
        : [key, value],
    ),
  );
}

const clientKey = (role: ToolRole | "SYSTEM", server: ServerName) => `${role}:${server}`;

/**
 * Role-scoped MCP client pool.
 *
 * Each role gets its own server processes, started with a tool gate naming
 * exactly the tools that role may call. Two consequences worth stating plainly:
 *
 *  - A role cannot call a tool it lacks authority for, because the tool is not
 *    registered in its session. The `assertToolAllowed` check below still runs,
 *    but as defence in depth and to produce the audit event - not as the only
 *    thing standing between a role and a capability.
 *  - Servers no longer inherit the parent environment. Each receives only the
 *    variables it needs, so the repository and runner servers never hold the
 *    model API key, the GitHub token, or the database URL.
 */
export class McpTools {
  private clients = new Map<string, Client>();
  private readonly taskId: string;
  private readonly repoRoot: string;
  private protectedTest?: string;

  async protectReproduction(testPath: string) {
    this.protectedTest = testPath;
    for (const role of TOOL_ROLES) {
      const key = clientKey(role, "repository");
      const client = this.clients.get(key);
      if (!client) continue;
      await client.close();
      this.clients.delete(key);
      await this.start(role, "repository", toolsForRole(role, "repository"));
    }
  }

  constructor(taskId: string, repoRoot: string) {
    this.taskId = taskId;
    this.repoRoot = repoRoot;
  }

  /**
   * Starts the servers each role needs.
   *
   * `servers` narrows what is started (the github server is only needed when an
   * issue body must be fetched); roles still only receive their own tools.
   */
  async connect(servers: ServerName[], roles: ToolRole[] = TOOL_ROLES) {
    const wanted = new Set(servers);
    for (const role of roles) {
      for (const server of serversForRole(role)) {
        if (!wanted.has(server as ServerName)) continue;
        const tools = toolsForRole(role, server);
        if (!tools.length) continue;
        await this.start(role, server as ServerName, tools);
      }
    }
    // The github server is trusted infrastructure, not an agent capability: it
    // is reachable only through callTrusted, never from a role.
    if (wanted.has("github")) await this.start("SYSTEM", "github", undefined);
  }

  private async start(role: ToolRole | "SYSTEM", server: ServerName, tools: string[] | undefined) {
    const root = projectRoot();
    const source = path.join(root, "packages", "mcp", server, "src", "server.ts");
    const client = new Client({ name: `bugwright-${role.toLowerCase()}-${server}`, version: "0.2.0" });

    const params: StdioServerParameters = {
      command: process.execPath,
      args: ["--require", path.join(root, "scripts", "windows-user-shim.cjs"), "--import", "tsx", source],
      env: environmentForServer(server, process.env, {
        BUGWRIGHT_REPO_ROOT: this.repoRoot,
        ...(this.protectedTest ? { BUGWRIGHT_PROTECTED_TEST: this.protectedTest } : {}),
        ...(tools ? { BUGWRIGHT_ALLOWED_TOOLS: tools.join(",") } : {}),
      }),
    };

    try {
      await client.connect(new StdioClientTransport(params));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`MCP ${server} connection failed for ${role}: ${detail}`, { cause: error });
    }
    this.clients.set(clientKey(role, server), client);
  }

  async call(
    role: ToolRole,
    server: ServerName,
    name: string,
    args: Record<string, unknown> = {},
    iteration = 0,
  ) {
    try {
      assertToolAllowed(role, server, name);
      if (server === "repository" && ["apply_patch", "write_test_file"].includes(name)) {
        assertReproductionEditable(String(args.path), this.protectedTest);
      }
    } catch (error) {
      await db.taskEvent.create({
        data: {
          taskId: this.taskId,
          type: "TOOL_DENIED",
          title: `${role} was denied ${server}.${name}`,
          tool: `${server}.${name}`,
          agentRole: role,
          status: "DENIED",
          iteration,
          input: sanitizeInput(args) as never,
        },
      });
      throw error;
    }
    return this.execute(clientKey(role, server), server, name, args, role, iteration);
  }

  /**
   * Infrastructure calls made by the orchestrator itself, not by a model.
   *
   * Restricted to the github and git servers: this is how the issue body is
   * fetched and how the publisher reads the final changed-file list. It is not
   * a way for a role to reach a tool it was denied - `call` is the only path a
   * model-driven agent takes.
   */
  async callTrusted(server: "github" | "git", name: string, args: Record<string, unknown> = {}) {
    const key = this.clients.has(clientKey("SYSTEM", server))
      ? clientKey("SYSTEM", server)
      : clientKey("REVIEWER", server);
    return this.execute(key, server, name, args, undefined, 0);
  }

  private async execute(
    key: string,
    server: ServerName,
    name: string,
    args: Record<string, unknown>,
    role?: ToolRole,
    iteration = 0,
  ) {
    const client = this.clients.get(key);
    if (!client) throw new Error(`MCP server ${server} is not connected for ${key.split(":")[0]}`);
    const started = Date.now();
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: server === "runner" ? 11 * 60_000 : 60_000,
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      const raw = content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      if (result.isError) throw new Error(raw || `${name} failed`);
      await db.taskEvent.create({
        data: {
          taskId: this.taskId,
          type: "TOOL_COMPLETED",
          title: `${role ?? "SYSTEM"} used ${server}.${name}`,
          tool: `${server}.${name}`,
          agentRole: role,
          status: "COMPLETED",
          durationMs: Date.now() - started,
          iteration,
          input: sanitizeInput(args) as never,
          output: {
            resultChars: raw.length,
            resultHash: createHash("sha256").update(raw).digest("hex").slice(0, 16),
          },
        },
      });
      return raw;
    } catch (error) {
      await db.taskEvent.create({
        data: {
          taskId: this.taskId,
          type: "TOOL_FAILED",
          title: `${role ?? "SYSTEM"} failed ${server}.${name}`,
          tool: `${server}.${name}`,
          agentRole: role,
          status: "FAILED",
          durationMs: Date.now() - started,
          iteration,
          input: sanitizeInput(args) as never,
          output: { error: error instanceof Error ? error.message : String(error) },
        },
      });
      throw error;
    }
  }

  async close() {
    await Promise.all([...this.clients.values()].map((client) => client.close().catch(() => undefined)));
    this.clients.clear();
  }
}

export function parseToolJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as T;
  }
}
