import path from "node:path";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAIProvider } from "./providers/openai.js";
import { RecordingProvider, ReplayProvider } from "./providers/replay.js";
import { ModelError, ModelProvider } from "./types.js";

export type ProviderId = "gemini" | "anthropic" | "openai" | "replay";

/** Roles that make model calls. The Tester is deterministic and has none. */
export type ModelRole = "MANAGER" | "RESEARCHER" | "REPRODUCER" | "CODER" | "REVIEWER";

export interface ProviderSpec {
  provider: ProviderId;
  model?: string;
}

/**
 * Parses `provider` or `provider:model` (e.g. `anthropic:claude-sonnet-4-20250514`).
 */
export function parseSpec(value: string): ProviderSpec {
  const [provider, ...rest] = value.trim().split(":");
  const id = provider.toLowerCase();
  if (id !== "gemini" && id !== "anthropic" && id !== "openai" && id !== "replay") {
    throw new ModelError("invalid_request", `Unknown model provider "${provider}"`);
  }
  const model = rest.join(":").trim();
  return { provider: id, model: model || undefined };
}

function instantiate(spec: ProviderSpec): ModelProvider {
  switch (spec.provider) {
    case "gemini":
      return new GeminiProvider({ model: spec.model });
    case "anthropic":
      return new AnthropicProvider({ model: spec.model });
    case "openai":
      return new OpenAIProvider({ model: spec.model });
    case "replay":
      return new ReplayProvider(cassettePath(), { model: spec.model });
  }
}

const cassettePath = () =>
  process.env.BUGPILOT_CASSETTE ?? path.resolve(process.cwd(), "evaluations/cassettes/default.json");

/**
 * Resolves the provider for a role.
 *
 * Precedence, most specific first:
 *   1. `BUGPILOT_MODEL_<ROLE>`  e.g. BUGPILOT_MODEL_REVIEWER=anthropic:claude-sonnet-4-20250514
 *   2. `BUGPILOT_MODEL`         default for every role
 *   3. Gemini, for backward compatibility with single-provider setups
 *
 * Per-role configuration is what makes two things possible: cheap models for
 * the research fan-out and strong ones for coding and review, and a Reviewer on
 * a different model family from the Coder - so review independence is a
 * property of the system rather than of the prompt.
 */
export function resolveProvider(role: ModelRole): ModelProvider {
  if (process.env.BUGPILOT_REPLAY === "1") {
    return new ReplayProvider(cassettePath());
  }

  const roleSpec = process.env[`BUGPILOT_MODEL_${role}`];
  const globalSpec = process.env.BUGPILOT_MODEL;
  const spec = roleSpec
    ? parseSpec(roleSpec)
    : globalSpec
      ? parseSpec(globalSpec)
      : { provider: "gemini" as const };

  const provider = instantiate(spec);
  if (process.env.BUGPILOT_RECORD === "1") return new RecordingProvider(provider, cassettePath());
  return provider;
}

/**
 * True when the Reviewer runs on a different provider family from the Coder.
 *
 * Two instances of the same model share failure modes, so a same-family
 * reviewer is disproportionately blind to exactly the mistakes the coder made.
 * Surfaced in `/metrics` so the independence claim can be checked rather than
 * assumed.
 */
export function reviewerIsIndependent(): boolean {
  try {
    return resolveProvider("REVIEWER").id !== resolveProvider("CODER").id;
  } catch {
    return false;
  }
}
