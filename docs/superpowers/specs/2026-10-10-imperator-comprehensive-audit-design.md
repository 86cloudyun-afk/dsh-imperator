# Imperator 0.4.1 comprehensive audit repair

## Intent and acceptance

The user requests a comprehensive project audit and resolution of confirmed problems, continuing the previously authorized Superpowers implementation, independent review, PR creation and merge workflow at the highest available reasoning effort. Audit all production modules and existing open issues against immutable main81b7ce67114f96ebcd05b257571ce8a6bc9e68c7 (0.4.0); this is not a claim that arbitrary production defects can be disproved without deployment evidence.

Keep existing data, public names, scope isolation, strict native execution and missing-host-capability fail-closed behavior. Every production correction requires an observed discriminating RED test before GREEN, full available verification, independent task review, then a complete release review and an additional actual-PR audit before expected-head merge.

## Operating constraints

- Package name `@local/dsh-taskforce`; preset `taskforce`; display name `任务部队`; existing database `$DSH_HOME/taskforce/taskforce.db`.
- No new external runtime dependencies. Node engines `^22.23.2 || ^24.19.0`; native matrix pinned DSH `0.2.0-rc.2` and `0.2.1-alpha.2`.
- Preserve original acceptance60s and cleanup12s deadlines; no timeout waiver or weakening existing meaningful assertions.
- Checkout and actual unpacked-package tests both count. New test files must be registered; legacy tests may change only for explicitly recorded contract decisions with replacement coverage.
- Current cloud executor failed capability configuration; there is no shell/filesystem execution tool. Use isolated GitHub branches and real Actions jobs instead of fabricating local paths/results. SDK/provider readiness is unknown; do not print credentials or claim production/paid-model tests.
- Official full-tree adapter remains closed; H01/H03 helpers do not establish H02/H04/H05/H06, strict containment or whole-tree quiescence.

## Required corrections

1. Any actual delivery freezes its same task/run/plan/evidence generation until explicit bounded trusted-root return; failed review is not required. Legacy NULL active revisions or replacement revisions cannot bypass delivered ancestry, including a repeated artifact referencing the same receipt. Sole exact-current delivery permits normal first review and passing acceptance, including max_reworks0. Current fail/unverified review cannot be superseded or accepted. Preserve original request-key read-only replays, terminal historical results and legitimate root-authorized new generations/plans. Denial precedes receipt writes/native execution. Frozen review and both acceptance strict-evidence reads provide actionable budget-aware root return→claim→verify/new artifact/review guidance; exhausted/zero budget requires a new explicitly root-authorized task. Ordinary execution retry/explicit waiver and mutable workflow verification remain. Restore-stage revalidation obeys the same budget.
2. Store diagnostics share the five-table unassigned contract; accepted resolved_blockers counts distinct blockers with valid resolution. Persist nullable TEXT submitted_at for future submissions instead of reusing updated_at; legacy unknown times remain null. All-runs statistics include terminal unresolved blockers using shared pending/resolution predicates and one read snapshot. Default/summary board scope integrity includes recovery event/checkpoint/control rows, matching detail/acceptance without leaking contents.
3. Governor settle extends terminal replay narrowly: a settled row with matching supplied row generation, authorized current/captured owner and identical normalized proof returns its existing result without audit/hold/budget mutation, even after a newer reservation. Conflicting proof refuses; bind/unknown/nonterminal transitions retain latest fences. Scheduler inherits and tests the same behavior.
4. Execution receipts allow a symlink in the configured store root while binding physical receipt containment to the canonical store root; preserve exact historical textual log identities. Receipt-file and receipt-directory escape symlinks still fail. Operational doctor/preflight validate all runtime-required core table columns and object types while accepting truly supported additive migrations; malformed schema reports incompatibility without modifying the original database.
5. Scope membership validates required native functions after both resolution paths, preserving genuine standalone behavior. Guard unknown-outcome classifications cannot turn ambiguous effects into definite failure or instructions to change arguments/repeat effects; definite nonstarted/error controls remain discriminating.
6. Durable controls cannot silently repeat an unresolved operation when the journal becomes unavailable. Explicit durable retry keys and previously journal-backed activation must fail closed before host effects; genuinely journal-free legacy control remains documented, bounded and distinguishable. Test explicit and trusted-coordinate retries, missing/closed/replaced services, no leaked raw input and recovery after journal availability returns.

## Triage decisions

- #47 is already fixed by trusted actor/session identity; do not reserve the text lead or change legitimate worker-session names.
- #45 retains all terminal unresolved blockers, including preclosure leftovers; correct misleading after-closure wording. recordFact.late records insertion-time state; board late_blockers describes current state.
- #42 remains the deliberate legacy any-kind+path evidence contract. Strict execution/workflow require independent real receipts; verify that old legacy sequence cannot bypass them and clarify the human-review boundary. Excluding blocker alone would not prove positive evidence and would alter investigation compatibility.
- #53 is an intentional narrow contract extension, not a claim that the old documented fence was accidentally absent.
- Inspect PR41 test coverage on current main; adopt only a demonstrated coverage gap. PR50 is closed and offered no new behavior, so it is not a repair deliverable.

## Delivery

Implement independent fixes in isolated branches with explicit owned files. Integrate shared-file hunks without whole-side replacement. Publish cohesive component PRs as practical, each with its original-main/full-range review and exact-head checks; carry common planning evidence without claiming future merge gates in source. Verify final main tree and main CI. Record every issue disposition, actual test/commit evidence, external limitations and decisions in the ledger/PR records.

## Durable journal availability interface

`E_CONTROL_JOURNAL_UNAVAILABLE` means the current control dispatch is refused before a native effect, while missing journal state cannot establish the result of earlier requests with the same key. Preserve the original retry key and advise reading its receipt after recovery; never suggest changing the key or repeating an effect. Guard treats this envelope conservatively as an unknown historical outcome, retaining definite-failure controls separately.

## Journal continuity and actual-review follow-up

Bind the original recovery service object per tools activation, including initial mount. Missing/replaced/closed/unreadable durability refuses controls before effects; returning the original object may replay. A replacement object needs controller verification of the original persistent database and a fresh activation; same-object reconnect remains supported. Same-object hostile database replacement is outside this contract. Truly absent recovery service without explicit request key retains detached legacy control; explicit null or malformed mounted service is not absence. A normal authoritative ctx.get undefined must not become failure merely because optional Cordis reflection throws on a missing service.

Legacy failed workflow history may retain its plan/evidence generation while old revalidation cleared the active revision. The upgrade must require bounded root return for such a reachable active failure lineage, while preserving terminal historical outcomes and legitimate new root-approved revisions. Recovery integrity queries require bounded task-key access; pagination alone does not bound whole-run anomaly aggregates.

## Synchronous control journal and startup diagnostics follow-up

A durable begin result must be a synchronous validated operation envelope before any host effect. Keep legitimate short new-intent fields and full read-only replay shapes. Missing/incomplete/thenable results cannot authorize dispatch. A malformed finish result after an effect must report an unknown outcome under the original retry key, never successful settlement or a new-key retry. Rejecting native or cross-realm Promises must be observed safely without turning an asynchronous journal API into accepted durability, so invalid adapters cannot produce an unhandled rejection that terminates the executor.

The shared five-table NULL diagnostic runs on open/migrate, boot and adoption. Existing receipt/waiver task-leading indexes scan assigned audit history even with no NULL rows. Use additive partial run-key indexes inside the existing migration transaction to make the real production NULL queries search only the relevant rows. Keep row values, column metadata, diagnostic/adoption/quarantine semantics and the control task-key index. Actual EQP and large assigned-history fixtures establish the access-path improvement; wall-clock samples are observations rather than latency gates or service guarantees. Performance indexes remain outside the doctor's data-readability prerequisites.

## Stable keys on early journal refusal

A pre-dispatch journal lookup/unavailability refusal returns a validated explicit original key or the original trusted-coordinate-derived key when reconstructable. It must not generate a new UUID that could be mistaken for earlier history. Without either source, historical-key reconstruction is unavailable and the caller retains its previously returned generated key separately. Normal mounted new intents keep their existing UUID fallback; successful never-journal detached controls do not acquire new coordinate reads. No durable outcome is fabricated by this metadata.

## Definite rejected control replays

The stop API can persist a definite rejected receipt after an explicit accepted:false response. Its validated, complete, consistent durable replay is a definite rejection for ECHO even though the compatibility error code remains E_CONTROL_OUTCOME_UNKNOWN. Count distinct matched invocations, not duplicate results; replay must invoke no second host effect. Missing or conflicting metadata, pending/unknown, journal unavailability and native TOOL_OUTCOME_UNKNOWN remain ambiguous and must not arm ECHO or reasoning demotion. Demonstrate the real registry→SQLite→replay→guard path with native/PTC histories, not a handcrafted status-only exception. Do not change the merged tools protocol, runner deadlines, runtime dependencies or host pins.
