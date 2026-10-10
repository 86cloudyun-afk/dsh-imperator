# Task 2: Repair store reporting and submission chronology

Read this first; this is the task's requirements. Baseline81b7ce67114f96ebcd05b257571ce8a6bc9e68c7; read the linked spec's relevant requirements and decisions: docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md.

## Global constraints

Package `@local/dsh-taskforce`, preset `taskforce`, display `任务部队`, database `$DSH_HOME/taskforce/taskforce.db`; Node `^22.23.2 || ^24.19.0`; no external runtime dependencies; DSH pins rc.2/alpha.2; acceptance60s/cleanup12s unchanged; full-tree adapter closed; checkout+packed tests; no credential values; no main/other-branch mutation by implementers.

## Files

- lib/store/index.js
- lib/store/board-page.js
- tools/tests/submit-audit-attribution.test.mjs
- tools/tests/store-evidence.test.mjs
- tools/tests/store-scope-integrity.test.mjs
- tools/tests/board-pagination.test.mjs
- tools/tests/submit-status-code.test.mjs
- tools/tests/owner-session.test.mjs (only additive-migration expected-row fixture)
- tools/tests/sqlite.test.mjs (only exact additive-migration diagnostic fixture)
- tools/verify-store.mjs (only S04 exact additive task column fixture)
- docs/STORE.md

## Interfaces

migrate/unassignedSummary/apply boot diagnostics; acceptTask.resolved_blockers; submitTask/closeTask submitted_at; statsAllRuns.blockers_late; scope_integrity_totals.

## Required discriminating tests

Only NULL receipt/waiver diagnostics and boot warning;0/1/2 distinct resolved blockers and duplicate resolvers; fixed T0 submit then T1 fact/decision and aliases; resubmission uses new time, old schema yields null; all runs/NULL/pending-state/foreign-scope statistics; second WAL writer cannot split snapshot; each recovery table foreign/NULL board/detail totals and acceptance refusal; terminal preclosure leftovers stay visible.

## Implementation approach

Preserve submit-status zero-write idempotence assertions; after genuine RED, update the obsolete fixture to pin actual submitted_at rather than updated_at. Add nullable TEXT task.submitted_at migration and project field; stamp actual submission transition only. Reuse existing evidence predicates and five-table diagnostics. Count recovery integrity using scope-safe joins; healthy output retains prior shape. Wrap all-runs multiquery reads in existing deferred snapshot helper.

## Sequence and report

1. Read real production paths, existing tests and applicable repository instructions.
2. Commit tests only on your isolated branch; observe actual RED assertions against unchanged production in Actions. Fix fixture errors before claiming RED.
3. Apply only the minimal owned-file fix; production must not precede RED.
4. Read every exact-head six-job log. Report all failures by name, actual counts/skips and RED/GREEN run links; do not broaden after checks pass without a new concern.
5. Write the report at docs/superpowers/research/2026-10-10-imperator-audit/task-2-report.md. Return status/head/tree/owned-file blobs, one-line test evidence and concerns.

Do not spawn subagents or reviewers. Parent assigns independent review, integrates shared hunks, creates PRs and merges. Do not touch other branches/main, weaken assertions, alter workflow gates, or print credentials. Without shell, use structured GitHub tree/commit/ref tools with expected_sha leases and real Actions. Report remote evidence honestly.

## Recorded follow-up

Preserve existing diagnostic zero counts and exact schema expectations while adding receipt/waiver and submitted_at. PR63's actual review found missing task-leading access for control_operation integrity queries. Test production SQL EXPLAIN QUERY PLAN and correct scoped counts with a substantial fixture before the minimal additive index correction; retain all original rows and columns.
