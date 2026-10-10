# Task 7: Integrate, close audit coverage and verify release

Read this first; this is the task's requirements. Baseline81b7ce67114f96ebcd05b257571ce8a6bc9e68c7; read the linked spec's relevant requirements and decisions: docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md.

## Global constraints

Package `@local/dsh-taskforce`, preset `taskforce`, display `任务部队`, database `$DSH_HOME/taskforce/taskforce.db`; Node `^22.23.2 || ^24.19.0`; no external runtime dependencies; DSH pins rc.2/alpha.2; acceptance60s/cleanup12s unchanged; full-tree adapter closed; checkout+packed tests; no credential values; no main/other-branch mutation by implementers.

## Files

- package.json
- README.md
- docs/superpowers/research/2026-10-10-imperator-comprehensive-audit-ledger.md
- docs/superpowers/plans/2026-10-10-imperator-comprehensive-audit.md
- tools/tests/store-evidence.test.mjs
- tools/tests/submit-audit-attribution.test.mjs

## Interfaces

Version0.4.1; full integration tree; issue/PR dispositions; complete independent final and PR audit; exact-head merge.

## Required discriminating tests

Strict execution cannot use legacy resolved-blocker-path sequence without valid actual receipt; caller/alias coverage versus PR41 verified; npm test and actual unpacked native six-job matrix; full current/baseline parity and SIGKILL soak; final identical-main-tree and postmerge six checks.

## Implementation approach

Apply reviewed owned files and shared hunks only, preserve all tests/tool maps/indexes. Advance package/README version once final code is verified. Attach every created PR, inspect its actual checks/threads/comments, merge only reviewed expected head, verify actual main.

## Sequence and report

1. Read real production paths, existing tests and applicable repository instructions.
2. Commit tests only on your isolated branch; observe actual RED assertions against unchanged production in Actions. Fix fixture errors before claiming RED.
3. Apply only the minimal owned-file fix; production must not precede RED.
4. Read every exact-head six-job log. Report all failures by name, actual counts/skips and RED/GREEN run links; do not broaden after checks pass without a new concern.
5. Write the report at docs/superpowers/research/2026-10-10-imperator-audit/task-7-report.md. Return status/head/tree/owned-file blobs, one-line test evidence and concerns.

Do not spawn subagents or reviewers. Parent assigns independent review, integrates shared hunks, creates PRs and merges. Do not touch other branches/main, weaken assertions, alter workflow gates, or print credentials. Without shell, use structured GitHub tree/commit/ref tools with expected_sha leases and real Actions. Report remote evidence honestly.
