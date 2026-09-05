# Evaluation protocol

## What is and is not claimed

BugWright makes **no performance claim over a single-agent baseline.** The
baseline runner is scaffolded (`executionMode: "SINGLE_AGENT"`) but not
implemented, so there is nothing to compare against yet.

This is deliberate. A multi-agent system that reports a resolution rate with no
baseline is reporting a number that cannot be interpreted — and quietly
implying an improvement it never measured. The scaffold exists so the same
persistence and metrics schema serves both arms when the comparison is run.

## Read `verifiedFixRate` first

`GET /metrics` returns a `soundness` block, and it exists because resolution
rate on its own is misleading.

A completed task means the reviewer approved and a human was asked. It does not
by itself mean the reported bug was fixed: on a real repository the existing
suite passes before a patch and after it, so a green run only shows that
nothing else broke.

```
soundness.verifiedFixRate      completed tasks where a test that failed before
                               the patch passed after it
soundness.reproductionSuccessRate  issues where a failing test could be written
soundness.stoppedUnreproducible    runs correctly stopped for lack of evidence
soundness.scopeViolations          patches that wandered outside researched files
```

`verifiedFixRate` below 1 means part of the resolution rate is unbacked.
`stoppedUnreproducible` above zero is **good**: it is the system declining to
guess.

## Running a comparison

Hold everything fixed except the arm under test:

| Fixed | Varied |
| --- | --- |
| Model, temperature, prompts per role | `executionMode` |
| Issue text, verbatim | |
| Runner images and resource limits | |
| Attempt, revision, model-call and time budgets | |
| Fixture corpus and its hidden tests | |

Run each fixture **at least three times per arm**. Agent runs are
non-deterministic and a single run of each arm is not evidence of anything;
report the spread, not only the mean.

### Metrics to record

**Outcome**

- Resolution rate, and `verifiedFixRate` alongside it — never resolution alone.
- Regression rate against hidden tests the agent never saw.
- First-attempt success; mean revision cycles.
- False-positive rate: patches produced for `no-repro`, where the correct
  answer is to stop.

**Cost — report this, do not bury it**

- Input and output tokens, and cost per *resolved* issue.
- Wall-clock duration per task.
- Peak context per role.

Multi-agent's honest weakness is that it is slower and more expensive. A
comparison that reports only quality is marketing.

**Multi-agent specific**

- Per-role success rates; delegation cycles; reviewer rejection rate and how
  often a rejection was correct.
- Whether the Reviewer ran on a different model family from the Coder
  (`multiAgent.reviewerModelIndependent`) — a same-family reviewer shares the
  Coder's blind spots, so this changes how the rejection rate should be read.

**Safety**

- Denied tool attempts, scope violations, approval bypass attempts.
- Protected-path write attempts.
- Injection outcome on `fixtures/injection-issue`: was the bug fixed *and* the
  injected instruction ignored?

## Corpus

See [../fixtures/README.md](../fixtures/README.md). Two of the four fixtures
expect BugWright to **refuse**, which is the property most benchmarks never
measure: whether the system knows when to stop.

A serious comparison needs 10–15 fixtures with hidden regression tests. Public
benchmarks such as SWE-bench are deliberately not used here — a mediocre score
on a famous benchmark is less informative than a well-controlled comparison on
a corpus whose expected outcomes are documented.

## Reproducibility

Record a run once and replay it forever:

```bash
BUGWRIGHT_RECORD=1 BUGWRIGHT_CASSETTE=evaluations/cassettes/<name>.json npm run demo
BUGWRIGHT_REPLAY=1 BUGWRIGHT_CASSETTE=evaluations/cassettes/<name>.json npm test
```

Replay errors on an unrecorded request rather than silently making a live call,
so a replayed evaluation cannot quietly become a real one. Commit the cassette
alongside the results.

## Reporting

Publish the losses. If multi-agent is slower and more expensive for a
comparable resolution rate, that is the finding — and it is a more useful one
than a table where every column happens to favour the arm the author built.
