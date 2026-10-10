# Imperator next-generation 0.4 design

Date: 2026-10-10. Base: e0743f045afa0c4a81c3207c809c56ad49acaa5b (0.3.2).

## Authorized outcome

The user requested all six proposed next-generation upgrades, maximum development and validation effort, and retains authorization to create PRs, conduct a fresh independent full review, and merge only after checks and review complete. Execution uses parallel specialist implementers and independent final review. Highest budget refers to this development effort; product budgets remain explicit validated policies.

Deliver production-usable diagnosis, controlled recovery, durable scheduling/workflow, measured long-history improvements, and operator tooling. Existing official-host limitations must be surfaced accurately. Actual production failure reproduction and paid long-model acceptance require an accessible deployment/log entry and a ready runtime credential; these cannot be replaced by synthetic success.

## Existing contracts

- Keep package @local/dsh-taskforce, preset taskforce, and the taskforce.db path.
- Keep Node ^22.23.2 || ^24.19.0 and exact native validation on DSH 0.2.0-rc.2 / 0.2.1-alpha.2.
- Preserve host-derived session/run identity, caller Agent object authorization, owner and evidence-generation fences, cross-run filtering, strict native bash/approval/sandbox/guards, and standard-mode isolation.
- Preserve legacy openTask behavior. Coding workflow templates explicitly require execution policy.
- Preserve full mutable pagination membership, NULL-safe scopes, uncapped resolver checks, current byte limits and exact tokens unless a separately proven protocol replaces them.
- Service isolation is an API boundary; local same-UID filesystem access is not a security boundary.

## 1. Diagnosis and controlled recovery

Add lib/store/recovery.js, exporting RECOVERY_DDL and TaskforceRecovery(store). Use the store-owned current connection and existing SQLite transactions; initialization must be atomic and compatible with reconnect/rollback invalidation.

Persist bounded control operation intents/outcomes, task transitions and checkpoints. Each control intent includes operation ID, direct trusted caller, target child, optional verified root run/task attribution, evidence generation where applicable, and process-instance ID. Never persist message content or raw exceptions in the journal. Persist intent before host invocation; a missing/failed outcome persistence remains unresolved effect, never safe-to-retry proof.

Trusted API: beginControl(input, authority), finishControl(input, authority), checkpoint(input, runId, trustedActor), timeline(input, runId), inspect(input, runId), diagnosticBundle(input, runId). Input field limits and JSON output budgets must be explicit. Replaying an operation key with matching payload never authorizes another host invocation.

Integrate task_child_send and task_child_stop after their existing direct-child/service preflight. Full ancestor-chain unavailability must not break existing control; unattributed journal entries are visible only through the trusted direct-caller scope. Missing live-agent observation is unknown, not inactive; explicit idle is only an instantaneous observation. Neither idle nor stop acceptance proves process-tree quiescence.

Task mutations and append-only task_event rows share one transaction. Existing history gets an explicitly incomplete baseline. Checkpoints capture owner/generation plus bounded model-authored recovery context; they do not prove effects, restore authority, or revive stale evidence. Inspection never executes, resends, reassigns, waives or accepts.

Expose bounded timeline/recovery through task_board, and a narrowly scoped task_checkpoint tool if required. Default diagnostic exports allowlist codes/IDs/counts/timestamps/versions, excluding prompts, reasoning, messages, commands, environment, raw errors, paths and log contents. Export reports truncation and observation gaps.

## 2. Workflow and dependency gates

Add lib/workflow/index.js and lib/store/workflow.js. TaskforceWorkflow(store) owns same-run bounded DAG edges, dependency generation fences, coding templates, immutable artifact/review history and optimistic stage versions. Store task lifecycle stays authoritative.

Stages: plan, implement, test, review, lead_acceptance, completed. Concrete host-only API: create, setDependencies, approvePlan, recordArtifact, recordReview, returnForRework, state, ready. Every mutation receives run and trusted actor separately, an explicit request_key and where applicable expected_version. Equal replay returns original result; conflicting payload fails.

Dependencies must be same-run, cycle-free, and immutable during active work. Claim/governor admission checks accepted prerequisites without current blockers/integrity defects and captures their evidence generations. Submit/accept rechecks those fences: reject/reaccept upstream does not revive downstream evidence.

Store.acceptTask enforces workflow readiness, current artifact/version, strict latest receipt and actual independent reviewer identity in the same transaction as acceptance. Workflow waivers cannot bypass these gates. Writer/reviewer identity is host-observed; labels or a new turn in the same session do not establish independence. Artifact provenance comes from actual receipt.snapshot and log digests; model hashes/revisions are claims.

Existing files/command must satisfy current executionPolicy at coding-template creation. Adding a new verification manifest requires explicit trusted invalidation; no weakening of existing file snapshot semantics. Root rework uses existing reject/evidence generation and bounded append-only history.

## 3. Durable scheduler and official-host evidence

Add lib/scheduler/index.js with TaskforceScheduler(store), durable same-run queued requests and atomic governor admission. API: enqueue, admitNext, bind, markUnknown, settle, state. Preserve root/task/owner identities, append-only retry charging, resource locks, and unknown occupying capacity. Scheduling core performs no implicit external effects.

Add concrete pinned-host identity preparation and strict persistence/readback evidence helpers where supported. Provide structured capability diagnostics for H01-H06. Supplying booleans/callbacks is not proof of native enforcement.

Native adapter activation remains fail-closed until complete target-side admission, durable delivery lookup, supervised process-tree quiescence, genuine owner recovery, and enforced workspace identity are proven. Alpha.2 waitForExit is range-relative and can use weaker fallback. H02 is absent even in newest observed upstream. Implement usable local scheduling/evidence work and document exact upstream contract changes; never label it official full-tree enforcement.

## 4. Long-history performance and validation

Measure blocker access-path candidates on identical datasets; keep the existing partial index unless selected-row forcing or task-first index shows benefit including startup/write/storage costs. Never weaken resolver or membership semantics for speed.

Reduce event-projection copy after a validated prefix and make working-context TODO projection incremental with full-replay parity. Mutable seed, replacement, reorder, truncation and scope/policy changes retain reset semantics. No claimed constant-time full step or identity shortcut for unverified accessor arrays.

Add isolated benchmark tools for large fact/event histories, fresh-process startup/migration, WAL/database sizes, writes, RSS/heap, first/middle/final/exhausted pages, and synthetic soak/fault injection. Fresh process is not proof of cold OS caches. Keep timing informational, exact behavior/security pass-fail.

## 5. Operator CLI and delivery

Add lib/operations/index.js and tools/imperator.mjs: doctor, backup, preflight, restore. Doctor uses an independent readOnly DatabaseSync and creates/migrates nothing. Output is bounded and secret-safe.

Backup uses SQLite online snapshot including committed WAL, then verifies/copies referenced immutable receipt logs into an exclusive staging directory. Reject existing output, live-root nesting, symlink/traversal, missing/tampered log references, and incomplete snapshots. Publish success manifest only after checks.

Preflight migrates a disposable snapshot only and compares retained rows/identity-sensitive fields. Restore targets a new directory, validates manifests/hashes/schema and preserves historical audit. Absolute receipt/source roots remain provenance; relocation requires re-verification and cannot make old receipt valid. No automatic production install/restart or destructive replacement.

Expose ./recovery, ./workflow, ./scheduler, ./operations and an operator bin after packed CLI execution tests. Update version to0.4.0 and delivery docs accurately, including native and production acceptance limitations.

## 6. Verification and integration

Each subsystem must observe genuine test-first RED on unchanged production, then GREEN on actual Node SQLite, followed by integration checks. Tests cover multi-connection races, rollback, stale identity/generation, cross-run corruption, secret sentinel suppression, restart/no-effects and exact output bounds.

Use isolated branches if the managed executor remains unavailable, with execution supplied by GitHub Actions. Parent alone integrates shared files and creates PRs. Final verification includes complete offline suites and unpacked exact npm archive native matrix plus operator CLI, fault injection/soak and measured performance artifacts.

New paid model regression is authorized by maximum-budget execution request when the configured runtime is actually ready; use the harness maximum supported bounded request budget and capture real usage. A pending/unknown credential observation is not readiness.

Before merge: fresh independent full base-to-head review on the most capable configured model, all exact-head CI green, address verified feedback, then expected-head squash merge. Verify main tree and post-merge CI. Report every blocked real-host/production requirement explicitly rather than claiming universal completion.