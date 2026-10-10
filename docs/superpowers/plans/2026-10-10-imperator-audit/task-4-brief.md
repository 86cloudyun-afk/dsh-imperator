# Task 4: Repair execution root resolution and complete operation schema checks

Read this first; this is the task's requirements. Baseline81b7ce67114f96ebcd05b257571ce8a6bc9e68c7; read the linked spec's relevant requirements and decisions: docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md.

## Global constraints

Package `@local/dsh-taskforce`, preset `taskforce`, display `任务部队`, database `$DSH_HOME/taskforce/taskforce.db`; Node `^22.23.2 || ^24.19.0`; no external runtime dependencies; DSH pins rc.2/alpha.2; acceptance60s/cleanup12s unchanged; full-tree adapter closed; checkout+packed tests; no credential values; no main/other-branch mutation by implementers.

## Files

- lib/store/execution.js
- lib/operations/index.js
- tools/tests/execution-receipts.test.mjs
- tools/tests/operations.test.mjs
- docs/OPERATIONS.md
- docs/STORE.md

## Interfaces

strictExecutionEvidence physical versus textual paths; doctor/currentSchema/preflight all required core columns including task.submitted_at afterTask2.

## Required discriminating tests

Actual successful foreground receipts at direct-root/ancestor symlink accepted; external receipt-dir/file links and archived old-root receipt refused; DROP task.note/fact core field and wrong object type cause doctor incompatibility/preflight refusal; valid old additive schema migrates on isolated copy; original files/bytes unchanged.

## Implementation approach

Canonicalize only trusted root for containment; preserve textual provenance and reject receipt escape links. Validate full core requirements from trusted schema declarations or complete map, including receipt/waiver SQL columns, and object types. Preserve supported migration behavior and operations canonical-path policy.

## Sequence and report

1. Read real production paths, existing tests and applicable repository instructions.
2. Commit tests only on your isolated branch; observe actual RED assertions against unchanged production in Actions. Fix fixture errors before claiming RED.
3. Apply only the minimal owned-file fix; production must not precede RED.
4. Read every exact-head six-job log. Report all failures by name, actual counts/skips and RED/GREEN run links; do not broaden after checks pass without a new concern.
5. Write the report at docs/superpowers/research/2026-10-10-imperator-audit/task-4-report.md. Return status/head/tree/owned-file blobs, one-line test evidence and concerns.

Do not spawn subagents or reviewers. Parent assigns independent review, integrates shared hunks, creates PRs and merges. Do not touch other branches/main, weaken assertions, alter workflow gates, or print credentials. Without shell, use structured GitHub tree/commit/ref tools with expected_sha leases and real Actions. Report remote evidence honestly.
