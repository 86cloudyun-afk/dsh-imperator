# Task 2 store reporting and submission chronology

Status: implemented and verified on `codex/audit-store-consistency`. All six exact-source-head Actions jobs passed, and every decoded job log was read. This report is a separate docs-only commit; the parent owns final integration verification.

## Inputs and ownership

- Frozen production: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`, tree `352e615beb3251b60424d4aa81b6929037c51778`, package `@local/dsh-taskforce@0.4.0`.
- Requirements/docs branch base: `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`; [Task 2 brief](https://github.com/86cloudyun-afk/dsh-imperator/blob/234a7896e44b8d4e19608e3c80ef44a982ddc6ff/docs/superpowers/plans/2026-10-10-imperator-audit/task-2-brief.md#L1) and linked [approved design](https://github.com/86cloudyun-afk/dsh-imperator/blob/234a7896e44b8d4e19608e3c80ef44a982ddc6ff/docs/superpowers/specs/2026-10-10-imperator-comprehensive-audit-design.md#L1).
- Initially verified source/tests candidate: `e6f0fd022d4c929e7d77603a0bde78232c8526d3`, tree `761130801618677b562e82f6833cfff06c2060f5`.
- Verified PR #63 follow-up source/tests candidate: `de88459306d8e77de2ebb5cfdb004ab21450ed9a`, tree `3bbbb211e37e0b606d12c5fa066bb44af19392fe`; current owned-file manifest below includes its index and tests.
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

The initial repair added 26 top-level tests in four existing files; the PR #63 follow-up below adds two more. The first tests-only commit added 23, of which 21 failed and 2 passed (zero resolved blockers and healthy compact integrity shape); the next tests-only commit added three coverage-only attribution tests that already passed on unchanged production.

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
| `docs/STORE.md` | `51504ec9a66ab71f4b13120fb1ed4c99b7cdf2c1` |
| `lib/store/board-page.js` | `01bfe493621c00d015515bc71831b687dea6a160` |
| `lib/store/index.js` | `e966cf8c3795f8497084f098e48e7002cc05f1a8` |
| `tools/tests/board-pagination.test.mjs` | `a2c93c0c118aebfcc9108ea7c1e6efbfcf60de96` |
| `tools/tests/owner-session.test.mjs` | `d2c23bfee04e48ad2f36ea772f65fa98c872b08c` |
| `tools/tests/sqlite.test.mjs` | `c4c33442237f7394c82da04e607258fb5463e58e` |
| `tools/tests/store-evidence.test.mjs` | `ac9c1ea1b807e97e4025f2e02d48d982d70e0e08` |
| `tools/tests/store-scope-integrity.test.mjs` | `ffef89aa7ce6aeac69976770b7c03bda9f990ff1` |
| `tools/tests/submit-audit-attribution.test.mjs` | `ca46d49217fd530c4e98a81c2a5e6ae978bb1ade` |
| `tools/tests/submit-status-code.test.mjs` | `8355747e3e53885c31aa15a189658f931e97954a` |
| `tools/verify-store.mjs` | `94bb3d6182001c28c8e303778f739b2e8bd5d5fa` |

## Rulings, dependencies and limits

- The parent explicitly allowed the above four fixture files/hunks and delegated PR #41 coverage. No workflow YAML, runner, ops implementation, tools implementation, workflow module or execution module was edited.
- Task 4 must include nullable TEXT task.submitted_at in its full supported schema gate. Its store dependency is index blob `e966cf8c3795f8497084f098e48e7002cc05f1a8`; it includes the final task-key control index. The two exact schema/diagnostic fixture updates are listed in the manifest. Parent controls dependency import/integration.
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

