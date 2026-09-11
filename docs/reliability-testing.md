# Reliability testing

BugWright's recovery controls are executable, not only architectural claims.
The Phase 3 reliability probe starts two independent Node.js processes against
the same PostgreSQL task:

1. Worker A acquires generation 1 and deliberately wedges its event loop, so
   its heartbeat cannot renew the lease.
2. After the lease expires, worker B acquires generation 2, writes a marker,
   and keeps heartbeating.
3. Worker A wakes and attempts a database write with generation 1.
4. The probe passes only when PostgreSQL rejects A's stale write and B's marker
   remains the final value.

This tests the failure mode that matters in a distributed worker system. Two
in-memory promises would not prove that ownership survives process boundaries.

## Run it locally

Start PostgreSQL, synchronize the schema, and run the probe:

```powershell
docker compose up -d postgres
npm run db:generate
npm run db:push
npm run test:reliability
```

A successful run prints one JSON report. Its `passed` field is `true`, the
takeover generation is greater than the initial generation,
`staleWritesRejected` is non-zero, and `finalValue` belongs to the takeover
worker. The probe creates and removes its own task record.

GitHub Actions runs the same command against a clean PostgreSQL 16 service in
the `reliability` job.

## Controlled fault points

Fault injection is off by default. Set all of the following in a disposable
local process to activate one point once:

```powershell
$env:BUGWRIGHT_ENABLE_FAULT_INJECTION="1"
$env:BUGWRIGHT_FAULT_POINT="after_lease_claim"
$env:BUGWRIGHT_FAULT_MODE="block"
$env:BUGWRIGHT_FAULT_DURATION_MS="15000"
```

Available points are `after_lease_claim`, `after_coding_checkpoint`,
`during_testing`, `after_github_commit`, `after_branch_creation`, and
`after_pr_creation`. Modes are `throw`, `exit`, `pause`, and `block`. The block
mode intentionally stops heartbeats. Production mode refuses fault injection
unless `BUGWRIGHT_ALLOW_PRODUCTION_FAULTS=1` is also explicitly set.

For a local fake GitHub API, set `GITHUB_API_URL` to its origin and
`BUGWRIGHT_ALLOW_INSECURE_GITHUB_API=1` when using HTTP. The publisher still
uses its durable idempotency record and deterministic branch, so a retry can
recover a remote commit, branch, or pull request after a lost response.

## Operational evidence

`GET /metrics` exposes a `reliability` section derived from persisted task
events. It reports lease acquisition and contention, fenced stale executions
and writes, recovered checkpoints and publications, tasks that experienced a
takeover, and mean checkpoint recovery time. These are production-observable
signals; the CI probe also asserts the underlying event is persisted. Multiple
lease acquisitions are reported separately and are not automatically labelled
as takeovers, because normal execution and publication also acquire sequential
leases.
