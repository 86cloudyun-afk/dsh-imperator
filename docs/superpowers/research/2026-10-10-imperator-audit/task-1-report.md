# Task 1 report: frozen workflow delivery

## Status and immutable inputs

Implementation and candidate verification, including both PR #61 persisted-upgrade follow-ups, are complete. Independent task/release/PR review and integration remain the parent's responsibility; this implementer created no PR and changed no other branch.

- Requirement: [Task 1 brief](../../plans/2026-10-10-imperator-audit/task-1-brief.md) and [approved audit design](../../specs/2026-10-10-imperator-comprehensive-audit-design.md).
- Production baseline: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`.
- Isolated branch: `codex/audit-workflow-freeze`, created exactly at planning head `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`.
- Verified final production/test/documentation candidate: `4524b9e04fb54bbde47b8998548c32bae946808a` (initial freeze `8a0b84de21c3de107551ab70e37cce4f9f1a9153`; first persisted-upgrade follow-up `4a5d03755f9674d11682efca88c6a191f7376b2e`).
- Verified final candidate tree: `700a7a9b582db4ae06a82177da1f9dc6d074c4d5`.
- This report is a subsequent documentation-only commit. The final six-job follow-up results belong to the candidate above; the original freeze results retain their original immutable SHA below. Neither is presented as an unexecuted report-head run. Per parent coordination, the report-only head is handed back without waiting for a duplicate matrix; final integration/PR exact-head verification belongs to the parent.

## Confirmed causes and correction

The previous artifact path allowed a new revision while already in review or lead_acceptance. The pending execution hook reset either stage to test before a replacement artifact. A fail/unverified review could be followed by pass for the same revision, and acceptance considered only the latest review. Those combinations bypassed root return and its bounded rework budget.

The shared workflowDeliveryGate rejects artifact replacement and verification after any actual delivery in the same task/run/plan/evidence generation, including older-writer persisted states with cleared or replacement revision IDs. Review and acceptance admit a sole exact-current artifact but refuse another actual delivered ancestor in that tuple. It also rejects review supersession and acceptance when any nonpassing result belongs to the exact current task/run/revision/plan/evidence generation. Both requirements_result and quality_result participate. The hook executes in the existing synchronous transaction before receipt insertion and before the native executor call.

Exact request replay remains before mutable-work gates. Historical completed decisions remain read-only; root return clears the current revision and advances evidence generation through the existing budgeted path. Unrelated historical revision references/plans/generations do not poison new deliveries; the approved PR #61 supplements below preserve every actual same-generation delivery across older-writer replacement revisions, regardless of review verdict. Restored lead_acceptance requires root return, claim, new current-root execution, a new artifact and independent review; zero/exhausted budget refuses this reopening.

No schema, tools/index, model-tool definition, package identity, Node/DSH pin, deadline or external dependency changes. The second PR #61 follow-up adds the explicitly authorized two-line store/index import and strict-evidence call substitution documented below; the earlier freeze and first follow-up did not modify store/index. The official full-tree adapter remains closed.

## Test contract and discriminating coverage

The former lead_acceptance test that admitted a new pending execution was replaced under the approved freeze contract. Its source/log tampering acceptance checks remain. New tests assert denial for both the real verification API and direct pending host hook, no new receipt/audit/revision, and no native executor call.

Coverage includes unreviewed/fail/unverified/pass delivery freezes; changed source after failure; both review dimensions and different reviewer sessions; synthetic pre-upgrade active fail-to-pass history; exact tuple isolation; original artifact/review request replay before and after completion; historical terminal acceptance replay; root return to a fresh valid revision; exhausted budget; restored lead_acceptance recovery and max_reworks=0 refusal. Real SQLite, actual source/log evidence and actual Node syntax-check subprocesses are used.

An intermediate tests-only run [38030598342](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030598342) exposed one fixture error in “historical completed fail-then-pass outcome keeps original acceptance replay read-only”: a new terminal request used the pre-acceptance expected_version and hit E_WORKFLOW_VERSION before E_TERMINAL. The fixture was corrected to read the current version. No production change preceded the corrected RED below.

## Initial freeze RED evidence

Tests-only commit: `610b2db7519285ad4188f4e30f4d05209f26738b`. [Run 38030764528](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030764528). All six logs were fetched and inspected. Each full suite produced exactly 19 expected missing-rejection/exception failures; compatibility and replay controls passed. No fixture failures remained.

| Job | Job ID | Tests | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| offline (24.19.0) | [114151039181](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030764528/job/114151039181) | 873 | 848 | 19 | 6 |
| native-host (24.19.0, 0.2.1-alpha.2) | [114151039283](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030764528/job/114151039283) | 873 | 842 | 19 | 12 |
| native-host (22.23.2, 0.2.1-alpha.2) | [114151039285](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030764528/job/114151039285) | 873 | 842 | 19 | 12 |
| offline (22.23.2) | [114151039312](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030764528/job/114151039312) | 873 | 848 | 19 | 6 |
| native-host (24.19.0, 0.2.0-rc.2) | [114151039344](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030764528/job/114151039344) | 873 | 842 | 19 | 12 |
| native-host (22.23.2, 0.2.0-rc.2) | [114151039351](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030764528/job/114151039351) | 873 | 842 | 19 | 12 |

The 19 expected failing tests were:

- restored lead acceptance requires current-root execution and a new independently reviewed artifact
- restored frozen delivery with zero rework budget refuses revalidation without receipt or execution
- delivered unreviewed revision refuses direct artifact replacement
- delivered unreviewed revision refuses fresh verification before intent or native execution
- delivered fail revision refuses direct artifact replacement
- delivered fail revision refuses fresh verification before intent or native execution
- delivered unverified revision refuses direct artifact replacement
- delivered unverified revision refuses fresh verification before intent or native execution
- delivered pass revision refuses direct artifact replacement
- delivered pass revision refuses fresh verification before intent or native execution
- current requirements_result=fail review cannot be superseded by another passing review
- pre-upgrade active requirements_result=fail-then-pass history cannot be accepted without root return
- current requirements_result=unverified review cannot be superseded by another passing review
- pre-upgrade active requirements_result=unverified-then-pass history cannot be accepted without root return
- current quality_result=fail review cannot be superseded by another passing review
- pre-upgrade active quality_result=fail-then-pass history cannot be accepted without root return
- current quality_result=unverified review cannot be superseded by another passing review
- pre-upgrade active quality_result=unverified-then-pass history cannot be accepted without root return
- root return is required after passing review and exhausted budget cannot be bypassed

## Initial freeze GREEN evidence

[Candidate run 38030970282](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030970282) tested exactly `8a0b84de21c3de107551ab70e37cce4f9f1a9153`. All six jobs succeeded; every exact-candidate job log was fetched and inspected.

| Job | Job ID | Tests | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| offline (24.19.0) | [114151650299](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030970282/job/114151650299) | 873 | 867 | 0 | 6 |
| native-host (22.23.2, 0.2.0-rc.2) | [114151650461](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030970282/job/114151650461) | 873 | 861 | 0 | 12 |
| native-host (24.19.0, 0.2.1-alpha.2) | [114151650489](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030970282/job/114151650489) | 873 | 861 | 0 | 12 |
| native-host (24.19.0, 0.2.0-rc.2) | [114151650509](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030970282/job/114151650509) | 873 | 861 | 0 | 12 |
| offline (22.23.2) | [114151650523](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030970282/job/114151650523) | 873 | 867 | 0 | 6 |
| native-host (22.23.2, 0.2.1-alpha.2) | [114151650527](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030970282/job/114151650527) | 873 | 861 | 0 | 12 |

Each unpacked native combination additionally passed 40/40 native boundary tests, 17 HOST_VERIFIED checks and 13 ISOLATION_VERIFIED checks, with no model requests. Offline host-dependent checks remain explicitly unverified; unpacked suite skips also include repository-only contracts. No new skip or timeout relaxation was introduced. Existing offline benchmark/fault steps completed successfully.


## PR #61 follow-up: persisted upgrade delivery history

The actual [PR #61 review thread](https://github.com/86cloudyun-afk/dsh-imperator/pull/61#discussion_r4236754935) exposed another reachable upgrade state. At baseline 81b7ce6, a nonpassing R1 review followed by recordExecution(pending) atomically persisted stage=test and revision_id=NULL while leaving the plan/evidence generation unchanged. A crash there, after the old recordArtifact had persisted R2, or after an independent pass of R2 all allowed the upgraded exact-current-only gate to forget R1. Tests demonstrated acceptance with max_reworks=0.

The parent explicitly approved the corresponding migration-contract supplement: failure of a real delivered artifact remains sticky across replacement revisions within the same task/run/current plan/current evidence generation. The gate retains its exact-current-revision check and additionally associates earlier reviews with actual artifact rows matching task, run, plan and generation. Thus both NULL-pointer and already-persisted R2 states require budgeted root return. An unrelated/orphan noncurrent revision reference is not inferred to be a delivered ancestor; the original other-revision/plan/generation positive test remains unchanged. Historical completed outcomes and original-key read-only replay remain unchanged. The root-return path advances generation and permits a fresh reviewed delivery.

Only lib/store/workflow.js, tools/tests/workflow-engine.test.mjs and docs/WORKFLOW.md changed for this first persisted-upgrade follow-up; this report is updated separately. For that first follow-up, no schema migration, store/index or tools/index change was required. The original audit branch continued from e97e3a04918a2cb606f2bdb355fc3bb65b1a2dab; main and the clean PR branch were untouched.

The new fixture uses precise SQL equivalent to the old pending/artifact/review transaction writes, retaining real initial artifacts, failed reviews and decision audits. Later crash states finish their replacement receipt through production recordExecution with actual Node subprocess output, then persist the old artifact/review shapes. Every fixture closes its store, reconstructs store/workflow objects at the same path, and checks unchanged durable rows before exercising upgraded APIs. It does not delete or disable production guards.

Seventeen new tests cover all three persisted states times both result dimensions and fail/unverified; direct pending/artifact/accept error routing; no receipt/audit mutation or native execution after refusal; max_reworks=0; original request replay; budgeted root-return recovery at all three boundaries; and real-artifact task/run/plan/generation association controls. The foreign-run association control isolates the helper and separately verifies that public scope integrity still rejects the corrupt attached artifact without disclosing its run.

### Follow-up fixture correction (not qualifying RED)

Initial tests-only commit 1906d3589fd48c95aa0a29c4c7cf84246ffbb774, [run 38033267770](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267770), failed 16 new tests before their target assertions because the fixture tried to reopen a permanently closed TaskforceStore instance. Those were the fifteen cases listed below plus “legacy replacement history preserves read-only replay and budgeted root-return recovery at every crash boundary”; all reported the same closed-instance error. All six full logs were read. The fixture was corrected in tests-only b66de62f190401fc4b79d0d00f99ca898c73435f to construct new store/workflow instances; no production change preceded the qualifying RED.

| Job | Job ID | Tests | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| native-host (22.23.2, 0.2.1-alpha.2) | [114158404350](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267770/job/114158404350) | 890 | 862 | 16 | 12 |
| native-host (24.19.0, 0.2.1-alpha.2) | [114158404442](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267770/job/114158404442) | 890 | 862 | 16 | 12 |
| native-host (22.23.2, 0.2.0-rc.2) | [114158404459](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267770/job/114158404459) | 890 | 862 | 16 | 12 |
| native-host (24.19.0, 0.2.0-rc.2) | [114158404531](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267770/job/114158404531) | 890 | 862 | 16 | 12 |
| offline (22.23.2) | [114158404535](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267770/job/114158404535) | 890 | 868 | 16 | 6 |
| offline (24.19.0) | [114158404537](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033267770/job/114158404537) | 890 | 868 | 16 | 6 |

### Follow-up qualifying RED

Tests-only commit: b66de62f190401fc4b79d0d00f99ca898c73435f; tree 4daf8f5a4985d4f3cf0c0257e4de3a2024b5b992. [Run 38033436454](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033436454). All six complete logs match that exact SHA and contain exactly 15 expected assertion failures. The four native logs were inspected before the production fix; the two slower offline jobs subsequently confirmed the same failures. There were no remaining fixture failures.

| Job | Job ID | Tests | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| offline (24.19.0) | [114158899342](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033436454/job/114158899342) | 890 | 869 | 15 | 6 |
| native-host (22.23.2, 0.2.0-rc.2) | [114158899421](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033436454/job/114158899421) | 890 | 863 | 15 | 12 |
| native-host (24.19.0, 0.2.1-alpha.2) | [114158899427](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033436454/job/114158899427) | 890 | 863 | 15 | 12 |
| native-host (22.23.2, 0.2.1-alpha.2) | [114158899491](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033436454/job/114158899491) | 890 | 863 | 15 | 12 |
| offline (22.23.2) | [114158899533](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033436454/job/114158899533) | 890 | 869 | 15 | 6 |
| native-host (24.19.0, 0.2.0-rc.2) | [114158899554](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033436454/job/114158899554) | 890 | 863 | 15 | 12 |

The expected failing tests were:

- legacy test replacement preserves requirements_result=fail failure until root return
- legacy test replacement preserves requirements_result=unverified failure until root return
- legacy test replacement preserves quality_result=fail failure until root return
- legacy test replacement preserves quality_result=unverified failure until root return
- legacy review replacement preserves requirements_result=fail failure until root return
- legacy review replacement preserves requirements_result=unverified failure until root return
- legacy review replacement preserves quality_result=fail failure until root return
- legacy review replacement preserves quality_result=unverified failure until root return
- legacy lead_acceptance replacement preserves requirements_result=fail failure until root return
- legacy lead_acceptance replacement preserves requirements_result=unverified failure until root return
- legacy lead_acceptance replacement preserves quality_result=fail failure until root return
- legacy lead_acceptance replacement preserves quality_result=unverified failure until root return
- legacy cleared revision rejects direct pending through the shared failure gate
- legacy cleared revision rejects direct artifact through the shared failure gate
- legacy cleared revision rejects direct accept through the shared failure gate

The four stage=test cases completed verify, artifact, passing review and acceptance before reporting Missing expected rejection. The four review and four lead_acceptance cases reported Missing expected exception. Direct pending also lacked its required rejection. Direct artifact/accept instead reached E_VERIFICATION_RECEIPT, demonstrating the incorrect recovery guidance rather than the required E_WORKFLOW_STAGE/E_WORKFLOW_EVIDENCE root-return gate. Replay/root-return and all ownership-association controls passed.

### Follow-up final GREEN

Production candidate: 4a5d03755f9674d11682efca88c6a191f7376b2e; tree 009cff0e0d3332a214d57cf6c04d97c242e7102c. [Run 38033601930](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033601930) completed successfully. Every full job log was fetched, checked for the exact candidate SHA, and inspected for all suite totals, failures, skips and native proof summaries.

| Job | Job ID | Tests | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| native-host (24.19.0, 0.2.0-rc.2) | [114159382291](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033601930/job/114159382291) | 890 | 878 | 0 | 12 |
| offline (24.19.0) | [114159382354](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033601930/job/114159382354) | 890 | 884 | 0 | 6 |
| offline (22.23.2) | [114159382363](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033601930/job/114159382363) | 890 | 884 | 0 | 6 |
| native-host (22.23.2, 0.2.0-rc.2) | [114159382374](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033601930/job/114159382374) | 890 | 878 | 0 | 12 |
| native-host (22.23.2, 0.2.1-alpha.2) | [114159382377](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033601930/job/114159382377) | 890 | 878 | 0 | 12 |
| native-host (24.19.0, 0.2.1-alpha.2) | [114159382391](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033601930/job/114159382391) | 890 | 878 | 0 | 12 |

All seventeen new tests passed, including the old-request replay and fresh-generation controls. Existing exact-current tuple, historical completed acceptance replay and restore/budget assertions remain passing and were not weakened. Every native combination additionally passed 40/40 boundary tests, 17 HOST_VERIFIED and 13 ISOLATION_VERIFIED checks, with no model requests. The six offline skips are existing unavailable-host checks; unpacked suites add six repository-only skips, and the separate pinned native pass supplies the host boundary evidence. Both offline benchmark/fault steps succeeded. No new skip, timeout relaxation or claimed production/paid-model result was introduced.

Every first-follow-up tree used its verified 40-character base tree, retained all 191 entries, and was inspected for no deletions/unowned changes before the expected-SHA ref lease. The first report-only handoff commit changed only this report relative to that tested candidate; its exact tree and complete six-file blob manifest were returned to the parent for independent review and final integration verification.

## First persisted-upgrade candidate manifest (superseded)

| File | Blob SHA |
| --- | --- |
| docs/WORKFLOW.md | `c475c9735e9fb1e3205d5408a69f39442dc60966` |
| lib/store/workflow.js | `4250766dd33f52da6310d86f819aa784adb33fa8` |
| lib/workflow/index.js | `1a23f13a25ffed1a8fa8ff45aa17258e38bc124e` |
| tools/tests/nextgen-restore-integration.test.mjs | `e5ef0f51b73839a1a7fae095574007c7b3dcbbd5` |
| tools/tests/workflow-engine.test.mjs | `f7b24d4e394134341c6f8d01048c84f91d327706` |

That handoff additionally contained this report at `docs/superpowers/research/2026-10-10-imperator-audit/task-1-report.md`; its own blob is supplied in the handoff manifest.


## Second PR #61 follow-up: all delivery ancestry and executable recovery

### Independently confirmed findings and approved scope

The clean PR remained unmerged while independent release triage confirmed [P1 discussion 4237110123](https://github.com/86cloudyun-afk/dsh-imperator/pull/61#discussion_r4237110123) (thread PRRT_kwDOU4Tz5s6rCtFW) and [P2 discussion 4237110130](https://github.com/86cloudyun-afk/dsh-imperator/pull/61#discussion_r4237110130) (thread PRRT_kwDOU4Tz5s6rCtFb). This follow-up continued only the original author branch from report head 30232c06f264eae9416960511bff681cb806d701 / tree ff3c62fec4344bc4f17b072e40ceae58161561de. No clean PR, main or other branch was modified.

P1: the earlier historical gate remembered failed reviews but not an unreviewed or passing delivery. The baseline writer could persist R1, start a new verification clearing revision_id to NULL, and persist a replacement R2/review without advancing evidence generation. It could also create R2 directly from the same valid receipt. On upgrade these reachable persisted states could complete a same-generation replacement without root return even when max_reworks=0. Tests use the exact equivalent old SQL writes with real artifacts, receipts and audits, then close the old store and reopen a fresh store object against the durable database. They do not revive a closed instance or fabricate a replacement owner.

The minimal shared gate now queries real workflow_artifact rows matching task, run, current plan and current evidence generation. Replacement refuses any such artifact, independent of workflow stage/current revision. Review and acceptance refuse another artifact in that tuple, using NULL-aware IS NOT; a sole exact-current artifact remains eligible for its first review and passing acceptance. The previous exact-current nonpass check and actual-artifact-associated failed review check are retained. An orphan or unrelated noncurrent review reference is not a delivery; foreign task/plan/generation history does not poison this delivery, while the separate public foreign-run integrity rejection still applies. Explicit root return creates a fresh generation within the unchanged budget. Original request-key replay stays before these gates, including completed historical outcomes.

P2: frozen source/log/restore evidence failure previously instructed task_verify or waiver, although frozen delivery and coding policy forbid those actions. workflowStrictEvidence preserves the real strict receipt check and converts only E_VERIFICATION_RECEIPT in review/lead_acceptance into a budget-aware workflow code/message/hint. Existing error.hint precedence in the real tool wrapper exposes the actionable hint without changing tools/index. With budget, the actual root reads workflow state and returns for rework before owner claim, fresh verification, artifact and independent review. With zero/exhausted budget, the hint requires separate explicit root authorization and a new task; no task or authorization is generated automatically. Ordinary strict tasks and mutable implement/test workflows keep their original retry/waiver behavior.

Acceptance retains both real strict evidence reads. Four regression cases mutate actual source or actual receipt log bytes precisely at the second SQLite receipt query, then let every real SQL statement and evidence check execute. They assert receiptReads=2, an actionable tool-facing workflow error, submitted status and no committed mutation. The first strict read is not reused as a cached result.

### Tests-only RED, before the production push

Tests-only SHA: 6134452e1e378ea50fe56fddd8e4cab54b898f9c; tree 4987d7ed3367e84a3720de3f3513286e00dbf10c. [Run 38040626126](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38040626126). Every full log was fetched and read, and all six failure-name sets were matched exactly, before the production commit was created and pushed. A draft unreferenced Git tree had been prepared after the four native RED logs; it was not committed or attached to any branch until both offline RED logs were also complete and read. All six groups had exactly the same 23 intended failures and no fixture or unrelated failure.

| Job | Job ID | Tests | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| offline (22.23.2) | [114179979061](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38040626126/job/114179979061) | 913 | 884 | 23 | 6 |
| native-host (22.23.2, 0.2.0-rc.2) | [114179979299](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38040626126/job/114179979299) | 913 | 878 | 23 | 12 |
| offline (24.19.0) | [114179979303](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38040626126/job/114179979303) | 913 | 884 | 23 | 6 |
| native-host (22.23.2, 0.2.1-alpha.2) | [114179979319](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38040626126/job/114179979319) | 913 | 878 | 23 | 12 |
| native-host (24.19.0, 0.2.1-alpha.2) | [114179979341](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38040626126/job/114179979341) | 913 | 878 | 23 | 12 |
| native-host (24.19.0, 0.2.0-rc.2) | [114179979342](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38040626126/job/114179979342) | 913 | 878 | 23 | 12 |

The eight ancestry failures are missing rejection/exception assertions; the test/NULL cases reach acceptance on the unfixed writer. Twelve source/log drift cases and three strengthened existing receipt/restore checks fail because the old E_VERIFICATION_RECEIPT response lacks the required workflow recovery contract. The four second-read cases reach both real reads before failing on that old response. The prior fail/unverified, tuple isolation, replay, root-return and immutable-history tests remain intact.

Exact RED failure names:

- restored lead acceptance requires current-root execution and a new independently reviewed artifact
- restored frozen delivery with zero rework budget refuses revalidation without receipt or execution
- modified source and tampered logs invalidate accepted review
- legacy unreviewed delivery stays frozen after persisted test replacement
- legacy unreviewed delivery stays frozen after persisted review replacement
- legacy unreviewed delivery stays frozen after persisted lead_acceptance replacement
- legacy direct artifact replacement of unreviewed delivery freezes even when the receipt is unchanged
- legacy pass delivery stays frozen after persisted test replacement
- legacy pass delivery stays frozen after persisted review replacement
- legacy pass delivery stays frozen after persisted lead_acceptance replacement
- legacy direct artifact replacement of pass delivery freezes even when the receipt is unchanged
- frozen review source drift exposes actionable tool recovery with budget 0
- frozen review source drift exposes actionable tool recovery with budget 1
- frozen review log drift exposes actionable tool recovery with budget 0
- frozen review log drift exposes actionable tool recovery with budget 1
- frozen lead_acceptance source drift exposes actionable tool recovery with budget 0
- frozen lead_acceptance source drift exposes actionable tool recovery with budget 1
- frozen lead_acceptance log drift exposes actionable tool recovery with budget 0
- frozen lead_acceptance log drift exposes actionable tool recovery with budget 1
- frozen acceptance second receipt read maps source drift to budget 0 workflow recovery
- frozen acceptance second receipt read maps source drift to budget 1 workflow recovery
- frozen acceptance second receipt read maps log drift to budget 0 workflow recovery
- frozen acceptance second receipt read maps log drift to budget 1 workflow recovery

### Final candidate GREEN

Candidate SHA: 4524b9e04fb54bbde47b8998548c32bae946808a; tree 700a7a9b582db4ae06a82177da1f9dc6d074c4d5. [Run 38041034332](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38041034332). All six complete job logs were fetched and inspected for this exact SHA, actual suite totals, all failures/skips and native proofs.

| Job | Job ID | Tests | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| offline (24.19.0) | [114181150316](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38041034332/job/114181150316) | 913 | 907 | 0 | 6 |
| native-host (24.19.0, 0.2.1-alpha.2) | [114181150418](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38041034332/job/114181150418) | 913 | 901 | 0 | 12 |
| native-host (22.23.2, 0.2.0-rc.2) | [114181150454](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38041034332/job/114181150454) | 913 | 901 | 0 | 12 |
| native-host (24.19.0, 0.2.0-rc.2) | [114181150487](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38041034332/job/114181150487) | 913 | 901 | 0 | 12 |
| offline (22.23.2) | [114181150499](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38041034332/job/114181150499) | 913 | 907 | 0 | 6 |
| native-host (22.23.2, 0.2.1-alpha.2) | [114181150509](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38041034332/job/114181150509) | 913 | 901 | 0 | 12 |

All 23 added tests pass. Three pre-existing frozen evidence expectations were strengthened to require actionable workflow recovery, with their actual drift/refusal assertions preserved. Positive controls exercise root-return recovery for both unreviewed and passing legacy R1 at test/NULL, review/R2 and lead_acceptance/R2 boundaries; zero-budget sole-current review and acceptance; repeated verification in mutable implement/test; ordinary strict retry and explicit root waiver; artifact/review/accept original-key replay after completed source/log drift; and actual root-authorized fresh task creation when the old budget is zero. Existing failed/unverified, exact-current orphan, unrelated tuple, restored delivery, terminal-history and bounded rework controls remain passing.

Each pinned native combination additionally passes 40/40 boundary tests, 17 HOST_VERIFIED and 13 ISOLATION_VERIFIED checks, with no model requests. Offline suites retain six unavailable-host skips; unpacked suites retain those plus six repository-only skips, and the separate pinned native pass supplies host evidence. Both offline benchmark/fault steps succeed. Existing 60000 ms verification deadlines and 12000 ms host validation bounds remain unchanged. No production host capability or paid-model execution is inferred from this evidence.

### Authorized shared store/index integration hunk

Parent explicitly approved only the import and second strict acceptance call below. Author-branch baseline store/index blob: dc492e855c6a732deda1f800d65327e34b86d98e; candidate blob: bc859c4de031c74f0805e17327435c40e540f61f. This full author blob must not replace the newer integrated Task 2 file. Apply only these two exact substitutions to that shared file and verify all other bytes are unchanged.

Old import:
```js
import { WORKFLOW_DDL, workflowClaim, workflowSubmit, workflowStartDecision, workflowAccept, workflowFinishDecision, workflowVerificationStarted } from './workflow.js'
```
New import:
```js
import { WORKFLOW_DDL, workflowClaim, workflowSubmit, workflowStartDecision, workflowAccept, workflowFinishDecision, workflowVerificationStarted, workflowStrictEvidence } from './workflow.js'
```
Old acceptance call:
```js
      const executionReceipt = strict && waiverReason === null ? strictExecutionEvidence(this.#db(), this.root, row) : null
```
New acceptance call:
```js
      const executionReceipt = strict && waiverReason === null ? workflowStrictEvidence(this.#db(), this.root, row, workflowDecision?.flow, 'accept') : null
```

workflowDecision?.flow is the existing decision snapshot, obtained after workflow role/version/replay handling. Ordinary tasks have no workflow flow. The wrapper rethrows non-receipt errors and mutable-stage receipt errors unchanged. Both workflowAccept and the later store.acceptTask evidence check still execute; matching completed acceptance replay returns before either new check.

### Final candidate manifest and tree preservation

Full candidate tree: [700a7a9b582db4ae06a82177da1f9dc6d074c4d5](https://api.github.com/repos/86cloudyun-afk/dsh-imperator/git/trees/700a7a9b582db4ae06a82177da1f9dc6d074c4d5?recursive=1). The recursive tree contains all 191 entries (168 blobs and 23 directories), is not truncated, and has no deleted paths. Every tree operation used an existing exact 40-character base tree, inspected its complete result, and used an expected-SHA lease for the author-branch update. Only the six assigned paths plus the two authorized store/index substitutions differ across the complete Task 1 work. No other branch was edited.

| File | Candidate blob SHA | Scope |
| --- | --- | --- |
| docs/WORKFLOW.md | `dd47d404212dab5ce4d63dc4c99bf4348bfcab3c` | Owned |
| lib/store/index.js | `bc859c4de031c74f0805e17327435c40e540f61f` | Only the two authorized substitutions |
| lib/store/workflow.js | `d9c21d76f5658256b9bd010fde1c9398b4ed49ea` | Owned |
| lib/workflow/index.js | `7247b401cd32067d5f2ee53ad8849bbbbb686fcd` | Owned |
| tools/tests/nextgen-restore-integration.test.mjs | `b94c02e44bf25eba74d9973311db29f22d7e66dc` | Owned |
| tools/tests/workflow-engine.test.mjs | `573194e4dc7cfc53086412b1451eac7794ef98f5` | Owned |

This report is the sixth owned file. Its final blob, documentation-only commit SHA and tree are supplied in the handoff. The report-only commit does not claim its own matrix run; the parent requested no duplicate documentation-only matrix and retains final integrated exact-head/PR/main verification.

## Limits and remaining concerns

The targeted regressions and existing suite pass on the candidate above. Independent review and integration remain pending; earlier successful candidates did not prove the absence of the later independently discovered issues. Full production deployment, paid-model behavior and whole-tree containment/quiescence are not established by these tests. The cloud environment was unavailable; all execution evidence came from real GitHub Actions, not a claimed local run. No helper/reviewer agents were spawned by this implementer, and no PR, merge or external publication was performed.
