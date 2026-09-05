# Evaluation protocol

Run the same versioned fixture set through a single-agent baseline and BugPilot. Keep model, temperature, issue text, runner image, and attempt limits fixed. Use hidden regression tests when possible.

Record resolution and regression rates, first-attempt success, mean iterations and duration, role success/detection rates, delegation and disagreement counts, revision success, denied tools/writes/commands, approval bypass attempts, unrelated files, model/tool calls, redundant calls, and average per-role context size. `GET /metrics` computes the metrics available from persisted production runs; benchmark-specific hidden-test results belong in this directory.
