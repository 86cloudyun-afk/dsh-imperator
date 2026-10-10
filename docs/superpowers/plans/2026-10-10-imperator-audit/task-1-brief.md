# Task 1: Freeze workflow delivery and review decisions

Read this first; this is the task's requirements. Baseline81b7ce67114f96ebcd05b257571ce8a6bc9e68c7; read the linked spec's relevant requirements and decisions: docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md.

## Global constraints

Package `@local/dsh-taskforce`, preset `taskforce`, display `任务部队`, database `$DSH_HOME/taskforce/taskforce.db`; Node `^22.23.2 || ^24.19.0`; no external runtime dependencies; DSH pins rc.2/alpha.2; acceptance60s/cleanup12s unchanged; full-tree adapter closed; checkout+packed tests; no credential values; no main/other-branch mutation by implementers.

## Files

- lib/workflow/index.js
- lib/store/workflow.js
- tools/tests/workflow-engine.test.mjs
- tools/tests/nextgen-restore-integration.test.mjs
- docs/WORKFLOW.md

## Interfaces

Existing workflow methods and recordExecution pending hook; no new model tool. Root return consumes existing bounded rework count.

## Required discriminating tests

Direct artifact after failed review; source-change verify and artifact after failed review; verify after lead_acceptance; same-current-revision fail/unverified then pass; old active fail→pass acceptance; root return→new revision succeeds; original-key replay remains; restore root-return path and max_reworks0 refuse; rejection writes no receipt and calls no native executor.

## Implementation approach

Use shared exact-current-revision failure/frozen-stage admission in artifact/verification/review/acceptance. Keep request replay before rejecting an already-completed identical request and retain historical terminal outcomes.

## Sequence and report

1. Read real production paths, existing tests and applicable repository instructions.
2. Commit tests only on your isolated branch; observe actual RED assertions against unchanged production in Actions. Fix fixture errors before claiming RED.
3. Apply only the minimal owned-file fix; production must not precede RED.
4. Read every exact-head six-job log. Report all failures by name, actual counts/skips and RED/GREEN run links; do not broaden after checks pass without a new concern.
5. Write the report at docs/superpowers/research/2026-10-10-imperator-audit/task-1-report.md. Return status/head/tree/owned-file blobs, one-line test evidence and concerns.

Do not spawn subagents or reviewers. Parent assigns independent review, integrates shared hunks, creates PRs and merges. Do not touch other branches/main, weaken assertions, alter workflow gates, or print credentials. Without shell, use structured GitHub tree/commit/ref tools with expected_sha leases and real Actions. Report remote evidence honestly.
