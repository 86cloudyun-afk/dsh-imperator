# SDD ledger — plan: docs/superpowers/plans/2026-10-10-imperator-comprehensive-audit.md

## Baseline and audit coverage

Immutablemain81b7ce67114f96ebcd05b257571ce8a6bc9e68c7, tree352e615beb3251b60424d4aa81b6929037c51778, package0.4.0. Previous main run38024642590 all6 success. Five independent audit domains covered workflow/recovery, governor/scheduler, store/pagination/migrations, host/tools/plugins, operations/execution/evidence; parent covers packaging/runner/SQLite/verification and integration. Findings below initially source-verified, not Node/SQLite runtime claims.

Known issues43/44/46/48/52/57/59 have current-source defects. Issue53 is an intentional contract extension. Issue47 already fixed; PR50 closed without useful delta. Issue45 current state-based visibility is correct but some wording stale. Issue42 is explicit legacy semantics, not strict execution bypass. Additional candidates: recovery-scope default board omissions; all-runs torn snapshot; doctor core-column omissions; ambiguous guard outcomes; durable control service-loss retry.

## Rulings

- Ruling: use isolated GitHub branches and Actions after managed executor capability startup failed — actual shell tools are unavailable — local/production/paid-model acceptance stays unverified.
- Ruling: preserve terminal unresolved blocker visibility (#45), changing misleading chronology wording only — hiding preclosure leftovers violates current contract — callers seeking insertion-time chronology must use the fact-write metadata.
- Ruling: retain deliberate legacy any-kind+path basis (#42), clarify human-review boundary and prove strict receipt isolation — excluding one negative kind would not prove success and changes investigation compatibility — legacy callers remain responsible for content review.
- Ruling: narrowly extend settled-only same-proof replay (#53), preserving all scope/owner/row-generation checks and no writes — safe retry should not depend on a later reservation — old callers expecting that specific fence now receive historical settled result.
- Ruling: freeze delivery/review and require root return for restored-root revalidation (#59), including current-revision failed-review history — existing direct reverify path bypasses budgets — max_reworks0/exhausted moved workflows require a new authorized task.

## Execution status

Tasks1–7 pending genuine RED/GREEN and independent review. No production correction, PR or merge performed for this audit yet. Dynamic isolated V8 real-dispatcher boundary reproduction of service-loss replay reported by recovery audit; real node/SQLite regression required before correction. A workflow audit agent was platform-interrupted; its completed source findings are retained and implementation will be reassigned.

PR/merge/main completion is recorded by parent only after actual gates. The source plan does not assert its own future merge.

## Ownership and current execution

Task2 granted submit-status-code.test.mjs for the obsolete updated_at fixture; Task5 granted host-api-contract.test.mjs for real anchor-enabled native guard parity. Tasks1/2/3/5/6 have tests-only isolated commits in real Actions; Task4 is dispatched. No production fix or audit PR merged yet. Managed executor is now definitively failed again; Actions remain the actual execution path.
