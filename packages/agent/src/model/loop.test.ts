import { describe, expect, it } from "vitest";
import { compactHistory, parseStructured, runAgentLoop } from "./loop.js";
import { FakeProvider } from "./providers/fake.js";
import { Message, ModelError } from "./types.js";

const noTools = { system: "s", input: { a: 1 }, tools: [] };

describe("runAgentLoop", () => {
  it("returns the final text when the model stops without calling tools", async () => {
    const provider = new FakeProvider([{ text: '{"ok":true}' }]);
    const result = await runAgentLoop(provider, noTools);
    expect(result.text).toBe('{"ok":true}');
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  it("executes tool calls and feeds results back to the model", async () => {
    const provider = new FakeProvider([
      { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { text: '{"done":true}' },
    ]);
    const seen: string[] = [];
    const result = await runAgentLoop(provider, {
      ...noTools,
      tools: [{ name: "read_file", description: "", parameters: {} }],
      execute: async (name) => {
        seen.push(name);
        return "file contents";
      },
    });
    expect(seen).toEqual(["read_file"]);
    expect(result.toolCalls).toBe(1);
    expect(result.modelCalls).toBe(2);
    // The tool result must reach the model's next request.
    const lastRequest = provider.requests.at(-1)!;
    const parts = lastRequest.messages.flatMap((message) => message.parts);
    expect(parts.some((part) => part.kind === "tool_result" && part.result.content === "file contents")).toBe(
      true,
    );
  });

  it("reports a failing tool to the model instead of crashing the run", async () => {
    const provider = new FakeProvider([
      { toolCalls: [{ name: "apply_patch" }] },
      { text: '{"recovered":true}' },
    ]);
    const result = await runAgentLoop(provider, {
      ...noTools,
      tools: [{ name: "apply_patch", description: "", parameters: {} }],
      execute: async () => {
        throw new Error("Patch context was not found");
      },
    });
    expect(result.text).toBe('{"recovered":true}');
    const parts = provider.requests.at(-1)!.messages.flatMap((message) => message.parts);
    const errorResult = parts.find((part) => part.kind === "tool_result" && part.result.isError);
    expect(errorResult).toBeDefined();
  });

  it("refuses tool calls when the agent has no executor", async () => {
    const provider = new FakeProvider([{ toolCalls: [{ name: "read_file" }] }]);
    await expect(runAgentLoop(provider, noTools)).rejects.toThrow(/not permitted to call tools/);
  });

  it("retries a rate limit without counting it as a model call", async () => {
    const provider = new FakeProvider([
      { error: new ModelError("rate_limited", "429", { retryAfterMs: 1 }) },
      { text: '{"ok":true}' },
    ]);
    const result = await runAgentLoop(provider, noTools);
    // The bug this guards: counting HTTP retries as model calls inflates the
    // headline efficiency metric.
    expect(result.modelCalls).toBe(1);
    expect(result.retries).toBe(1);
  });

  it("does not retry an auth failure", async () => {
    const provider = new FakeProvider([
      { error: new ModelError("auth", "bad key") },
      { text: "unreachable" },
    ]);
    await expect(runAgentLoop(provider, noTools)).rejects.toThrow(/bad key/);
    expect(provider.remaining).toBe(1);
  });

  it("stops after the configured number of turns", async () => {
    const provider = new FakeProvider(
      Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "search_code" }] })),
    );
    await expect(
      runAgentLoop(provider, {
        ...noTools,
        maxTurns: 3,
        tools: [{ name: "search_code", description: "", parameters: {} }],
        execute: async () => "no matches",
      }),
    ).rejects.toThrow(/maximum model iterations/);
  });

  it("measures context across the whole conversation, not just the first input", async () => {
    const big = "x".repeat(5_000);
    const provider = new FakeProvider([{ toolCalls: [{ name: "read_file" }] }, { text: "{}" }]);
    const result = await runAgentLoop(provider, {
      ...noTools,
      tools: [{ name: "read_file", description: "", parameters: {} }],
      execute: async () => big,
    });
    expect(result.contextChars).toBeGreaterThan(5_000);
  });

  it("reports real token usage and a cost", async () => {
    const provider = new FakeProvider([{ text: "{}" }], { model: "gemini-3.5-flash" });
    const result = await runAgentLoop(provider, noTools);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe("compactHistory", () => {
  it("elides older large tool results and keeps recent ones intact", () => {
    const long = "y".repeat(10_000);
    const messages: Message[] = [
      {
        role: "user",
        parts: [{ kind: "tool_result", result: { id: "1", name: "read_file", content: long } }],
      },
      {
        role: "user",
        parts: [{ kind: "tool_result", result: { id: "2", name: "read_file", content: long } }],
      },
      {
        role: "user",
        parts: [{ kind: "tool_result", result: { id: "3", name: "read_file", content: long } }],
      },
    ];
    const { messages: next, compacted } = compactHistory(messages, 2);
    expect(compacted).toBe(1);
    const first = next[0].parts[0];
    const last = next[2].parts[0];
    expect(first.kind === "tool_result" && first.result.content).toContain("elided");
    expect(last.kind === "tool_result" && last.result.content.length).toBe(10_000);
  });

  it("leaves small results alone", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ kind: "tool_result", result: { id: "1", name: "t", content: "short" } }] },
    ];
    expect(compactHistory(messages).compacted).toBe(0);
  });
});

describe("parseStructured", () => {
  it("reads a fenced JSON block", () => {
    expect(parseStructured('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("reads JSON surrounded by prose", () => {
    expect(parseStructured('Here it is: {"a":2} - done')).toEqual({ a: 2 });
  });

  it("throws when there is no object", () => {
    expect(() => parseStructured("no json here")).toThrow(/structured JSON/);
  });
});
