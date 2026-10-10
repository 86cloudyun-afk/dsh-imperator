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

1. Workflow reviews become frozen delivery stages. Direct artifact writes and fresh verification cannot move review/lead_acceptance back to test. A current-revision fail/unverified review cannot be superseded or accepted until explicit root return, bounded by max_reworks. Preserve exact request-key read-only replays and completed historical outcomes. Failed history belongs to exact task/run/revision/plan/evidence generation, so root-approved new revisions remain usable. Denial precedes new receipt and native execution. Restore-stage revalidation requires root return and budget; zero/exhausted budget refuses it.
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
