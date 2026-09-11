# 1. Separate agents by authority, not by skill

**Status:** accepted

## Context

A single capable model with good prompting can diagnose a bug, write a patch,
run tests, and review the result. Splitting that into several agents costs
latency, tokens, and a great deal of orchestration complexity. It needs a
better justification than "multi-agent systems are interesting."

## Decision

Split by **authority**, not by skill. Each role gets the narrowest capability
that lets it do its job:

| Role       | May do                                  | May not do                  |
| ---------- | --------------------------------------- | --------------------------- |
| Manager    | delegate                                | touch the repository at all |
| Researcher | read, search, read history              | write, execute              |
| Reproducer | read, write **test files only**         | edit source, execute        |
| Coder      | read, patch source                      | execute, publish, approve   |
| Tester     | execute fixed operations in a container | read or modify source       |
| Reviewer   | read, inspect diff and history          | write, execute              |

The claim is not that five models diagnose better than one. It is that **no
single context can investigate, change, verify, and approve its own work.**

## Consequences

Good:

- A model that convinces itself a patch is correct cannot also be the thing
  that certifies it. The Reviewer starts from the issue, the research, the
  diff, and the test evidence in a fresh context, and never sees the Coder's
  reasoning.
- Failures become attributable. `/metrics` reports success per role, so a
  regression can be traced to a stage rather than to "the agent".
- The boundaries are enforceable in code, not prompts. Because the split
  follows capability, it maps onto per-role MCP servers, and a role's forbidden
  tools are absent from its session rather than refused at call time.

Bad:

- More model calls, so more latency and cost. `/metrics` reports cost per
  resolved issue rather than hiding it.
- More failure modes: an agent can fail, and reports have to be validated at
  every boundary.
- Context is re-established at each handoff, which is real duplicated input
  token cost.

## Alternatives considered

**One agent with a good prompt.** Cheaper and often effective. Rejected because
self-review is the specific thing it cannot do, and self-review is the entire
point of the human gate that follows.

**Three roles (research, code, verify).** Considered seriously. Rejected
because "verify" would then mean both _running tests_ and _judging the change_,
which are different authorities: one executes code, the other must not.

**Seven or more roles** (triage, planning, docs, and so on). Rejected as
complexity without a matching authority boundary. Roles are only worth adding
when they can be given a different capability set — which is precisely why the
Reproducer was later added as a sixth (see ADR 6).
