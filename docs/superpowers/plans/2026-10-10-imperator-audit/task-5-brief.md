# Task 5: Repair scope activation and ambiguous guard outcomes

Read this first; this is the task's requirements. Baseline81b7ce67114f96ebcd05b257571ce8a6bc9e68c7; read the linked spec's relevant requirements and decisions: docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md.

## Global constraints

Package `@local/dsh-taskforce`, preset `taskforce`, display `任务部队`, database `$DSH_HOME/taskforce/taskforce.db`; Node `^22.23.2 || ^24.19.0`; no external runtime dependencies; DSH pins rc.2/alpha.2; acceptance60s/cleanup12s unchanged; full-tree adapter closed; checkout+packed tests; no credential values; no main/other-branch mutation by implementers.

## Files

- lib/plugins/scope-membership.mjs
- lib/plugins/guard.mjs
- tools/tests/preset-isolation.test.mjs
- tools/tests/guard-causality.test.mjs
- tools/tests/host-api-contract.test.mjs
- docs/PRESET_ISOLATION.md
- docs/RELIABILITY.md

## Interfaces

createScopeMembership resolution invariant; guard event projection and echo/demotion behavior.

## Required discriminating tests

Direct resolution lacks either/both native functions→activation error; direct valid module distinguishes own/foreign/empty scope; existing fallback+standalone preserved. Matched native TOOL_OUTCOME_UNKNOWN and durable E_CONTROL_OUTCOME_UNKNOWN repeated histories do not become definite failed echo/change-arguments guidance; definite TOOL_NOT_STARTED/genuine failure and mixed histories still behave correctly; native SDK result shape parity.

## Implementation approach

Place actual native guard parity in the existing host-api-contract anchor-enabled stage; do not claim a skipped node:test fixture proves native parity. Apply native export contract symmetrically after successful resolution. Classify unknown outcomes independently of definite failure using actual shared tool event envelopes; no memory/projection optimization unrelated to the bug.

## Sequence and report

1. Read real production paths, existing tests and applicable repository instructions.
2. Commit tests only on your isolated branch; observe actual RED assertions against unchanged production in Actions. Fix fixture errors before claiming RED.
3. Apply only the minimal owned-file fix; production must not precede RED.
4. Read every exact-head six-job log. Report all failures by name, actual counts/skips and RED/GREEN run links; do not broaden after checks pass without a new concern.
5. Write the report at docs/superpowers/research/2026-10-10-imperator-audit/task-5-report.md. Return status/head/tree/owned-file blobs, one-line test evidence and concerns.

Do not spawn subagents or reviewers. Parent assigns independent review, integrates shared hunks, creates PRs and merges. Do not touch other branches/main, weaken assertions, alter workflow gates, or print credentials. Without shell, use structured GitHub tree/commit/ref tools with expected_sha leases and real Actions. Report remote evidence honestly.

## Additional actual premerge finding

PR65 discussion_r4237238079: a real stop accepted:false persists rejected; its complete replay retains E_CONTROL_OUTCOME_UNKNOWN. Treat that consistent durable rejection as definite failure while preserving pending/unknown, malformed or contradictory metadata, native TOOL_OUTCOME_UNKNOWN and journal-unavailable protection. Prove real SQLite/registry replay persistence and zero second effects, then matched distinct native/PTC invocation histories and actual guard plugin behavior. Tests-only six complete behavioral RED logs must precede production; independently read source GREEN and final owned manifest before clean integration. Preserve the already merged scope report and append evidence. Prior aggregate/source approvals become historical after this change.
