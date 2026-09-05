# 5. Language adapters, and deterministic replay

**Status:** accepted

## Context

Two separate problems with one shared cause: things that should have been data
were hardcoded.

**Verification** was a `Set` of twelve npm command strings, executed as
`sh -lc <string>` inside the container. Project detection looked for
`package.json` at the root and one level below. So BugPilot could only verify
Node repositories, and could not see the `packages/*/package.json` layout that
most real TypeScript repositories use.

**Testing the orchestrator** required a live model. That meant the pipeline
itself — the part with the safety properties — had no automated test at all,
because CI has no API key and would not spend money on every push if it did.

## Decision

### Language adapters

A `LanguageAdapter` implements `detect / install / test / typecheck / lint` and
returns a `CommandSpec`:

```ts
{ argv: string[], network: "none" | "bridge", timeoutMs, projectPath }
```

Three things follow from that shape:

- **`argv`, executed directly.** No `sh -lc`, so no quoting to get wrong and no
  shell to inject into.
- **The allowlist becomes structural.** The adapter *constructs* the command;
  the model supplies only an enumerated operation and a project path that
  detection already returned. It never contributes a token to a command line.
- **"Not configured" is a distinct result from "failed".** Running
  `npm run typecheck` in a repository with no such script exits non-zero, which
  the Tester read as a real failure and used to send the Coder off revising a
  correct patch. This was a live correctness bug, not only a portability one.

Detection is recursive with a depth cap. Lint is scoped to the changed files,
because a repository's pre-existing lint debt is not evidence about this patch.

Node and Python ship; each has its own container image and cache mounts.

### Deterministic replay

`RecordingProvider` wraps any provider and writes every exchange to a cassette
keyed by a hash of the request. `ReplayProvider` serves them back, and **errors
on an unrecorded request** rather than silently falling through to a live call.

## Consequences

Good:

- New languages are additive: an adapter plus an image, no orchestrator change.
- The runner's safety story is stronger than the allowlist it replaced.
- Recording a run once turns an expensive non-deterministic pipeline into a
  fixture that CI can replay offline, for free, on every push.
- A reproducible bug report becomes possible: ship the cassette.

Bad:

- Cassettes are brittle by design. Change a prompt and the request hash
  changes, so the recording has to be refreshed. This is a real maintenance
  cost, accepted because a cassette that silently tolerated prompt drift would
  be worse than useless.
- Two container images to build and keep current instead of one.
- Python test detection is heuristic: pytest is assumed unless the project
  declares otherwise, which will occasionally be wrong.

## Alternative considered

**One fat image with every toolchain.** Simpler to build, much slower to pull,
and it couples unrelated language upgrades. Per-adapter images keep each one
small and independently versioned.
