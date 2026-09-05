import { describe, expect, it } from "vitest";
import { toGeminiContents } from "./providers/gemini.js";
import { Message } from "./types.js";

/**
 * These guard a real production failure.
 *
 * Gemini 3 attaches an opaque `thoughtSignature` to `functionCall` parts. The
 * first tool call succeeded, then the follow-up request - which replays the
 * assistant turn - was rejected with:
 *
 *   400 Function call is missing a thought_signature in functionCall parts.
 *
 * because the canonical `Message` shape had rebuilt the turn from name and args
 * and dropped the signature. Every research agent failed on its second turn.
 */
describe("toGeminiContents", () => {
  const rawAssistantTurn = {
    role: "model" as const,
    parts: [
      { thought: true, text: "I should list the tree first.", thoughtSignature: "sig-thought" },
      {
        functionCall: { name: "list_tree", args: { depth: 3 } },
        thoughtSignature: "sig-call",
      },
    ],
  };

  const assistantMessage: Message = {
    role: "assistant",
    parts: [{ kind: "tool_call", call: { id: "list_tree:1", name: "list_tree", args: { depth: 3 } } }],
    providerRaw: rawAssistantTurn,
  };

  it("replays an assistant turn verbatim, preserving thoughtSignature", () => {
    const [content] = toGeminiContents([assistantMessage]);
    expect(content).toBe(rawAssistantTurn);
    expect(content.parts[1].thoughtSignature).toBe("sig-call");
  });

  it("preserves the signature on every functionCall part", () => {
    const signatures = toGeminiContents([assistantMessage])[0]
      .parts.filter((part) => part.functionCall)
      .map((part) => part.thoughtSignature);
    expect(signatures).toEqual(["sig-call"]);
    expect(signatures).not.toContain(undefined);
  });

  it("still serialises an assistant turn that has no provider representation", () => {
    const [content] = toGeminiContents([{ ...assistantMessage, providerRaw: undefined }]);
    expect(content.role).toBe("model");
    expect(content.parts[0].functionCall).toEqual({ name: "list_tree", args: { depth: 3 } });
  });

  it("ignores a providerRaw that is not Gemini-shaped", () => {
    // A cassette recorded from another provider must not be replayed as-is.
    const [content] = toGeminiContents([{ ...assistantMessage, providerRaw: { some: "other shape" } }]);
    expect(content.parts[0].functionCall).toBeDefined();
  });

  it("maps a user turn's tool results to functionResponse parts", () => {
    const [content] = toGeminiContents([
      {
        role: "user",
        parts: [
          { kind: "tool_result", result: { id: "list_tree:1", name: "list_tree", content: "src/\napp/" } },
        ],
      },
    ]);
    expect(content.role).toBe("user");
    expect(content.parts[0].functionResponse).toEqual({
      name: "list_tree",
      response: { result: "src/\napp/" },
    });
  });

  it("marks a failed tool result as an error for the model to react to", () => {
    const [content] = toGeminiContents([
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            result: { id: "p:1", name: "apply_patch", content: "context not found", isError: true },
          },
        ],
      },
    ]);
    expect(content.parts[0].functionResponse?.response).toEqual({ error: "context not found" });
  });

  it("drops empty messages rather than sending an empty parts array", () => {
    expect(toGeminiContents([{ role: "user", parts: [{ kind: "text", text: "" }] }])).toEqual([]);
  });

  it("round-trips a full tool-calling exchange in order", () => {
    const contents = toGeminiContents([
      { role: "user", parts: [{ kind: "text", text: "{}" }] },
      assistantMessage,
      {
        role: "user",
        parts: [{ kind: "tool_result", result: { id: "list_tree:1", name: "list_tree", content: "ok" } }],
      },
    ]);
    expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
    expect(contents[1].parts[1].thoughtSignature).toBe("sig-call");
  });
});
