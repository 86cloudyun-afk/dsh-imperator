# Task 4: execution root identity and complete operations schema

Status: implementation candidate verified by all six jobs; ready for parent independent review and shared-hunk integration.

## Frozen identities and scope

- Production baseline: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`, tree `352e615beb3251b60424d4aa81b6929037c51778`, version 0.4.0.
- Planning base: `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`.
- Isolated branch: `codex/audit-operations-execution`; no main, other branch, PR or merge operation.
- Corrected tests-only RED head: `b35fec9d06e18cbb1b42f1fba693a08546fc038d`, tree `557332555a2ddf53609d32fc705ab5d5e710768e`; Task4 production unchanged.
- Independent doctor/preflight and Task2-column RED head: `c55ab909a1160e059e42b48b722dfbe6d133787f`, tree `dc218cecefe87190d19255c29c78160438c7f573`; Task4 production unchanged.
- Production candidate: `6a1f1c3df53161943ca7121fde7ed13203cbacb3`, tree `ea6e0525623a0fcec6da33fe6558c5c07f6fedf7`.
- Candidate tree inspected recursively: 167 blobs, all critical package/workflow/runner/store/test files present. Package manifest, workflow gates and runner unchanged.
- No usable shell: executor startup failed. Every claimed runtime result below is actual GitHub Actions evidence, not a local test claim. No credential values were inspected or emitted.

## Root cause, reachability and minimal changes

**#52, P2: a legitimate configured store-root alias prevents strict execution verification.** Baseline `lib/store/execution.js:177` compares `realpathSync(log.path)` with `resolve(expected)`. The former follows a direct-root or ancestor symlink while the latter retains its lexical path. Create such a root, open an execution task, claim as its real worker, finish successful foreground `task_verify`, then submit/accept: verification incorrectly reports `verified:false` and strict acceptance refuses otherwise valid receipt.

Candidate `lib/store/execution.js:173-188` resolves only the trusted configured root. It retains exact `log.path === join(root, receipts, filename)`, rejects a symlink at the log file itself, and requires the resolved file to equal the expected file beneath the physical root's receipts directory. It still checks actual file type, bytes, observed byte count, SHA-256, current source snapshot, owner/run/generation and foreground outcome. Resolving both compared log expressions would be a tautology and would permit a redirected receipts directory; that alternative was not used.

Two actual native tests live in the existing anchor-aware `tools/tests/host-boundaries.test.mjs:956` stage. The general node:test stage does not receive `DSH_INSTALL_ANCHOR`, even in native jobs; placing these assertions there would skip the decisive native check. Real ToolRuntime and LocalBashExecutor execute the successful command with foreground ownership/call correlation, capture raw stdout/stderr and then accept the receipt. Direct and ancestor aliases fail correctly before the fix and pass after it. Real-SQLite execution tests independently cover both aliases, external file/directory symlinks, unchanged old-root text after relocation and the legacy/strict contrast.

**Operations schema gate, P2: incomplete core-column and object checks can report compatibility for a database that cannot serve store operations.** Baseline `lib/operations/index.js:124-136` omits task.note, fact.statement/evidence_path, handoff.note, receipt.command, waiver.reason and other runtime fields, and reads view columns without requiring the object to be a real table. Dropping a representative omitted column leaves doctor healthy and preflight successful; replacing handoff with a readable view also leaves doctor healthy.

Candidate `lib/operations/index.js:124-151` checks the complete runtime column sets for all five real core tables, plus the existing additive/optional-family declaration gates. The Task2 candidate's task.submitted_at must be nullable TEXT. It accepts supported old core CREATE declarations and an isolated additive migration; it does not demand byte-identical CREATE SQL for historically migrated core tables. Separate doctor and preflight assertions prevent the first failing doctor assertion from concealing an unexecuted preflight assertion. Every malformed-schema case records original database digest and root listing and proves they remain unchanged. Dropping only submitted_at requires doctor upgrade and successful preflight migration on a disposable copy with all original rows/bytes retained.

**#42 is a deliberate legacy contract, not a production change.** Baseline `lib/store/evidence.js:9-12` and `lib/store/index.js:1445-1451` explicitly accept a CONFIRMED/PLAUSIBLE record of any kind with a nonempty path as legacy evidence, while execution receipt validation is independent. The exact sequence is recorded in `tools/tests/execution-receipts.test.mjs:439-455`: path-bearing blocker → valid same-task/run decision with resolves_fact_id → submit → accept. Legacy retains the blocker in evidence_basis and no waiver; execution refuses with E_VERIFICATION_RECEIPT without a real receipt. Excluding blocker would break investigation compatibility and would not establish positive correctness. The STORE documentation clarifies the required human review of original records and logs.

Operations' existing canonical-root/ancestor-symlink refusal remains deliberate and unchanged. Existing SQLite/WAL snapshot, archival provenance, restore isolation, schema/row retention, log digest, failed migration retry, manifest tampering and exclusive destination checks remain in the six-job suite. No receipt history, actor attribution or archived textual path is rewritten.

## Task4-owned blobs at the production candidate

| Path | Blob |
|---|---|
| docs/OPERATIONS.md | `8434bd59bc93b83cbeea5aa79c1ce640a3084585` |
| docs/STORE.md | `492afebca118491a56ffcd4ec56b4da2580a2cfd` |
| lib/operations/index.js | `8020f2b589857864b73c888db69e73bbe8419cc8` |
| lib/store/execution.js | `db29bbfc5ad2e8a1ff843631ec889a4a2c48d2b6` |
| tools/tests/execution-receipts.test.mjs | `b0f482f0c2ca9e7381c30d1980f2ffee5ddc45bf` |
| tools/tests/host-boundaries.test.mjs | `656a9cf2fc285f51430e1dbc7fe677713bd5ab93` |
| tools/tests/operations.test.mjs | `c274b7679c24cd8bac52d1efcfd6f4b91a4a4723` |

The host-boundaries ownership is only the appended Task4 native alias hunk. Shared docs/STORE.md is based on the exact Task2 document plus only two Task4 paragraphs: legacy any-kind path review at line 238 and configured-root/physical receipt containment at line 414. Parent must integrate those paragraphs without replacing other contributors' shared document changes.

## Explicit dependency; not Task4-owned production

Authorized Task2 candidate: `e6f0fd022d4c929e7d77603a0bde78232c8526d3`, tree `761130801618677b562e82f6833cfff06c2060f5`. It is an additional parent of the production candidate. Its eleven exact blobs were inherited; they were not edited on behalf of Task2. The earlier accidental incomplete f0a5dc tree was never used as a dependency or parent. The initial joint RED used the earlier complete 8834 candidate; its two outdated fixture failures were fixed only by importing the authorized Task2 fixture blobs below.

| Task2 dependency path | Exact source blob |
|---|---|
| docs/STORE.md | `342dda50450c8506aa8e90e17af05021ed549bc5` |
| lib/store/board-page.js | `01bfe493621c00d015515bc71831b687dea6a160` |
| lib/store/index.js | `318ddac27f33ad3290f76e3afaf0e6353e2c0876` |
| tools/tests/board-pagination.test.mjs | `bd23d719d0dfc1b63b35236dc7b831d1fec549e1` |
| tools/tests/owner-session.test.mjs | `d2c23bfee04e48ad2f36ea772f65fa98c872b08c` |
| tools/tests/sqlite.test.mjs | `c4c33442237f7394c82da04e607258fb5463e58e` |
| tools/tests/store-evidence.test.mjs | `ac9c1ea1b807e97e4025f2e02d48d982d70e0e08` |
| tools/tests/store-scope-integrity.test.mjs | `5fadbe9ce763e744cc709919b8d5977725bca77b` |
| tools/tests/submit-audit-attribution.test.mjs | `ca46d49217fd530c4e98a81c2a5e6ae978bb1ade` |
| tools/tests/submit-status-code.test.mjs | `8355747e3e53885c31aa15a189658f931e97954a` |
| tools/verify-store.mjs | `94bb3d6182001c28c8e303778f739b2e8bd5d5fa` |

Parent should extract only Task4-owned files/hunks and this report, then integrate the separately reviewed Task2 work.

## Actual RED evidence, before Task4 production

[Baseline RED run 38031024331](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031024331). All six complete decoded job logs were read.

| Job / full log | Conclusion | tests/pass/fail/skipped (general; native boundaries) |
|---|---|---|
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031024331/job/114151813599) | failure | 865/850/9/6 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031024331/job/114151813644) | failure | 865/850/9/6 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031024331/job/114151813658) | failure | 865/844/9/12; 42/40/2/0 |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031024331/job/114151813670) | failure | 865/844/9/12; 42/40/2/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031024331/job/114151813673) | failure | 865/844/9/12; 42/40/2/0 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031024331/job/114151813688) | failure | 865/844/9/12; 42/40/2/0 |

General stage failures in each job:

- strict receipts accept a configured direct root symlink with unchanged textual log paths
- strict receipts accept a configured ancestor root symlink with unchanged textual log paths
- doctor and preflight reject missing runtime core column task.note without source changes
- doctor and preflight reject missing runtime core column fact.statement without source changes
- doctor and preflight reject missing runtime core column fact.evidence_path without source changes
- doctor and preflight reject missing runtime core column handoff.note without source changes
- doctor and preflight reject missing runtime core column execution_receipt.command without source changes
- doctor and preflight reject missing runtime core column execution_waiver.reason without source changes
- doctor and preflight reject a core view with table-shaped columns without repairing source

Additional failures in each actual native boundaries stage:

- actual native task_verify accepts a direct store root symlink with exact textual log provenance
- actual native task_verify accepts a ancestor store root symlink with exact textual log provenance

All six verification scripts passed in this baseline RED run. Native preset contract, host integration and preset isolation also passed; native boundaries had precisely the two configured-root path failures. The actual foreground result was completed, exit 0, output_complete:true, source_changed:false, native_error:null, but verified:false. No missing-anchor, fixture or model-call failure was counted as #52 evidence. External receipt-link, relocated text and precise #42 negative controls passed.

[Independent schema/Task2-column RED run 38031371708](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031371708). All six complete decoded logs were read.

| Job / full log | Conclusion | tests/pass/fail/skipped (general; native boundaries) |
|---|---|---|
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031371708/job/114152841035) | failure | 903/875/22/6 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031371708/job/114152841145) | failure | 903/869/22/12; 42/40/2/0 |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031371708/job/114152841197) | failure | 903/869/22/12; 42/40/2/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031371708/job/114152841203) | failure | 903/869/22/12; 42/40/2/0 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031371708/job/114152841225) | failure | 903/875/22/6 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031371708/job/114152841274) | failure | 903/869/22/12; 42/40/2/0 |

Every general-stage failure by name (22 per job):

- strict receipts accept a configured direct root symlink with unchanged textual log paths
- strict receipts accept a configured ancestor root symlink with unchanged textual log paths
- verify-store keeps a complete report tail when stdout is a pipe
- doctor rejects missing runtime core column task.note without source changes
- preflight rejects missing runtime core column task.note without source changes
- doctor rejects missing runtime core column fact.statement without source changes
- preflight rejects missing runtime core column fact.statement without source changes
- doctor rejects missing runtime core column fact.evidence_path without source changes
- preflight rejects missing runtime core column fact.evidence_path without source changes
- doctor rejects missing runtime core column handoff.note without source changes
- preflight rejects missing runtime core column handoff.note without source changes
- doctor rejects missing runtime core column execution_receipt.command without source changes
- preflight rejects missing runtime core column execution_receipt.command without source changes
- doctor rejects missing runtime core column execution_waiver.reason without source changes
- preflight rejects missing runtime core column execution_waiver.reason without source changes
- doctor rejects a core view with table-shaped columns without repairing source
- doctor rejects malformed submitted_at INTEGER without repairing source
- doctor rejects malformed submitted_at TEXT NOT NULL DEFAULT '' without repairing source
- preflight rejects malformed submitted_at INTEGER without repairing source
- preflight rejects malformed submitted_at TEXT NOT NULL DEFAULT '' without repairing source
- missing additive submitted_at requires doctor upgrade and preflight adds only an isolated nullable TEXT column
- failed migration rolls back schema and same store retries cleanly

The two native root failures above remained. Of these 22 general failures, twenty are Task4 assertions; the two known Task2 fixture failures are `verify-store keeps a complete report tail when stdout is a pipe` and `failed migration rolls back schema and same store retries cleanly`. Their updated exact dependency blobs are inherited, not altered or weakened by Task4. The independent preflight missing-column assertions failed with “Missing expected rejection” for E_OPERATIONS_SCHEMA; submitted_at malformed/missing assertions operated against the actual Task2 schema. No future column was required of baseline to manufacture RED.

## Exact-head GREEN evidence

[GREEN run 38031767125](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031767125), exact production head `6a1f1c3df53161943ca7121fde7ed13203cbacb3`, tree `ea6e0525623a0fcec6da33fe6558c5c07f6fedf7`. All six jobs completed successfully, all six full decoded logs were read, and there are no failing assertions.

| Job / full log | Conclusion | tests/pass/fail/skipped (general; native boundaries) |
|---|---|---|
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031767125/job/114154021882) | success | 903/897/0/6 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031767125/job/114154022041) | success | 903/897/0/6 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031767125/job/114154022055) | success | 903/891/0/12; 42/42/0/0 |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031767125/job/114154022057) | success | 903/891/0/12; 42/42/0/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031767125/job/114154022076) | success | 903/891/0/12; 42/42/0/0 |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031767125/job/114154022083) | success | 903/891/0/12; 42/42/0/0 |

All six verification scripts pass in every job. Both checkout offline jobs pass their general node:test stage and truthfully report host integration UNVERIFIED. Every native job tests the actual packed/unpacked delivery, passes general node:test, preset contract, native boundaries, host integration and preset isolation. The two new native aliases run and pass under both supported Node versions and both pinned rc.2/alpha.2 hosts; the boundary stage has zero skips.

Offline six skips are the existing three native module contracts, real-native Config/module resolution, native hung cleanup and pinned H01/H03 raw-readback cases requiring a DSH install anchor. The native package's general stage retains these six anchor skips and adds six existing repository-metadata checks excluded by packaging (.github/.gitignore): engines matrix, ignore/skip synchronization, and four workflow/pack/action checks. They are not skipped Task4 regressions; checkout covers the six repository checks and the later native stages receive the install anchor. No skipped general-stage case is represented as a successful native assertion.

The exact candidate also passes all new negative controls and the valid missing-submitted_at isolated migration. No production or test change was made after this successful verification; the subsequent report-only commit retains these same owned/dependency production and test blobs.

## Limits and handoff

No paid-model request or real-user production execution was performed. These tests establish SQLite, foreground native host and unpacked delivery behavior under the frozen supported versions; they do not authenticate a legacy evidence_path's contents or turn a restored historical receipt into current authority. Independent review, shared-hunk integration and PR/merge remain parent-owned.
