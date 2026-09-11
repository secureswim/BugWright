# Fenced execution and recovery

BugWright tasks are long-running workflows with filesystem, model, container,
database, and GitHub side effects. Queue delivery alone does not prove that a
single live process owns those effects, so workers use a database lease plus a
monotonically increasing generation.

## Claim and heartbeat

A claim is one conditional `UPDATE`: the task must be in a runnable state and
its prior lease must be absent or expired. The update sets a unique worker ID,
an expiry, and a heartbeat timestamp while incrementing `leaseGeneration`.
Concurrent claimers cannot both update the row.

The owner renews every 10 seconds by default for a 45-second lease. Values are
configurable with `BUGWRIGHT_HEARTBEAT_MS` and `BUGWRIGHT_LEASE_MS`; the
heartbeat should remain comfortably shorter than the lease.

## Fencing

Every orchestration write requires all of:

- the same task ID;
- the same worker ID;
- the same lease generation; and
- an expiry later than the database request time.

Agent tool calls check the fence before and after execution. Final publication
state, publication status, and the audit event commit in one database
transaction after another fenced row update. If generation 8 replaces
generation 7, generation 7 cannot regain authority by waking up or extending
its old deadline.

## Checkpoint recovery

The reproduction baseline and every test candidate are versioned review
artifacts. When an interrupted task resumes, BugWright removes tracked and
non-ignored partial source files, reconstructs the base from raw Git blobs,
overlays the captured artifact bytes and file modes, and recomputes the full
fingerprint. It preserves ignored dependency and build caches.

If reconstruction does not produce the stored fingerprint, recovery stops. The
workflow then uses its persisted reports to resume at the latest complete
stage rather than repeating completed model work.

## Publication recovery

`PublicationAttempt.idempotencyKey` is SHA-256 over task, artifact,
repository, and target branch. Its checkpoints record tree creation, commit
creation, branch creation, and the final pull-request URL.

The branch name is deterministic. A retry can adopt it only if its commit has
the approved tree and base parent. Existing open pull requests are reused and
diverged branches are never force-pushed.

GitHub and PostgreSQL do not provide a shared transaction. A crash after
creating a commit but before persisting or referencing its SHA can leave an
unreachable Git object and a retry may create another. The externally visible
branch and pull request remain unique, and their bytes remain bound to the
approved artifact.
