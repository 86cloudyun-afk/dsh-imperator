# Task 3 report: safe historical settled replay

## Result and scope

The implementation candidate is `e02b7cab27ab413d49a12cc562b324e6cde15f2e`, tree `4fa055894ac40ea7a043fee5d34e04eb88e17f40`, on `codex/audit-settled-replay`. All six jobs of its actual [GREEN Verify run](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030790223) completed successfully; every job log was retrieved and checked for exact checkout SHA, test failures, counts, skips and verifier results.

This report is added in a subsequent documentation-only commit. The candidate SHA/tree above are the verification inputs; the five owned blobs below remain identical in the report commit. The report commit adds only this file. Parent review and the integrated release's exact-head, actual-PR and main verification remain separate gates.

Production baseline: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7` (0.4.0). Planning parent: `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`, tree `f5ccdec261c34b05912b7f8766faa46fabe31647`. Requirements are Task 3's brief and the comprehensive audit design at that planning SHA.

Issue [#53](https://github.com/86cloudyun-afk/dsh-imperator/issues/53) is an intentional narrow contract extension. The old test and documentation explicitly fenced historical settled generations; this work does not describe that old documented rule as a missing accidental implementation.

## Root cause and change

At baseline, governor `#target()` checks both the supplied reservation generation and the latest task admission generation before `settle()` can inspect the durable settled row. R1 reserve -> R1 settle -> same-task R2 reserve -> identical R1 settle therefore fails with `E_GOVERNOR_FENCE`. The scheduler delegates settlement to the same path.

Only `settle()` enables a private settled-replay option. Trusted run, current/captured worker ownership and the target row's own generation are still checked. The latest-task generation check is skipped only when that specific row is already settled. Existing canonical proof comparison then returns the stored reservation or rejects a conflicting proof with `E_GOVERNOR_CONFLICT`. The successful replay path performs no reservation, hold, budget or audit mutation.

Bind, markUnknown, reserved/running/unknown first settlement and new admission retain their fences. Scheduler production code, native adapter activation, host capability boundaries, workflow gates, runtime dependencies, names, Node/DSH pins and acceptance/cleanup deadlines were not changed.

The obsolete settled-fence assertion was replaced with a settled lookup plus unchanged snapshot assertion. Existing wrong-generation assertions remain, and new tests explicitly retain old bind/markUnknown fences after R2 admission. Governor and scheduler documentation now describe the extended contract.

## Observed RED before production changes

Tests-only commit: `9b7115d9d70cd2592e795b958c27e7d2cd55bad5`, tree `3a70261ab44e3deb23cea11ff4214003c3ceb6d1`. Its actual [RED Verify run](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030568074) failed in all six jobs solely on the five new tests. The commit changed only the two existing test files; production and the obsolete settled-fence assertion were unchanged. The first completed unpacked Node22/rc.2 log established the correct failure before the production fix was committed.

Failure names in every RED job:

1. `historical settled never_started replay is read-only after a newer admission and reopening`
2. `historical settled terminal replay is read-only after a newer admission and reopening`
3. `historical settlement conflicts and scope or row-generation mistakes cannot mutate a newer reservation`
4. `historical settled replay still requires both current and captured worker ownership`
5. `scheduler historical settled replay preserves the newer admission through reopening`

The identical-proof and authorized lead replay calls threw `E_GOVERNOR_FENCE` from baseline governor line134. The conflicting-proof test produced an assertion failure because it received the fence instead of the durable proof conflict. Fixtures succeeded up to those intended calls. No additional suite failure was observed.

## Exact-SHA RED/GREEN job evidence

Counts are main node:test total / pass / fail / skip. Cancellation and todo counts were zero throughout.

| Matrix job | RED job | RED counts | GREEN job | GREEN counts |
| --- | --- | --- | --- | --- |
| checkout offline Node22.23.2 | [114150445708](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030568074/job/114150445708) | 857 / 846 / 5 / 6 | [114151116882](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030790223/job/114151116882) | 857 / 851 / 0 / 6 |
| checkout offline Node24.19.0 | [114150445776](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030568074/job/114150445776) | 857 / 846 / 5 / 6 | [114151116980](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030790223/job/114151116980) | 857 / 851 / 0 / 6 |
| unpacked Node22.23.2 DSH0.2.0-rc.2 | [114150445451](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030568074/job/114150445451) | 857 / 840 / 5 / 12 | [114151117045](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030790223/job/114151117045) | 857 / 845 / 0 / 12 |
| unpacked Node22.23.2 DSH0.2.1-alpha.2 | [114150445789](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030568074/job/114150445789) | 857 / 840 / 5 / 12 | [114151117044](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030790223/job/114151117044) | 857 / 845 / 0 / 12 |
| unpacked Node24.19.0 DSH0.2.0-rc.2 | [114150445749](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030568074/job/114150445749) | 857 / 840 / 5 / 12 | [114151116934](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030790223/job/114151116934) | 857 / 845 / 0 / 12 |
| unpacked Node24.19.0 DSH0.2.1-alpha.2 | [114150445829](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030568074/job/114150445829) | 857 / 840 / 5 / 12 | [114151116956](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030790223/job/114151116956) | 857 / 845 / 0 / 12 |

All six standard offline verifier scripts passed in every RED and GREEN job. All four unpacked jobs also passed the separate native boundary suite (40 tests, 40 pass, 0 fail, 0 skip), host integration (17 checks) and preset isolation (13 checks), in both stages. The H01/H03 helper probe recorded `native_enabled:false` and zero model requests. The complete GREEN log includes all five new tests and the replacement contract test passing in each matrix entry.

The six main-suite skips require a resolvable native installation unavailable to that offline phase. The packed main suite additionally skips six checks of checkout-only files excluded from the package; the same checks run in the checkout jobs. The separately anchored native phase runs the actual installed-package boundary/helper tests. These skips do not hide a new failure.

## Discriminating coverage

The new tests exercise both never_started and bound terminal+quiescence proofs, including canonical normalization with permuted terminal-proof property order. Each admits a new writer/retry reservation on the same resource after R1 settles, then compares the complete governor snapshot and ordered raw rows of all five governor tables before and after historical replay. The active writer, one retained resource hold, cumulative new count, retry debit and audit history remain identical. The same checks repeat after closing and reopening the store.

Conflict tests distinguish durable proof conflict from stale-generation refusal and reject wrong row generation, another run and an unrelated worker. Public submission/rejection/reassignment creates a real ownership transition: the original worker fails the current-owner check, the replacement worker fails the captured-owner check, and trusted lead replay remains read-only.

Scheduler coverage performs two queue admissions for the same task and includes ordered raw snapshots of both scheduler tables as well as all governor tables. Historical settlement and its reopened replay return the original settled view while the new reservation, queue rows, holds, counters and audit remain unchanged. Historical bind and unknown marking stay fenced.

## Owned blob manifest

| Owned path | Blob SHA |
| --- | --- |
| lib/governor/index.js | `cd950e1b8879845b4e8f4ed4ae3f16a8e526d0e8` |
| tools/tests/governor.test.mjs | `1ce16bbe7c19b121003c5ae9f2dee05bff23cc9b` |
| tools/tests/scheduler.test.mjs | `24a1617d31eaf3b2038b72e0a6c598261ff7dfb9` |
| docs/GOVERNOR.md | `3ce11b5aebeec65430c8eaa913731b22d255951b` |
| docs/SCHEDULER.md | `447812c6da4d0cf89e3ba3a8b084c671b493a17c` |

GitHub compare from planning parent to the candidate reports exactly these five files and the tests-only/fix commits. The report file's own blob and report commit SHA/tree are supplied in the final handoff, because this document cannot contain its own immutable Git hash.

## Evidence limits and handoff

The managed cloud executor failed; no local shell test, local checkout or local filesystem result is claimed. Verification above is actual remote GitHub Actions on the exact recorded candidates, including npm pack and unpacked-package acceptance. No paid-model or deployment acceptance was performed. Full-tree native activation remains closed for unresolved official-host capabilities.

No additional confirmed defect was found in this task's governor/scheduler audit paths. Parent owns independent review, component PR creation, integration, expected-head merge and final main verification. This implementer created no PR, merged nothing, spawned no reviewer/subagent and changed no other branch.
