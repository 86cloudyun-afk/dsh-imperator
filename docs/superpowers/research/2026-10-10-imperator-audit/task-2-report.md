# Task 2 store reporting and submission chronology

Status: implemented and verified on `codex/audit-store-consistency`. All six exact-source-head Actions jobs passed, and every decoded job log was read. This report is a separate docs-only commit; the parent owns final integration verification.

## Inputs and ownership

- Frozen production: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`, tree `352e615beb3251b60424d4aa81b6929037c51778`, package `@local/dsh-taskforce@0.4.0`.
- Requirements/docs branch base: `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`; [Task 2 brief](https://github.com/86cloudyun-afk/dsh-imperator/blob/234a7896e44b8d4e19608e3c80ef44a982ddc6ff/docs/superpowers/plans/2026-10-10-imperator-audit/task-2-brief.md#L1) and linked [approved design](https://github.com/86cloudyun-afk/dsh-imperator/blob/234a7896e44b8d4e19608e3c80ef44a982ddc6ff/docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md#L1).
- Initially verified source/tests candidate: `e6f0fd022d4c929e7d77603a0bde78232c8526d3`, tree `761130801618677b562e82f6833cfff06c2060f5`.
- Verified PR #63 control access follow-up source/tests candidate: `de88459306d8e77de2ebb5cfdb004ab21450ed9a`, tree `3bbbb211e37e0b606d12c5fa066bb44af19392fe`.
- Verified PR #63 sparse audit count follow-up source/tests candidate: `bb2ee34e5e28ec5cd350d0a8834f21cedc2fe06f`, tree `6c60ce2ff3063c7103c27e797866254626827e76`; the current owned-file manifest includes both access-path corrections.
- No local shell or executor was available: the selected cloud environment failed to initialize. Reproduction and verification below ran in actual GitHub Actions, using unchanged repository workflow gates. Remote commits/ref updates used the isolated branch and expected-SHA leases.
- Systematic debugging and test-first workflow were used. Parent owns independent review, integration, PRs and merging. This task created no PR, changed no main/other branch, and spawned no agents/reviewers.

The brief's seven source/test/doc files were retained. Parent explicitly added only these existing fixture changes: `submit-status-code.test.mjs` fixes the timestamp fixture; `owner-session.test.mjs` adds `submitted_at:null` to its historical-row expected object; `sqlite.test.mjs` expands exact migration expected values; `verify-store.mjs` expands S04's exact column list. Parent also delegated three PR #41 attribution coverage cases into the already owned attribution test. All previous fields and strong assertions remain.

## Confirmed causes and corrections

Open issue status was treated as a lead, not proof. The tests-only commits executed against the original production blobs and produced the discriminating failures below.

| Scope | Baseline cause and trigger | Minimal correction and contract |
| --- | --- | --- |
| #57: boot/migration diagnostics | [Migration](https://github.com/86cloudyun-afk/dsh-imperator/blob/81b7ce67114f96ebcd05b257571ce8a6bc9e68c7/lib/store/index.js#L639) and [boot](https://github.com/86cloudyun-afk/dsh-imperator/blob/81b7ce67114f96ebcd05b257571ce8a6bc9e68c7/lib/store/index.js#L2004) counted only task/fact/handoff. A scoped submitted task with only NULL-run receipt/waiver rows therefore had no boot warning; adoption correctly left these rows quarantined. | [Shared five-table query](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/lib/store/index.js#L349) supplies migration, summary and boot counts from one SELECT snapshot. Warn for these audits and explain manual attribution; adoption rules and its compatibility result keys remain unchanged. Detached recovery controls are not counted as orphaned tasks. |
| #48: accepted resolved_blockers | [Return field](https://github.com/86cloudyun-afk/dsh-imperator/blob/81b7ce67114f96ebcd05b257571ce8a6bc9e68c7/lib/store/index.js#L1513) was hardcoded to zero. Acceptance with 1 or 2 resolved blockers returned zero even with valid decisions; duplicate resolver facts must not inflate the number. | [COUNT DISTINCT](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/lib/store/index.js#L1486) counts scoped blockers with an EXISTS valid resolver inside the existing acceptance transaction. The same evidence/resolution predicate remains in force; REFUTED historical decisions do not resolve or bypass acceptance. |
| #46: submitted_at chronology | [Idempotent return](https://github.com/86cloudyun-afk/dsh-imperator/blob/81b7ce67114f96ebcd05b257571ce8a6bc9e68c7/lib/store/index.js#L1340) used updated_at. Submit at T0, append fact or decision at T1, then submit or close(done/partial) returned T1. There was no persistent true submission field. | [Nullable TEXT migration](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/lib/store/index.js#L327) and [transition stamp](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/lib/store/index.js#L1007) persist the most recent real submission. Ordinary activity updates only updated_at; idempotent retries return the stored time without writing. Reject/claim/terminal transitions preserve it; fresh resubmission replaces it. Old unknown times remain NULL, never guessed from updated_at or audit prose. taskOf/detail projections expose the field. |
| #43: all-runs blocker counts | [Global stats](https://github.com/86cloudyun-afk/dsh-imperator/blob/81b7ce67114f96ebcd05b257571ce8a6bc9e68c7/lib/store/index.js#L1946) omitted blockers_late, repeated a literal pending list, and performed multiple independent reads. Three domains, including NULL, exposed missing late totals; a real second WAL connection inserted between query boundaries and split the totals. | [Shared blockerCounts](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/lib/store/index.js#L361) uses PENDING_STATUSES, same-parent same-run joins and the existing valid resolver predicate. [statsAllRuns](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/lib/store/index.js#L1956) uses the existing deferred read transaction. Global fact count remains the raw all-row count, as contracted. |
| Recovery integrity totals | [board-page integrity](https://github.com/86cloudyun-afk/dsh-imperator/blob/81b7ce67114f96ebcd05b257571ce8a6bc9e68c7/lib/store/board-page.js#L94) counted fact/handoff/execution audits but omitted task_event/task_checkpoint/control_operation. Detail and acceptance already detected these anomalies while compact totals hid them. | [Counts](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/lib/store/board-page.js#L95) add attached foreign/NULL recovery rows using `child.run_id IS NOT parent.run_id`, scoped by the parent task. Only positive new anomaly keys appear; the healthy legacy shape remains exact. Foreign content stays hidden; waiver cannot bypass acceptance integrity. |
| #45: misleading terminal wording | The current-state collection correctly contained an unresolved blocker created before cancellation, but detail prose called it a blocker recorded “收口之后”. | [Prose](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/lib/store/index.js#L1845) and STORE docs say all current terminal unresolved blockers, including preclosure leftovers. No blocker is hidden and no time-based predicate is introduced. recordFact.late still describes status at insertion. |
| #42: legacy evidence semantics | Approved decision keeps the present legacy evidence contract. | No evidence.js or legacy evidence predicate change; accepted-review and non-artifact pointer behavior retain the baseline contract. |

Submission timestamp fixtures retain zero-write, fact preservation, unchanged owner/identity and activity-time assertions. The historical migration fixture explicitly expects a new nullable field while preserving every old value. The new real-old-schema chronology test independently asserts physical TEXT/nullability and unknown historical time.

## Discriminating tests

The initial repair added 26 top-level tests in four existing files; the PR #63 control follow-up adds two, and the sparse-audit follow-up adds one, for 29 additions. The first tests-only commit added 23, of which 21 failed and 2 passed (zero resolved blockers and healthy compact integrity shape); the next tests-only commit added three coverage-only attribution tests that already passed on unchanged production.

- [Chronology](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/tools/tests/submit-audit-attribution.test.mjs#L109): mocked fixed T0/T1/T2, later fact and resolver decision, all submit aliases, exact task/fact row snapshot across idempotent retries, reject/claim/resubmit, projections, and a genuinely pre-migration task table with an unknown submission time.
- [Blockers/statistics](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/tools/tests/store-evidence.test.mjs#L123): 0/1/2 distinct blockers, duplicate valid resolvers, REFUTED historical decision, preclosure terminal leftovers, all four pending states across run-a/run-b/NULL, and foreign-parent rows excluded from blockers while raw global facts remain counted.
- [Diagnostics/integrity](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/tools/tests/store-scope-integrity.test.mjs#L101): receipt/waiver-only NULL rows, actual apply() boot warning, adoption quarantine, and all three recovery tables across (scoped, foreign)/(scoped, NULL)/(NULL, foreign). Each case checks detail/totals, hidden foreign text and atomic acceptance refusal even with a waiver; healthy output is asserted exactly.
- [WAL snapshot](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/tools/tests/board-pagination.test.mjs#L481): actual WAL second connection commits a new task plus blocker after the initial global query. First read remains on the old snapshot; the next read sees both new rows and no leaked transaction.
- [Delegated PR #41 coverage](https://github.com/86cloudyun-afk/dsh-imperator/blob/e6f0fd022d4c929e7d77603a0bde78232c8526d3/tools/tests/submit-audit-attribution.test.mjs#L169): non-owner with a note on an unbound legacy task; done/partial owner/non-owner/root signatures and actor_session; undefined/empty/whitespace notes with no audit row.

Existing mutable pagination tests also passed, including reopened prior terminal tasks, blockers entering/leaving the alarm set, new resolvers above the first-page ceiling, NULL cohorts, pending-internal transitions, token/run/filter binding, current full-run totals, separate cursors and shared page snapshots. No pagination contract change was needed.

## Actual RED evidence

Every decoded log for both six-job RED runs was read. All six jobs in each run had exactly the same 21 assertion failures, no unexpected failures, and no fixture/import error. All six script validators passed. Packed native gates and their separate 40-test boundary run passed.

Initial tests-only head `dd1ab30c87092227470b7eea67843ba3ba047556`, tree `bc4d54d402ff0afb8474a9eb8b7d7963e9b701b4`: [run 38030613477](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030613477).

| Job/log | Job ID | tests/pass/fail/skipped/cancelled |
| --- | --- | --- |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030613477/job/114150579571) | 114150579571 | 875/848/21/6/0 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030613477/job/114150579737) | 114150579737 | 875/848/21/6/0 |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030613477/job/114150579692) | 114150579692 | 875/842/21/12/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030613477/job/114150579721) | 114150579721 | 875/842/21/12/0 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030613477/job/114150579787) | 114150579787 | 875/842/21/12/0 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030613477/job/114150579868) | 114150579868 | 875/842/21/12/0 |

Coverage-only tests head `bf0b13afca826fc4d58de84baab381f66a40bb0f`, tree `71dcb4ac5598089da77700e25cec14b8bec29ae7`: [run 38030851937](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030851937).

| Job/log | Job ID | tests/pass/fail/skipped/cancelled |
| --- | --- | --- |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030851937/job/114151307206) | 114151307206 | 878/851/21/6/0 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030851937/job/114151307285) | 114151307285 | 878/845/21/12/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030851937/job/114151307288) | 114151307288 | 878/845/21/12/0 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030851937/job/114151307313) | 114151307313 | 878/845/21/12/0 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030851937/job/114151307322) | 114151307322 | 878/851/21/6/0 |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030851937/job/114151307366) | 114151307366 | 878/845/21/12/0 |

The three attribution coverage additions passed in every second-RED job. Both RED commits retained production index blob `dc492e855c6a732deda1f800d65327e34b86d98e` and board-page blob `73eced7dffe667a5d3a39152c02fc8551ad6bad5`.

All failing test names (identical in both RED runs):

- all-runs statistics share one snapshot across a concurrent WAL insert
- acceptance reports 1 distinct resolved blockers
- acceptance reports 2 distinct resolved blockers
- REFUTED historical decisions do not count as resolved blockers or permit acceptance
- terminal unresolved blockers remain visible even when recorded before cancellation
- all-runs blocker statistics include every pending state, terminal and NULL scope
- migration diagnostics include only-NULL execution audit and preserve quarantine
- boot warns when only quarantined NULL execution receipts and waivers exist
- board integrity totals report task_event corruption scope-a/scope-b
- board integrity totals report task_event corruption scope-a/null
- board integrity totals report task_event corruption null/scope-b
- board integrity totals report task_checkpoint corruption scope-a/scope-b
- board integrity totals report task_checkpoint corruption scope-a/null
- board integrity totals report task_checkpoint corruption null/scope-b
- board integrity totals report control_operation corruption scope-a/scope-b
- board integrity totals report control_operation corruption scope-a/null
- board integrity totals report control_operation corruption null/scope-b
- submission time survives a later fact and submit aliases
- submission time survives a later decision and submit aliases
- a fresh submission after reject and claim persists its new time
- old-schema submitted rows migrate with an unknown nullable submission time

## Observed candidate fixture failures

First production correction `8834bdb7dae458936f93e120a022b4838cd317c6`, tree `2c993b5dd1ea93bfcb5d733f7fc358b80982f2a8`, [run 38031110073](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031110073): all six logs read; every new regression/coverage case passed. Offline jobs: 878/870/2/6/0. Packed jobs: 878/864/2/12/0 plus boundaries 40/40/0/0/0.

The only failing test names were:
- `verify-store keeps a complete report tail when stdout is a pipe`: indirect failure from verify-store S04 expecting the old 14-column task schema.
- `failed migration rolls back schema and same store retries cleanly`: exact constructor diagnostics expected only three count keys; its subsequent additive-column list also needed the real new column.

Parent authorized the exact fixture updates after these real logs. No assertion was removed or loosened; exit-propagation and all rollback behavior stayed intact. Compared trees `2c993b5dd1ea93bfcb5d733f7fc358b80982f2a8` and `761130801618677b562e82f6833cfff06c2060f5` differ only at sqlite.test.mjs and verify-store.mjs. Every other source/test/doc blob, including index and board-page, is identical.

A remote tree-construction mistake briefly produced an incomplete isolated candidate `f0a5dc37eb2c0b6a258e2e5be10785b3ab0624f5`. It was detected by full compare before any evidence claim and replaced using a lease. It is outside the final branch history and supplies no verification evidence. The corrected full tree has 167 blobs, no deleted baseline files and exactly 11 owned-file changes relative to the requirements base.

## Initial repair GREEN evidence

Exact source/tests head `e6f0fd022d4c929e7d77603a0bde78232c8526d3`, tree `761130801618677b562e82f6833cfff06c2060f5`: [run 38031521153](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031521153) completed **success**. All six job logs were fetched in full and read; every newly added test and every retained fixture assertion passed. There were no failing test names or cancelled tests.

| Job/log | Job ID | tests/pass/fail/skipped/cancelled | Conclusion |
| --- | --- | --- | --- |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031521153/job/114153278171) | 114153278171 | 878/866/0/12/0 | success |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031521153/job/114153278157) | 114153278157 | 878/866/0/12/0 | success |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031521153/job/114153278173) | 114153278173 | 878/866/0/12/0 | success |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031521153/job/114153278103) | 114153278103 | 878/866/0/12/0 | success |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031521153/job/114153278104) | 114153278104 | 878/872/0/6/0 | success |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031521153/job/114153277967) | 114153277967 | 878/872/0/6/0 | success |

Each of the four packed jobs also ran a separate native boundary set: **40/40/0/0/0**. The six script validators and node:test passed in all jobs. In every packed job, preset contract/native boundaries/host integration/preset isolation passed. Offline host integration remains explicitly UNVERIFIED; it is not counted as a pass.

The six main-test native prerequisites intentionally skipped in checkout and packed runs were:

- dsh-scope 必须导出 scopeOf / scopeChainOf（scope-membership 的硬依赖）
- dsh-subagent 的 childSessionMeta 必须产出 origin/delegationDepth/parentSession 语义锚点
- dsh-tools 必须导出可用的 defineTool（工具注册行的硬依赖）
- real native resolution rejects missing Config fields, bad structure and missing modules
- native failed or hung cleanup exits nonzero and deletes its disposable home
- pinned official H01 preparation and H03 strict flush raw readback; no model requests

They require an installed native anchor; the packed jobs execute the separate pinned native stages. Packed runs additionally skip these six repository-only contracts because .github/.gitignore are intentionally excluded from the tarball; the checkout jobs validate them:

- engines.node is exactly the CI-tested node release train
- .gitignore top-level directory patterns stay covered by SKIP_DIRS
- native workflow never hardcodes the packed deliverable filename
- native workflow resolves the packed filename from pack.json and fails closed
- tar unpack and checksum reuse the single resolved filename
- every pinned action carries a 40-hex SHA and its version comment

Recorded native harness outputs include `modelRequests:0`, `paidRequests:0`, scheduler `native_enabled:false` and `ISOLATION_VERIFIED: 13 checks; no model requests`. This is pinned host/mock evidence, not live paid-provider validation.


## Updated candidate owned-file manifest

These are exact candidate blobs, before the separate report-only commit. The report's own blob/head/tree will be returned separately to the parent so the report does not claim to verify its own future commit.

| File | Blob SHA |
| --- | --- |
| `docs/STORE.md` | `b2c4f9c581eb8e4d99e7adca46197c16844fc2ab` |
| `lib/store/board-page.js` | `01bfe493621c00d015515bc71831b687dea6a160` |
| `lib/store/index.js` | `bedfa667fea8beab2642eb68435fc2d9566920c5` |
| `tools/tests/board-pagination.test.mjs` | `a2c93c0c118aebfcc9108ea7c1e6efbfcf60de96` |
| `tools/tests/owner-session.test.mjs` | `d2c23bfee04e48ad2f36ea772f65fa98c872b08c` |
| `tools/tests/sqlite.test.mjs` | `c4c33442237f7394c82da04e607258fb5463e58e` |
| `tools/tests/store-evidence.test.mjs` | `ac9c1ea1b807e97e4025f2e02d48d982d70e0e08` |
| `tools/tests/store-scope-integrity.test.mjs` | `371632faab8422905ff9f1041656eb1fdb6e555e` |
| `tools/tests/submit-audit-attribution.test.mjs` | `ca46d49217fd530c4e98a81c2a5e6ae978bb1ade` |
| `tools/tests/submit-status-code.test.mjs` | `8355747e3e53885c31aa15a189658f931e97954a` |
| `tools/verify-store.mjs` | `94bb3d6182001c28c8e303778f739b2e8bd5d5fa` |

## Rulings, dependencies and limits

- The parent explicitly allowed the above four fixture files/hunks and delegated PR #41 coverage. No workflow YAML, runner, ops implementation, tools implementation, workflow module or execution module was edited.
- Task 4 must include nullable TEXT task.submitted_at in its full supported schema gate. Its latest store dependency is index blob `bedfa667fea8beab2642eb68435fc2d9566920c5`; it retains the task-key control index and adds the two sparse NULL audit indexes, without additional columns. The two exact schema/diagnostic fixture updates are listed in the manifest. Parent controls dependency import/integration.
- No data backfill, global recovery adoption expansion, new timestamp inference or accepted evidence predicate change was introduced. Old recovery adoption result keys are preserved by the RECOVERY contract.
- The initial candidate had no dedicated control-integrity scale evidence. PR #63 supplied a concrete review concern; the follow-up below reproduces it with real query plans at 280 tasks/8,120 operations and adds one supported access path. No wall-clock threshold or general latency claim is used.
- The workflow's offline path reports host integration UNVERIFIED by design; packed native gates establish the pinned rc.2/alpha.2 boundary behavior. No real paid provider readiness claim is made. Recorded native harness calls report zero model/paid requests, and the full-tree native adapter remains closed.
- Per the parent's final instruction, this report-only commit will not be treated as a separate verified code candidate. Parent will review the base-to-report diff and perform exact-head final integration/PR/main verification.


## PR #63 review follow-up: control integrity access path

The actual [review thread](https://github.com/86cloudyun-afk/dsh-imperator/pull/63#discussion_r4236774781) targets board-page.js:103 at reviewed commit `00de863ce466ee20a15f4496d230ce2426b13d8d`. Its index/board/test blobs matched the initial Task 2 candidate. The concern is reachable: tasks/summary always calculate full-run `scope_integrity_totals` even with page limit 1, and the legacy board/detail `#scopeIntegrity` uses the same correlated control predicate. Control indexes began with run_id/caller_session; task events and checkpoints already had task-first indexes.

[New scale regression](https://github.com/86cloudyun-afk/dsh-imperator/blob/6516de7732f37615a77db8f7ba2931d07059ae0d/tools/tests/board-pagination.test.mjs#L525) loads **280 tasks and 8,120 control records**. It executes five actual compact totals queries and two legacy full-run queries, captures their real SQLite EXPLAIN QUERY PLAN, and requires a task_id-bound SEARCH rather than SCAN o. It also checks exact global counts despite one-row pages, scoped/NULL foreign rows, hidden foreign text, and healthy output in the presence of detached operations. No rewritten substitute query or timer threshold stands in for the production access path.

[New migration regression](https://github.com/86cloudyun-afk/dsh-imperator/blob/6516de7732f37615a77db8f7ba2931d07059ae0d/tools/tests/store-scope-integrity.test.mjs#L171) removes task-first control indexes to create a supported old journal, verifies the old SCAN path, closes it and reopens through the real store migration. It compares exact serialized row bytes in six tables, all PRAGMA column metadata, and `added_columns:[]`, before requiring the restored task-key lookup.

### Follow-up RED

Tests-only head `6516de7732f37615a77db8f7ba2931d07059ae0d`, tree `e09a4a92469113a013a763ec38ae099b457b9ba4`: [run 38033102913](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033102913). Every one of the six decoded logs was read. Exactly two expected assertion failures occurred in each job; no unrelated/platform/fixture/import failure was found. All six script validators passed; packed native gates and the separate 40-test boundary run passed.

| Job/log | Job ID | tests/pass/fail/skipped/cancelled |
| --- | --- | --- |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033102913/job/114157932248) | 114157932248 | 880/866/2/12/0 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033102913/job/114157932232) | 114157932232 | 880/866/2/12/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033102913/job/114157932235) | 114157932235 | 880/866/2/12/0 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033102913/job/114157932220) | 114157932220 | 880/866/2/12/0 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033102913/job/114157932277) | 114157932277 | 880/872/2/6/0 |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033102913/job/114157932158) | 114157932158 | 880/872/2/6/0 |

The test-only tree preserves index blob `318ddac27f33ad3290f76e3afaf0e6353e2c0876` and board-page blob `01bfe493621c00d015515bc71831b687dea6a160`; all production paths are unchanged. Each scale diagnostic reported seven `SCAN o` plans; each reopen diagnostic reported `before:SCAN o, after:SCAN o`.


The only new failures are:
- `control integrity uses task-key searches on a large journal for paged and legacy boards`
- `reopening a legacy control journal preserves every row and column while restoring task lookup`

All observed failures were ERR_ASSERTION: every control access was `SCAN o`; the migration's before/after path was `SCAN o`/`SCAN o`. The value/isolation/healthy-shape/row/column/added_columns assertions had already passed before the plan assertion failed.

Production was committed after three packed-job logs had confirmed these genuine RED assertions; remaining logs were read afterward. The parent explicitly accepted this actual ordering and required all six RED logs to be read before final delivery. No commit timestamp or failure history was rewritten.

### Minimal correction and doctor contract

Candidate `de88459306d8e77de2ebb5cfdb004ab21450ed9a`, tree `3bbbb211e37e0b606d12c5fa066bb44af19392fe`, adds only one production access path: after RECOVERY_DDL creates the recovery tables, the existing write transaction executes `CREATE INDEX IF NOT EXISTS idx_control_task ON control_operation(task_id,run_id)`. No query/evidence predicate, table column, trigger, row, adoption rule or output shape changes. The covering index supports both existing compact and legacy queries. STORE documents this migration.

The parent explicitly decided that missing this performance index is not a data-readability schema failure. The actual doctor declaration parses WORKFLOW_DDL/RECOVERY_DDL plus the existing required blocker index; this new store-owned performance index does not expand REQUIRED_ADDITIVE_SCHEMA. No operations file was edited. Preflight actually runs TaskforceStore migration on its isolated copy; its before/after schemaHash records the added index while retained-row checks stay unchanged. Task 4's nullable submitted_at column requirement remains intact.

Full-tree checks before each ref update confirmed 168 blobs with no removal: the RED commit changes only the two authorized test files; RED-to-fix changes only store/index.js and STORE.md. All remaining blobs are preserved. The final report commit will update only this report; main and the clean PR branch were not changed.

### Follow-up GREEN

Exact follow-up source/tests head `de88459306d8e77de2ebb5cfdb004ab21450ed9a`, tree `3bbbb211e37e0b606d12c5fa066bb44af19392fe`: [run 38033267129](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267129) completed **success**. All six decoded job logs were read in full. There were no failing test names, cancellations or additional regressions.

| Job/log | Job ID | tests/pass/fail/skipped/cancelled | Conclusion |
| --- | --- | --- | --- |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267129/job/114158402383) | 114158402383 | 880/868/0/12/0 | success |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267129/job/114158402697) | 114158402697 | 880/868/0/12/0 | success |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267129/job/114158402500) | 114158402500 | 880/868/0/12/0 | success |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267129/job/114158402497) | 114158402497 | 880/868/0/12/0 | success |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267129/job/114158402584) | 114158402584 | 880/874/0/6/0 | success |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267129/job/114158402478) | 114158402478 | 880/874/0/6/0 | success |

In every job, all seven actual scale query plans became `SEARCH o USING COVERING INDEX idx_control_task (task_id=?)`. The old-journal migration diagnostic became `before:SCAN o, after:SEARCH o USING COVERING INDEX idx_control_task (task_id=?)`. Exact serialized rows, column metadata, `added_columns:[]`, isolation counts and healthy shapes passed. The two new tests make the main total 880 rather than the original candidate's 878.

Each packed job also passed the separate 40/40/0/0/0 native boundary set and preset contract/host integration/preset isolation. The six script validators and main node:test passed in all six jobs. The same intentional six native-prerequisite skips and six additional packed-only repository-contract skips listed above remain; offline host integration is still UNVERIFIED by design.



## PR #63 review follow-up: sparse unassigned audit counts

The actual [review thread](https://github.com/86cloudyun-afk/dsh-imperator/pull/63#discussion_r4236848264) targets the shared counter at index.js:351 in reviewed commit `8976957aeae15cc8d434d2ca2e3368cdec69f68b`. The review was investigated rather than treating a SCAN plan alone as a failure. Both execution tables had task-first indexes, while actual migration/open, boot, global statistics and unassigned summary share a single five-table SELECT whose audit predicates are literal `WHERE run_id IS NULL`. Thus every open read all assigned audit history even when the NULL audit count was zero.

### Actual diagnosis before the plan assertion

Diagnostic-only head `10b3451861e8c2828bd91816d95d4a942fe23b13`, tree `47350781cb049f5e8a53551c6ac4287e5d8ca3e6`: [run 38034874104](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104). All six decoded job logs were read. Production remained exactly the previous control-index candidate. One new real-SQL scale case first checked 1,000 assigned rows per audit table with no NULL audits, then 100,000 assigned rows per table with no NULL audits, then 3 NULL rows per table. The NULL rows include an assigned parent, an unassigned parent and a nonexistent parent; malformed historical receipt JSON is deliberately preserved.

Every one of the eight instrumented production counter executions in each job reported:

```
SCAN execution_receipt USING COVERING INDEX idx_execution_task_run
SCAN execution_waiver USING COVERING INDEX idx_execution_waiver_task_run
```

The first two timing columns below measure only the actual prepared statement's get(), excluding EXPLAIN. The remaining columns measure the instrumented complete operation, including diagnostic overhead. These are absolute observations from one run, not thresholds, controlled benchmarks or arbitrary latency promises. The 136.871/144.716 ms observations show runner noise and are not used as a pass/fail criterion.

| Job/log | 1k healthy count ms | 100k healthy count ms | migrate 100k ms | reopen 100k ms | apply boot 100k ms | adopt 100k ms |
| --- | --- | --- | --- | --- | --- | --- |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114784) | 0.242 | 7.263 | 9.674 | 136.871 | 144.716 | 98.413 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114760) | 0.137 | 11.762 | 10.348 | 10.862 | 11.080 | 10.471 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114829) | 0.094 | 11.037 | 9.709 | 10.388 | 10.186 | 9.744 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114843) | 0.102 | 5.980 | 15.362 | 9.707 | 9.080 | 9.037 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114813) | 0.120 | 11.824 | 12.093 | 10.846 | 10.991 | 10.724 |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114640) | 0.094 | 4.735 | 6.428 | 7.937 | 7.318 | 6.932 |

Increasing assigned history 100-fold increased the empty-NULL count from 0.094–0.242 ms to 4.735–11.824 ms across these actual jobs. The task/fact/handoff subqueries already used run-key searches. A selective NULL audit lookup is feasible: the new indexes need only zero or three audit entries per table here rather than all 100,000 assigned entries. Avoidable startup growth, its actual repeated call path and this sparse access alternative justified a minimal correction.

Diagnostic-only job results, with all existing script gates and packed native gates passing:

| Job/log | Job ID | tests/pass/fail/skipped/cancelled |
| --- | --- | --- |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114784) | 114163114784 | 881/869/0/12/0 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114760) | 114163114760 | 881/869/0/12/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114829) | 114163114829 | 881/869/0/12/0 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114843) | 114163114843 | 881/869/0/12/0 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114813) | 114163114813 | 881/875/0/6/0 |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38034874104/job/114163114640) | 114163114640 | 881/875/0/6/0 |

### Selective-count RED

The tests-only assertion head `e9be7d2bf7b1d084c92f98318fc9d5cfd0ae1ab4`, tree `0981a638dd2733b230ec1d3ac32029e0b88bcd09`: [run 38035331240](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035331240). All six decoded logs were read. Each had exactly one new ERR_ASSERTION failure:

- `unassigned audit diagnostics use selective run-key searches with 100k assigned rows`

The [scale regression](https://github.com/86cloudyun-afk/dsh-imperator/blob/bb2ee34e5e28ec5cd350d0a8834f21cedc2fe06f/tools/tests/store-scope-integrity.test.mjs#L209) captures EXPLAIN for the actual shared SQL prepared by production calls and requires each audit table to have a run_id-bound SEARCH. It does not force an index name, substitute a rewritten query, use INDEXED BY, or impose a wall-clock threshold. All value checks run before the final plan assertion: the fixture checks five-table migration diagnostics, SHA256 over the exact JSON serialization of every one of 200,006 audit rows, complete PRAGMA column metadata, `added_columns:[]`, actual open/apply boot warnings, adoption of only the original NULL-parent audits, retained scoped/orphan quarantine, preserved malformed JSON, acceptance refusal and the existing control index. Before migrating the populated journal it removes any partial run-key audit indexes, so GREEN must exercise real additive index creation on historical rows rather than only a fresh database.

| Job/log | Job ID | tests/pass/fail/skipped/cancelled |
| --- | --- | --- |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035331240/job/114164464703) | 114164464703 | 881/868/1/12/0 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035331240/job/114164464528) | 114164464528 | 881/868/1/12/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035331240/job/114164464495) | 114164464495 | 881/868/1/12/0 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035331240/job/114164464538) | 114164464538 | 881/868/1/12/0 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035331240/job/114164464368) | 114164464368 | 881/874/1/6/0 |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035331240/job/114164464525) | 114164464525 | 881/874/1/6/0 |

All six script validators passed. Packed jobs additionally passed the separate 40/40/0/0/0 boundary set and preset contract/host integration/preset isolation. No fixture/import/platform failure appeared. The RED tree changes only the authorized scope-integrity test and retains index blob `e966cf8c3795f8497084f098e48e7002cc05f1a8`. Four native RED logs established the genuine assertion failure before production was committed; the two offline RED logs were read afterward. This is the actual sequence, with no rerun, amended history or backdated commit.

### Minimal correction and schema compatibility

Candidate `bb2ee34e5e28ec5cd350d0a8834f21cedc2fe06f`, tree `6c60ce2ff3063c7103c27e797866254626827e76`, adds [two CREATE INDEX IF NOT EXISTS statements](https://github.com/86cloudyun-afk/dsh-imperator/blob/bb2ee34e5e28ec5cd350d0a8834f21cedc2fe06f/lib/store/index.js#L665) after the table DDL in the existing core migration write transaction:

```
CREATE INDEX IF NOT EXISTS idx_execution_receipt_unassigned
  ON execution_receipt(run_id) WHERE run_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_execution_waiver_unassigned
  ON execution_waiver(run_id) WHERE run_id IS NULL;
```

They cover the count and contain only the NULL run range. First migration must inspect the existing tables to build indexes; subsequent opens reuse them. The preceding idx_control_task remains unchanged. No column, row, query predicate, five-table diagnostic key, adoption policy, evidence rule or output shape changes. RED-to-production full-tree comparison confirmed exactly index.js and STORE.md changed, with all other 166 blobs retained. Compared with the previous report head, only these two files and the scope-integrity test changed.

The parent explicitly confirmed these performance indexes do not belong to the doctor data-readability requirement. Store migration adds them to an isolated preflight copy and schemaHash records them; doctor can still read a supported old journal that lacks performance indexes. No operations declaration was expanded. The separate submitted_at doctor review thread is owned and fixed by Task 4 in the parent's later integration, and is not duplicated here.

### Selective-count GREEN

Exact source/tests head `bb2ee34e5e28ec5cd350d0a8834f21cedc2fe06f`, tree `6c60ce2ff3063c7103c27e797866254626827e76`: [run 38035489681](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681) completed success. All six decoded logs were read in full. Every value/row/column/boot/adoption/quarantine assertion and retained control scale/migration regression passed. The main total is 881; no test failed or was cancelled.

| Job/log | Job ID | tests/pass/fail/skipped/cancelled | Conclusion |
| --- | --- | --- | --- |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164933032) | 114164933032 | 881/869/0/12/0 | success |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164932986) | 114164932986 | 881/869/0/12/0 | success |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164933040) | 114164933040 | 881/869/0/12/0 | success |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164932899) | 114164932899 | 881/869/0/12/0 | success |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164932993) | 114164932993 | 881/875/0/6/0 | success |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164933005) | 114164933005 | 881/875/0/6/0 | success |

Each job captured eight real shared-counter executions; both audit subqueries used:

```
SEARCH execution_receipt USING COVERING INDEX idx_execution_receipt_unassigned (run_id=?)
SEARCH execution_waiver USING COVERING INDEX idx_execution_waiver_unassigned (run_id=?)
```

The same absolute-measurement convention applies to GREEN: query-only first two columns, complete instrumented operations afterward. The populated old-journal migrate stage deliberately rebuilds the dropped partial indexes. Its 11.500–17.079 ms first-build cost remains; the unchanged 100k healthy counter now takes 0.037–0.052 ms and indexed reopen takes 1.947–2.698 ms in these jobs. These separate runner observations are consistent with the access-path change and establish no arbitrary latency bound. Work still scales with the number of actual NULL audit rows.

| Job/log | 1k healthy count ms | 100k healthy count ms | migrate 100k ms | reopen 100k ms | apply boot 100k ms | adopt 100k ms |
| --- | --- | --- | --- | --- | --- | --- |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164933032) | 0.036 | 0.052 | 17.079 | 2.372 | 2.853 | 2.951 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164932986) | 0.046 | 0.045 | 13.603 | 2.440 | 2.714 | 2.872 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164933040) | 0.318 | 0.037 | 11.500 | 1.947 | 1.998 | 2.284 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164932899) | 0.041 | 0.048 | 15.069 | 2.698 | 2.501 | 3.663 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164932993) | 0.038 | 0.047 | 13.844 | 2.630 | 2.655 | 2.641 |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035489681/job/114164933005) | 0.032 | 0.046 | 11.888 | 2.133 | 1.832 | 2.179 |

All six script validators and node:test passed. Each packed job also passed boundaries 40/40/0/0/0 and preset contract/host integration/preset isolation. The same intentional skips listed earlier remain: six native prerequisites in checkout, plus six repository-only contracts in tarball runs. Offline host integration remains explicitly UNVERIFIED.

Full recursive trees were checked with valid 40-character base_tree_sha values before every commit/ref update. The requirements tree contains 167 blobs; the candidate contains 168, with no removed baseline blob. Exactly the 11 owned source/test/doc files plus this report differ from the requirements base; 156 existing blobs remain byte-identical. This final docs-only update changes only this report relative to the exact verified source/tests head. The report blob/head/tree is returned separately; its commit is not a new code-verification claim. Parent still owns independent review and final aggregate/PR/main checks.
