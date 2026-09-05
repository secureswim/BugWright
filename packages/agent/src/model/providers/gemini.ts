import {
  Message,
  ModelError,
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
} from "../types.js";

/* Gemini wire types (only the fields BugPilot uses). */
type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
};
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiResponse = {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
};

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini pairs tool calls to tool results by function name rather than by id.
 * We synthesise deterministic ids on the way in and drop them on the way out,
 * so the agent loop only ever sees the canonical id-based shape.
 */
const synthesizeId = (name: string, index: number) => `${name}:${index}`;

function toGeminiContents(messages: Message[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    const parts: GeminiPart[] = [];
    for (const part of message.parts) {
      if (part.kind === "text") {
        if (part.text) parts.push({ text: part.text });
      } else if (part.kind === "tool_call") {
        parts.push({ functionCall: { name: part.call.name, args: part.call.args } });
      } else {
        parts.push({
          functionResponse: {
            name: part.result.name,
            response: part.result.isError ? { error: part.result.content } : { result: part.result.content },
          },
        });
      }
    }
    if (!parts.length) continue;
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

/** Map an HTTP status and body onto a normalised {@link ModelError}. */
function classify(status: number, body: string): ModelError {
  if (status === 429) {
    return new ModelError("rate_limited", `Gemini rate limited: ${body.slice(0, 400)}`, {
      status,
      retryAfterMs: suggestedDelayMs(body),
    });
  }
  if (status === 401 || status === 403) {
    return new ModelError("auth", `Gemini rejected the API key (${status})`, { status });
  }
  if (status === 400 && /token|too long|exceeds/i.test(body)) {
    return new ModelError("context_overflow", `Gemini context overflow: ${body.slice(0, 400)}`, { status });
  }
  if (status === 400) {
    return new ModelError("invalid_request", `Gemini rejected the request: ${body.slice(0, 400)}`, {
      status,
    });
  }
  if (status >= 500) {
    return new ModelError("transient", `Gemini ${status}: ${body.slice(0, 400)}`, { status });
  }
  return new ModelError("transient", `Gemini ${status}: ${body.slice(0, 400)}`, { status });
}

function suggestedDelayMs(body: string): number | undefined {
  const match = body.match(/retry(?:Delay)?(?:"\s*:\s*"| in )([\d.]+)s/i);
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export class GeminiProvider implements ModelProvider {
  readonly id = "gemini";
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    jsonSchema: true,
    parallelToolCalls: true,
    systemPrompt: true,
    maxContextTokens: 1_000_000,
  };

  private readonly apiKey: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) throw new ModelError("auth", "GEMINI_API_KEY is missing");
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    // Gemini rejects a request that carries both tools and a response schema.
    const useSchema = Boolean(request.responseSchema) && request.tools.length === 0;
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: toGeminiContents(request.messages),
      ...(request.tools.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ],
          }
        : {}),
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        ...(useSchema
          ? { responseMimeType: "application/json", responseSchema: request.responseSchema }
          : {}),
      },
    };

    let response: Response;
    try {
      response = await fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        signal: request.signal ?? AbortSignal.timeout(120_000),
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelError("cancelled", "Gemini request was cancelled", { cause: error });
      }
      throw new ModelError("transient", `Gemini request failed: ${String(error)}`, { cause: error });
    }

    if (!response.ok) throw classify(response.status, await response.text());

    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    if (!candidate?.content) throw new ModelError("refused", "Gemini returned no candidate content");

    const parts = candidate.content.parts ?? [];
    const calls: ToolCall[] = [];
    const message: Message = { role: "assistant", parts: [] };

    for (const [index, part] of parts.entries()) {
      if (part.text) message.parts.push({ kind: "text", text: part.text });
      if (part.functionCall) {
        const call: ToolCall = {
          id: synthesizeId(part.functionCall.name, index),
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        };
        calls.push(call);
        message.parts.push({ kind: "tool_call", call });
      }
    }

    const usageMetadata = data.usageMetadata ?? {};
    return {
      message,
      usage: {
        inputTokens: usageMetadata.promptTokenCount ?? 0,
        outputTokens: usageMetadata.candidatesTokenCount ?? 0,
        cachedInputTokens: usageMetadata.cachedContentTokenCount ?? 0,
      },
      stopReason: calls.length ? "tool_calls" : candidate.finishReason === "MAX_TOKENS" ? "length" : "stop",
    };
  }
}
