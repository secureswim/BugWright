# 6. Reproduce the bug before writing any code

**Status:** accepted
**This is the most important decision in the project.**

## Context

The original pipeline ran issue → research → code → test, where "test" meant
running the repository's existing suite and reporting a boolean.

That is unsound, and the demo hid it. `fixtures/calculator-bug` ships
`add(a, b) { return a - b }` **together with a test asserting `add(4,3) === 7`**.
So the suite fails before the patch and passes after it, and everything looks
rigorous.

Real repositories do not look like that. A bug exists precisely _because_ no
test catches it. On a real issue the suite passes before the patch and passes
after it, so a green run means only **"nothing else broke."** It carries no
evidence whatsoever that the reported bug was fixed.

The system's central claim — an empirically verified patch — was true of one
fixture and false in general.

## Decision

Insert a **Reproducer** between research and coding.

It writes one test that captures the reported behaviour, and that test must be
**observed to fail against the unpatched code** before any code is written.

- The Reproducer may write **test files only**, enforced by `assertTestPath` in
  the repository MCP server. Otherwise "prove the bug exists" quietly becomes
  "change code until something passes."
- It **cannot execute anything**. The orchestrator runs the test through the
  Tester's runner authority, so the Reproducer cannot certify its own work.
  Its `reproduced: true` claim is overwritten by the observed exit code.
- A test that **passes** before the fix means the diagnosis was wrong. The run
  stops and says so.
- If no test can be written, the run stops with `NEEDS_ATTENTION`. **This is a
  correct outcome, not a failure.**

`TestReport` then answers two questions that were previously collapsed into
one: `reproductionFixed` (is the bug fixed?) and `regression` (did anything
break?). `routeAfterTest` refuses to approve a patch whose reproduction test
still fails, however green the suite is.

The Coder is told not to edit the reproduction test, and the Reviewer is told
to reject a diff that weakens or removes it — because the cheapest way to make
a suite green is to delete the test that proves the bug.

## Consequences

Good:

- The claim becomes true: _no patch is accepted until a test that failed before
  it passes after it._
- The reproduction test ships in the pull request as a regression guard, which
  is what a human reviewer wants to see first anyway.
- Bad diagnoses are caught **before** any code is written, which is much
  cheaper than catching them after a full test cycle.
- "Cannot reproduce" becomes a first-class, honest outcome. `/metrics` reports
  `verifiedFixRate` — the share of completed tasks actually backed by a
  failing-then-passing test — so the headline resolution number can be checked
  against the evidence rather than taken on trust.

Bad:

- One more model call and at least one extra container run per task.
- Fewer tasks complete. Issues with no assertable behaviour now stop instead of
  producing a confident patch. This looks like a worse resolution rate and is
  a better system; `fixtures/no-repro` exists to keep that honest.
- Reproduction quality depends on the model matching the repository's test
  conventions. It is told to read a neighbouring test first, which helps and
  does not guarantee.

## Alternative considered

**Generate the test after the fix.** Cheaper, and it still ships a regression
guard. Rejected because a test written with the patch in hand is written to
pass; it demonstrates nothing about whether the bug was ever real. The failing
run has to come first or it is not evidence.
