# Task 1 report: frozen workflow delivery

## Status and immutable inputs

Implementation and candidate verification, including the PR #61 persisted-upgrade follow-up, are complete. Independent task/release/PR review and integration remain the parent's responsibility; this implementer created no PR and changed no other branch.

- Requirement: [Task 1 brief](../../plans/2026-10-10-imperator-audit/task-1-brief.md) and [approved audit design](../../specs/2026-10-10-imperator-comprehensive-audit-design.md).
- Production baseline: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`.
- Isolated branch: `codex/audit-workflow-freeze`, created exactly at planning head `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`.
- Verified final production/test/documentation candidate: `4a5d03755f9674d11682efca88c6a191f7376b2e` (initial freeze candidate `8a0b84de21c3de107551ab70e37cce4f9f1a9153`).
- Verified final candidate tree: `009cff0e0d3332a214d57cf6c04d97c242e7102c`.
- This report is a subsequent documentation-only commit. The final six-job follow-up results belong to the candidate above; the original freeze results retain their original immutable SHA below. Neither is presented as an unexecuted report-head run. Per parent coordination, the report-only head is handed back without waiting for a duplicate matrix; final integration/PR exact-head verification belongs to the parent.

## Confirmed causes and correction

The previous artifact path allowed a new revision while already in review or lead_acceptance. The pending execution hook reset either stage to test before a replacement artifact. A fail/unverified review could be followed by pass for the same revision, and acceptance considered only the latest review. Those combinations bypassed root return and its bounded rework budget.

The shared workflowDeliveryGate now rejects artifact replacement and verification from frozen review/lead_acceptance. It also rejects review supersession and acceptance when any nonpassing result belongs to the exact current task/run/revision/plan/evidence generation. Both requirements_result and quality_result participate. The hook executes in the existing synchronous transaction before receipt insertion and before the native executor call.

Exact request replay remains before mutable-work gates. Historical completed decisions remain read-only; root return clears the current revision and advances evidence generation through the existing budgeted path. Unrelated historical revision references/plans/generations do not poison new deliveries; the approved PR #61 supplement below preserves actual same-generation failed deliveries across older-writer replacement revisions. Restored lead_acceptance requires root return, claim, new current-root execution, a new artifact and independent review; zero/exhausted budget refuses this reopening.

No schema, store/index, tools/index, model-tool, package identity, Node/DSH pin, deadline or external dependency changes. The official full-tree adapter remains closed.

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

Only lib/store/workflow.js, tools/tests/workflow-engine.test.mjs and docs/WORKFLOW.md changed for this follow-up; this report is updated separately. No schema migration, store/index or tools/index change is required. The original audit branch continued from e97e3a04918a2cb606f2bdb355fc3bb65b1a2dab; main and the clean PR branch were untouched.

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

Every follow-up tree used its verified 40-character base tree, retained all 191 paths, and was inspected for no deletions/unowned changes before the expected-SHA ref lease. The report-only handoff commit changes only this report relative to the tested candidate; its exact tree and complete six-file blob manifest are returned to the parent for independent review and final integration verification.

## Owned final candidate manifest

| File | Blob SHA |
| --- | --- |
| docs/WORKFLOW.md | `c475c9735e9fb1e3205d5408a69f39442dc60966` |
| lib/store/workflow.js | `4250766dd33f52da6310d86f819aa784adb33fa8` |
| lib/workflow/index.js | `1a23f13a25ffed1a8fa8ff45aa17258e38bc124e` |
| tools/tests/nextgen-restore-integration.test.mjs | `e5ef0f51b73839a1a7fae095574007c7b3dcbbd5` |
| tools/tests/workflow-engine.test.mjs | `f7b24d4e394134341c6f8d01048c84f91d327706` |

The handoff additionally contains this report at `docs/superpowers/research/2026-10-10-imperator-audit/task-1-report.md`; its own blob is supplied in the handoff manifest.

## Limits and remaining concerns

No known Task 1 defect remains after the candidate checks. Full production deployment, paid-model behavior and whole-tree containment/quiescence are not established by these tests. The cloud environment was unavailable; all execution evidence came from real GitHub Actions, not a claimed local run. No helper/reviewer agents were spawned by this implementer. Independent review may identify further issues and has not been represented as complete here.
