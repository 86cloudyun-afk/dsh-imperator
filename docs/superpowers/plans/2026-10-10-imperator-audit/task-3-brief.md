# Task 3: Allow safe historical settled replay

Read this first; this is the task's requirements. Baseline81b7ce67114f96ebcd05b257571ce8a6bc9e68c7; read the linked spec's relevant requirements and decisions: docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md.

## Global constraints

Package `@local/dsh-taskforce`, preset `taskforce`, display `任务部队`, database `$DSH_HOME/taskforce/taskforce.db`; Node `^22.23.2 || ^24.19.0`; no external runtime dependencies; DSH pins rc.2/alpha.2; acceptance60s/cleanup12s unchanged; full-tree adapter closed; checkout+packed tests; no credential values; no main/other-branch mutation by implementers.

## Files

- lib/governor/index.js
- tools/tests/governor.test.mjs
- tools/tests/scheduler.test.mjs
- docs/GOVERNOR.md
- docs/SCHEDULER.md

## Interfaces

settle(input,runId,actor) and scheduler transition; only terminal historical settled replay extends old fence behavior.

## Required discriminating tests

R1 settle→same-task R2 reserve→R1 same-proof settle replay; reopen persistence; different proof/row generation/cross-run/current or captured owner refusal; stale bind and markUnknown remain fenced; R2 resources/budgets/audit byte-row snapshots unchanged; scheduler two queue admissions same task old settle.

## Implementation approach

Narrow settled-only row-generation/owner/scope authorization before skipping the latest task fence. Compare canonical proof, return original row without write. Explicitly replace obsolete settled-fence assertion and document this contract extension; no new adapter activation.

## Sequence and report

1. Read real production paths, existing tests and applicable repository instructions.
2. Commit tests only on your isolated branch; observe actual RED assertions against unchanged production in Actions. Fix fixture errors before claiming RED.
3. Apply only the minimal owned-file fix; production must not precede RED.
4. Read every exact-head six-job log. Report all failures by name, actual counts/skips and RED/GREEN run links; do not broaden after checks pass without a new concern.
5. Write the report at docs/superpowers/research/2026-10-10-imperator-audit/task-3-report.md. Return status/head/tree/owned-file blobs, one-line test evidence and concerns.

Do not spawn subagents or reviewers. Parent assigns independent review, integrates shared hunks, creates PRs and merges. Do not touch other branches/main, weaken assertions, alter workflow gates, or print credentials. Without shell, use structured GitHub tree/commit/ref tools with expected_sha leases and real Actions. Report remote evidence honestly.
