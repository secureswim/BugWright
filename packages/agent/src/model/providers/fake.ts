import {
  Message,
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
} from "../types.js";

/** One scripted turn: either plain text, or tool calls the loop should execute. */
export type ScriptedTurn =
  | { text: string }
  | { toolCalls: Array<{ name: string; args?: Record<string, unknown> }> }
  | { error: Error };

/**
 * A deterministic in-memory provider for unit tests.
 *
 * Turns are consumed in order, so a test can script an exact conversation -
 * "call read_file, then return this JSON" - and assert on what the loop did
 * with it. No network, no key, no cost.
 */
export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  /** Every request this provider was asked to complete, in order. */
  readonly requests: ProviderRequest[] = [];

  private readonly turns: ScriptedTurn[];
  private cursor = 0;

  constructor(turns: ScriptedTurn[], options: { model?: string; jsonSchema?: boolean } = {}) {
    this.turns = turns;
    this.model = options.model ?? "fake-model";
    this.capabilities = {
      jsonSchema: options.jsonSchema ?? true,
      parallelToolCalls: true,
      systemPrompt: true,
      maxContextTokens: 1_000_000,
    };
  }

  get remaining(): number {
    return this.turns.length - this.cursor;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const turn = this.turns[this.cursor++];
    if (!turn) throw new Error("FakeProvider ran out of scripted turns");
    if ("error" in turn) throw turn.error;

    const message: Message = { role: "assistant", parts: [] };
    if ("text" in turn) {
      message.parts.push({ kind: "text", text: turn.text });
      return {
        message,
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
        stopReason: "stop",
      };
    }

    for (const [index, call] of turn.toolCalls.entries()) {
      const toolCall: ToolCall = {
        id: `fake-${this.cursor}-${index}`,
        name: call.name,
        args: call.args ?? {},
      };
      message.parts.push({ kind: "tool_call", call: toolCall });
    }
    return {
      message,
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      stopReason: "tool_calls",
    };
  }
}
