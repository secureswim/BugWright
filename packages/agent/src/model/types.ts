/**
 * Canonical, provider-independent types for model interaction.
 *
 * Every provider normalises its wire format into these shapes, so the agent
 * loop above them never learns which vendor is answering. Adding a provider
 * means implementing {@link ModelProvider} - it does not mean reimplementing
 * turn management, tool dispatch, budgets, or retries.
 */

/** A tool the model may call, described in JSON Schema. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object describing the tool arguments. */
  parameters: Record<string, unknown>;
}

/**
 * A tool call requested by the model.
 *
 * `id` is required even though Gemini pairs calls to results by function name
 * rather than by id: the Gemini provider synthesises ids so that the loop only
 * ever deals with one shape.
 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  /** Serialised tool output, or the error message when `isError` is set. */
  content: string;
  isError?: boolean;
}

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "tool_result"; result: ToolResult };

export interface Message {
  role: "user" | "assistant";
  parts: MessagePart[];
  /**
   * The provider's own representation of an assistant turn, kept verbatim so it
   * can be replayed byte-for-byte on the next request.
   *
   * Canonical parts are a lowest common denominator, and some providers carry
   * opaque fields that must survive the round trip. Gemini 3 attaches a
   * `thoughtSignature` to each `functionCall` and rejects a follow-up request
   * whose replayed call has lost it ("Function call is missing a
   * thought_signature in functionCall parts"). Anthropic's thinking blocks
   * carry a signature with the same requirement.
   *
   * Providers set this on responses they produce and prefer it over
   * re-serialising `parts`. It is opaque to the agent loop.
   */
  providerRaw?: unknown;
}

/** Token accounting for a single provider call. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
});

/**
 * What a provider can do. The loop reads these instead of branching on vendor
 * names, so an unsupported feature degrades rather than breaking.
 */
export interface ProviderCapabilities {
  /** Native constrained JSON output. When false the loop falls back to fence parsing. */
  jsonSchema: boolean;
  /** More than one tool call in a single assistant turn. */
  parallelToolCalls: boolean;
  /** A dedicated system instruction channel (rather than a leading user message). */
  systemPrompt: boolean;
  maxContextTokens: number;
}

export interface ProviderRequest {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  /** JSON Schema the response must satisfy. Honoured only when `jsonSchema` is supported. */
  responseSchema?: Record<string, unknown>;
  temperature: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  message: Message;
  usage: Usage;
  /** Why the model stopped. `length` means output was truncated. */
  stopReason: "stop" | "tool_calls" | "length" | "other";
}

/**
 * One completion, given canonical messages. Providers are stateless: they do
 * not retry, do not execute tools, and do not manage history.
 */
export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ModelErrorKind =
  "rate_limited" | "context_overflow" | "refused" | "transient" | "invalid_request" | "auth" | "cancelled";

/**
 * Providers normalise vendor errors into this type so the loop can react to
 * the *kind* of failure: rate limits back off, context overflow triggers
 * compaction and a retry, auth and invalid_request fail immediately.
 */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  /** Server-suggested wait before retrying, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(
    kind: ModelErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ModelError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient";
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export const textPart = (text: string): MessagePart => ({ kind: "text", text });

export const userText = (text: string): Message => ({ role: "user", parts: [textPart(text)] });

/** Concatenated text of every text part in a message. */
export function messageText(message: Message): string {
  return message.parts
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function messageToolCalls(message: Message): ToolCall[] {
  return message.parts
    .filter((part): part is { kind: "tool_call"; call: ToolCall } => part.kind === "tool_call")
    .map((part) => part.call);
}

/**
 * Rough character count of everything that would be sent for a request.
 *
 * Used for the context-size metric. It counts the whole conversation including
 * accumulated tool results, not just the initial input - measuring only the
 * first payload understates real context growth by an order of magnitude.
 */
export function contextChars(system: string, messages: Message[]): number {
  let total = system.length;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "text") total += part.text.length;
      else if (part.kind === "tool_call")
        total += part.call.name.length + JSON.stringify(part.call.args).length;
      else total += part.result.content.length;
    }
  }
  return total;
}
