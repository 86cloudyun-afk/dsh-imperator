# Task 5 audit and repair report — scope activation and ambiguous guard outcomes

Date: 2026-10-10. Production baseline: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`, tree `352e615beb3251b60424d4aa81b6929037c51778`, version 0.4.0. Isolated branch: `codex/audit-scope-unknown`, created from requirements/docs commit `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`.

Requirements: [Task 5 brief](https://github.com/86cloudyun-afk/dsh-imperator/blob/234a7896e44b8d4e19608e3c80ef44a982ddc6ff/docs/superpowers/plans/2026-10-10-imperator-audit/task-5-brief.md) and its linked comprehensive audit design at the same SHA. Parent additionally assigned the native parity hunk in `tools/tests/host-api-contract.test.mjs` and the `E_CONTROL_JOURNAL_UNAVAILABLE` classification contract. The cloud executor failed configuration; all execution evidence below comes from actual GitHub Actions, not local shell execution.

## Confirmed findings and minimal repairs

### P2 — direct scope resolution bypassed the native export contract (#44)

At baseline [scope-membership.mjs:11](https://github.com/86cloudyun-afk/dsh-imperator/blob/81b7ce67114f96ebcd05b257571ce8a6bc9e68c7/lib/plugins/scope-membership.mjs#L11), successful bare Node resolution bypassed the function validation at lines 20–22, which only applied to the host-catalog fallback. A directly resolvable `@deepseek-ai/dsh-scope` missing either required function therefore allowed plugin activation; later membership evaluation could become unknown. A successful require returning null/undefined could also be mistaken for the absence of a native host. Unknown membership intentionally preserves existing safety rules; that conservative contract is not itself the bug.

Discriminating sequence: place an independently resolved package beside a temporary copy of the exact production module; export only scopeOf, only scopeChainOf, neither, null, or undefined; activate createScopeMembership. All five expected activation-error assertions failed against unchanged production. A complete package distinguishes the precise owner revision, foreign revision and empty scope. Existing catalog and genuine standalone tests remain.

Repair: track whether native resolution succeeded, then apply the same two-function invariant after direct or catalog resolution. A missing native module without a host catalog still follows the existing standalone path. No alternate SDK copy, guessed host path, global filter or runtime dependency was introduced.

Scope production/doc commit: `2bcfb08d2ac91b468c4745860ebfff8d4211d7e3` (tree `8d7f5ad67c215a164b370b87cf55b407bf2511d8`).

### P2 — ambiguous external effects were counted as definite ECHO failures

At baseline [guard.mjs:268](https://github.com/86cloudyun-afk/dsh-imperator/blob/81b7ce67114f96ebcd05b257571ce8a6bc9e68c7/lib/plugins/guard.mjs#L268), a matched isError result or a complete registered-task error envelope unconditionally counted as a definite failure. Repeated native TOOL_OUTCOME_UNKNOWN or durable pending/unknown child-control results therefore produced ECHO; the injected message advised changing tool/arguments, and nonzero legacy stepDownRequests could arm demotion. That advice is inappropriate when an earlier external effect may already have happened.

Discriminating sequences cover native unknown errors, durable E_CONTROL_OUTCOME_UNKNOWN, pending/unknown statuses with preserved persistence/null codes, PTC inner results, a mixed definite/unknown/definite history, result replay, actual plugin guidance/demotion, and a missing-journal envelope without operation metadata. The latter `E_CONTROL_JOURNAL_UNAVAILABLE` denies the current dispatch but cannot determine a historical same-key effect. These assertions failed before any production modification. Actual public SDK Session and createToolResultMessage constructors also produced RED in both pinned DSH versions with the real installation anchor. These are no-model persisted-event shape checks; no claim is made that a real unknown external effect or paid provider request was induced.

Repair: distinguish an observed ambiguous outcome from both an unresolved call and a definite failure. Native TOOL_OUTCOME_UNKNOWN and complete matched child-control envelopes carrying the two unknown codes or pending/unknown status are recorded as a nonfailure barrier. A repeated result cannot overwrite that first outcome. Definite TOOL_NOT_STARTED and genuine task errors still contribute to ECHO, including later definite tails. Unknown results cannot inject the ECHO change-arguments message or arm effort demotion. Preserve the original retry_key and inspect receipts when the journal returns; missing history does not authorize a replacement-key effect.

Guard production/doc commit: `1e6fe649f856697d526319f54a06179f2934c06f` (tree `01eb36f6df14107d4a4138d7393f98f6c5a1e345`). `lib/tools/index.js`, working-context, event-projection, the runner and workflow files were not changed.

## Actual RED evidence

All three tests-only commits retained frozen production code. Every six-job log was read; their failures were assertion failures for the required behavior, not fixture or installation errors. Counts below are tests/pass/fail/skip, identical within each two-job offline or four-job native category.

| Tests-only head | Actions | Offline node:test | Native node:test | Native boundaries |
| --- | --- | --- | --- | --- |
| `eeb6f8315b0f05e7e0e9631da3d95a5e7c07583d` | [38030566039](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030566039) | 866/848/11/7 | 866/842/11/13 | 40/40/0/0 |
| `287e27913e28394f25d308dc9909af5ae6999ee5` | [38030780447](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030780447) | 868/848/11/9 | 868/842/11/15 | 43/41/2/0 |
| `11f1274ecd406c1aa8ec63c4c3760b29066ae626` | [38030967110](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030967110) | 871/848/14/9 | 871/842/14/15 | 43/41/2/0 |

The first run exercised offline event contracts but its extra native parity case lacked an installation anchor. The second commit removed that redundant SKIP case from guard-causality and moved three real SDK tests into the existing anchored host-api-contract native stage. The third commit added the missing-journal case and null/undefined direct module exports, with a further actual RED before the production fixes.

Unique failing names in the final tests-only run (the first 14 occur in node:test; the last two occur in anchored native boundaries):

- `matched native unknown effects do not produce definite-failure ECHO`
- `an ambiguous matched outcome breaks a definite failure tail and its replay cannot overwrite it`
- `durable pending/E_CONTROL_OUTCOME_UNKNOWN control effects do not produce definite-failure ECHO`
- `durable unknown/E_CONTROL_OUTCOME_UNKNOWN control effects do not produce definite-failure ECHO`
- `durable unknown/PERSISTENCE_UNAVAILABLE control effects do not produce definite-failure ECHO`
- `durable unknown/null control effects do not produce definite-failure ECHO`
- `PTC durable unknown control effects do not produce definite-failure ECHO`
- `unknown controls cannot inject change-arguments guidance or arm effort demotion`
- `missing durable journal leaves prior effects ambiguous and cannot advise a replacement retry`
- `direct native scope resolution refuses missing scopeChainOf`
- `direct native scope resolution refuses missing scopeOf`
- `direct native scope resolution refuses missing both native functions`
- `direct native scope resolution refuses missing both native functions (null exports)`
- `direct native scope resolution refuses missing both native functions (undefined exports)`
- `native SDK result shape does not classify native-unknown as definite-failure ECHO`
- `native SDK result shape does not classify durable-unknown as definite-failure ECHO`

Definite TOOL_NOT_STARTED, genuine native/PTC task errors, complete direct scope exports, catalog resolution and standalone compatibility were passing controls; their behavior was not weakened.

## Exact code-head GREEN

Code head: `1e6fe649f856697d526319f54a06179f2934c06f`, tree `01eb36f6df14107d4a4138d7393f98f6c5a1e345`. [Verify run 38031405217](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031405217) completed successfully; all six exact-head logs were read.

| Job | Result | node:test tests/pass/fail/skip | Anchored native boundaries |
| --- | --- | --- | --- |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031405217/job/114152940982) | success | 871/862/0/9 | not applicable |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031405217/job/114152941088) | success | 871/862/0/9 | not applicable |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031405217/job/114152941110) | success | 871/856/0/15 | 43/43/0/0 |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031405217/job/114152941140) | success | 871/856/0/15 | 43/43/0/0 |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031405217/job/114152941160) | success | 871/856/0/15 | 43/43/0/0 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031405217/job/114152941221) | success | 871/856/0/15 | 43/43/0/0 |

The native jobs unpacked the exact npm deliverable and passed all 11 acceptance phases: six legacy scripts, node:test, preset contract, native boundaries, host integration and preset isolation. Each reports PASSED preset contract with 29 rows, HOST_VERIFIED with 17 checks and ISOLATION_VERIFIED with 13 checks. Anchored native boundaries execute the native/durable unknown tests and TOOL_NOT_STARTED control with zero skips.

The regular node:test pass has nine native-capability skips without an anchor. The packaged regular pass adds six checkout-only skips because .github/.gitignore are not in the deliverable, totaling 15; the corresponding checkout tests and actual anchored native stage ran in their intended jobs. No skipped ordinary native parity case is represented as execution.

## Owned file manifests for separate integration

The earlier tests-only commits contain both topics; use these file manifests to build separate component PRs rather than treating each combined tests commit as a topic-isolated change.

| Scope component path | Final blob |
| --- | --- |
| `docs/PRESET_ISOLATION.md` | `88ebfc3c543c7006b7f05784d557cd700db9109e` |
| `lib/plugins/scope-membership.mjs` | `e2d4dc24d93c9a94b2bfb011386fadb4ac29784d` |
| `tools/tests/preset-isolation.test.mjs` | `cb68261e2731558e84fb41a9c66fa007b8cdb119` |

| Guard component path | Final blob |
| --- | --- |
| `docs/RELIABILITY.md` | `771cfeed12e5d83e26453662120d35fd41b9c697` |
| `lib/plugins/guard.mjs` | `3bf53076dad76c701e670caa44bee6712f1d5275` |
| `tools/tests/guard-causality.test.mjs` | `6868f8faa17d75b2c1e960bf996d8303d2dd78b1` |
| `tools/tests/host-api-contract.test.mjs` | `8553aa979d732043e548ca6274473d229932ef13` |

Report path: `docs/superpowers/research/2026-10-10-imperator-audit/task-5-report.md`. Relative to the verified code/test candidate `1e6fe649f856697d526319f54a06179f2934c06f`, the report head differs only in this report file; all seven component blobs above are unchanged. Per the parent's explicit handoff instruction, a report-only repeated matrix is not awaited or claimed as GREEN. The task's exact-head GREEN evidence applies to the code/test candidate. The parent performs independent full-base-to-report-head review, final integration/PR review and merge/main verification.

## Read-only attribution checks and boundaries

- Issue #47 is already repaired at the frozen baseline: task_fact passes trusted actor identity and the store ignores a model-supplied child_id when recording the author. A legal child session ID of lead does not acquire root authorization. No duplicate fix was made.
- PR #50 is redundant with baseline optional-cwd compatibility and is now closed. No PR mutation was performed.
- PR #41 at `23f00bc2b0cd8c9532a8f45aa2d6816fada5d2b4` adds legacy unbound nonowner note attribution, a done/partial three-caller alias matrix, and blank-note checks. Current submit-audit-attribution tests already cover owner/lead task_submit authorship, while owner-session tests cover bound ownership. Its extra alias/legacy coverage is not evidence of a current bound-owner production authorization defect; the old PR's no-owner-gate statement applies only to legacy unbound tasks. No unrelated tests were added in this task.

Node engines, package/preset/display/database names, pins, runtime dependencies, acceptance 60s and cleanup 12s remained unchanged. The full-tree SDK scheduling adapter remains closed. No production profile, facts, credentials, paid model request, main/other branch, PR or merge was touched.

Native acceptance logs contain MaxListenersExceededWarning for 11 process listeners. All gates still passed; these logs do not establish a production shutdown cause or long-run stability. No listener limit, deadline or assertion was changed to suppress them. The earlier cleanup/SIGTERM race is not claimed as a proven production root cause.

Applicable systematic-debugging, TDD and verification guidance was read. The referenced TDD supporting resource writing-good-tests.md failed to load through the skill provider; that was reported and did not replace the required actual discriminating RED/GREEN checks. No shell, local execution or production/paid-provider validation is claimed. Independent review, component PR creation/integration and final merge are assigned to the parent.

## PR #65 follow-up: definite durable stop rejection hidden by the compatible unknown code

This section records the later premerge finding [review comment 4237238079](https://github.com/86cloudyun-afk/dsh-imperator/pull/65#discussion_r4237238079). It supplements the historical scope and unknown-effect evidence above; the already merged scope component and its original report text are preserved.

Follow-up base: PR #65 head `7a293aa679c428a4945d104af753a90b6e509c3e`, tree `73b9714db8142a6694e52646d973033cdf321bb0`, with actual main `89b6271d451447261c453b628e6783d6f2b42d53` already included. All work was isolated on `codex/audit-guard-rejected-replay`; this implementer did not mutate main, PR #65's branch, the release branch or any other component.

The registered real `task_child_stop` handler receives an explicit `{ accepted: false }` from the external interrupt boundary and settles the actual SQLite control row as `rejected`. The first envelope has `ok:true` and `stopped.accepted:false`: transport success does not mean the stop was accepted. Subsequent same-key replay envelopes have `ok:false`, the existing compatible `E_CONTROL_OUTCOME_UNKNOWN` code, and a complete durable `operation.status:rejected` row. The prior guard classified this code before inspecting the completed refusal, so six independent replay attempts could never trigger ECHO.

The minimal repair preserves the tools protocol. Only a matched `task_child_stop` error envelope with that compatible code and a complete, coherent durable rejected replay can count as definite failure. The row must be settled, non-invoking and replayed, have its positive row ID and public identities/timestamps, unbound task/generation, and null message/error metadata appropriate to the explicit stop refusal. Its target and original retry key must match the invocation. The call cache retains only a SHA-256 binding and an explicit-key boolean: it adds no raw argument/key cache or warning payload. Target whitespace is trimmed as the real handler does; request-key whitespace is preserved exactly; JSON encoded and object arguments are supported; run_id may be null.

Native `TOOL_OUTCOME_UNKNOWN` still takes precedence. Pending/unknown operations, missing journals, bare rejected status, incomplete rows, mismatched targets/keys, contradictory receipt metadata and `E_CONTROL_JOURNAL_UNAVAILABLE` retain the uncertainty barrier and cannot inject ECHO/change-argument guidance or arm effort demotion. These tests do not authorize changing the key of an ambiguous external effect.

### Follow-up discriminating tests and actual RED before production

Tests-only head `da0fe0fd3b62d725efd71b2f8aae8ecd3d577b22`, tree `9e8360860397a9f9cc747ec0ff5ec96bfb5e64c7`, changes only the two existing test files. The complete tree contains the same 163 blobs; all production blobs are unchanged. The test commit was created at 10:04:26 UTC. [RED Verify 38043630241](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043630241) completed at 10:07:07 UTC; every one of its six full job logs was read and its exact failure set checked by 10:08:33 UTC. Production commit `009462fb6002a6224c5428669c2fffd3590fcbe6` was created only afterwards, at 10:09:43 UTC.

The ordinary tests exercise real temporary SQLite and the actual registered tool handlers; only the external subagent interrupt receipt is a fixture. Each history performs exactly one initial interrupt, then six independent calls with the identical target/key and distinct call IDs/steps. Every replay retains the operation ID and original key, dispatches zero further interrupts and preserves the complete database row. Native and PTC histories separately test full fold, incremental projection and plugin ECHO. The plugin test keeps TaskForce effort unchanged, omits target/key from warning text, and suppresses repeated warning injection. Seventeen uncertainty variants share one fixture to avoid unnecessary database overhead. Native-unknown precedence and one-result replay deduplication are separate controls.

Two additional anchored tests use the installed public SDK Session and createToolResultMessage constructors with that same real SQLite/registry path, native/PTC transports, and reused provider IDs scoped by six distinct steps. Their initial package-wide unanchored execution is truthfully skipped; they actually execute in the anchor-enabled native boundary stage with zero skips.

| RED job | Main tests/pass/fail/skip | Anchored boundaries |
| --- | --- | --- |
| [offline 22.23.2](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043630241/job/114188659833) | 1326/1309/6/11 | not applicable |
| [offline 24.19.0](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043630241/job/114188659861) | 1326/1309/6/11 | not applicable |
| [native 24.19.0 / rc.2](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043630241/job/114188659881) | 1326/1303/6/17 | 53/51/2/0 |
| [native 22.23.2 / alpha.2](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043630241/job/114188659901) | 1326/1303/6/17 | 53/51/2/0 |
| [native 22.23.2 / rc.2](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043630241/job/114188659916) | 1326/1303/6/17 | 53/51/2/0 |
| [native 24.19.0 / alpha.2](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043630241/job/114188659919) | 1326/1303/6/17 | 53/51/2/0 |

The only ordinary failing names were `durable rejected stop replay triggers {fold|projection|plugin} ECHO through {native|PTC}` (six exact combinations). The only additional anchored failing names were `native SDK durable rejected stop replay triggers ECHO through native` and its `PTC` counterpart. Every failure was ERR_ASSERTION for missing ECHO (undefined instead of echo, or zero instead of one warning), after real receipt/persistence/single-effect assertions passed. Uncertainty, deduplication and existing guard positive controls passed. No fixture exception, deadline failure or cancellation was present; all six legacy scripts and native host/isolation stages passed.

### Follow-up exact-source GREEN and final owned manifest

Production/docs head: `009462fb6002a6224c5428669c2fffd3590fcbe6`, tree `b665bc47698f945b3b9f33465a888188346ea193`. Relative to tests-only RED, only guard and RELIABILITY changed; both test blobs are byte-identical. Relative to the follow-up base, there are four changed files, 163 preserved blobs and 159 unchanged blobs.

[Verify 38043938948](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043938948) completed successfully at the exact source head.

| GREEN job | Result | Main tests/pass/fail/skip | Anchored boundaries |
| --- | --- | --- | --- |
| [native-host (24.19.0, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043938948/job/114189561644) | success | 1326/1309/0/17 | 53/53/0/0 |
| [offline (22.23.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043938948/job/114189561763) | success | 1326/1315/0/11 | not applicable |
| [native-host (24.19.0, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043938948/job/114189561772) | success | 1326/1309/0/17 | 53/53/0/0 |
| [native-host (22.23.2, 0.2.1-alpha.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043938948/job/114189561790) | success | 1326/1309/0/17 | 53/53/0/0 |
| [offline (24.19.0)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043938948/job/114189561824) | success | 1326/1315/0/11 | not applicable |
| [native-host (22.23.2, 0.2.0-rc.2)](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38043938948/job/114189561883) | success | 1326/1309/0/17 | 53/53/0/0 |

All six exact-source full logs were read. Both offline jobs retain truthful UNVERIFIED host status. All four native jobs accept the actual packed/unpacked `@local/dsh-taskforce@0.4.0` deliverable, pass all eleven acceptance phases, PASSED preset contract with 29 rows, HOST_VERIFIED with 17 checks and ISOLATION_VERIFIED with 13 checks. All main-suite and boundary cancelled counts are zero. The two new SDK tests add two truthful unanchored skips, resulting in 11 checkout skips and 17 packed regular-pass skips; all 53 anchored boundary tests actually pass with zero skips.

| Follow-up owned source path | Blob at verified code head |
| --- | --- |
| `lib/plugins/guard.mjs` | `d40f1059b5f38c9f974b72773957efa9a8bca1f8` |
| `tools/tests/guard-causality.test.mjs` | `b1b07bb374cd574c26f47ad1263708ae493fb377` |
| `tools/tests/host-api-contract.test.mjs` | `a36c0b138cf6064fc657e953817a17761de657f9` |
| `docs/RELIABILITY.md` | `fce42b20d20496f8ada7880058e4dc46b661eed2` |

The final follow-up commit appends only this report to the preserved scope/guard report; the four verified source/test/docs blobs and all other source-tree paths remain unchanged. Its five-file final manifest includes this report and is handed to the parent after a recursive-tree identity check. No GREEN claim is made for an unawaited report-only matrix. Independent module review, refreshed PR/component CI, whole-change review, the extra fresh premerge review and actual main verification remain the parent's gates.

Node engines, DSH pins, dependencies, identifiers, database path, acceptance 60s and cleanup 12s remain unchanged, with no waiver. The full-tree adapter remains closed. This repair restores repeated-failure detection for a completed explicit refusal; it does not stop a child itself or prove the cause of a historical production crash. There was no local executor, deployed runtime log inspection, paid model request or long-duration real-provider run.
