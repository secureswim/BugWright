import {
  Message,
  ModelError,
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
} from "../types.js";

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicResponse = {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

const ENDPOINT = "https://api.anthropic.com/v1/messages";

/**
 * Anthropic requires every assistant `tool_use` to be answered by a `tool_result`
 * in the *next* user message, so tool results are grouped rather than interleaved.
 */
function toAnthropicMessages(messages: Message[]) {
  return messages
    .map((message) => {
      const blocks: AnthropicBlock[] = [];
      for (const part of message.parts) {
        if (part.kind === "text") {
          if (part.text) blocks.push({ type: "text", text: part.text });
        } else if (part.kind === "tool_call") {
          blocks.push({ type: "tool_use", id: part.call.id, name: part.call.name, input: part.call.args });
        } else {
          blocks.push({
            type: "tool_result",
            tool_use_id: part.result.id,
            content: part.result.content,
            ...(part.result.isError ? { is_error: true } : {}),
          });
        }
      }
      return { role: message.role, content: blocks };
    })
    .filter((message) => message.content.length > 0);
}

function classify(status: number, body: string, retryAfter: string | null): ModelError {
  const seconds = Number(retryAfter);
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  if (status === 429)
    return new ModelError("rate_limited", `Anthropic rate limited: ${body.slice(0, 400)}`, {
      status,
      retryAfterMs,
    });
  if (status === 401 || status === 403)
    return new ModelError("auth", `Anthropic rejected the API key (${status})`, { status });
  if (status === 400 && /prompt is too long|max_tokens|context/i.test(body))
    return new ModelError("context_overflow", `Anthropic context overflow: ${body.slice(0, 400)}`, {
      status,
    });
  if (status === 400)
    return new ModelError("invalid_request", `Anthropic rejected the request: ${body.slice(0, 400)}`, {
      status,
    });
  return new ModelError("transient", `Anthropic ${status}: ${body.slice(0, 400)}`, { status });
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    // Anthropic constrains JSON through a forced tool call rather than a
    // response schema field; the loop's fence-parsing fallback is used instead.
    jsonSchema: false,
    parallelToolCalls: true,
    systemPrompt: true,
    maxContextTokens: 200_000,
  };

  private readonly apiKey: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ModelError("auth", "ANTHROPIC_API_KEY is missing");
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: request.signal ?? AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: this.model,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters,
                })),
              }
            : {}),
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelError("cancelled", "Anthropic request was cancelled", { cause: error });
      }
      throw new ModelError("transient", `Anthropic request failed: ${String(error)}`, { cause: error });
    }

    if (!response.ok)
      throw classify(response.status, await response.text(), response.headers.get("retry-after"));

    const data = (await response.json()) as AnthropicResponse;
    const message: Message = { role: "assistant", parts: [] };
    const calls: ToolCall[] = [];

    for (const block of data.content ?? []) {
      if (block.type === "text") message.parts.push({ kind: "text", text: block.text });
      else if (block.type === "tool_use") {
        const call: ToolCall = { id: block.id, name: block.name, args: block.input ?? {} };
        calls.push(call);
        message.parts.push({ kind: "tool_call", call });
      }
    }

    return {
      message,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cachedInputTokens: data.usage?.cache_read_input_tokens ?? 0,
      },
      stopReason: calls.length ? "tool_calls" : data.stop_reason === "max_tokens" ? "length" : "stop",
    };
  }
}
