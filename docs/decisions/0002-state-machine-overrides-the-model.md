# 2. The state machine constrains the model, not the reverse

**Status:** accepted

## Context

The Manager decides what happens next: revise the code, re-investigate, review,
stop. Letting a model make that decision directly is the natural design and the
one most agent frameworks encourage. It also means a confused or manipulated
model can route a run anywhere — including straight to approval.

## Decision

The Manager is **advisory**. Routing is decided by pure functions in
`state-machine.ts` that take the model's suggestion as one input among several
and are free to discard it.

The invariants those functions guarantee:

- Passing checks always go to the Reviewer.
- Reviewer approval always goes to the human gate, never to publishing.
- A reviewer rejection can never become an approval, from any state, for any
  model suggestion.
- A patch whose reproduction test still fails is never approved, whatever the
  regression suite says.
- An exhausted budget always terminates.

The model's advice is honoured in exactly one place: choosing between
re-research and re-coding after a failed check. That is a judgement about
evidence with no safety consequence either way.

## Consequences

Good:

- The safety properties are ordinary code with tests. `state-machine.test.ts`
  iterates every decision a compromised Manager could return and asserts none
  reaches the human gate from a failing state.
- Prompt injection cannot route around the gate, because routing was never the
  model's to decide.
- The rules can be read in one screen, which is what makes them arguable.

Bad:

- Genuinely novel recovery strategies are unavailable. If a run needs something
  the table does not encode, it stops.
- The transition rules are a second place to keep in sync with the roles.

## Note on cost

Because the advisory call is overridden in most branches, `managerDecide` was
narrowed to the one choice that is actually delegated. Asking a model for a
decision that is then discarded is a call paid for and thrown away — the
earlier version did exactly that.
