# Imperator Comprehensive Audit Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct all confirmed audit defects at the frozen0.4.0 base and deliver reviewed0.4.1 without inventing production evidence.
**Architecture:** Preserve existing subsystem boundaries and SQLite transactions. Fix admission/reporting/root-containment defects at their shared source; isolate branch changes and integrate only reviewed owned files/shared hunks.
**Tech Stack:** JavaScript ESM, node:sqlite, native pinned DSH/Cordis, GitHub Actions.
**Spec:** docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md

## Global Constraints

Package `@local/dsh-taskforce`, preset `taskforce`, display `任务部队`, database `$DSH_HOME/taskforce/taskforce.db`; Node `^22.23.2 || ^24.19.0`; no external runtime dependencies; DSH pins rc.2/alpha.2; acceptance60s/cleanup12s unchanged; full-tree adapter closed; checkout+packed tests; no credential values; no main/other-branch mutation by implementers.

## Review Focus

- Store/journal service disappearance between pending intent and retry cannot duplicate native effects.
- Review-stage revalidation and restored roots cannot bypass root-return budgets.
- Old schema/NULL-scoped audit rows must not appear healthy or leak into another run.
- Physical root symlinks are legitimate; receipt escape links are not.
- Historical settled retries are read-only and cannot alter new reservations or evade authorization.

---

### Task 1: Freeze workflow delivery and review decisions

**Files:** `lib/workflow/index.js`, `lib/store/workflow.js`, `tools/tests/workflow-engine.test.mjs`, `tools/tests/nextgen-restore-integration.test.mjs`, `docs/WORKFLOW.md`
**Interfaces:** Existing workflow methods and recordExecution pending hook; no new model tool. Root return consumes existing bounded rework count.
**Task brief:** docs/superpowers/plans/2026-10-10-imperator-audit/task-1-brief.md

- [ ] Write discriminating regressions: Direct artifact after failed review; source-change verify and artifact after failed review; verify after lead_acceptance; same-current-revision fail/unverified then pass; old active fail→pass acceptance; root return→new revision succeeds; original-key replay remains; restore root-return path and max_reworks0 refuse; rejection writes no receipt and calls no native executor.
- [ ] Run tests against unchanged production; record expected RED assertions and SHA/run.
- [ ] Implement minimal correction: Use shared exact-current-revision failure/frozen-stage admission in artifact/verification/review/acceptance. Keep request replay before rejecting an already-completed identical request and retain historical terminal outcomes.
- [ ] Verify full six-job available matrix and write task report with exact-head evidence.
- [ ] Complete independent spec/quality review, integrate reviewed files and record actual PR gate.

### Task 2: Repair store reporting and submission chronology

**Files:** `lib/store/index.js`, `lib/store/board-page.js`, `tools/tests/submit-audit-attribution.test.mjs`, `tools/tests/store-evidence.test.mjs`, `tools/tests/store-scope-integrity.test.mjs`, `tools/tests/board-pagination.test.mjs`, `tools/tests/submit-status-code.test.mjs`, `tools/tests/owner-session.test.mjs`, `tools/tests/sqlite.test.mjs`, `tools/verify-store.mjs`, `docs/STORE.md`
**Interfaces:** migrate/unassignedSummary/apply boot diagnostics; acceptTask.resolved_blockers; submitTask/closeTask submitted_at; statsAllRuns.blockers_late; scope_integrity_totals.
**Task brief:** docs/superpowers/plans/2026-10-10-imperator-audit/task-2-brief.md

- [ ] Write discriminating regressions: Only NULL receipt/waiver diagnostics and boot warning;0/1/2 distinct resolved blockers and duplicate resolvers; fixed T0 submit then T1 fact/decision and aliases; resubmission uses new time, old schema yields null; all runs/NULL/pending-state/foreign-scope statistics; second WAL writer cannot split snapshot; each recovery table foreign/NULL board/detail totals and acceptance refusal; terminal preclosure leftovers stay visible.
- [ ] Run tests against unchanged production; record expected RED assertions and SHA/run.
- [ ] Implement minimal correction: Add nullable TEXT task.submitted_at migration and project field; stamp actual submission transition only. Reuse existing evidence predicates and five-table diagnostics. Count recovery integrity using scope-safe joins; healthy output retains prior shape. Wrap all-runs multiquery reads in existing deferred snapshot helper.
- [ ] Verify full six-job available matrix and write task report with exact-head evidence.
- [ ] Complete independent spec/quality review, integrate reviewed files and record actual PR gate.

### Task 3: Allow safe historical settled replay

**Files:** `lib/governor/index.js`, `tools/tests/governor.test.mjs`, `tools/tests/scheduler.test.mjs`, `docs/GOVERNOR.md`, `docs/SCHEDULER.md`
**Interfaces:** settle(input,runId,actor) and scheduler transition; only terminal historical settled replay extends old fence behavior.
**Task brief:** docs/superpowers/plans/2026-10-10-imperator-audit/task-3-brief.md

- [ ] Write discriminating regressions: R1 settle→same-task R2 reserve→R1 same-proof settle replay; reopen persistence; different proof/row generation/cross-run/current or captured owner refusal; stale bind and markUnknown remain fenced; R2 resources/budgets/audit byte-row snapshots unchanged; scheduler two queue admissions same task old settle.
- [ ] Run tests against unchanged production; record expected RED assertions and SHA/run.
- [ ] Implement minimal correction: Narrow settled-only row-generation/owner/scope authorization before skipping the latest task fence. Compare canonical proof, return original row without write. Explicitly replace obsolete settled-fence assertion and document this contract extension; no new adapter activation.
- [ ] Verify full six-job available matrix and write task report with exact-head evidence.
- [ ] Complete independent spec/quality review, integrate reviewed files and record actual PR gate.

### Task 4: Repair execution root resolution and complete operation schema checks

**Files:** `lib/store/execution.js`, `lib/operations/index.js`, `tools/tests/execution-receipts.test.mjs`, `tools/tests/operations.test.mjs`, `tools/tests/host-boundaries.test.mjs`, `docs/OPERATIONS.md`, `docs/STORE.md`
**Interfaces:** strictExecutionEvidence physical versus textual paths; doctor/currentSchema/preflight all required core columns including task.submitted_at afterTask2.
**Task brief:** docs/superpowers/plans/2026-10-10-imperator-audit/task-4-brief.md

- [ ] Write discriminating regressions: Actual successful foreground receipts at direct-root/ancestor symlink accepted; external receipt-dir/file links and archived old-root receipt refused; DROP task.note/fact core field and wrong object type cause doctor incompatibility/preflight refusal; valid old additive schema migrates on isolated copy; original files/bytes unchanged.
- [ ] Run tests against unchanged production; record expected RED assertions and SHA/run.
- [ ] Implement minimal correction: Canonicalize only trusted root for containment; preserve textual provenance and reject receipt escape links. Validate full core requirements from trusted schema declarations or complete map, including receipt/waiver SQL columns, and object types. Preserve supported migration behavior and operations canonical-path policy.
- [ ] Verify full six-job available matrix and write task report with exact-head evidence.
- [ ] Complete independent spec/quality review, integrate reviewed files and record actual PR gate.

### Task 5: Repair scope activation and ambiguous guard outcomes

**Files:** `lib/plugins/scope-membership.mjs`, `lib/plugins/guard.mjs`, `tools/tests/preset-isolation.test.mjs`, `tools/tests/guard-causality.test.mjs`, `tools/tests/host-api-contract.test.mjs`, `docs/PRESET_ISOLATION.md`, `docs/RELIABILITY.md`
**Interfaces:** createScopeMembership resolution invariant; guard event projection and echo/demotion behavior.
**Task brief:** docs/superpowers/plans/2026-10-10-imperator-audit/task-5-brief.md

- [ ] Write discriminating regressions: Direct resolution lacks either/both native functions→activation error; direct valid module distinguishes own/foreign/empty scope; existing fallback+standalone preserved. Matched native TOOL_OUTCOME_UNKNOWN and durable E_CONTROL_OUTCOME_UNKNOWN repeated histories do not become definite failed echo/change-arguments guidance; definite TOOL_NOT_STARTED/genuine failure and mixed histories still behave correctly; native SDK result shape parity.
- [ ] Run tests against unchanged production; record expected RED assertions and SHA/run.
- [ ] Implement minimal correction: Apply native export contract symmetrically after successful resolution. Classify unknown outcomes independently of definite failure using actual shared tool event envelopes; no memory/projection optimization unrelated to the bug.
- [ ] Verify full six-job available matrix and write task report with exact-head evidence.
- [ ] Complete independent spec/quality review, integrate reviewed files and record actual PR gate.

### Task 6: Prevent control replay during journal service degradation

**Files:** `lib/tools/index.js`, `tools/tests/tool-recovery.test.mjs`, `tools/tests/nextgen-tool-integration.test.mjs`, `tools/verify-child-control.mjs`, `docs/RECOVERY.md`, `docs/CONTROL.md`
**Interfaces:** controlIntent/finishControl durable envelope; send/resume/stop effect dispatch; detached legacy controls.
**Task brief:** docs/superpowers/plans/2026-10-10-imperator-audit/task-6-brief.md

- [ ] Write discriminating regressions: Persistent pending outcome then journal unavailable same explicit retry key and trusted-coordinate retry→zero second host effect; closed database, replaced/unavailable recovery service and earlier journal-backed activation fail before effect; journal returns original pending/replayed result; genuinely detached legacy no-request control retains documented behavior; error hint never recommends new-key repetition.
- [ ] Run tests against unchanged production; record expected RED assertions and SHA/run.
- [ ] Implement minimal correction: Fail closed at durable control boundary before native effect when durability was requested or this activation depends on prior journal-backed operation. Retain exact stable key semantics and safe unavailable diagnostics without raw messages/errors.
- [ ] Verify full six-job available matrix and write task report with exact-head evidence.
- [ ] Complete independent spec/quality review, integrate reviewed files and record actual PR gate.

### Task 7: Integrate, close audit coverage and verify release

**Files:** `package.json`, `README.md`, `docs/superpowers/research/2026-10-10-imperator-comprehensive-audit-ledger.md`, `docs/superpowers/plans/2026-10-10-imperator-comprehensive-audit.md`, `tools/tests/store-evidence.test.mjs`, `tools/tests/submit-audit-attribution.test.mjs`
**Interfaces:** Version0.4.1; full integration tree; issue/PR dispositions; complete independent final and PR audit; exact-head merge.
**Task brief:** docs/superpowers/plans/2026-10-10-imperator-audit/task-7-brief.md

- [ ] Write discriminating regressions: Strict execution cannot use legacy resolved-blocker-path sequence without valid actual receipt; caller/alias coverage versus PR41 verified; npm test and actual unpacked native six-job matrix; full current/baseline parity and SIGKILL soak; final identical-main-tree and postmerge six checks.
- [ ] Run tests against unchanged production; record expected RED assertions and SHA/run.
- [ ] Implement minimal correction: Apply reviewed owned files and shared hunks only, preserve all tests/tool maps/indexes. Advance package/README version once final code is verified. Attach every created PR, inspect its actual checks/threads/comments, merge only reviewed expected head, verify actual main.
- [ ] Verify full six-job available matrix and write task report with exact-head evidence.
- [ ] Complete independent spec/quality review, integrate reviewed files and record actual PR gate.


## Ownership amendments

Task2 also owns the existing submit-status-code fixture: preserve its no-write assertions, but pin submitted_at after the genuine chronology RED. Task5 also owns one native guard parity hunk in host-api-contract, the existing anchor-enabled stage, avoiding an ineffective skipped node:test check. All implementers retain the frozen234a789 production base; these grants do not authorize other files.

Task2 additionally owns only the owner-session additive-migration expected-row hunk: explicitly assert submitted_at:null and preserve every old row value/identity assertion. No identity behavior or other owner-session tests may change.

Task4 owns two native symlink receipt cases in host-boundaries, the actual anchor-enabled stage. Task4 may carry the exact Task2 candidate as a documented dependency before final core-column validation. Task5 covers Task6 E_CONTROL_JOURNAL_UNAVAILABLE as an ambiguous historical outcome; this does not prove the rejected current call executed.

Task2 also owns only sqlite.test exact additive-migration diagnostic expectations and verify-store S04 exact column fixture. Add receipt/waiver zero counts and submitted_at while preserving every existing meaningful row/column/identity/rollback check. These grants followed genuine RED and the first implemented candidate's two obsolete fixture failures.

## Actual PR review follow-up

Initial six modules completed actual six-job GREEN and independent spec/quality review. PR60–66 were created and attached; none merged. Actual PR review then found four further defects requiring discriminating RED: old failed workflow whose active revision was cleared before upgrade; explicit-null recovery misclassified as detached; authoritative ctx.get missing service obscured by reflective Cordis miss; missing task-first index for recovery integrity counts. Tasks1/2/6 are reopened for these findings; original GREEN remains historical evidence only. Final integration, current PR checks, original-base independent review and a fresh extra premerge round remain pending.

Task6 additionally owns only new real-Cordis control cases in host-boundaries.test.mjs; root integrates their hunk with Task4's two independently approved root-alias cases. Task6 tests its own baseline+hunk without copying Task4 production; aggregate verifies the union.
