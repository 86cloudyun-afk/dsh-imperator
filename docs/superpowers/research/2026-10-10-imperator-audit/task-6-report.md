# Task 6: Control journal degradation fence

Status: latest Task6 source candidate b3dc0d7d7d10e5fdc3dd983c9fd632cadd79b146 has six exact-head GREEN jobs with full logs read, after actual PR62 boundary reviews. Work remains isolated on `codex/audit-control-journal-fence`; this implementer created no PR and performed no merge or main/other-branch mutation. Root owns final integration and release review.

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

## Actual PR 62 revision: synchronous durable reply validation

The new actual-PR thread [discussion 4236848441](https://github.com/86cloudyun-afk/dsh-imperator/pull/62#discussion_r4236848441), thread ID `PRRT_kwDOU4Tz5s6rCD5x`, identified another mounted-journal boundary. At the previous candidate `1a6bf2d8f0873cfbde7f4d40c2cfaef61b96ad6e`, callable beginControl returning undefined/null/Promise/incomplete data was blindly spread. The resulting operation had only retry_key and the default `invoke !== false` path called sendMessage/interrupt without a validated durable intent. FinishControl also blindly spread invalid results after a host effect, reporting success with no confirmed outcome. This revision addresses both phases through their shared control boundary. Child send is the resume path; there is no separate task_child_resume API.

The real API was inspected at recovery source blob `f835b2efa38ad23a9988f0570fda6ed3c65633d9` and fixed tools baseline blob `80fa5f11a65c6f8451e1d46fac4b4c3fc41889e7`. beginControl new results are exactly the legal short envelope `{operation_id, invoke:true, replayed:false, durable:true, status:"pending"}` (recovery.js:199). Replay returns publicOperation's full row plus invoke:false/replayed:true/durable:true (line194). Finish returns the full row plus replayed boolean/durable:true, including an immutable matching settled replay (lines202–220). New-intent validation therefore does not require action/caller/target/run/id/process fields absent from the actual new API.

### Distinguishing runtime tests and accurate RED history

Added 238 cases in the existing tool-recovery file: 214 negative regressions and 24 legitimate API controls. All use the actual production tools dispatcher and temporary real SQLite, with only context/service publication and native effect endpoints as counted fixtures. The malformed reply is deliberately injected at the mounted recovery method boundary; this is not a claim that the unmodified TaskforceRecovery or pinned SDK emits those malformed values. Existing actual pinned-native Cordis tests continue to run unchanged.

Before production changes:

- Tests-only `fd6e9e29792434e04670fc389693813fc87d293d`, tree `9233b8eccbf0f46dda1e7fc2938cbed0a5ceb136`, [run38035048257](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035048257): 230 new cases. All six full logs read. Offline1116 total /902 pass /208 fail /6 skip; native1116 /896 pass /208 fail /12 skip. There were206 intended negative failures and two fixture errors, so this round is **not accepted RED**.
- Tests-only `21e95db757b73248618a82d594750af02163e2eb`, tree `707a4a34b5eb904a1f4242524fc599f49b7e3c70`, [run38035219502](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035219502): added8 isolated rejected-Promise child regressions. All six full logs read. Offline1124 /902 pass /216 fail /6 skip; native1124 /896 pass /216 fail /12 skip. There were214 intended negative failures plus the same two fixture errors; also **not accepted RED**.
- The fixture's depth1 missing-parent control still correctly derives the root run from its trusted parent's ID. The two failed positive names were `real unattributed direct-caller envelope remains valid for send` and `real unattributed direct-caller envelope remains valid for stop`. Corrected only this fixture to depth2, where ancestry is genuinely unattributed.
- Effective tests-only `04aacf36b54ecb4e3ebe0855158178c5170c683d`, tree `79aff28c629afe3f0b60e73fbe244e0cc92534ca`, [run38035485460](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035485460): all six full logs read; identical214 failures in each matrix and all24 new legal controls passed. Offline1124 /904 pass /214 fail /6 skip; native1124 /898 pass /214 fail /12 skip. Native boundaries46/46, HOST17/17 and isolation13/13 passed. Cancelled0 everywhere. All four native jobs and their full valid RED logs were observed before the production patch; the two slower offline jobs completed and were read after that source push. The production tools blob remained80fa5f11… throughout all three tests-only heads.

| Effective RED matrix | job ID |
|---|---:|
| offline22.23.2 |114164921082|
| offline24.19.0 |114164921255|
| native22.23.2 /rc.2 |114164921257|
| native22.23.2 /alpha.2 |114164921239|
| native24.19.0 /rc.2 |114164921212|
| native24.19.0 /alpha.2 |114164921323|

Begin-negative variants cover undefined, null, Promise.resolve, a promise decorated with apparently valid fields, an ordinary thenable, empty/short/incomplete data, non-boolean invoke, missing durability/status, and inconsistent new/replay flags. Both actions cross explicit key, trusted coordinates and unavailable coordinates. A real begin first commits pending before its reply is corrupted, ensuring the computed key must be preserved even if no key was supplied. Assertions require zero host effects, stable unavailable diagnostics with only the original retry_key (no claimed durable/status), one actual pending row, and a read-only original-key pending replay after restoring the same journal. Full replay mutations independently test caller/action/target/run/row/process binding.

Finish-negative variants require exactly one host effect followed by E_CONTROL_OUTCOME_UNKNOWN with the original validated pending intent/key and no acceptance receipt. Restoring the method and reusing that key returns pending read-only. Additional cases commit the real accepted outcome *before* corrupting the response; the first response must remain unknown while the original-key follow-up correctly reads accepted, still with one host effect. Thus an invalid return cannot establish that SQLite persistence failed. Host-exception plus malformed-finish cases likewise preserve the original intent/key and prohibit new-key repetition.

Eight independent Node subprocesses run `--unhandled-rejections=strict` for send/stop ×begin/finish ×native/cross-realm Promise.reject(privateError). Cross-realm uses node:vm's runInNewContext. Each child executes the actual dispatcher and real SQLite, yields one event-loop turn and checks the row/key. Effective RED exits1 with the intentional PRIVATE_ASYNC_REPLY sentinel; GREEN must exit0, expose no private sentinel, retain actual pending and preserve zero begin effects or one finish effect. No rejection handler is installed by the test to mask the process failure, and no acceptance/cleanup or CI timeout is changed.

The24 positive controls cover legal five-field new intent plus accepted replay for both actions/all three key modes, actual SQLite failed-outcome-write pending replay, all four real full replay statuses, real immutable finish replay and broken depth2 ancestry producing caller-scoped run_id:null. Existing accepted/pending/rejected/unknown behavior remains intact.

### Minimal phase-specific fix

The source patch snapshots only known control fields once inside a guarded boundary. It validates synchronous non-array object replies; durable:true, strict boolean invoke/replayed and pending new status are required. Replay additionally validates the full public operation and trusted caller/run/action/target tuple. Only a mounted ticket with invoke===true reaches an external effect. Task/evidence fields are null because these tools never pass task_id. Text validation matches the actual API's nonempty/NUL-free/256-UTF8-byte rule; finish error-code normalization matches its actual four-code allowlist.

Native promises are detected with the built-in node:util/types.isPromise, which recognizes cross-realm promises. Promise.prototype.then.call installs fulfillment/rejection consumption on an already-started promise, then the protocol is immediately rejected. Its eventual value is never awaited or used to authorize effects. Ordinary thenables are rejected without invoking their then method. This keeps the real synchronous API intact and prevents unhandled rejection from the invalid return.

Finish validation requires the full bound public operation, the original operation_id, the requested status and normalized message/error fields. Invalid return, getter failure or write failure yields E_CONTROL_OUTCOME_UNKNOWN with the last confirmed intent and original retry key, dropping arbitrary adapter fields/private diagnostics and all effect receipts. Since a committed outcome can precede a lost/bad reply, the final error says “结算写入或回包无法确认”, and its hint explicitly describes the returned intent as the last confirmed state rather than an assertion that the database remains pending. Restore/read the original key; never replace it.

Existing readControlJournal authoritative get/normal-undefined behavior, explicit-null refusal, journal object continuity, exact key hashing, legitimate detached keyless controls and fixed unknown-effect/no-new-key hints remain. Ordinary service resolution and other modules are untouched. No native shared-file change was needed in this round; the prior six-case appended hunk and Task4 integration boundary above still apply unchanged.

### Exact latest source verification

First production patch `107907881633875981dedb2053af9c44226b80b2`, tree `87803b3d8a2dd232035a8c6be725bc2f5d6265ef`, [run38035739123](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035739123). All six full logs from that first patch were read: offline1124/1118 pass/0 fail/6 skip; native1124/1112 pass/0 fail/12 skip plus native boundaries46/46, cancelled0 throughout. Root's source review requested the more precise settlement error text above. Latest source `b3dc0d7d7d10e5fdc3dd983c9fd632cadd79b146`, tree `078175262458a9c9173bf70c715cc1750db680c2`, parent107907… changes only that error string; the following results are from the **latest source**, not inferred from the preceding run.

Latest source [run38035848255](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38035848255) completed all six jobs successfully; every full exact-head log was read. Offline unit1124 total /1118 pass /0 fail /6 skip; native unit1124 /1112 pass /0 fail /12 skip plus native boundaries46/46, HOST17/17 and isolation13/13. Cancelled0 in every suite. All214 accepted RED negatives now pass, all24 real API controls still pass, and all8 strict rejected-Promise children exit0 without the private sentinel. Both Node versions run; the two native host pins are actual installed rc.2/alpha.2. Packed/native and checkout/offline acceptance remain; paid/model requests0, containment adapter remains closed.

| Latest GREEN matrix | job ID | unit total/pass/fail/skip | native boundaries |
|---|---:|---|---|
|offline (24.19.0)|114165978767|1124/1118/0/6|—|
|native-host (22.23.2, 0.2.1-alpha.2)|114165978916|1124/1112/0/12|46/46|
|native-host (22.23.2, 0.2.0-rc.2)|114165978933|1124/1112/0/12|46/46|
|offline (22.23.2)|114165978942|1124/1118/0/6|—|
|native-host (24.19.0, 0.2.1-alpha.2)|114165979038|1124/1112/0/12|46/46|
|native-host (24.19.0, 0.2.0-rc.2)|114165979048|1124/1112/0/12|46/46|


Current source owned-file manifest (the report-only final blob/head/tree are returned separately):

| File | blob |
|---|---|
| `docs/CONTROL.md` | `199ed9904292765fa4148a9bb0bcba9b776588e2` |
| `docs/RECOVERY.md` | `22de4f569357de8df9fc28c20081963796820b8c` |
| `lib/tools/index.js` | `c38e833c1567e9ea63befec406a193eabaf6c0a1` |
| `tools/tests/host-boundaries.test.mjs` | `f795eb5359e9a4abb1623d37d174887544b6d7c9` |
| `tools/tests/nextgen-tool-integration.test.mjs` | `41c13c88396a37ef8c2c124bacaf1f641ce3a408` |
| `tools/tests/tool-recovery.test.mjs` | `8770574e655daf4a0034d6d317fef892e3678869` |
| `tools/verify-child-control.mjs` | `99d8e14e71b03653719e91dacba0043a120d4f77` |

The complete191-entry source tree was inspected (truncated:false). Relative to1a6bf2d8…, only tools/index, existing tool-recovery tests and CONTROL/RECOVERY changed. No shared host file mutation, Task4 source copy, store/workflow/governor/guard/package/workflow/version/main/PR mutation occurred. The workflow blob remains31b60b2e6372e518bc8e80c99f4e19634e580fda and the original60s acceptance/12s cleanup remain. No cloud shell, production deployment, paid model request or incident/crash cause is claimed. Replacing a journal still requires controller verification/reactivation; genuinely detached controls still lack replay protection. Same-UID edits and a shape-valid adapter lying about its database are outside this API-boundary guarantee.

### All214 effective RED failure names

These names were read from each of the six full effective RED logs and their deduplicated sets are identical. The206 original malformed-envelope negatives are included here; the two fixture-positive failures above separately record the earlier208/216 rounds.

- invalid begin undefined blocks send with explicit key
- invalid begin null blocks send with explicit key
- invalid begin promise blocks send with explicit key
- invalid begin decorated promise blocks send with explicit key
- invalid begin thenable blocks send with explicit key
- invalid begin empty blocks send with explicit key
- invalid begin missing operation id blocks send with explicit key
- invalid begin empty operation id blocks send with explicit key
- invalid begin missing invoke blocks send with explicit key
- invalid begin null invoke blocks send with explicit key
- invalid begin string invoke blocks send with explicit key
- invalid begin numeric invoke blocks send with explicit key
- invalid begin missing status blocks send with explicit key
- invalid begin not durable blocks send with explicit key
- invalid begin new accepted blocks send with explicit key
- invalid begin new replayed blocks send with explicit key
- invalid begin short replay blocks send with explicit key
- invalid finish undefined keeps send unknown with explicit key
- invalid finish null keeps send unknown with explicit key
- invalid finish promise keeps send unknown with explicit key
- invalid finish decorated promise keeps send unknown with explicit key
- invalid finish thenable keeps send unknown with explicit key
- invalid finish empty keeps send unknown with explicit key
- invalid finish short intent keeps send unknown with explicit key
- invalid finish wrong operation keeps send unknown with explicit key
- invalid finish wrong status keeps send unknown with explicit key
- invalid finish wrong message keeps send unknown with explicit key
- invalid finish not durable keeps send unknown with explicit key
- invalid finish missing row identity keeps send unknown with explicit key
- invalid finish wrong caller keeps send unknown with explicit key
- invalid finish wrong target keeps send unknown with explicit key
- invalid begin undefined blocks send with trusted coordinates
- invalid begin null blocks send with trusted coordinates
- invalid begin promise blocks send with trusted coordinates
- invalid begin decorated promise blocks send with trusted coordinates
- invalid begin thenable blocks send with trusted coordinates
- invalid begin empty blocks send with trusted coordinates
- invalid begin missing operation id blocks send with trusted coordinates
- invalid begin empty operation id blocks send with trusted coordinates
- invalid begin missing invoke blocks send with trusted coordinates
- invalid begin null invoke blocks send with trusted coordinates
- invalid begin string invoke blocks send with trusted coordinates
- invalid begin numeric invoke blocks send with trusted coordinates
- invalid begin missing status blocks send with trusted coordinates
- invalid begin not durable blocks send with trusted coordinates
- invalid begin new accepted blocks send with trusted coordinates
- invalid begin new replayed blocks send with trusted coordinates
- invalid begin short replay blocks send with trusted coordinates
- invalid finish undefined keeps send unknown with trusted coordinates
- invalid finish null keeps send unknown with trusted coordinates
- invalid finish promise keeps send unknown with trusted coordinates
- invalid finish decorated promise keeps send unknown with trusted coordinates
- invalid finish thenable keeps send unknown with trusted coordinates
- invalid finish empty keeps send unknown with trusted coordinates
- invalid finish short intent keeps send unknown with trusted coordinates
- invalid finish wrong operation keeps send unknown with trusted coordinates
- invalid finish wrong status keeps send unknown with trusted coordinates
- invalid finish wrong message keeps send unknown with trusted coordinates
- invalid finish not durable keeps send unknown with trusted coordinates
- invalid finish missing row identity keeps send unknown with trusted coordinates
- invalid finish wrong caller keeps send unknown with trusted coordinates
- invalid finish wrong target keeps send unknown with trusted coordinates
- invalid begin undefined blocks send with no coordinates
- invalid begin null blocks send with no coordinates
- invalid begin promise blocks send with no coordinates
- invalid begin decorated promise blocks send with no coordinates
- invalid begin thenable blocks send with no coordinates
- invalid begin empty blocks send with no coordinates
- invalid begin missing operation id blocks send with no coordinates
- invalid begin empty operation id blocks send with no coordinates
- invalid begin missing invoke blocks send with no coordinates
- invalid begin null invoke blocks send with no coordinates
- invalid begin string invoke blocks send with no coordinates
- invalid begin numeric invoke blocks send with no coordinates
- invalid begin missing status blocks send with no coordinates
- invalid begin not durable blocks send with no coordinates
- invalid begin new accepted blocks send with no coordinates
- invalid begin new replayed blocks send with no coordinates
- invalid begin short replay blocks send with no coordinates
- invalid finish undefined keeps send unknown with no coordinates
- invalid finish null keeps send unknown with no coordinates
- invalid finish promise keeps send unknown with no coordinates
- invalid finish decorated promise keeps send unknown with no coordinates
- invalid finish thenable keeps send unknown with no coordinates
- invalid finish empty keeps send unknown with no coordinates
- invalid finish short intent keeps send unknown with no coordinates
- invalid finish wrong operation keeps send unknown with no coordinates
- invalid finish wrong status keeps send unknown with no coordinates
- invalid finish wrong message keeps send unknown with no coordinates
- invalid finish not durable keeps send unknown with no coordinates
- invalid finish missing row identity keeps send unknown with no coordinates
- invalid finish wrong caller keeps send unknown with no coordinates
- invalid finish wrong target keeps send unknown with no coordinates
- invalid replay wrong caller is refused for send
- invalid replay wrong action is refused for send
- invalid replay wrong target is refused for send
- invalid replay wrong run is refused for send
- invalid replay missing row id is refused for send
- invalid replay missing process is refused for send
- committed outcome with invalid finish undefined retains send original key
- host exception and invalid finish undefined preserve send unknown intent
- committed outcome with invalid finish promise retains send original key
- host exception and invalid finish promise preserve send unknown intent
- invalid begin undefined blocks stop with explicit key
- invalid begin null blocks stop with explicit key
- invalid begin promise blocks stop with explicit key
- invalid begin decorated promise blocks stop with explicit key
- invalid begin thenable blocks stop with explicit key
- invalid begin empty blocks stop with explicit key
- invalid begin missing operation id blocks stop with explicit key
- invalid begin empty operation id blocks stop with explicit key
- invalid begin missing invoke blocks stop with explicit key
- invalid begin null invoke blocks stop with explicit key
- invalid begin string invoke blocks stop with explicit key
- invalid begin numeric invoke blocks stop with explicit key
- invalid begin missing status blocks stop with explicit key
- invalid begin not durable blocks stop with explicit key
- invalid begin new accepted blocks stop with explicit key
- invalid begin new replayed blocks stop with explicit key
- invalid begin short replay blocks stop with explicit key
- invalid finish undefined keeps stop unknown with explicit key
- invalid finish null keeps stop unknown with explicit key
- invalid finish promise keeps stop unknown with explicit key
- invalid finish decorated promise keeps stop unknown with explicit key
- invalid finish thenable keeps stop unknown with explicit key
- invalid finish empty keeps stop unknown with explicit key
- invalid finish short intent keeps stop unknown with explicit key
- invalid finish wrong operation keeps stop unknown with explicit key
- invalid finish wrong status keeps stop unknown with explicit key
- invalid finish wrong message keeps stop unknown with explicit key
- invalid finish not durable keeps stop unknown with explicit key
- invalid finish missing row identity keeps stop unknown with explicit key
- invalid finish wrong caller keeps stop unknown with explicit key
- invalid finish wrong target keeps stop unknown with explicit key
- invalid begin undefined blocks stop with trusted coordinates
- invalid begin null blocks stop with trusted coordinates
- invalid begin promise blocks stop with trusted coordinates
- invalid begin decorated promise blocks stop with trusted coordinates
- invalid begin thenable blocks stop with trusted coordinates
- invalid begin empty blocks stop with trusted coordinates
- invalid begin missing operation id blocks stop with trusted coordinates
- invalid begin empty operation id blocks stop with trusted coordinates
- invalid begin missing invoke blocks stop with trusted coordinates
- invalid begin null invoke blocks stop with trusted coordinates
- invalid begin string invoke blocks stop with trusted coordinates
- invalid begin numeric invoke blocks stop with trusted coordinates
- invalid begin missing status blocks stop with trusted coordinates
- invalid begin not durable blocks stop with trusted coordinates
- invalid begin new accepted blocks stop with trusted coordinates
- invalid begin new replayed blocks stop with trusted coordinates
- invalid begin short replay blocks stop with trusted coordinates
- invalid finish undefined keeps stop unknown with trusted coordinates
- invalid finish null keeps stop unknown with trusted coordinates
- invalid finish promise keeps stop unknown with trusted coordinates
- invalid finish decorated promise keeps stop unknown with trusted coordinates
- invalid finish thenable keeps stop unknown with trusted coordinates
- invalid finish empty keeps stop unknown with trusted coordinates
- invalid finish short intent keeps stop unknown with trusted coordinates
- invalid finish wrong operation keeps stop unknown with trusted coordinates
- invalid finish wrong status keeps stop unknown with trusted coordinates
- invalid finish wrong message keeps stop unknown with trusted coordinates
- invalid finish not durable keeps stop unknown with trusted coordinates
- invalid finish missing row identity keeps stop unknown with trusted coordinates
- invalid finish wrong caller keeps stop unknown with trusted coordinates
- invalid finish wrong target keeps stop unknown with trusted coordinates
- invalid begin undefined blocks stop with no coordinates
- invalid begin null blocks stop with no coordinates
- invalid begin promise blocks stop with no coordinates
- invalid begin decorated promise blocks stop with no coordinates
- invalid begin thenable blocks stop with no coordinates
- invalid begin empty blocks stop with no coordinates
- invalid begin missing operation id blocks stop with no coordinates
- invalid begin empty operation id blocks stop with no coordinates
- invalid begin missing invoke blocks stop with no coordinates
- invalid begin null invoke blocks stop with no coordinates
- invalid begin string invoke blocks stop with no coordinates
- invalid begin numeric invoke blocks stop with no coordinates
- invalid begin missing status blocks stop with no coordinates
- invalid begin not durable blocks stop with no coordinates
- invalid begin new accepted blocks stop with no coordinates
- invalid begin new replayed blocks stop with no coordinates
- invalid begin short replay blocks stop with no coordinates
- invalid finish undefined keeps stop unknown with no coordinates
- invalid finish null keeps stop unknown with no coordinates
- invalid finish promise keeps stop unknown with no coordinates
- invalid finish decorated promise keeps stop unknown with no coordinates
- invalid finish thenable keeps stop unknown with no coordinates
- invalid finish empty keeps stop unknown with no coordinates
- invalid finish short intent keeps stop unknown with no coordinates
- invalid finish wrong operation keeps stop unknown with no coordinates
- invalid finish wrong status keeps stop unknown with no coordinates
- invalid finish wrong message keeps stop unknown with no coordinates
- invalid finish not durable keeps stop unknown with no coordinates
- invalid finish missing row identity keeps stop unknown with no coordinates
- invalid finish wrong caller keeps stop unknown with no coordinates
- invalid finish wrong target keeps stop unknown with no coordinates
- invalid replay wrong caller is refused for stop
- invalid replay wrong action is refused for stop
- invalid replay wrong target is refused for stop
- invalid replay wrong run is refused for stop
- invalid replay missing row id is refused for stop
- invalid replay missing process is refused for stop
- committed outcome with invalid finish undefined retains stop original key
- host exception and invalid finish undefined preserve stop unknown intent
- committed outcome with invalid finish promise retains stop original key
- host exception and invalid finish promise preserve stop unknown intent
- rejected native promise from begin does not crash send
- rejected cross realm promise from begin does not crash send
- rejected native promise from finish does not crash send
- rejected cross realm promise from finish does not crash send
- rejected native promise from begin does not crash stop
- rejected cross realm promise from begin does not crash stop
- rejected native promise from finish does not crash stop
- rejected cross realm promise from finish does not crash stop

After latest source verification only this report is committed. Root owns independent source/diff review, shared-hunk integration, repeated report-only matrix if desired, final aggregate/actual-PR audits and expected-head merge; this implementer does not merge or create PRs.
