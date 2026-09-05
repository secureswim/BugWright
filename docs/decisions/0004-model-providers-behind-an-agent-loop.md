# 4. Split stateless providers from a provider-independent agent loop

**Status:** accepted

## Context

The first implementation had an `AgentModel` interface with one method,
`generate`, implemented once by `GeminiModel`. That single method owned the
retry loop, multi-turn conversation state, tool execution, the turn budget, and
JSON extraction. The interface existed, but adding a second vendor would have
meant reimplementing all of it — so the abstraction bought nothing.

It also produced two wrong numbers. `contextChars` was set to the length of the
opening payload, ignoring up to twelve turns of accumulated tool results — and
a single `read_file` returns up to 80KB. And the retry loop incremented the
model-call counter per HTTP attempt, so rate limits inflated the efficiency
metric.

## Decision

Cut the abstraction in a different place.

- **`ModelProvider`** does exactly one thing: one completion, given canonical
  messages and tool schemas, returning a canonical assistant message plus real
  token usage. Stateless. No retries, no tool execution, no history.
- **`runAgentLoop`** owns everything else — turns, tool dispatch, budgets,
  retry with backoff, context compaction, usage aggregation — once, for every
  provider.

A new vendor is a `complete` method of roughly eighty lines.

Supporting decisions:

- **Canonical tool-call ids.** Anthropic and OpenAI pair calls to results by
  id; Gemini pairs by function name. The Gemini provider synthesises ids so the
  loop only ever sees one shape.
- **Typed errors.** `ModelError` carries a kind, so the loop reacts to the
  *kind* of failure: rate limits back off, context overflow triggers compaction
  and a retry, auth failures stop immediately.
- **Capability flags.** The loop reads `capabilities.jsonSchema` rather than
  branching on vendor names, so native constrained output is used where it
  exists and fence-parsing is the fallback where it does not.
- **Per-role configuration.** `BUGWRIGHT_MODEL_<ROLE>` beats `BUGWRIGHT_MODEL`.

## Consequences

Good:

- Real token counts and per-model cost, so `/metrics` can report cost per
  resolved issue instead of a character-count proxy.
- `FakeProvider` makes the loop unit-testable with scripted turns, and
  `ReplayProvider` makes the whole orchestrator runnable in CI with no API key
  and no network (ADR 5).
- Cheap models for the research fan-out, strong ones for coding and review.
- The Reviewer can run on a different model family from the Coder. Two
  instances of one model share failure modes, so a same-family reviewer is
  disproportionately blind to exactly the mistakes the Coder made; cross-family
  review makes independence structural. `/metrics` reports whether it is
  actually configured, so the claim can be checked.

Bad:

- More files and one more indirection than a single `generate`.
- The canonical message type is a lowest common denominator; provider-specific
  features (extended thinking, prompt caching hints) need capability flags to
  reach it rather than being expressible directly.
- Three provider implementations are three things that drift when vendor APIs
  change.
