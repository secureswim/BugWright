# Multi-agent design

## Why five roles

The boundaries follow authority: diagnosis is read-only, implementation can mutate code, verification can execute code, review is independently read-only, and publishing is deterministic. Splitting these responsibilities prevents one model context from investigating, changing, testing, and approving its own assumptions. It also lets evaluation show where failures originate.

## Communication

Agents exchange `ResearchReport`, `PatchProposal`, `TestReport`, and `ReviewReport` objects through `AgentMessage<T>`. Zod validates model-produced reports before persistence. Agents see only the report fields needed for their role; hidden reasoning and earlier model histories are never forwarded.

## State machine

```text
QUEUED → PREPARING → PLANNING → RESEARCHING → CODING → TESTING
 TESTING(pass) → REVIEWING
 TESTING(fail) → RE_CODING or RE_RESEARCHING → TESTING
 REVIEWING(reject) → REVISION_REQUESTED → RE_CODING
 REVIEWING(approve) → AWAITING_HUMAN_APPROVAL → PUBLISHING → COMPLETED
 limit reached → NEEDS_ATTENTION
 unrecoverable error → FAILED
```

The model may advise whether a failing test needs research or coding. `state-machine.ts` constrains that advice: passing tests always go to review, reviewer approval always goes to the human gate, reviewer rejection never becomes approval, and limit exhaustion always stops.

## MCP and permissions

Four reusable MCP servers expose narrow operations. `roleToolPermissions` is enforced in the client before transport, and denied calls create audit events. The repository server independently validates paths and patch context. The runner accepts enumerated operations rather than command strings.

The Manager has zero MCP tools. Researcher and Reviewer cannot write or execute. Coder cannot execute or publish. Tester cannot read or modify application source through MCP. Publishing is ordinary trusted backend code and requires a persisted human approval matching the current hash.

## Failure and disagreement

A failed Tester report returns to Coder by default; the Manager can request targeted re-research when the diagnosis appears wrong. Reviewer findings supersede Coder confidence and always cause fresh coding and tests. Maximum three test attempts and two review cycles prevent infinite loops. At the limit, the evidence stays visible in `NEEDS_ATTENTION`.

## Recovery

PostgreSQL stores the plan, research, patch, diff, test report, review report, approval hash, and every supporting artifact. pg-boss persists jobs, and the worker requeues interrupted nonterminal tasks on startup. For a stopped task, `POST /tasks/:id/resume` selects the latest valid boundary: plan resumes research, research resumes coding, a patch resumes testing, passed tests resume review, and an approved review returns to the human gate. If the human already approved the exact fingerprint, resume revalidates the current diff and test evidence before retrying only the publishing job. Workspace and base-commit checks reuse the existing checkout.

## Evaluation

The fixture harness records role status, model calls, tool calls, context characters, duration, delegation cycles, revision cycles, failed checks, denials, and approval state. These enable single-agent versus multi-agent comparisons without claiming improvement before measuring it.
