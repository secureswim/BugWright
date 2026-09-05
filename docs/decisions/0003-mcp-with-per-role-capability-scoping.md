# 3. MCP servers, scoped per role

**Status:** accepted
**Supersedes the client-side-only enforcement in the original design**

## Context

Agents need to read files, patch them, inspect git, and run tests. Two
questions: how are those exposed, and how is a role stopped from using one it
should not have?

The original answer to the second question was a `Set` of allowed
`server.tool` keys, checked in `McpTools.call` before dispatch. That check runs
**in the caller's own process**, against servers that would happily execute the
call for anyone — and a `callTrusted` path bypassed it entirely. It documented
an intention more than it enforced a boundary.

## Decision

**MCP** for the tool interface: four narrow servers (repository, git, runner,
github) exposing enumerated operations, over the official TypeScript SDK.

**Per-role server processes** for enforcement. Each role gets its own server
instances, started with `BUGWRIGHT_ALLOWED_TOOLS` naming exactly the tools that
role may call. The server registers only those, so the Tester's repository
server has no `read_file` to call and the Coder has no runner at all.

`assertToolAllowed` still runs client-side — as defence in depth, and because
it is what produces the `TOOL_DENIED` audit event.

## Consequences

Good:

- A violation is unrepresentable rather than refused. The capability is absent
  from the session, not guarded within it.
- Server processes stop inheriting the parent environment. Each gets an
  explicit variable allowlist, so the repository and runner servers no longer
  hold the model API key, the GitHub token, or `DATABASE_URL` — which the
  README had always claimed and the code had not delivered.
- The servers are reusable and independently testable, and the boundary is a
  process boundary rather than a function call.

Bad:

- More processes: roughly eight stdio servers per task rather than three.
  Startup cost is milliseconds each and they are short-lived, but it is real.
- `callTrusted` still exists for orchestrator-level calls (fetching the issue
  body, reading the final changed-file list). It is restricted to the github
  and git servers and is not reachable from a model-driven agent, but it is the
  one remaining path that is trusted by convention rather than by construction.

## Alternatives considered

**Direct function calls instead of MCP.** Simpler and faster. Rejected because
the process boundary is what makes per-role scoping meaningful — an in-process
allowlist is the design this ADR replaced.

**One server with a role parameter.** Would need the server to trust a caller-
supplied role, which is the same problem one layer down.

**A sidecar policy proxy between client and servers.** Stronger still, and the
natural next step if servers ever move off stdio. Rejected for now as more
infrastructure than the threat justifies.
