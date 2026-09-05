import { Usage } from "./types.js";

/** USD per million tokens. */
interface Price {
  input: number;
  output: number;
  cachedInput?: number;
}

/**
 * Published list prices, keyed by a prefix of the model id.
 *
 * These change often and are only used to report the cost of a run, never to
 * make a decision, so a stale entry degrades a metric rather than behaviour.
 * An unknown model yields a cost of 0 and is reported as unpriced.
 */
const PRICES: Array<[string, Price]> = [
  ["gemini-3.8-flash", { input: 0.1, output: 0.4, cachedInput: 0.025 }],
  ["gemini-3.5-flash-lite", { input: 0.05, output: 0.2, cachedInput: 0.013 }],
  ["gemini-3.5-flash", { input: 0.1, output: 0.4, cachedInput: 0.025 }],
  ["gemini-3.5-pro", { input: 1.25, output: 10, cachedInput: 0.31 }],
  ["gemini-2.5-flash", { input: 0.3, output: 2.5, cachedInput: 0.075 }],
  ["gemini-2.5-pro", { input: 1.25, output: 10, cachedInput: 0.31 }],
  ["claude-haiku", { input: 1, output: 5, cachedInput: 0.1 }],
  ["claude-sonnet", { input: 3, output: 15, cachedInput: 0.3 }],
  ["claude-opus", { input: 15, output: 75, cachedInput: 1.5 }],
  ["gpt-4o-mini", { input: 0.15, output: 0.6, cachedInput: 0.075 }],
  ["gpt-4o", { input: 2.5, output: 10, cachedInput: 1.25 }],
  ["gpt-4.1-mini", { input: 0.4, output: 1.6, cachedInput: 0.1 }],
  ["gpt-4.1", { input: 2, output: 8, cachedInput: 0.5 }],
];

export function priceFor(model: string): Price | undefined {
  const normalized = model.toLowerCase();
  let best: [string, Price] | undefined;
  for (const entry of PRICES) {
    if (!normalized.includes(entry[0])) continue;
    if (!best || entry[0].length > best[0].length) best = entry;
  }
  return best?.[1];
}

/** Cost of `usage` in USD, or 0 when the model has no published price here. */
export function costUsd(model: string, usage: Usage): number {
  const price = priceFor(model);
  if (!price) return 0;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const total =
    (fresh * price.input) / 1e6 +
    (usage.cachedInputTokens * (price.cachedInput ?? price.input)) / 1e6 +
    (usage.outputTokens * price.output) / 1e6;
  return Number(total.toFixed(6));
}

export const isPriced = (model: string): boolean => priceFor(model) !== undefined;
