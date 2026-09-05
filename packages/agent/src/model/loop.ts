import { costUsd } from "./cost.js";
import {
  Message,
  MessagePart,
  ModelError,
  ModelProvider,
  ProviderRequest,
  ToolSchema,
  Usage,
  addUsage,
  contextChars,
  emptyUsage,
  messageText,
  messageToolCalls,
} from "./types.js";

export interface AgentLoopOptions {
  system: string;
  /** Structured input for the agent; serialised as the opening user message. */
  input: unknown;
  tools: ToolSchema[];
  /** Executes one tool call. Rejections are reported to the model as tool errors. */
  execute?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** JSON Schema for the final answer, used when the provider supports it. */
  responseSchema?: Record<string, unknown>;
  maxTurns?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Total provider attempts, including retries, before the loop gives up. */
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  text: string;
  messages: Message[];
  usage: Usage;
  /** Successful provider completions. Retries are counted separately. */
  modelCalls: number;
  /** Retried provider attempts that did not produce a completion. */
  retries: number;
  toolCalls: number;
  /** Largest request context observed, in characters, including tool results. */
  contextChars: number;
  costUsd: number;
  model: string;
  provider: string;
  compactions: number;
}

const DEFAULT_MAX_TURNS = 12;
const MAX_BACKOFF_MS = 60_000;
/** Tool results longer than this are candidates for compaction. */
const COMPACTION_THRESHOLD_CHARS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replaces the body of older, large tool results with a short placeholder.
 *
 * Tool output dominates context in a long run - a single `read_file` can return
 * 80KB - so on context overflow we shrink history rather than failing the task.
 * The most recent `keepRecent` tool results are left untouched because they are
 * what the model is actively reasoning about.
 */
export function compactHistory(
  messages: Message[],
  keepRecent = 2,
): { messages: Message[]; compacted: number } {
  const indices: Array<[number, number]> = [];
  messages.forEach((message, messageIndex) => {
    message.parts.forEach((part, partIndex) => {
      if (part.kind === "tool_result" && part.result.content.length > COMPACTION_THRESHOLD_CHARS) {
        indices.push([messageIndex, partIndex]);
      }
    });
  });

  const targets = indices.slice(0, Math.max(0, indices.length - keepRecent));
  if (!targets.length) return { messages, compacted: 0 };

  const next = messages.map((message) => ({ ...message, parts: [...message.parts] }));
  for (const [messageIndex, partIndex] of targets) {
    const part = next[messageIndex].parts[partIndex];
    if (part.kind !== "tool_result") continue;
    next[messageIndex].parts[partIndex] = {
      kind: "tool_result",
      result: {
        ...part.result,
        content:
          `[${part.result.content.length} characters elided to fit the context window. ` +
          `Re-run ${part.result.name} if this evidence is still needed.]\n` +
          part.result.content.slice(0, 400),
      },
    };
  }
  return { messages: next, compacted: targets.length };
}

/**
 * Runs one agent to completion: repeated provider calls, tool dispatch, budget
 * enforcement, retry with backoff, and context compaction.
 *
 * This is provider-independent on purpose. Adding a model vendor means writing
 * a {@link ModelProvider}; it never means touching this file.
 */
export async function runAgentLoop(
  provider: ModelProvider,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxAttempts = options.maxAttempts ?? 4;

  let messages: Message[] = [
    { role: "user", parts: [{ kind: "text", text: JSON.stringify(options.input) }] },
  ];
  let usage = emptyUsage();
  let modelCalls = 0;
  let retries = 0;
  let toolCalls = 0;
  let compactions = 0;
  let peakContext = 0;
  let finalText = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    const request: ProviderRequest = {
      system: options.system,
      messages,
      tools: options.tools,
      responseSchema: provider.capabilities.jsonSchema ? options.responseSchema : undefined,
      temperature: options.temperature ?? 0.1,
      maxOutputTokens: options.maxOutputTokens ?? 8192,
      signal: options.signal,
    };
    peakContext = Math.max(peakContext, contextChars(request.system, request.messages));

    /* ---- one completion, with retry and compaction ---- */
    let response;
    let attempt = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        response = await provider.complete({ ...request, messages });
        modelCalls++;
        break;
      } catch (error) {
        const modelError =
          error instanceof ModelError ? error : new ModelError("transient", String(error), { cause: error });

        if (modelError.kind === "context_overflow") {
          const compacted = compactHistory(messages);
          if (compacted.compacted > 0) {
            messages = compacted.messages;
            compactions += compacted.compacted;
            retries++;
            continue;
          }
        }

        attempt++;
        if (!modelError.retryable || attempt >= maxAttempts) {
          throw Object.assign(modelError, { modelCalls, toolCalls, retries });
        }
        retries++;
        const backoff = Math.min(MAX_BACKOFF_MS, Math.max(500 * 2 ** attempt, modelError.retryAfterMs ?? 0));
        await sleep(backoff);
      }
    }

    messages = [...messages, response.message];
    usage = addUsage(usage, response.usage);

    const text = messageText(response.message);
    if (text) finalText = text;

    const calls = messageToolCalls(response.message);
    if (!calls.length) {
      return {
        text: finalText,
        messages,
        usage,
        modelCalls,
        retries,
        toolCalls,
        contextChars: peakContext,
        costUsd: costUsd(provider.model, usage),
        model: provider.model,
        provider: provider.id,
        compactions,
      };
    }

    if (!options.execute) {
      throw Object.assign(new ModelError("refused", "This agent is not permitted to call tools"), {
        modelCalls,
        toolCalls,
        retries,
      });
    }

    /* ---- execute the requested tools ---- */
    const parts: MessagePart[] = [];
    for (const call of calls) {
      toolCalls++;
      try {
        const result = await options.execute(call.name, call.args);
        parts.push({ kind: "tool_result", result: { id: call.id, name: call.name, content: result } });
      } catch (error) {
        // A failing tool is information for the model, not a crash: it can read
        // the error and correct its next call.
        parts.push({
          kind: "tool_result",
          result: {
            id: call.id,
            name: call.name,
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          },
        });
      }
    }

    // One turn before the budget runs out, tell the model to stop gathering and
    // answer from what it already has - otherwise it burns the final turn on a
    // tool call whose result it can never use.
    if (turn === maxTurns - 2) {
      parts.push({
        kind: "text",
        text:
          "Tool budget exhausted. Do not call another tool. " +
          "Return the required final JSON now using the evidence already collected.",
      });
    }

    messages = [...messages, { role: "user", parts }];
  }

  throw Object.assign(new ModelError("refused", "Agent exceeded its maximum model iterations"), {
    modelCalls,
    toolCalls,
    retries,
  });
}

/**
 * Extracts a JSON object from model text.
 *
 * Only needed for providers without native constrained output; when
 * `capabilities.jsonSchema` is true the text is already valid JSON and this is
 * a no-op parse.
 */
export function parseStructured<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Agent did not return structured JSON");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}
