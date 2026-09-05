import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as registry from "./model/registry.js";

/**
 * The public surface of `@bugwright/agent`.
 *
 * This guards a real failure: the API imports `reviewerIsIndependent` from this
 * package, the re-export in `index.ts` was dropped during an edit, and nothing
 * caught it until the server refused to boot with
 *
 *   SyntaxError: The requested module '@bugwright/agent' does not provide an
 *   export named 'reviewerIsIndependent'
 *
 * ESM named exports are a runtime contract, and this package is consumed
 * directly from source, so a dropped re-export is invisible until something
 * imports it.
 *
 * The barrel is checked by reading it rather than importing it. Importing
 * `./index.js` pulls in the Prisma client and the whole orchestrator, which
 * needs a generated client and a database to load - so a test that imported it
 * would be skipped exactly where it is most needed. The symbols themselves are
 * verified by importing the module that defines them, which has no such
 * dependencies.
 */
const barrel = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

/** Names other workspaces import from "@bugwright/agent", and who needs each. */
const REQUIRED_EXPORTS: Array<[name: string, consumer: string]> = [
  ["reviewerIsIndependent", "apps/api /health and packages/evaluation"],
  ["resolveProvider", "packages/evaluation"],
  ["parseSpec", "model configuration"],
  ["McpTools", "apps/api, apps/worker, scripts"],
  ["runTask", "apps/worker"],
  ["changedFilesFromNameStatus", "apps/worker/src/publish.ts"],
  ["assessScope", "orchestrator and reuse"],
  ["changedFilesFromDiff", "orchestrator and reuse"],
  ["attemptHistory", "resume"],
  ["RoleModel", "roles"],
  ["GeminiModel", "backwards compatibility"],
  ["FakeProvider", "tests"],
  ["ReplayProvider", "deterministic replay"],
  ["RecordingProvider", "cassette capture"],
];

describe("@bugwright/agent public exports", () => {
  it.each(REQUIRED_EXPORTS)("re-exports %s (needed by %s)", (name) => {
    // Matches `export { ... name ... }` or `export function name`.
    const exported = new RegExp(
      `export\\s+(\\{[^}]*\\b${name}\\b[^}]*\\}|(async\\s+)?function\\s+${name}\\b)`,
      "s",
    );
    expect(barrel).toMatch(exported);
  });

  it("resolves the model registry symbols the API depends on", () => {
    expect(typeof registry.reviewerIsIndependent).toBe("function");
    expect(typeof registry.resolveProvider).toBe("function");
    expect(typeof registry.parseSpec).toBe("function");
  });

  it("reports reviewer independence without throwing when no key is configured", () => {
    // The API calls this from /health, which has to answer even when the
    // environment is incomplete - that is the whole point of a health check.
    const previous = { ...process.env };
    for (const key of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[key];
    try {
      expect(() => registry.reviewerIsIndependent()).not.toThrow();
      expect(registry.reviewerIsIndependent()).toBe(false);
    } finally {
      Object.assign(process.env, previous);
    }
  });

  it("rejects an unknown provider rather than silently defaulting", () => {
    expect(() => registry.parseSpec("nonexistent-vendor")).toThrow(/Unknown model provider/);
  });

  it("parses provider and provider:model forms", () => {
    expect(registry.parseSpec("gemini")).toEqual({ provider: "gemini", model: undefined });
    expect(registry.parseSpec("anthropic:claude-sonnet-4-20250514")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
  });
});
