/**
 * Compatibility surface for the model layer.
 *
 * The implementation lives in `./model/`, split into stateless providers and a
 * provider-independent agent loop. This module keeps the old `AgentModel`
 * shape working for callers that only need "run an agent and give me text".
 */
import { AgentLoopResult, runAgentLoop } from "./model/loop.js";
import { ModelRole, resolveProvider } from "./model/registry.js";
import { ModelProvider, ToolSchema } from "./model/types.js";

export * from "./model/index.js";

/** Tool description in the shape the role definitions already use. */
export type ModelTool = ToolSchema;

export interface ModelRequest {
  system: string;
  input: unknown;
  tools: ModelTool[];
  execute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  responseSchema?: Record<string, unknown>;
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface ModelResult {
  text: string;
  modelCalls: number;
  toolCalls: number;
  retries: number;
  contextChars: number;
  costUsd: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  compactions: number;
}

export interface AgentModel {
  generate(request: ModelRequest): Promise<ModelResult>;
}

const flatten = (result: AgentLoopResult): ModelResult => ({
  text: result.text,
  modelCalls: result.modelCalls,
  toolCalls: result.toolCalls,
  retries: result.retries,
  contextChars: result.contextChars,
  costUsd: result.costUsd,
  model: result.model,
  provider: result.provider,
  inputTokens: result.usage.inputTokens,
  outputTokens: result.usage.outputTokens,
  compactions: result.compactions,
});

/**
 * Runs an agent against the provider configured for `role`.
 *
 * The provider is resolved per role, so which vendor answers is configuration
 * rather than code. See `model/registry.ts`.
 */
export class RoleModel implements AgentModel {
  private readonly provider: ModelProvider;

  constructor(role: ModelRole, provider?: ModelProvider) {
    this.provider = provider ?? resolveProvider(role);
  }

  get id(): string {
    return this.provider.id;
  }

  get model(): string {
    return this.provider.model;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    const result = await runAgentLoop(this.provider, {
      system: request.system,
      input: request.input,
      tools: request.tools,
      responseSchema: request.responseSchema,
      maxTurns: request.maxTurns,
      signal: request.signal,
      execute: request.execute
        ? async (name, args) => {
            const value = await request.execute!(name, args);
            return typeof value === "string" ? value : JSON.stringify(value);
          }
        : undefined,
    });
    return flatten(result);
  }
}

/** Backwards-compatible alias: the Gemini-only entry point this replaced. */
export class GeminiModel extends RoleModel {
  constructor() {
    super("CODER");
  }
}
