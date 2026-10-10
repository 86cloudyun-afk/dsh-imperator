# Imperator Next-Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship a tested next-generation reliability/workflow/operator layer while preserving official-host capability evidence gates.

**Architecture:** Five isolated subsystem branches implement same-store trusted services and bounded product surfaces. Parent integrates shared store/tool/governor/runner/package files, then an independent reviewer checks the complete branch.

**Tech Stack:** JavaScript ES modules, Node22/24 built-in SQLite, official pinned DSH, dependency-free CLI, GitHub Actions.

**Spec:** docs/superpowers/specs/2026-10-10-imperator-nextgen-design.md

## Global Constraints

- Node ^22.23.2 || ^24.19.0; native validation DSH0.2.0-rc.2 and0.2.1-alpha.2.
- Package @local/dsh-taskforce, preset taskforce, existing data path and nonworkflow legacy behavior preserved.
- Trusted identity outside model input; no automatic unknown-effect replay, acceptance or resource release.
- Native H01-H06 require actual evidence; standard mode remains isolated.
- Model context/diagnostic outputs bounded; no raw secret/prompt/log exports.
- No production install/restart, publishing or destructive DB restore.

## Review Focus

- Crash after external acceptance but before local outcome commit: retain unresolved operation without repeat.
- Two processes and broken ancestry: preserve scope and live ownership without false abandonment.
- Upstream reject/reaccept and writer changes: old downstream tests/reviews cannot revive.
- WAL snapshot and relocated receipt roots: backup includes committed state; restore never fabricates verification.
- Exhausted pages and mutable/frozen accessor histories: preserve exact membership, output and reset semantics.

---

### Task1: Recovery journal, checkpoints and timeline

**Files:** lib/store/recovery.js; tools/tests/recovery-journal.test.mjs; docs/RECOVERY.md. Parent integration lib/store/index.js, lib/tools/index.js.
**Interfaces:** TaskforceRecovery(store), RECOVERY_DDL; beginControl/finishControl/checkpoint/timeline/inspect/diagnosticBundle. Existing store connection and trusted identities consumed.
- [x] Write crash-boundary, restart/no-effect, direct-caller/run scope, idle/unknown, size/secret and rollback tests.
- [x] Run genuine RED in isolated branch.
- [x] Implement bounded durable services and supply exact integration hooks.
- [x] Run focused and full suites; commit GREEN evidence.

### Task2: Workflow DAG, stage/version and independent evidence gates

**Files:** lib/workflow/index.js; lib/store/workflow.js; tools/tests/workflow-engine.test.mjs; docs/WORKFLOW.md. Parent integration store lifecycle and governor admission.
**Interfaces:** TaskforceWorkflow(store), WORKFLOW_DDL and synchronous claim/submit/accept/reject hooks.
- [x] Write DAG cycles/races, stale upstream generation, direct acceptance bypass, reviewer independence, strict defaults and replay tests.
- [x] Observe RED.
- [x] Implement APIs from spec with exact host-observed artifact provenance and atomic gates.
- [x] Run focused/full suites; commit tested integration patch/evidence.

### Task3: Durable queue and concrete host evidence ports

**Files:** lib/scheduler/index.js; lib/scheduler/dsh-host.js; tools/tests/scheduler.test.mjs; docs/SCHEDULER.md. Parent governor readiness hook.
**Interfaces:** TaskforceScheduler(store) enqueue/admitNext/bind/markUnknown/settle/state; pinned-host evidence helpers.
- [x] Test queue/admission atomicity, resource contention, restart, no automatic effects, unknown locks and native capability rejection.
- [x] Observe RED.
- [x] Implement governor-backed scheduling and H01/H03 evidence helpers; keep unresolved native activation closed.
- [x] Probe exact official host contracts; run focused/full tests and document external capability gaps.

### Task4: Measured performance and long-history/soak tools

**Files:** lib/plugins/event-projection.mjs; lib/plugins/working-context.mjs; tools/probe-nextgen.mjs; tools/soak-nextgen.mjs; targeted projection/board tests. Shared board/DDL edits provided to parent.
**Interfaces:** Existing projection/output unchanged; benchmark/soak emit bounded white-list JSON evidence.
- [x] Add parity tests for TODO, reset/mutation/reorder/accessors and exhausted page semantics.
- [x] Observe RED for selected changes.
- [x] Implement measured copy/TODO improvements; benchmark blocker access-path alternatives before adopting.
- [x] Run fresh-process startup/storage/write/large history and fault/soak evidence plus full tests.

### Task5: Safe operator CLI, backup/preflight/restore

**Files:** lib/operations/index.js; tools/imperator.mjs; tools/tests/operations.test.mjs; docs/OPERATIONS.md.
**Interfaces:** doctor/backup/preflight/restore functions and corresponding real packaged CLI.
- [x] Test no-write doctor, live WAL snapshot, tamper/symlink/traversal, restore relocation and atomic publication.
- [x] Observe RED.
- [x] Implement dependency-free secret-safe operators and staging-only restore.
- [x] Execute actual packed archive CLI, SQLite fault cases and full suite.

### Task6: Integration, real acceptance, release and review

**Files:** shared lib/store/index.js, lib/tools/index.js, lib/governor/index.js, package.json, README.md, tools/verify-all.mjs, .github/workflows/verify.yml and release evidence.
- [x] Integrate subsystem code and shared guards with unique test registrations/exports; bump0.4.0.
- [x] Verify task transitions, workflow lifecycle, recovery views, runner compatibility and standard preset isolation.
- [ ] Execute full offline and unpacked official matrix, CLI, soak and performance artifacts.
- [x] If runtime credential/deployment available, execute opted-in bounded real model/production regression and record complete usage; otherwise report missing entry without substituting synthetic results.
- [ ] Create PR and attach artifact, review complete fixed head independently, resolve verified feedback and ensure all exact-head CI green.
- [ ] Squash merge expected reviewed head, verify main tree+CI, archive actual evidence and remaining official-host gaps.
## Frozen-source release gate

Subsystem implementation and independent reviews are complete. The remaining final-source CI, delivery PR attachment/review, expected-head merge and post-merge main checks occur after this source snapshot; their actual completion evidence is maintained in the delivery PR and controller task plan. The conditional model/production item used its missing-entry path: cloud executor configuration failed, no usable deployment/log or credential readiness was supplied, and no0.4 model/production success is asserted. Runtime budgets remain finite validated policies despite the highest development reasoning budget.
