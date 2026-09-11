# Artifact integrity

BugWright treats verification as a statement about immutable bytes, not a
working directory that may change later. Phase 1 introduces a versioned review
artifact that is captured after coding and used by testing, human approval,
and publication.

## What is captured

The artifact contains:

- the exact 40-character base commit and resulting Git tree;
- a sorted SHA-256 source manifest covering every tracked file and every
  non-ignored untracked file;
- changed file bytes encoded as base64, including binary files, plus Git
  executable modes and explicit deletions;
- the complete binary-capable Git diff with no display truncation;
- the protected reproduction path, content hash, failing baseline artifact,
  and baseline test-run ID; and
- a canonical SHA-256 fingerprint over the complete structure.

Capture uses a temporary private Git index. It does not stage the repository,
alter the user's index, or run clean/smudge filters. PostgreSQL JSONB may reorder
object keys, so fingerprinting uses a recursive canonical representation.

## Verification chain

1. The reproducer creates a test and BugWright captures its baseline artifact.
   The test must fail, and its raw-byte hash and test-run record are retained.
2. Before coding begins, the reproduction path is protected in both the MCP
   client and repository server. Its bytes are checked again at every artifact
   boundary.
3. After coding, BugWright captures the candidate artifact. The Tester checks
   that exact fingerprint before and after every runner operation and attaches
   it to each test record and the final report.
4. The human approval hash binds the destination, artifact fingerprint,
   failing baseline, passing reproduction, and all evidence for that artifact.
5. The publisher revalidates the source and evidence before its first GitHub
   request. It uploads the artifact's captured bytes—not a later filesystem
   read—and requires GitHub's generated tree to equal the reviewed tree before
   creating a commit.

Old tasks fail closed because they have no versioned artifact. Start a new task
to re-run reproduction and verification after upgrading.

## Rejected inputs and limits

Capture rejects symlinks, Windows junctions, Git submodules, hardlinks,
non-regular files, control characters in paths, more than 10,000 source files,
individual files over 8 MiB, and artifacts over 64 MiB. On Windows, existing
tracked executable modes are preserved; newly created files default to
`100644`. Renames are represented as a deletion plus an addition.

Ignored untracked outputs such as dependency directories and build caches are
not source and are outside the artifact. If such a file must be reviewed, it
must be tracked or removed from ignore rules.

## Security boundary and residual risk

The artifact hash detects accidental changes and binds trusted backend state;
it is not a signature against an attacker who can modify the database or the
BugWright process. The workspace is writable so real toolchains can create
temporary outputs. A test that changes source and restores exactly the same
bytes between checks is not observed, and capture is not an atomic filesystem
snapshot. Use `BUGWRIGHT_RUNNER_READONLY=1` where the target project supports a
strict read-only workspace.

This phase does not add distributed worker leases or exactly-once execution.
Publication reuses an existing branch and open pull request, but crash recovery
and concurrent-worker ownership are separate reliability work.
