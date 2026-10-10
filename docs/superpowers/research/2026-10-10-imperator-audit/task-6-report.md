# Task 6: Control journal degradation fence

Status: implemented on isolated branch `codex/audit-control-journal-fence`; no PR, merge or main/other-branch mutation.

Requirements: [task-6 brief](../../plans/2026-10-10-imperator-audit/task-6-brief.md) and [linked audit design](../../specs/2026-10-10-imperator-comprehensive-audit-design.md), read at `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`. Production baseline: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`. The environment failed before exposing shell; all edits used structured GitHub tree/commit/ref operations with expected-SHA leases, and all runtime evidence is real GitHub Actions. The repository tree has no AGENTS.md.

## Confirmed defect and minimal change

P1: after a durable child send/stop intent was persisted and its outcome update failed, the real dispatcher resolved the recovery service again. Missing recovery silently used legacy detached mode; a new recovery object backed by a fresh SQLite database recorded another intent. Retrying the same explicit key or trusted turn/step/rootCallId/callId therefore invoked the external effect twice. The baseline tools blob `1ae77acd8a1230cd84caafc78627f5cb569d4839` remained unchanged in both tests-only RED commits.

The tools activation now captures its initially visible recovery journal and binds the first later journal it observes. Before any send/stop effect, a missing, unreadable, closed, malformed or replaced journal fails with `E_CONTROL_JOURNAL_UNAVAILABLE`. An explicit request_key without a journal also fails, including on a new activation. A failed service lookup is distinguished from an absent service, without global state or changes to ordinary service-resolution callers.

The unavailable error carries fixed safe diagnostics and no effect receipt. It proves only that this call did not dispatch; it cannot establish that an earlier same-key effect failed. Its hint preserves the original retry_key/request_key, prohibits new-key repetition and reports the journal fault to the controller. Input/scope/conflict rejections from the recovery API remain intact; post-dispatch unknown-outcome handling and exact key hashing are unchanged. Task 5 independently owns guard interpretation of this error.

Restoring the same journal object returns the original pending/replayed operation without another host invocation or journal mutation. A replacement object requires trusted tools reactivation after the controller verifies the original persistent database. This conservative object binding also rejects replacement objects that might use the same database; it does not attempt to infer database identity from paths. The same TaskforceRecovery object's normal reconnection to its original database remains compatible.

Genuinely detached legacy activations that have never observed a journal and have no explicit key retain their effects and explicitly return durable:false, durability:"unavailable". Trusted coordinates do not invent durability for them. They retain no replay protection. Journal identity does not authenticate same-UID database changes, and no production crash diagnosis is inferred.

Changed implementation/documentation: `lib/tools/index.js`, `docs/RECOVERY.md`, `docs/CONTROL.md`. Added 24 cases in existing `tools/tests/tool-recovery.test.mjs`: 22 negative boundaries and two detached compatibility positives. `tools/tests/nextgen-tool-integration.test.mjs` and `tools/verify-child-control.mjs` are unchanged and remain part of full acceptance. No store, workflow, governor, guard, runtime dependency, package version, CI gate or timeout changes.

## Reproduction and RED

The new tests execute the production tools registration/dispatcher with real temporary SQLite stores. The host context, registry and subagent service are boundary fixtures; sendMessage/interrupt effects are counted there. A real SQLite BEFORE UPDATE trigger on control_operation aborts outcome persistence after the first host acceptance, leaving an actual pending row. The next retry uses either the explicit original key or unchanged trusted coordinates after hiding/replacing the journal. The RED assertion observes effects=2 where effects=1 is required. First-call unavailable/explicit-key cases observe effects=1 where zero is required. Closed/unreadable/malformed cases distinguish safe stable diagnostics from raw or unclassified exceptions.

Both Actions RED runs were completed and all six job logs were read before production changed:

- Initial 20-case tests-only head `dc4c3b5b3f00bb95c91b4973409c0033bb815657`, tree `792c1a72085642e9c8b74bb8cff1e82b0162852b`: [run 38030619401](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030619401). All six jobs failed on the same 18 new assertions; two detached positives passed. Offline: 872 total / 848 pass / 18 fail / 6 skip. Native: 872 total / 842 pass / 18 fail / 12 skip.
- Additional initial-lookup/malformed distinction, still tests-only: head `c734ccc48655a0dda92aeb3107294448445b1b25`, tree `71b2f28f35485c64196ed97807e7da7d77b576f1`: [run 38030813783](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030813783). All six jobs failed on exactly the following 22 new assertions; two detached positives passed. No fixture/setup failure occurred.

```text
pending send with explicit key cannot repeat after journal missing
pending send with explicit key cannot repeat after journal replacement
pending send with trusted coordinates cannot repeat after journal missing
pending send with trusted coordinates cannot repeat after journal replacement
explicit send retry key needs a journal even on a new detached activation
journal observed at activation cannot disappear before the first send
closed journal denies send before a new native effect with safe diagnostics
unreadable replacement recovery denies send without exposing its exception
a fresh key cannot bypass a missing journal after durable send
pending stop with explicit key cannot repeat after journal missing
pending stop with explicit key cannot repeat after journal replacement
pending stop with trusted coordinates cannot repeat after journal missing
pending stop with trusted coordinates cannot repeat after journal replacement
explicit stop retry key needs a journal even on a new detached activation
journal observed at activation cannot disappear before the first stop
closed journal denies stop before a new native effect with safe diagnostics
unreadable replacement recovery denies stop without exposing its exception
a fresh key cannot bypass a missing journal after durable stop
unreadable store resolution cannot authorize initial detached send
malformed initial journal cannot authorize send or leak method diagnostics
unreadable store resolution cannot authorize initial detached stop
malformed initial journal cannot authorize stop or leak method diagnostics
```

| Exact RED job | Job ID | Total | Pass | Fail | Skip | Cancelled |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| offline Node 22.23.2 | 114151191650 | 876 | 848 | 22 | 6 | 0 |
| offline Node 24.19.0 | 114151191792 | 876 | 848 | 22 | 6 | 0 |
| native Node 22.23.2 / DSH 0.2.0-rc.2 | 114151191723 | 876 | 842 | 22 | 12 | 0 |
| native Node 22.23.2 / DSH 0.2.1-alpha.2 | 114151191818 | 876 | 842 | 22 | 12 | 0 |
| native Node 24.19.0 / DSH 0.2.0-rc.2 | 114151191739 | 876 | 842 | 22 | 12 | 0 |
| native Node 24.19.0 / DSH 0.2.1-alpha.2 | 114151191731 | 876 | 842 | 22 | 12 | 0 |

Each native RED job additionally completed 40 native boundary tests (40 pass, zero fail/skip/cancelled), HOST_VERIFIED 17 checks and ISOLATION_VERIFIED 13 checks. These native host checks used installed pinned DSH with no model requests; they do not turn the new boundary-fixture counters into a production incident.

## GREEN

Production fix head `d41ab37361fd45fbd4f8d7a66f0c1fed2cd0d04c`, tree `015a8cda64adff312b5eaa6b00bc6de031a0da67`: [run 38031317435](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031317435). All six jobs completed successfully and every exact-head log was read. All 24 new cases pass, including original-journal restoration/replay and both detached compatibility positives. No GREEN failures occurred.

| Exact GREEN job | Job ID | Total | Pass | Fail | Skip | Cancelled |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| offline (24.19.0) | 114152678510 | 876 | 870 | 0 | 6 | 0 |
| native-host (24.19.0, 0.2.0-rc.2) | 114152678591 | 876 | 864 | 0 | 12 | 0 |
| native-host (22.23.2, 0.2.0-rc.2) | 114152678639 | 876 | 864 | 0 | 12 | 0 |
| native-host (24.19.0, 0.2.1-alpha.2) | 114152678658 | 876 | 864 | 0 | 12 | 0 |
| native-host (22.23.2, 0.2.1-alpha.2) | 114152678663 | 876 | 864 | 0 | 12 | 0 |
| offline (22.23.2) | 114152678671 | 876 | 870 | 0 | 6 | 0 |

Each native GREEN job also passed 40/40 native boundary tests (zero fail/skip/cancelled), HOST_VERIFIED 17 and ISOLATION_VERIFIED 13, with no model requests. Offline verifies checkout sources; native verifies the exact unpacked npm deliverable against both pinned official DSH releases. Existing 60-second acceptance and 12-second cleanup limits were unchanged. No test/filter/assertion or workflow gate was weakened.

## Reproducible source identity and handoff

Use the exact commit references, not a mutable branch, when fetching files or checking out for CI regression. Git's commit tree and per-file blob IDs establish source identity; the existing Actions jobs also preserve their checkout/packed-deliverable evidence. The final handoff head/tree/report blob and its separate six-job workflow result will be supplied to the parent after completion.

Source tree `015a8cda64adff312b5eaa6b00bc6de031a0da67`:

| Owned path | Blob SHA |
| --- | --- |
| `lib/tools/index.js` | `b08e117cfbe00a4d96dd9960b576f8eb320eb138` |
| `tools/tests/tool-recovery.test.mjs` | `93944d152ea01c8f34e0f5d53829ea6d16bc7626` |
| `tools/tests/nextgen-tool-integration.test.mjs` | `41c13c88396a37ef8c2c124bacaf1f641ce3a408` |
| `tools/verify-child-control.mjs` | `99d8e14e71b03653719e91dacba0043a120d4f77` |
| `docs/RECOVERY.md` | `2bffcef9f7cc2e6f15365e6d4a3d57440ba50847` |
| `docs/CONTROL.md` | `5969171dc35a2bfdd13d1db184c3c1520bb6711d` |

The unchanged verification workflow blob is `31b60b2e6372e518bc8e80c99f4e19634e580fda`. Comparing the docs base to the production fix shows only the four changed owned files listed above; the report is the only subsequent change.

Concerns for integration: `lib/tools/index.js` is shared with other audit changes, so retain the control-specific service-read failure signal and journal fence when combining hunks. Parent owns independent review/integration. The per-activation object identity tradeoff and detached limitation are documented above; no unverified new recovery defect is asserted.
