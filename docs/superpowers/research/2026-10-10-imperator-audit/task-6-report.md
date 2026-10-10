# Task 6: Control journal degradation fence

Status: implemented and revised after actual PR 62 review on isolated branch `codex/audit-control-journal-fence`; no PR, merge or main/other-branch mutation.

Requirements: [task-6 brief](../../plans/2026-10-10-imperator-audit/task-6-brief.md) and [linked audit design](../../specs/2026-10-10-imperator-comprehensive-audit-design.md), read at `234a7896e44b8d4e19608e3c80ef44a982ddc6ff`. Production baseline: `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`. The environment failed before exposing shell; all edits used structured GitHub tree/commit/ref operations with expected-SHA leases, and all runtime evidence is real GitHub Actions. The repository tree has no AGENTS.md.

## Original defect and initial implementation history

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

## Initial GREEN

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

The unchanged verification workflow blob is `31b60b2e6372e518bc8e80c99f4e19634e580fda`. At the first handoff, comparing the docs base to the production fix showed only the four changed owned files listed above; the initial report-only commit followed. The PR-review revision below supersedes that initial reader and manifest.

Concerns for integration: `lib/tools/index.js` is shared with other audit changes, so retain the control-specific service-read failure signal and journal fence when combining hunks. Parent owns independent review/integration. The per-activation object identity tradeoff and detached limitation are documented above; no unverified new recovery defect is asserted.

## Actual PR 62 review and revised control reader

The actual review threads were read in full: [explicit null recovery](https://github.com/86cloudyun-afk/dsh-imperator/pull/62#discussion_r4236775615) and [normal Cordis miss](https://github.com/86cloudyun-afk/dsh-imperator/pull/62#discussion_r4236775617). Both P2 findings were verified. The first implementation used null both for explicit recovery:null and for detached absence. Its tests used plain object contexts, so a normal undefined primary lookup did not reproduce the real running Cordis proxy's reflective exception. An additional discriminator also showed that a genuine primary exception could be lost when reflection returned a valid SQLite journal.

Both pinned SDK references were read: [rc.2 reflect.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/vendor/cordis/src/reflect.ts) and [alpha.2 reflect.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/vendor/cordis/src/reflect.ts), identical blob `7bbe1ae9919b930230844ec3d4365466a78e90a8`. Their get API explicitly returns undefined for normal unprovided service absence without injection, whereas runtime property reflection throws for non-injected services. The Context and registry implementations were also checked to distinguish the unguarded root context from a running plugin fiber.

The revised control-specific reader prioritizes ctx.get whenever it is callable. Its successful undefined result is authoritative and cannot trigger a reflective lookup. Only legacy contexts without get read the service property. Explicit null for the service or its recovery journal and any real lookup exception become the unreadable sentinel and fail before effects. The ordinary resolveService implementation is restored exactly to the production baseline; the earlier optional failure callback is removed. Object binding, explicit request-key requirements, key hashing, controlIntent continuity, finishControl, unknown-effect envelopes and fixed refused hints are unchanged. No general tool-error handling is expanded.

Ten additional real-SQLite unit cases distinguish null service, null journal, actual primary failure with a valid reflected journal, authoritative undefined with a shadow journal and undefined recovery compatibility, for both send and stop. Six native cases mount the real tools plugin in an actual pinned Cordis runtime fiber with only tools injected, assert normal ctx.get absence and the real proxy throw, and then execute through the installed ToolRuntime. They cover normal absent service, primary-lookup fault injection and explicit null journal for both controls. Host context/Session/registry/tool transport are actual installed SDK objects; effect endpoints are counted boundary fixtures, with no model requests.

### Revised RED evidence

Tests-only head `86fa5eea2deaa5c0815dd0f5800a8a39f316e389`, tree `739ee107cfd348403772670360d8b57a1d6ded1a`: [run 38033145348](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033145348). The previous production tools blob `b08e117cfbe00a4d96dd9960b576f8eb320eb138` was unchanged. All four native jobs completed with the expected eight unit and four native failures before production was changed. The original exact-SHA two offline RED logs were read after their benchmark phases finished; all six logs were read. No fixture failure occurred.

The following are all 12 distinct failing names; the first eight fail in every unit suite, and the last four fail in every native boundary suite:

```text
explicit null-store cannot authorize keyless send
explicit null-journal cannot authorize keyless send
a failed primary store lookup cannot use reflected journal for send
normal undefined primary lookup remains authoritative for detached send
explicit null-store cannot authorize keyless stop
explicit null-journal cannot authorize keyless stop
a failed primary store lookup cannot use reflected journal for stop
normal undefined primary lookup remains authoritative for detached stop
actual native Cordis absent journal boundary for keyless send
actual native Cordis null-journal journal boundary for keyless send
actual native Cordis absent journal boundary for keyless stop
actual native Cordis null-journal journal boundary for keyless stop
```

| Exact revised RED job | Job ID | Unit total/pass/fail/skip | Native total/pass/fail/skip |
| --- | --- | --- | --- |
| offline (24.19.0) | 114158055625 | 886/872/8/6 | — |
| offline (22.23.2) | 114158055753 | 886/872/8/6 | — |
| native-host (24.19.0, 0.2.1-alpha.2) | 114158055801 | 886/866/8/12 | 46/42/4/0 |
| native-host (24.19.0, 0.2.0-rc.2) | 114158055802 | 886/866/8/12 | 46/42/4/0 |
| native-host (22.23.2, 0.2.1-alpha.2) | 114158055838 | 886/866/8/12 | 46/42/4/0 |
| native-host (22.23.2, 0.2.0-rc.2) | 114158055869 | 886/866/8/12 | 46/42/4/0 |

The two undefined-journal unit positives and two actual-native failed-primary negative controls already passed at RED. The normal native absence incorrectly returned E_CONTROL_JOURNAL_UNAVAILABLE before a legacy effect; explicit null incorrectly dispatched one effect without intent; the remaining unit assertions distinguish a shadow journal from an authoritative lookup. Every native RED job still completed HOST_VERIFIED 17 and ISOLATION_VERIFIED 13. All cancelled counts are zero.

### Revised GREEN evidence and final source manifest

Fix head `5488c0c61216d50bfea19f7f9318d8675c273c8c`, tree `cf22978b63283599f58075cc9e163cb0041803c8`: [run 38033318869](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38033318869). All six jobs completed successfully and every exact-head log was read. All earlier 24 control regressions and all 16 new cases pass.

| Exact revised GREEN job | Job ID | Unit total/pass/fail/skip | Native total/pass/fail/skip |
| --- | --- | --- | --- |
| offline (22.23.2) | 114158548397 | 886/880/0/6 | — |
| offline (24.19.0) | 114158548434 | 886/880/0/6 | — |
| native-host (24.19.0, 0.2.0-rc.2) | 114158548443 | 886/874/0/12 | 46/46/0/0 |
| native-host (22.23.2, 0.2.1-alpha.2) | 114158548458 | 886/874/0/12 | 46/46/0/0 |
| native-host (24.19.0, 0.2.1-alpha.2) | 114158548489 | 886/874/0/12 | 46/46/0/0 |
| native-host (22.23.2, 0.2.0-rc.2) | 114158548524 | 886/874/0/12 | 46/46/0/0 |

Every native GREEN job additionally passed HOST_VERIFIED 17 and ISOLATION_VERIFIED 13. Cancelled counts are all zero; no model requests, source/workflow gates or acceptance/cleanup timeout changes occurred.

| Owned path at verified revised source tree | Blob SHA |
| --- | --- |
| `lib/tools/index.js` | `80fa5f11a65c6f8451e1d46fac4b4c3fc41889e7` |
| `tools/tests/tool-recovery.test.mjs` | `8bc6c0412e206d2cc72fc32c01cbf2a216b7c2c4` |
| `tools/tests/host-boundaries.test.mjs` | `f795eb5359e9a4abb1623d37d174887544b6d7c9` |
| `tools/tests/nextgen-tool-integration.test.mjs` | `41c13c88396a37ef8c2c124bacaf1f641ce3a408` |
| `tools/verify-child-control.mjs` | `99d8e14e71b03653719e91dacba0043a120d4f77` |
| `docs/RECOVERY.md` | `c9ab8af8e55dcb26bf4670d063e7c891143eec78` |
| `docs/CONTROL.md` | `4a8c3ff9250d051ab4771d7ed68ef8a9374ce45b` |

### Shared-file integration boundary

This branch's host-boundaries file is exactly its unchanged baseline blob `93ea0aadcf7bc4897f44ac234c641fcd5328f9d3` plus the following new hunk; no other task's source or tests are copied into this branch. The original baseline tail is the existing native settlement/unknown-outcome accounting case, immediately before this appended loop. Root must append this hunk onto Task 4's independently owned host-boundaries blob `656a9cf2fc285f51430e1dbc7fe677713bd5ab93`, retaining its two root-alias cases; replacing that shared file with this branch's complete file would remove those cases. Task 4's two cases need its own execution fix and therefore were deliberately excluded from this isolated Task 6 matrix. The final aggregate matrix belongs to root.

```js
for (const action of ['send', 'stop']) {
  for (const publication of ['absent', 'failed-primary', 'null-journal']) {
    test('actual native Cordis ' + publication + ' journal boundary for keyless ' + action, options, async t => {
      const { ctx, agent } = await fixture(t)
      const { apply: applyTools } = await import('../../lib/tools/index.js')
      const main = agent('cordis-control-root')
      main.session.append('turn/start', { turn: 1 })
      main.session.append('step/start', { turn: 1, step: 1 })
      let effects = 0
      ctx.provide('agents', { get: id => id === main.session.header.id ? main : undefined })
      ctx.provide('subagents', {
        async listChildren() { return [{ id: 'cordis-control-child', mode: 'continuable', createdAt: 0 }] },
        async sendMessage(sender) { assert.equal(sender, main); effects++; return 'cordis-control-message' },
        interrupt(target, authority) { assert.equal(authority.agent, main); effects++ },
      })
      if (publication === 'null-journal') ctx.provide('taskforceStore', { recovery: null })
      await ctx.plugin({
        name: 'native-control-journal-probe',
        inject: ['tools'],
        apply(pluginCtx) {
          assert.ok(pluginCtx.fiber.runtime, 'exercise a running Cordis plugin, not the unguarded root context')
          if (publication !== 'null-journal') {
            assert.equal(pluginCtx.get('taskforceStore'), undefined)
            assert.throws(() => pluginCtx.taskforceStore, /without inject/,
              'the actual proxy reports normal non-injected absence through its reflective exception')
          } else {
            assert.equal(pluginCtx.get('taskforceStore').recovery, null)
          }
          const toolsCtx = publication === 'failed-primary' ? pluginCtx.extend({
            get(name) {
              if (name === 'taskforceStore') throw new Error('PRIVATE_PRIMARY_LOOKUP_FAILURE')
              return pluginCtx.get(name)
            },
          }) : pluginCtx
          applyTools(toolsCtx)
        },
      })
      const nativeResult = await main.ctx.tools.execute({
        agent: main, callId: 'cordis-control-call', name: 'task_child_' + action,
        arguments: { target_id: 'cordis-control-child', ...(action === 'send' ? { message: 'native boundary probe' } : {}) },
        signal: new AbortController().signal,
      })
      assert.equal(nativeResult.isError, false, nativeResult.error?.message)
      const result = JSON.parse(nativeResult.value)
      if (publication === 'absent') {
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.equal(result.operation.durable, false)
        assert.equal(result.operation.durability, 'unavailable')
        assert.equal(effects, 1, 'normal Cordis service absence retains one legacy effect')
      } else {
        assert.equal(effects, 0, 'failed or explicitly null journal must deny before native effect')
        assert.equal(result.code, 'E_CONTROL_JOURNAL_UNAVAILABLE', JSON.stringify(result))
        assert.match(result.hint, /原.*(?:键|retry_key)|retry_key/)
        assert.match(result.hint, /不得换键|禁止.*新.*键/)
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PRIMARY_LOOKUP_FAILURE|without inject/)
        for (const field of ['sent', 'stopped', 'delivery', 'execution']) assert.equal(Object.hasOwn(result, field), false)
      }
    })
  }
}
```

Only the report is changed after the revised source GREEN commit. Its final candidate head/tree/report blob are returned separately; under root's existing handoff rule the repeated report-only matrix and aggregate/PR/main checks are owned by root. The conservative journal-object binding and genuinely detached lack of replay protection remain the documented limitations. Preserve the direct control reader when integrating tools/index; do not reintroduce the obsolete shared-resolver failure callback.
