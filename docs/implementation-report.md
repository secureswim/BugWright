# BugWright implementation report

Date: 27 September 2026

All four requested improvements were implemented. Offline tests and static checks passed. A live model-driven fixture run and a live SWE-bench evaluation were not performed during implementation, so this report makes no benchmark performance claim.

## 1. Structural quarantine for external content

Added explicit content trust types, source labels, content hashes, integrity checks, boundary wrapping, and deterministic summaries for the Manager.

- Issue content is wrapped for Researcher, Reproducer, Coder, Reviewer, and baseline contexts.
- Manager planning and synthesis receive structural issue summaries rather than raw issue strings. Manager routing inputs omit raw verification output.
- Repository tool results, tool errors, diffs, test configuration, and externally derived verification evidence are wrapped before model consumption.
- Both payloads and source attributes are escaped, preventing repository text from closing a boundary or forging a new XML-like tag.
- MCP audit records include a trust classification alongside result length and hash. Runner results retain the requested trusted infrastructure classification in the audit trail; externally derived output is still quarantined when presented to models.
- Role prompts explain how to handle the boundary and ignore instructions embedded in external content.

Primary files: `packages/agent/src/quarantine.ts`, `context.ts`, `mcp.ts`, `roles.ts`, and `packages/shared/src/index.ts`.

Validation covered hashes, tampering, metadata extraction, Manager isolation, role context wrapping, and malicious closing tags. These checks establish structural behavior; they do not prove that every model will resist every prompt injection. Deterministic permissions and approval controls remain the enforcement mechanisms.

## 2. Functional single-agent baseline

Replaced the `SINGLE_AGENT` placeholder with an executable baseline using the Coder provider and the existing provider-independent model loop.

- One model authority pool has repository reads, Git inspection/history, graph queries, test-file writing, and source patching.
- Research/reproduction and implementation run as separate phases. A deterministic callback rejects tools unavailable in the current phase, including source patching during reproduction.
- Execution tools remain available only to the deterministic Tester/orchestrator. The model cannot certify its own test results.
- Extracted the reproduction verifier into a shared module used by both modes. It checks test collection, exit status, captured test bytes, and baseline artifact integrity.
- A reproduction must fail before the fix. Its bytes are protected before coding, and it must pass afterward.
- Attempt, revision, model-call, agent-run, and elapsed-time limits stop the baseline when exhausted.
- Runs record model telemetry under `SINGLE_AGENT`, along with messages, events, and deterministic test evidence.
- Artifact capture, workspace integrity checks, approval hashing, and the human approval gate are retained.
- Existing checkpoints and attempt history support resumption.

The baseline deliberately skips the independent research scope guard and independent model review. Its approval-compatible report identifies deterministic baseline verification and explicitly acknowledges the absence of independent review. It still stops at human authorization.

Primary files: `packages/agent/src/single-agent.ts`, `reproduction-verifier.ts`, `index.ts`, `roles.ts`, and shared/policy role definitions.

Offline FakeProvider tests covered the authority pool, rejection of model self-certification, phase restrictions, revision limits, model budgets, telemetry, and human approval hashing. Separate tests exercised the shared reproduction verifier.

## 3. Repository knowledge graph

Added the `@bugwright/mcp-knowledge-graph` workspace package and integrated it with Researcher and baseline tool access.

- Tree-sitter parses TypeScript, TSX, JavaScript, JSX, and Python.
- The cached graph records classes, functions, variables, source locations, signatures, and available documentation.
- Relationships include `defines`, `imports`, `calls`, `inherits`, `implements`, `contains`, and `references`.
- Five gated query tools are exposed: `query_entity`, `find_callers`, `find_callees`, `find_references`, and `class_hierarchy`.
- Filesystem changes are queued internally; queries refresh changed files and relink edges. Deleted or invalid files lose stale entities and edges.
- Parsing failures in individual files produce warnings without discarding valid graph data.
- Git internals, dependency/generated directories, and symlinks are excluded; path containment checks apply.
- Policy defines graph tool permissions and the server environment allowlist. Model credentials and database URLs are excluded.
- Researcher prompts describe semantic navigation, and evaluation metrics count graph tool usage.

Primary files: `packages/mcp/knowledge-graph/src/graph.ts`, `query.ts`, `server.ts`, its fixture tests and README, plus policy and agent integration changes.

Compatible native dependencies were installed: Tree-sitter 0.21.x, TypeScript/JavaScript grammars 0.23.x, and Python grammar 0.21.x. The lockfile was updated.

Tests covered all five query tools, TypeScript fixtures, JavaScript/Python import aliases and namespace calls, invalid files, updates/deletions, and unsafe paths.

Resolution is static and conservative. Dynamic dispatch, external symbols, package aliases, re-exports, and ambiguous symbols may remain unresolved. If recursive watching is unavailable, the server warns and retains its startup snapshot.

## 4. SWE-bench evaluation harness

Added the `@bugwright/evaluation-harness` workspace package, CLI, loader, runner, oracle adapter, result aggregation, and reports.

- JSONL loading validates instance fields, commit identities, and JSON test-ID arrays; duplicate instance IDs are rejected.
- Filtering supports repository, instance ID, and lists of instance IDs.
- Instance tasks contain the problem statement and selected execution mode. Gold patches, gold tests, and hints are not placed in task inputs.
- Workspace preparation can fetch and check out the immutable dataset `base_commit`. Prepared and resumed HEAD identities are checked.
- The repository default branch is resolved separately as the approval target. Successful resolutions are cached across instances/repeats, and lookup requests have a timeout.
- Instances run sequentially through the existing task persistence and lease-backed `runTask` path.
- The official Python SWE-bench Docker evaluator runs separately on the submitted agent diff. Its gold material stays outside the agent workspace/context.
- Oracle logic distinguishes internal verified resolution, gold test success, false positives, and unavailable oracle evidence.
- Gold coverage matches require exact test identities observed failing before and passing after in verbose reproduction output; filenames and model explanations do not establish a match.
- Aggregate results include resolution rates, verified resolution rates, oracle metrics, mean cost/duration/model calls, and per-instance outcomes and errors.
- Results are saved incrementally to `evaluations/results/<runId>.json` after each instance.
- CLI commands support `run`, repeated runs, `compare`, and `report`, with Markdown comparison output.
- Run IDs are validated before execution and file access to prevent path traversal.

Primary files: `packages/evaluation-harness/src/swebench.ts`, `runner.ts`, `oracle.ts`, `results.ts`, `cli.ts`, and `index.ts`; `packages/agent/src/preparation.ts` and pinned checkout integration.

Tests covered parsing/filtering, invalid datasets, oracle decision logic, observed test identity matching, aggregation math, task conversion, gold-material exclusion, unavailable oracle recording, and cached branch resolution.

The requested headline `verifiedResolvedRate` measures internal verified resolution across all attempted instances. It is distinct from official gold success. `goldResolvedRate` and `oracleEvaluatedCount` are reported separately; missing oracle evidence is not counted as a gold pass.

## 5. Shared metrics, workspace integration, and documentation

- Added shared content, graph, benchmark, oracle, and result types; extended `agentRoles` with `SINGLE_AGENT`.
- Added policy authority for the baseline and graph tools without granting model execution authority.
- Added optional `benchmark` metrics to `evaluationMetrics()`.
- Added per-mode baseline metrics and deltas; the comparison section is omitted unless both arms have tasks.
- Added quarantine audit counts and graph query usage metrics.
- Added the root `npm run harness` command and TypeScript project references. Existing workspace globs already discover both new packages.
- Added the evaluation package's explicit shared-types dependency and updated the package lock.
- Updated architecture and evaluation documentation, including baseline differences, oracle setup, commands, metric definitions, and limitations.
- Added a knowledge graph README and ignored the local npm cache directory.

The implementation used existing persistence tables. No new database model or schema migration was required. The existing Prisma client was generated for validation.

## 6. Validation performed

| Check                                                  | Observed result                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| Initial `npm test` attempt                             | Could not start because dependencies were absent                  |
| First complete full-suite run                          | 342 tests passed across 26 files                                  |
| Later full-suite run with integration tests            | 348 tests passed across 28 files                                  |
| Follow-up focused tests after phase/oracle refinements | 19 tests passed, including the newly added phase restriction test |
| Final harness runner tests                             | 3 tests passed, including the newly added branch-cache test       |
| Workspace TypeScript checks                            | Passed                                                            |
| Final targeted agent/harness TypeScript checks         | Passed                                                            |
| Workspace ESLint                                       | Passed                                                            |
| Changed-file Prettier checks                           | Passed                                                            |
| Git whitespace checks                                  | Passed                                                            |

The follow-up counts overlap the full-suite count and must not be added together as independent tests. The full suite was not rerun after the last two focused test additions; affected tests and targeted TypeScript checks passed afterward.

## 7. What remains unverified

No live model-driven fixture run, GitHub publication, or real SWE-bench evaluation was executed during implementation. Therefore, no live integration success, resolution rate, cost advantage, or multi-agent performance advantage is claimed.

A live fixture run needs PostgreSQL, the runner image, and configured model credentials. A gold benchmark run additionally needs the dataset, Python with the official `swebench` package, and Docker available to that interpreter.

For a harness invocation that loads the repository `.env`, run from the repository root:

```powershell
node --env-file=.env --import tsx packages/evaluation-harness/src/cli.ts run --dataset evaluations/verified.jsonl --instances django__django-11099 --mode single_agent --repeats 1
```

The `npm run harness` entrypoint expects the required environment variables to be available in the process environment. Consult `evaluations/README.md` for comparison and reporting commands.
