# Architecture

## Why six roles

The boundaries follow **authority**, not skill. Diagnosis is read-only.
Reproduction may write tests but never source, and may not execute. Implementation
may mutate source but not run it. Verification executes but cannot read or
modify source. Review is independently read-only. Publishing is deterministic
backend code no agent can reach.

Splitting this way prevents one model context from investigating, changing,
verifying, and approving its own assumptions — and it lets evaluation say where
a failure originated. See [decisions/0001](decisions/0001-separate-roles-by-authority.md).

## Communication

Agents exchange `ResearchReport`, `ReproductionReport`, `PatchProposal`,
`TestReport`, and `ReviewReport` through `AgentMessage<T>` records. Zod
validates every model-produced report before persistence.

Contexts are constructed rather than inherited (`context.ts`): no agent
receives another's hidden reasoning or model history, only the report fields
its job requires. The Reviewer's context is assembled fresh from the issue,
research, diff, and test evidence — which is what makes its judgement
independent of the Coder's.

The Coder additionally receives an **attempt log** rebuilt from persisted
messages: every prior patch, what failed, and why. Given only the latest
failure it re-proposes approaches that already failed, which is the standard
revision-loop pathology.

## States

```text
QUEUED → PREPARING → PLANNING → RESEARCHING → REPRODUCING → CODING → TESTING
  REPRODUCING(cannot reproduce) → NEEDS_ATTENTION
  CODING → scope guard → TESTING | RE_CODING
  TESTING(repro fixed + no regression) → REVIEWING
  TESTING(repro still failing) → RE_CODING          ← even with a green suite
  TESTING(regression) → RE_CODING | RE_RESEARCHING
  REVIEWING(reject) → REVISION_REQUESTED → RE_CODING
  REVIEWING(approve) → AWAITING_HUMAN_APPROVAL → PUBLISHING → COMPLETED
  limit reached → NEEDS_ATTENTION
  unrecoverable error → FAILED
```

The Manager may advise; `state-machine.ts` decides. Passing checks always reach
review, approval always reaches the human gate, a rejection never becomes an
approval, and exhaustion always stops. Those are pure functions with exhaustive
tests, not prompt instructions. See
[decisions/0002](decisions/0002-state-machine-overrides-the-model.md).

## The reproduction gate

`TESTING` answers two questions that used to be one boolean:

- `reproductionFixed` — does the test that failed before the patch pass now?
- `regression` — does the existing suite still pass?

A patch is accepted only when the first is `passed`. A green regression suite
with a still-failing reproduction test routes back to the Coder, because it
means nothing broke *and* nothing was fixed. See
[decisions/0006](decisions/0006-reproduce-before-fixing.md).

The Reproducer cannot run its own test. The orchestrator invokes the Tester's
runner authority and overwrites the model's claim with the observed exit code.

## The scope guard

After each patch, `assessScope` compares the changed files against the union of
files every research report identified. Unrelated files send the patch back
with the offending paths named.

This is ordinary deterministic code — no model call, instant, free, and not
open to negotiation by the agent whose work it checks. Test files are always in
scope, and with no recorded research surface it fails open and says so, because
a false rejection costs a revision cycle and teaches the Coder nothing.

## MCP and permissions

Four narrow servers — repository, git, runner, github — expose enumerated
operations. Each **role** gets its own server processes, started with a tool
gate naming exactly the tools that role may call, so the server registers only
those. `assertToolAllowed` still runs client-side for defence in depth and for
the `TOOL_DENIED` audit event.

Servers receive an explicit environment allowlist rather than the parent
environment: the repository and git servers see only `BUGWRIGHT_REPO_ROOT`.
Neither the model API key nor `DATABASE_URL` reaches any of them.

The runner accepts an enumerated operation plus a detected project path; a
language adapter builds the `argv`, which is executed without a shell. See
[decisions/0003](decisions/0003-mcp-with-per-role-capability-scoping.md) and
[decisions/0005](decisions/0005-language-adapters-and-deterministic-replay.md).

## Models

Stateless providers (Gemini, Anthropic, OpenAI) implement a single `complete`
call against canonical messages. One provider-independent loop owns turns, tool
dispatch, budgets, retry with typed-error handling, and context compaction.

Providers are resolved per role, which is what allows cheap models for the
research fan-out and a Reviewer on a different model family from the Coder.
`FakeProvider` and `ReplayProvider` make the orchestrator testable with no API
key. See [decisions/0004](decisions/0004-model-providers-behind-an-agent-loop.md).

## Failure and disagreement

A failed check returns to the Coder by default; the Manager may request
targeted re-research when the evidence suggests the diagnosis itself is wrong.
Reviewer findings supersede Coder confidence. Research synthesis is instructed
to preserve conflicting root causes in `risks` rather than average them — a
disagreement between researchers is signal.

Maximum three test attempts and two revision cycles. At the limit the evidence
stays visible in `NEEDS_ATTENTION` rather than being discarded.

## Recovery

PostgreSQL stores the plan, research, reproduction, patch, diff, test report,
review report, approval hash, and every supporting artifact. pg-boss persists
jobs and the worker requeues interrupted non-terminal tasks on startup.

`POST /tasks/:id/resume` selects the latest **valid** boundary, requiring the
whole artifact set for a stage to count: a patch with no diff is not a finished
coding stage, and a green suite whose reproduction test failed is not a
verified test stage. If a human already approved the exact fingerprint, resume
revalidates the current diff and evidence before retrying only the publish job.

## Publishing

One tree, one commit, one ref update through the Git Data API — not a sequence
of Contents API calls. An existing branch is fast-forwarded and an open pull
request reused, so a retried job can neither half-write a branch nor open a
duplicate. `assertEditable` runs again over every changed file immediately
before the push.

## Evaluation

Every run records role status, model calls, retries, tool calls, real input and
output tokens, cost, peak context, duration, delegation cycles, revision
cycles, failed checks, denials, and approval state.

`executionMode` lets the same schema serve a future `SINGLE_AGENT` baseline.
That baseline is deliberately not enabled, so no improvement is claimed before
it has been measured — see [../evaluations/README.md](../evaluations/README.md).
