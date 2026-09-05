import {
  Message,
  ModelError,
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
} from "../types.js";

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI wants each tool result as its own `role: "tool"` message keyed by
 * `tool_call_id`, so one canonical user message carrying several tool results
 * expands into several wire messages.
 */
function toOpenAIMessages(system: string, messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    const text = message.parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join("\n");
    const calls = message.parts.filter(
      (part): part is { kind: "tool_call"; call: ToolCall } => part.kind === "tool_call",
    );
    const results = message.parts.filter((part) => part.kind === "tool_result") as Array<
      Extract<Message["parts"][number], { kind: "tool_result" }>
    >;

    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((part) => ({
                id: part.call.id,
                type: "function" as const,
                function: { name: part.call.name, arguments: JSON.stringify(part.call.args) },
              })),
            }
          : {}),
      });
      continue;
    }

    for (const part of results) {
      out.push({ role: "tool", tool_call_id: part.result.id, content: part.result.content });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function classify(status: number, body: string, retryAfter: string | null): ModelError {
  const seconds = Number(retryAfter);
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  if (status === 429)
    return new ModelError("rate_limited", `OpenAI rate limited: ${body.slice(0, 400)}`, {
      status,
      retryAfterMs,
    });
  if (status === 401 || status === 403)
    return new ModelError("auth", `OpenAI rejected the API key (${status})`, { status });
  if (status === 400 && /context length|maximum context|too many tokens/i.test(body))
    return new ModelError("context_overflow", `OpenAI context overflow: ${body.slice(0, 400)}`, { status });
  if (status === 400)
    return new ModelError("invalid_request", `OpenAI rejected the request: ${body.slice(0, 400)}`, {
      status,
    });
  return new ModelError("transient", `OpenAI ${status}: ${body.slice(0, 400)}`, { status });
}

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    jsonSchema: true,
    parallelToolCalls: true,
    systemPrompt: true,
    maxContextTokens: 128_000,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey?: string; model?: string; baseUrl?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ModelError("auth", "OPENAI_API_KEY is missing");
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    this.baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const useSchema = Boolean(request.responseSchema) && request.tools.length === 0;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: request.signal ?? AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: this.model,
          messages: toOpenAIMessages(request.system, request.messages),
          temperature: request.temperature,
          max_completion_tokens: request.maxOutputTokens,
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
          ...(useSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: "report", strict: false, schema: request.responseSchema },
                },
              }
            : {}),
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelError("cancelled", "OpenAI request was cancelled", { cause: error });
      }
      throw new ModelError("transient", `OpenAI request failed: ${String(error)}`, { cause: error });
    }

    if (!response.ok)
      throw classify(response.status, await response.text(), response.headers.get("retry-after"));

    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    if (!choice?.message) throw new ModelError("refused", "OpenAI returned no choice");

    const message: Message = { role: "assistant", parts: [] };
    if (choice.message.content) message.parts.push({ kind: "text", text: choice.message.content });

    const calls = choice.message.tool_calls ?? [];
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // A malformed argument object is reported to the model as a tool error
        // by the loop rather than crashing the run.
        args = { __malformed: call.function.arguments };
      }
      message.parts.push({ kind: "tool_call", call: { id: call.id, name: call.function.name, args } });
    }

    return {
      message,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      stopReason: calls.length ? "tool_calls" : choice.finish_reason === "length" ? "length" : "stop",
    };
  }
}
