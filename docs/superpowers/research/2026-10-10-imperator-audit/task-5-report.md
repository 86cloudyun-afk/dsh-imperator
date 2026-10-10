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

Report path: `docs/superpowers/research/2026-10-10-imperator-audit/task-5-report.md`. The report is a separate documentation commit after the code-head verification; its final branch SHA and actual exact-head run are returned to the parent with the delivery handoff.

## Read-only attribution checks and boundaries

- Issue #47 is already repaired at the frozen baseline: task_fact passes trusted actor identity and the store ignores a model-supplied child_id when recording the author. A legal child session ID of lead does not acquire root authorization. No duplicate fix was made.
- PR #50 is redundant with baseline optional-cwd compatibility and is now closed. No PR mutation was performed.
- PR #41 at `23f00bc2b0cd8c9532a8f45aa2d6816fada5d2b4` adds legacy unbound nonowner note attribution, a done/partial three-caller alias matrix, and blank-note checks. Current submit-audit-attribution tests already cover owner/lead task_submit authorship, while owner-session tests cover bound ownership. Its extra alias/legacy coverage is not evidence of a current bound-owner production authorization defect; the old PR's no-owner-gate statement applies only to legacy unbound tasks. No unrelated tests were added in this task.

Node engines, package/preset/display/database names, pins, runtime dependencies, acceptance 60s and cleanup 12s remained unchanged. The full-tree SDK scheduling adapter remains closed. No production profile, facts, credentials, paid model request, main/other branch, PR or merge was touched.

Native acceptance logs contain MaxListenersExceededWarning for 11 process listeners. All gates still passed; these logs do not establish a production shutdown cause or long-run stability. No listener limit, deadline or assertion was changed to suppress them. The earlier cleanup/SIGTERM race is not claimed as a proven production root cause.

Applicable systematic-debugging, TDD and verification guidance was read. The referenced TDD supporting resource writing-good-tests.md failed to load through the skill provider; that was reported and did not replace the required actual discriminating RED/GREEN checks. No shell, local execution or production/paid-provider validation is claimed. Independent review, component PR creation/integration and final merge are assigned to the parent.
