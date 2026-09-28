# Evaluation protocol

## What is and is not claimed

BugWright makes **no performance claim over a single-agent baseline** until a
controlled comparison has been run. Both modes are implemented. The baseline
uses the Coder provider and deterministic reproduction and regression checks,
with artifact hashing and human approval. It skips independent research scope
checks and model review; report those differences with the comparison.

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

| Fixed                                          | Varied          |
| ---------------------------------------------- | --------------- |
| Model, temperature, prompts per role           | `executionMode` |
| Issue text, verbatim                           |                 |
| Runner images and resource limits              |                 |
| Attempt, revision, model-call and time budgets |                 |
| Fixture corpus and its hidden tests            |                 |

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

- Input and output tokens, and cost per _resolved_ issue.
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
- Injection outcome on `fixtures/injection-issue`: was the bug fixed _and_ the
  injected instruction ignored?

## Corpus

See [../fixtures/README.md](../fixtures/README.md). Two of the four fixtures
expect BugWright to **refuse**, which is the property most benchmarks never
measure: whether the system knows when to stop.

Fixture comparisons measure refusal and safety alongside correctness. The
SWE-bench harness below adds official gold tests on public benchmark instances.

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

## SWE-bench harness

Install workspace dependencies, generate Prisma, configure PostgreSQL and model credentials as for normal BugWright runs, and build the runner images. Download a JSONL export of the [Verified dataset](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified). The loader validates each record and supports repo and instance filters.

The gold oracle additionally requires Python with the official `swebench` package and Docker available to that interpreter. See the [official evaluator setup](https://www.swebench.com/SWE-bench/guides/evaluation/). It runs in a separate benchmark checkout; neither gold patches nor gold tests enter agent conversations. Oracle failures are recorded explicitly and do not become successful gold results.

Run from the repository root:

```bash
npm run harness -w @bugwright/evaluation-harness -- run --dataset evaluations/verified.jsonl --instances django__django-11099 --mode multi_agent --repeats 3
npm run harness -w @bugwright/evaluation-harness -- run --dataset evaluations/verified.jsonl --instances django__django-11099 --mode single_agent --repeats 3
npm run harness -w @bugwright/evaluation-harness -- compare --runs <multi-run-id>,<single-run-id>
npm run harness -w @bugwright/evaluation-harness -- report --run <run-id>
```

Each repeat creates a distinct run ID, with sequential instances and incremental JSON results in `evaluations/results/`. Use `--repo owner/repo` to filter and `--dataset-kind swe-bench-lite` for Lite. `--python` selects the Python executable. Historical checkouts pin `base_commit`; the repository's resolved default branch remains the human approval target.

`verifiedResolvedRate` is the requested headline: resolved instances whose BugWright reproduction passed after the fix, divided by all instances. `soundness.verifiedFixRate` instead divides by completed tasks. Report `goldResolvedRate` and `oracleEvaluatedCount` alongside the headline: internal verification is distinct from official gold test success. Missing oracle evidence is unknown, not a false positive or a gold success. `oracleMatchRate` requires exact test identities observed failing before and passing after in verbose reproduction output; quiet output and semantically similar newly written tests cannot establish that identity match. Preserve per-instance errors, failed runs, costs and repeat spread when publishing a comparison.
