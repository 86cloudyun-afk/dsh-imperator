# Task 6: Prevent control replay during journal service degradation

Read this first; this is the task's requirements. Baseline81b7ce67114f96ebcd05b257571ce8a6bc9e68c7; read the linked spec's relevant requirements and decisions: docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md.

## Global constraints

Package `@local/dsh-taskforce`, preset `taskforce`, display `任务部队`, database `$DSH_HOME/taskforce/taskforce.db`; Node `^22.23.2 || ^24.19.0`; no external runtime dependencies; DSH pins rc.2/alpha.2; acceptance60s/cleanup12s unchanged; full-tree adapter closed; checkout+packed tests; no credential values; no main/other-branch mutation by implementers.

## Files

- lib/tools/index.js
- tools/tests/tool-recovery.test.mjs
- tools/tests/nextgen-tool-integration.test.mjs
- tools/verify-child-control.mjs
- docs/RECOVERY.md
- docs/CONTROL.md

## Interfaces

controlIntent/finishControl durable envelope; send/resume/stop effect dispatch; detached legacy controls.

## Required discriminating tests

Persistent pending outcome then journal unavailable same explicit retry key and trusted-coordinate retry→zero second host effect; closed database, replaced/unavailable recovery service and earlier journal-backed activation fail before effect; journal returns original pending/replayed result; genuinely detached legacy no-request control retains documented behavior; error hint never recommends new-key repetition.

## Implementation approach

Fail closed at durable control boundary before native effect when durability was requested or this activation depends on prior journal-backed operation. Retain exact stable key semantics and safe unavailable diagnostics without raw messages/errors.

## Sequence and report

1. Read real production paths, existing tests and applicable repository instructions.
2. Commit tests only on your isolated branch; observe actual RED assertions against unchanged production in Actions. Fix fixture errors before claiming RED.
3. Apply only the minimal owned-file fix; production must not precede RED.
4. Read every exact-head six-job log. Report all failures by name, actual counts/skips and RED/GREEN run links; do not broaden after checks pass without a new concern.
5. Write the report at docs/superpowers/research/2026-10-10-imperator-audit/task-6-report.md. Return status/head/tree/owned-file blobs, one-line test evidence and concerns.

Do not spawn subagents or reviewers. Parent assigns independent review, integrates shared hunks, creates PRs and merges. Do not touch other branches/main, weaken assertions, alter workflow gates, or print credentials. Without shell, use structured GitHub tree/commit/ref tools with expected_sha leases and real Actions. Report remote evidence honestly.
