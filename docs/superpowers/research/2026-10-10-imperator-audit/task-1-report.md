# Task 1 report: frozen workflow delivery

## Status and immutable inputs

Implementation and candidate verification complete. Independent task/release/PR review and integration remain the parent's responsibility; this implementer created no PR and changed no other branch.

- Requirement: [Task 1 brief](../../plans/2026-10-10-imperator-audit/task-1-brief.md) and [approved audit design](../../specs/2026-10-10-imperator-comprehensive-audit-design.md).
- Production baseline: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`.
- Isolated branch: `codex/audit-workflow-freeze`, created exactly at planning head `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`.
- Verified production/test/documentation candidate: `8a0b84de21c3de107551ab70e37cce4f9f1a9153`.
- Verified candidate tree: `767c48960016d44e3743147b09eb1cfd6a887d28`.
- This report is a subsequent documentation-only commit. The six-job results below belong to the candidate above, not to an unexecuted report-head run. Per parent coordination, the report-only head is handed back without waiting for a duplicate matrix; final integration/PR exact-head verification belongs to the parent.

## Confirmed causes and correction

The previous artifact path allowed a new revision while already in review or lead_acceptance. The pending execution hook reset either stage to test before a replacement artifact. A fail/unverified review could be followed by pass for the same revision, and acceptance considered only the latest review. Those combinations bypassed root return and its bounded rework budget.

The shared workflowDeliveryGate now rejects artifact replacement and verification from frozen review/lead_acceptance. It also rejects review supersession and acceptance when any nonpassing result belongs to the exact current task/run/revision/plan/evidence generation. Both requirements_result and quality_result participate. The hook executes in the existing synchronous transaction before receipt insertion and before the native executor call.

Exact request replay remains before mutable-work gates. Historical completed decisions remain read-only; root return clears the current revision and advances evidence generation through the existing budgeted path. Unrelated historical revisions/plans/generations do not poison new deliveries. Restored lead_acceptance requires root return, claim, new current-root execution, a new artifact and independent review; zero/exhausted budget refuses this reopening.

No schema, store/index, tools/index, model-tool, package identity, Node/DSH pin, deadline or external dependency changes. The official full-tree adapter remains closed.

## Test contract and discriminating coverage

The former lead_acceptance test that admitted a new pending execution was replaced under the approved freeze contract. Its source/log tampering acceptance checks remain. New tests assert denial for both the real verification API and direct pending host hook, no new receipt/audit/revision, and no native executor call.

Coverage includes unreviewed/fail/unverified/pass delivery freezes; changed source after failure; both review dimensions and different reviewer sessions; synthetic pre-upgrade active fail-to-pass history; exact tuple isolation; original artifact/review request replay before and after completion; historical terminal acceptance replay; root return to a fresh valid revision; exhausted budget; restored lead_acceptance recovery and max_reworks=0 refusal. Real SQLite, actual source/log evidence and actual Node syntax-check subprocesses are used.

An intermediate tests-only run [38030598342](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030598342) exposed one fixture error in “historical completed fail-then-pass outcome keeps original acceptance replay read-only”: a new terminal request used the pre-acceptance expected_version and hit E_WORKFLOW_VERSION before E_TERMINAL. The fixture was corrected to read the current version. No production change preceded the corrected RED below.

## RED evidence

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

## GREEN evidence

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

## Owned candidate manifest

| File | Blob SHA |
| --- | --- |
| docs/WORKFLOW.md | `f15ce59603f5c0ce0add2c17c566964f003146d5` |
| lib/store/workflow.js | `92078f44c00f0721e7f61cbe27a431e3530f1940` |
| lib/workflow/index.js | `1a23f13a25ffed1a8fa8ff45aa17258e38bc124e` |
| tools/tests/nextgen-restore-integration.test.mjs | `e5ef0f51b73839a1a7fae095574007c7b3dcbbd5` |
| tools/tests/workflow-engine.test.mjs | `ba688fea6bdab7af9783599973d8e79b5c0b2600` |

The handoff additionally contains this report at `docs/superpowers/research/2026-10-10-imperator-audit/task-1-report.md`; its own blob is supplied in the handoff manifest.

## Limits and remaining concerns

No known Task 1 defect remains after the candidate checks. Full production deployment, paid-model behavior and whole-tree containment/quiescence are not established by these tests. The cloud environment was unavailable; all execution evidence came from real GitHub Actions, not a claimed local run. No helper/reviewer agents were spawned by this implementer. Independent review may identify further issues and has not been represented as complete here.
