import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { TASKFORCE_DEFINITION } from '../../lib/preset.js'

const moduleUrl = new URL('../verify-model.mjs', import.meta.url)
const api = () => import(moduleUrl.href).catch(() => ({}))
const root = resolve(new URL('../..', import.meta.url).pathname)
const goodMoney = 'export function sumMoney(a) { if (a.some(x => !Number.isFinite(x))) throw new TypeError(); return a.reduce((s,x) => s + Math.round(x*100),0)/100 }'
function setup(t, fault, afterStage = () => {}) {
  const outputDir = mkdtempSync(join(tmpdir(), 'model-report-test-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  let disposed = false
  const factory = async ({ workspace, onRequest }) => {
    const sessions = [{ id: 'root', parent: null, events: [] }]
    const tasks = []
    let n = 0
    return {
      hostVersion: '0.2.0-rc.2', rootId: 'root',
      async runStage(stage) {
        n++
        if (fault === 'timeout') return new Promise(() => {})
        if (fault === 'error') throw new Error('reasoning sk-secret marker credentials')
        await onRequest({ agentId: 'root', turn: n, step: 1 })
        if (fault === 'concurrent-pending') {
          await onRequest({ agentId: 'root', turn: n, step: 2 })
          sessions[0].events.push({ type: 'assistant/message', data: { turn: n, step: 2, usage: { inputTokens: 1, outputTokens: 1 }, message: { source: { provider: 'test-provider', model: 'test-model' }, content: [] } } })
        }
        if (fault === 'cap') await onRequest({ agentId: 'root', turn: n, step: 2 })
        sessions[0].events.push({ type: 'assistant/message', data: { turn: n, step: 1, usage: fault === 'usage' ? undefined : { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1 }, message: { source: { provider: 'test-provider', model: fault === 'route' ? 'unexpected' : 'test-model' }, content: [{ type: 'text', text: '137; reasoning sk-secret marker' }] } } })
        if (fault === 'readonly-write') writeFileSync(join(workspace, 'README.md'), 'changed')
        if (fault === 'native-error') sessions[0].events.push({ type: 'turn/end', data: { reason: { kind: 'error', error: 'sk-secret' } } })
        if (stage.name !== 'readonly') {
          if (stage.name === 'repair') sessions.push({ id: 'worker', parent: 'root', events: [] })
          if (fault !== 'worker-not-run') {
            await onRequest({ agentId: 'worker', turn: n, step: 1 })
            sessions[1].events.push({ type: 'assistant/message', data: { turn: n, step: 1, usage: { inputTokens: 2, outputTokens: 3 }, message: { source: { provider: 'test-provider', model: 'test-model' }, content: [] } } })
          }
          if (fault === 'ptc-caught') sessions[1].events.push(
            { type: 'tool/call', data: { turn: n, step: 1, callId: 'outer', name: 'run_code' } },
            { type: 'tool/ptc-dispatch-start', data: { rootCallId: 'outer', subCallId: 'inner', name: 'read', arguments: { path: 'missing' } } },
            { type: 'tool/ptc-dispatch', data: { rootCallId: 'outer', subCallId: 'inner', name: 'read', isError: true } },
            { type: 'tool/result', data: { turn: n, step: 1, callId: 'outer', message: { isError: false } } },
          )
          if (fault === 'new-worker') sessions.push({ id: 'unwanted', parent: 'root', events: [] })
          if (fault !== 'fake') writeFileSync(join(workspace, 'money.mjs'), goodMoney)
          if (fault === 'early-exit') writeFileSync(join(workspace, 'money.mjs'), 'process.exit(0); export function sumMoney() {}')
          writeFileSync(join(workspace, 'money.test.mjs'), '// deleted all model tests; independent grader must still work')
          sessions[1].events.push({ type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
          sessions[0].events.push({ type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'worker' } } })
          if (stage.name !== 'repair' && fault !== 'no-reuse') sessions[0].events.push({ type: 'tool/call', data: { name: 'task_child_send', arguments: JSON.stringify({ target_id: fault === 'wrong-target' ? 'other' : 'worker' }) } })
          tasks.push({ id: n, status: fault === 'acceptance' ? 'submitted' : 'accepted', owner_session: 'worker', evidence_policy: stage.name === 'strict' ? 'execution' : 'legacy', facts: 2, evidence: stage.name === 'strict' ? 0 : 1, waived: false, strictVerified: stage.name === 'strict' && fault !== 'receipt' })
        }
        await afterStage({ stage, sessions, tasks, onRequest, turn: n })
      },
      snapshot: () => ({ sessions, tasks, settled: fault !== 'unsettled' }),
      cancel() {}, async dispose() { disposed = true; if (fault === 'cleanup') { process.exitCode = 0; throw new Error('sk-secret') } },
    }
  }
  return { options: { modelCalls: true, installAnchor: '/unused/native/package.json', provider: 'test-provider', model: 'test-model', outputDir, stageTimeoutMs: 3000 }, factory, disposed: () => disposed, outputDir }
}

function modelObservationProjection(agentSlot = 0) {
  return { stageIndex: 0, phase: 'before-cancel', elapsedMs: 1, coverage: 'complete', truncated: false, saturated: false,
    agents: [0, 1].map(slot => ({ agentSlot: slot, parentSlot: slot ? 0 : null, role: slot ? 'worker' : 'root',
      lifetime: slot, status: slot === agentSlot ? 'running' : 'idle', turn: slot === agentSlot ? 7 : null,
      step: slot === agentSlot ? 2 : null, lastEvent: null, lastSeq: null, lastElapsedMs: null,
      requests: slot === agentSlot ? 1 : 0, turnStarts: 0, turnEnds: 0, lastEndReason: null, pendingIdleWaits: slot === agentSlot ? 1 : 0,
      mode: slot ? 'continuable' : 'unknown', activations: 0, requiredNotices: 0, deliveredNotices: 0, missingNotices: 0 })),
    requests: [{ requestIndex: 0, stageIndex: 0, agentSlot, lifetime: agentSlot, turn: 7, step: 2,
      admittedElapsedMs: 0, lastChunkElapsedMs: 1, chunks: 1, usageSeen: false, finishSeen: false,
      finishKind: null, ended: false, complete: false, assistantMessageSeen: false, assistantSeq: null,
      cancelAlreadyRequested: false, firstFailure: null, failurePhase: null }],
    tasks: { available: false, observedPhase: null, elapsedMs: null, rows: [], truncated: false },
    taskTail: [], ordinaryTail: [], taskDropped: 0, ordinaryDropped: 0, firstFailure: null }
}

test('model observation preserves the request owner before cancellation independently of identical legacy counters', async t => {
  const { runModelVerification } = await api()
  const reports = []
  for (const agentSlot of [0, 1]) {
    const h = setup(t, 'timeout'), projection = modelObservationProjection(agentSlot)
    reports.push(await runModelVerification({ ...h.options, stageTimeoutMs: 20 }, { createHarness: async config => {
      const harness = await h.factory(config)
      harness.snapshot().sessions.push({ id: 'worker', parent: 'root', events: [] })
      return { ...harness, beginModelObservationStage() {},
        async runStage() {
          config.onRequest({ agentId: agentSlot === 0 ? 'root' : 'worker', turn: 7, step: 2 })
          return new Promise(() => {})
        },
        modelObservationSnapshot(phase) { return { ...projection, phase } },
        cancel() { projection.requests[0].ended = true; projection.requests[0].firstFailure = 'stream-error'; projection.requests[0].failurePhase = 'after-cancel' },
      }
    } }))
  }
  assert.deepEqual(reports.map(r => r.failure), ['timeout', 'timeout'])
  assert.deepEqual(reports.map(r => r.stages[0].requests), [1, 1])
  assert.deepEqual(reports.map(r => r.stages[0].timeoutObservations?.requests[0].agentSlot), [0, 1],
    'the saved pre-cancel report must distinguish the actual observed request owners')
  for (const report of reports) {
    const stage = report.stages[0]
    assert.equal(stage.timeoutObservations.requests[0].ended, false)
    assert.equal(stage.timeoutObservations.requests[0].firstFailure, null)
    const request = stage.timeoutObservations.requests[0]
    const owner = stage.timeoutObservations.agents.find(row => row.agentSlot === request.agentSlot)
    assert.equal(owner.status, 'running')
    assert.equal(owner.requests, 1)
    assert.equal(owner.lifetime, request.lifetime)
    assert.equal(owner.turn, request.turn)
    assert.equal(owner.step, request.step)
    assert.equal(stage.observations.requests[0].ended, true)
    assert.equal(stage.observations.requests[0].failurePhase, 'after-cancel')
    assert.equal(stage.timeoutObservations.source, 'custom-harness-unverified')
    assert.deepEqual(Object.keys(stage.timeoutProgress).sort(), ['lastRequestElapsedMs', 'settlement'])
  }
})

test('runner is import-safe and requires explicit model opt-in before constructing a harness', async () => {
  const { runModelVerification } = await api()
  assert.equal(typeof runModelVerification, 'function', 'missing import-safe runModelVerification')
  let calls = 0
  await assert.rejects(runModelVerification({}, { createHarness: () => { calls++ } }), /model-calls/)
  assert.equal(calls, 0)
})

test('request and timeout limits reject invalid or unsafe values before host boot', async () => {
  const { runModelVerification } = await api()
  assert.equal(typeof runModelVerification, 'function')
  for (const [key, values] of Object.entries({ requestCap: [0, -1, 0.5, Infinity, '80', 81], stageTimeoutMs: [0, -1, NaN, 0.1, '180000', 2147483648] })) {
    for (const value of values) await assert.rejects(runModelVerification({ modelCalls: true, [key]: value }), TypeError)
  }
})

for (const fault of ['timeout', 'error', 'acceptance', 'usage', 'cap', 'fake', 'receipt', 'unsettled', 'readonly-write', 'new-worker', 'no-reuse', 'wrong-target', 'worker-not-run', 'native-error', 'early-exit', 'cleanup', 'route', 'ptc-caught']) {
  test(`model ${fault} cannot produce a successful report and always disposes`, async t => {
    const { runModelVerification } = await api()
    assert.equal(typeof runModelVerification, 'function')
    const h = setup(t, fault)
    if (fault === 'timeout') h.options.stageTimeoutMs = 10
    if (fault === 'cap') h.options.requestCap = 1
    const report = await runModelVerification(h.options, { createHarness: h.factory })
    assert.equal(report.ok, false)
    if (fault === 'cap') { assert.equal(report.failure, 'request-cap'); assert.equal(report.requests, 1) }
    if (fault === 'timeout') assert.equal(report.failure, 'timeout')
    if (fault === 'ptc-caught') assert.equal(report.failure, 'usage-or-runtime-error')
    assert.equal(h.disposed(), true)
    const json = readFileSync(join(h.outputDir, 'report.json'), 'utf8')
    assert.doesNotMatch(json, /sk-secret|reasoning|credentials|marker/)
    assert.equal(JSON.parse(json).ok, false)
  })
}

test('successful fixed stages include independent 4/8 checks, reuse, acceptance and allowlisted provenance', async t => {
  const { runModelVerification } = await api()
  assert.equal(typeof runModelVerification, 'function')
  const h = setup(t)
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  assert.equal(report.ok, true)
  assert.deepEqual(report.stages.map(s => s.independentChecks), [1, 4, 8, 8])
  assert.deepEqual(report.stages.map(s => s.newWorkers), [0, 1, 0, 0])
  assert.equal(report.stages[2].reuse, 1)
  assert.deepEqual(report.stages[3].closure.tasks.map(task => task.evidencePolicy), ['legacy', 'legacy', 'execution'])
  assert.equal(report.requests, 7)
  assert.equal(report.usage.inputTokens, 14)
  assert.match(report.provenance.sourceSha256, /^[0-9a-f]{64}$/)
  assert.equal(report.provenance.packageVersion, JSON.parse(readFileSync(join(root, 'package.json'))).version)
  assert.equal(h.disposed(), true)
  assert.doesNotMatch(JSON.stringify(report), /sk-secret|reasoning|credentials|marker/)
})

for (const stageName of ['repair', 'reuse']) {
  test(`${stageName} rejects execution policy even with accepted tasks and a valid receipt`, async t => {
    const { runModelVerification } = await api()
    const h = setup(t, undefined, ({ stage, tasks }) => {
      if (stage.name !== stageName) return
      tasks.at(-1).evidence_policy = 'execution'
      tasks.at(-1).strictVerified = true
    })
    const report = await runModelVerification(h.options, { createHarness: h.factory })
    assert.equal(report.ok, false)
    assert.equal(report.failure, 'evidence-policy')
    const stage = report.stages.at(-1)
    assert.equal(stage.name, stageName)
    assert.equal(stage.ok, false)
    assert.equal(stage.accepted, 1)
    assert.equal(stage.closure.ok, true, 'policy mismatch is distinct from accepted-task closure')
    assert.equal(stage.closure.tasks.at(-1).evidencePolicy, 'execution')
    assert.equal(stage.closure.tasks.at(-1).strictVerified, true)
    assert.deepEqual(stage.runtimeDiagnostics.failureCodes, [])
    assert.equal(h.disposed(), true)
  })
}

test('strict stage still rejects legacy policy even when the receipt flag is true', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, undefined, ({ stage, tasks }) => {
    if (stage.name !== 'strict') return
    tasks.at(-1).evidence_policy = 'legacy'
    tasks.at(-1).evidence = 1
  })
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  assert.equal(report.ok, false)
  assert.equal(report.failure, 'strict-receipt')
  assert.equal(report.stages.at(-1).name, 'strict')
  assert.equal(report.stages.at(-1).closure.ok, true)
})

test('product fingerprint follows content and paths, not timestamps or unrelated reports', async t => {
  const { productFingerprint } = await api()
  assert.equal(typeof productFingerprint, 'function')
  const dir = mkdtempSync(join(tmpdir(), 'model-fingerprint-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'lib')); mkdirSync(join(dir, 'tools'))
  writeFileSync(join(dir, 'package.json'), '{}'); writeFileSync(join(dir, 'cordis.patch.yml'), '[]')
  writeFileSync(join(dir, 'lib/a.js'), 'one')
  const before = productFingerprint(dir)
  writeFileSync(join(dir, 'report.json'), 'not product')
  assert.equal(productFingerprint(dir), before)
  writeFileSync(join(dir, 'lib/a.js'), 'two')
  assert.notEqual(productFingerprint(dir), before)
})

test('CLI without model-calls fails before resolving host or creating output', async () => {
  assert.equal(typeof (await api()).runModelVerification, 'function')
  const child = spawnSync(process.execPath, [moduleUrl.pathname, '--install-anchor', '/missing'], { encoding: 'utf8' })
  assert.equal(child.status, 1)
  assert.match(child.stderr, /model-calls/)
})

test('low-risk persona states one task/worker, milestone facts, once acceptance and preserved authority', () => {
  const persona = TASKFORCE_DEFINITION.plugins.find(row => row.id === 'persona').config.prefix
  for (const pattern of [/低风险/, /一个可验收任务/, /一名执行者/, /关键里程碑/, /一次.*验收/, /不自动降低有效思考档位/, /高风险.*独立复核/, /身份和权限以宿主为准/, /不执行命令/]) assert.match(persona, pattern)
})


test('settlement waits for all descendant notices and a reawakened parent driver', async () => {
  const { waitForNativeSettlement } = await api()
  assert.equal(typeof waitForNativeSettlement, 'function')
  const histories = { root: [], worker: [], nested: [] }
  const tracked = new Map(Object.keys(histories).map((id, i) => [id, {
    id, status: 'idle', whenIdle: async () => {},
    session: { header: { parentSession: i === 0 ? null : i === 1 ? 'root' : 'worker' }, snapshotEvents: () => histories[id] },
  }]))
  let completed = false
  const pending = waitForNativeSettlement({ tracked, rootId: 'root', activationCounts: new Map([['worker', 1], ['nested', 1]]), beforeCounts: new Map(), beforeNotices: new Map(), isDisposed: () => false }).then(() => { completed = true })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(completed, false)
  histories.root.push({ type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'worker' } } })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(completed, false, 'grandchild settlement is required even if root is idle')
  tracked.get('root').status = 'running'
  histories.worker.push({ type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'nested' } } })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(completed, false)
  tracked.get('root').status = 'idle'
  await pending
  assert.equal(completed, true)
})

test('failed stage retains independent grading and request metrics without losing prior stages', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, 'fake')
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  assert.equal(report.stages.length, 2)
  assert.equal(report.stages[1].name, 'repair')
  assert.equal(report.stages[1].ok, false)
  assert.equal(report.stages[1].independentChecks, 4)
  assert.equal(report.stages[1].requests, 2)
  assert.equal(report.requests, 3)
})

for (const extended of [false, true]) {
  test(`independent grader rejects overwritten assertions (${extended ? 8 : 4} checks)`, async t => {
    const { gradeMoney } = await import('../model-fixtures.mjs')
    const workspace = mkdtempSync(join(tmpdir(), 'model-grader-assert-'))
    t.after(() => rmSync(workspace, { recursive: true, force: true }))
    writeFileSync(join(workspace, 'money.mjs'), `import assert from 'node:assert/strict';
assert.equal = () => {};
assert.throws = () => {};
export function sumMoney() { return 999; }`)
    assert.deepEqual(gradeMoney(workspace, extended), { ok: false, checks: extended ? 8 : 4 })
  })
}

test('model module cannot manufacture completion from discoverable process arguments', async t => {
  const { gradeMoney } = await import('../model-fixtures.mjs')
  const workspace = mkdtempSync(join(tmpdir(), 'model-grader-completion-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeFileSync(join(workspace, 'money.mjs'), String.raw`
const source = process.execArgv[process.execArgv.indexOf('--eval') + 1];
const match = source.match(/process\.stdout\.write\(("[^"]+")\)/);
process.stdout.write(JSON.parse(match[1]));
process.exit(0);
export function sumMoney() { return 999; }
`)
  assert.equal(gradeMoney(workspace).ok, false)
})

test('module-owned serialization and stdout hooks cannot rewrite fixed observations', async t => {
  const { gradeMoney } = await import('../model-fixtures.mjs')
  const workspace = mkdtempSync(join(tmpdir(), 'model-grader-output-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeFileSync(join(workspace, 'money.mjs'), String.raw`
JSON.stringify = () => 'forged';
const original = process.stdout._write;
process.stdout._write = function(chunk, encoding, callback) {
  const nonce = String(chunk).split('\n')[0];
  return original.call(this, nonce + '\nvalue:0\nvalue:30\nvalue:0.3\nvalue:-0.9\n', encoding, callback);
};
export function sumMoney() { return 999; }
`)
  assert.equal(gradeMoney(workspace).ok, false)
})

for (const extended of [false, true]) {
  test(`model process._eval cannot manufacture ${extended ? 8 : 4} completed observations`, async t => {
    const { gradeMoney } = await import('../model-fixtures.mjs')
    const workspace = mkdtempSync(join(tmpdir(), 'model-grader-stdin-'))
    t.after(() => rmSync(workspace, { recursive: true, force: true }))
    writeFileSync(join(workspace, 'money.mjs'), String.raw`
const source = process._eval;
const match = source.match(/write\(1, ("(?:\\.|[^"\\])*") \+ observations\)/);
let result = JSON.parse(match[1])
  + 'value:0\nvalue:30\nvalue:0.3\nvalue:-0.9\n';
if (source.includes('observe(sumMoney, [1,NaN])'))
  result += 'type-error\ntype-error\ntype-error\nvalue:-1\n';
process.stdout.write(result);
process.exit(0);
export function sumMoney() { return 999; }
`)
    assert.deepEqual(gradeMoney(workspace, extended), { ok: false, checks: extended ? 8 : 4 })
  })
}

test('fixed pure module executes in its own realm without host globals or host input objects', async t => {
  const { gradeMoney } = await import('../model-fixtures.mjs')
  const workspace = mkdtempSync(join(tmpdir(), 'model-grader-realm-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeFileSync(join(workspace, 'money.mjs'), `
if (typeof process !== 'undefined' || typeof Buffer !== 'undefined') throw new Error('host global exposed');
JSON.stringify = () => 'forged';
const calculate = ${goodMoney.replace('export function sumMoney', 'function')};
export function sumMoney(a) {
  if (Object.getPrototypeOf(a) !== Array.prototype) throw new Error('host array exposed');
  return calculate(a);
}`)
  assert.deepEqual(gradeMoney(workspace, true), { ok: true, checks: 8 })
})

for (const source of [
  `import { readFileSync } from 'node:fs'; ${goodMoney}`,
  `await import('node:process'); ${goodMoney}`,
  `globalThis.constructor.constructor('return process')(); ${goodMoney}`,
]) {
  test('fixed money module fails closed on unsupported imports or host escape', async t => {
    const { gradeMoney } = await import('../model-fixtures.mjs')
    const workspace = mkdtempSync(join(tmpdir(), 'model-grader-module-'))
    t.after(() => rmSync(workspace, { recursive: true, force: true }))
    writeFileSync(join(workspace, 'money.mjs'), source)
    assert.equal(gradeMoney(workspace, true).ok, false)
  })
}

for (const waiver of [false, true]) {
  test(`public store acceptance distinguishes negative waiver text from actual legacy waiver=${waiver}`, async t => {
    const { observeModelTasks, diagnoseModelClosure } = await api()
    assert.equal(typeof observeModelTasks, 'function')
    const { tempStore } = await import('./helpers.mjs')
    const store = tempStore(t), run = 'closure-run'
    const id = store.openTask({ title: 'waiver classification' }, run).task_id
    store.claimTask({ task_id: id, child_id: 'worker' }, run, 'worker', 'worker')
    store.recordFact({ task_id: id, kind: 'fact', confidence: 'CONFIRMED', statement: '不使用人工豁免；已有实际测试依据' }, run, 'worker', 'worker')
    store.recordFact({ task_id: id, kind: 'decision', statement: '验收通过（人工豁免）：这是引用的反例，不是验收记录' }, run, 'lead', run)
    store.submitTask({ task_id: id, note: '不使用人工豁免' }, run, 'worker', 'worker')
    const acceptance = store.acceptTask({ task_id: id, note: '无需人工豁免，按实际证据验收', ...(waiver ? { waiver_reason: 'explicit actual waiver' } : {}) }, run, 'lead', run)
    assert.equal(acceptance.status, 'accepted')
    assert.equal(acceptance.waiver !== null, waiver)
    const rows = observeModelTasks(store, run, store.root)
    assert.equal(rows[0].waived, waiver)
    assert.equal(diagnoseModelClosure(rows, 1, 'worker').ok, !waiver)
    assert.deepEqual(diagnoseModelClosure(rows, 1, 'worker').failureCodes, waiver ? ['waiver'] : [])
  })
}

test('public strict waiver remains rejected using structured current-generation waiver evidence', async t => {
  const { observeModelTasks, diagnoseModelClosure } = await api()
  assert.equal(typeof observeModelTasks, 'function')
  const { tempStore } = await import('./helpers.mjs')
  const store = tempStore(t), run = 'strict-closure-run'
  writeFileSync(join(store.root, 'money.mjs'), goodMoney)
  writeFileSync(join(store.root, 'money.test.mjs'), '// fixture')
  const id = store.openTask({ title: 'strict waiver', evidence_policy: 'execution', verification_files: ['money.mjs', 'money.test.mjs'], verification_command: 'node --test money.test.mjs' }, run, { sessionId: run, cwd: store.root, isRoot: true }).task_id
  store.claimTask({ task_id: id, child_id: 'worker' }, run, 'worker', 'worker')
  store.submitTask({ task_id: id }, run, 'worker', 'worker')
  const acceptance = store.acceptTask({ task_id: id, waiver_reason: 'explicit strict waiver' }, run, 'lead', run)
  assert.equal(acceptance.execution_verified, false)
  assert.notEqual(acceptance.waiver, null)
  const rows = observeModelTasks(store, run, store.root)
  assert.equal(rows[0].waived, true)
  assert.deepEqual(diagnoseModelClosure(rows, 1, 'worker').failureCodes, ['waiver'])
})

test('incomplete acceptance report includes only bounded allowlisted closure diagnostics', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, 'acceptance')
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  const closure = report.stages.at(-1).closure
  assert.ok(closure, 'missing closure diagnostics')
  assert.equal(closure.ok, false)
  assert.equal(closure.newTaskCount, 1)
  assert.equal(closure.taskCount, 1)
  assert.deepEqual(closure.failureCodes, ['task-status'])
  assert.deepEqual(closure.tasks[0], { taskId: 2, status: 'submitted', ownerMatches: true, evidenceCount: 1, waived: false, evidencePolicy: 'legacy', strictVerified: false })
  assert.doesNotMatch(JSON.stringify(closure), /sk-secret|reasoning|credentials|marker/)
})

test('closure diagnostics bound details but retain all failure categories without copying arbitrary strings', async () => {
  const { diagnoseModelClosure } = await api()
  assert.equal(typeof diagnoseModelClosure, 'function')
  const tasks = Array.from({ length: 30 }, (_, id) => ({ id, status: 'accepted', owner_session: 'worker', evidence: 1, evidence_policy: 'legacy', waived: false }))
  tasks[29] = { ...tasks[29], status: 'sk-secret', owner_session: 'credentials', evidence: 'reasoning', waived: true }
  const closure = diagnoseModelClosure(tasks, 2, 'worker')
  assert.equal(closure.taskCount, 30)
  assert.equal(closure.tasks.length, 20)
  assert.equal(closure.truncated, true)
  assert.deepEqual(closure.failureCodes, ['new-task-count', 'task-status', 'owner-mismatch', 'waiver', 'legacy-evidence'])
  assert.doesNotMatch(JSON.stringify(closure), /sk-secret|reasoning|credentials/)
  const detail = diagnoseModelClosure(tasks.slice(29), 1, 'worker').tasks[0]
  assert.equal(detail.status, 'unknown')
  assert.equal(detail.evidenceCount, null)
})

const runtimeCases = [
  ['step-error', { type: 'step/error', data: { turn: 2, step: 1, error: 'sk-secret' } }],
  ['native-tool-error', { type: 'tool/result', data: { turn: 2, step: 1, message: { source: { toolName: 'task_submit', callId: 'sk-secret' }, isError: true, content: 'sk-secret' } } }],
  ['ptc-tool-error', { type: 'tool/ptc-dispatch', data: { name: 'read', isError: true, rootCallId: 'sk-secret', error: 'sk-secret' } }],
  ['noncompleted-turn', { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: 'sk-secret' } } }],
]
for (const [category, event] of runtimeCases) {
  for (const nextRequest of [false, true]) test(`${category} preserves observations and ${nextRequest ? 'blocks another request' : 'fails a settled stage'}`, async t => {
    const { runModelVerification } = await api()
    let admitted = 0
    const h = setup(t, undefined, ({ stage, sessions, onRequest, turn }) => {
      if (stage.name !== 'repair') return
      sessions[1].events.push(event)
      if (nextRequest) { onRequest({ agentId: 'root', turn, step: 2 }); admitted++ }
    })
    const report = await runModelVerification(h.options, { createHarness: h.factory })
    assert.equal(report.ok, false)
    assert.equal(report.failure, 'usage-or-runtime-error')
    assert.equal(admitted, 0)
    assert.equal(report.requests, 3, 'blocked request is not an actual provider request')
    assert.equal(report.stages[0].ok, true)
    const stage = report.stages[1]
    assert.equal(stage.newWorkers, 1)
    assert.equal(stage.facts, 2)
    assert.equal(stage.accepted, 1)
    assert.equal(stage.closure.ok, true)
    assert.deepEqual(stage.runtimeDiagnostics.failureCodes, [category])
    assert.equal(stage.runtimeDiagnostics.counts[category], 1)
    assert.equal(report.runtimeDiagnostics.counts[category], 1)
    assert.doesNotMatch(readFileSync(join(h.outputDir, 'report.json'), 'utf8'), /sk-secret/)
  })
}

test('pending usage does not block concurrent requests or weaken final accounting', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, 'concurrent-pending')
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  assert.equal(report.ok, true)
  assert.equal(report.requests, 11)
  assert.deepEqual(report.runtimeDiagnostics.failureCodes, [])
})

for (const category of ['missing-message', 'missing-usage', 'invalid-usage', 'duplicate-message', 'route-mismatch']) {
  test(`${category} has a distinct runtime counter without erasing closure`, async t => {
    const { runModelVerification } = await api()
    const h = setup(t, undefined, ({ stage, sessions }) => {
      if (stage.name !== 'repair') return
      const events = sessions[1].events
      const message = events.find(e => e.type === 'assistant/message')
      if (category === 'missing-message') events.splice(events.indexOf(message), 1)
      if (category === 'missing-usage') delete message.data.usage
      if (category === 'invalid-usage') message.data.usage.cacheReadTokens = -1
      if (category === 'duplicate-message') events.push(structuredClone(message))
      if (category === 'route-mismatch') message.data.message.source.model = 'sk-secret'
    })
    const report = await runModelVerification(h.options, { createHarness: h.factory })
    assert.equal(report.ok, false)
    assert.equal(report.failure, 'usage-or-runtime-error')
    assert.deepEqual(report.stages[1].runtimeDiagnostics.failureCodes, [category])
    assert.equal(report.stages[1].runtimeDiagnostics.counts[category], 1)
    assert.equal(report.stages[1].newWorkers, 1)
    assert.equal(report.stages[1].closure.ok, true)
    assert.doesNotMatch(JSON.stringify(report), /sk-secret/)
  })
}

test('runtime details are bounded, allowlisted and retain exact counts beyond the limit', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, undefined, ({ stage, sessions }) => {
    if (stage.name !== 'repair') return
    sessions[1].id = 'sk-secret-session'
    for (let i = 0; i < 25; i++) sessions[1].events.push({ type: 'tool/result', data: {
      turn: 'sk-secret', step: -1, message: { source: { toolName: i === 0 ? 'bash' : 'sk-secret-tool', callId: 'sk-secret' }, isError: true },
    } })
    sessions[1].events.push({ type: 'step/error', data: { error: 'sk-secret' } })
  })
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  const diag = report.stages[1].runtimeDiagnostics
  assert.equal(report.ok, false)
  assert.equal(diag.counts['native-tool-error'], 25)
  assert.equal(diag.counts['step-error'], 1)
  assert.equal(diag.details.length, 20)
  assert.equal(diag.truncated, true)
  assert.equal(diag.details[0].toolName, 'bash')
  assert.equal(diag.details[0].unknownTool, false)
  assert.equal(diag.details[1].toolName, null)
  assert.equal(diag.details[1].unknownTool, true)
  assert.equal(diag.details[0].turn, null)
  assert.equal(diag.details[0].step, null)
  assert.equal(diag.details[0].sessionIndex, 1)
  assert.equal(diag.details[0].eventIndex, 2)
  assert.doesNotMatch(readFileSync(join(h.outputDir, 'report.json'), 'utf8'), /sk-secret/)
})

test('bash nonzero exit data does not create a runtime error', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, undefined, ({ sessions }) => {
    sessions[0].events.push({ type: 'tool/result', data: { message: { source: { toolName: 'bash' }, isError: false, content: [{ type: 'text', text: 'exit code 1' }] } } })
  })
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  assert.equal(report.ok, true)
  assert.deepEqual(report.runtimeDiagnostics.failureCodes, [])
})

test('a thrown stage preserves its already observed worker, task and closure statistics', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, undefined, ({ stage }) => {
    if (stage.name === 'repair') throw new Error('sk-secret')
  })
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  assert.equal(report.failure, 'runtime-error')
  assert.equal(report.stages[1].newWorkers, 1)
  assert.equal(report.stages[1].facts, 2)
  assert.equal(report.stages[1].accepted, 1)
  assert.equal(report.stages[1].closure.ok, true)
})

for (const reason of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked', 'sk-secret']) {
  test(`noncompleted native reason ${reason === 'sk-secret' ? 'unknown' : reason} is reported as a fixed enum`, async t => {
    const { runModelVerification } = await api()
    const h = setup(t, undefined, ({ stage, sessions }) => {
      if (stage.name === 'repair') sessions[1].events.push({ type: 'turn/end', data: { reason: { kind: reason } } })
    })
    const report = await runModelVerification(h.options, { createHarness: h.factory })
    assert.equal(report.ok, false)
    assert.equal(report.stages[1].runtimeDiagnostics.details[0].reasonKind, reason === 'sk-secret' ? 'unknown' : reason)
    assert.doesNotMatch(JSON.stringify(report), /sk-secret/)
  })
}

// rc.2 AgentLoop emits nameless result messages and persists ToolFailure.info
// in data.error. Changing name correlation or enum filtering must fail these.
test('native diagnostic names cover mounted root and worker tools through scoped call identity', async t => {
  const { runModelVerification } = await api()
  const names = ['todo_write', 'get_goal', 'create_goal', 'update_goal', 'task_child_stop',
    'subagent_fork', 'ask_user_question', 'exit_plan_mode', 'web_search', 'web_fetch',
    'str_replace_editor', 'write', 'edit', 'bash', 'working_directory']
  const h = setup(t, undefined, ({ stage, sessions }) => {
    if (stage.name !== 'repair') return
    names.forEach((name, index) => sessions[1].events.push(
      { type: 'tool/call', data: { turn: 9, step: index, callId: 'reused', name, arguments: 'sk-secret' } },
      { type: 'tool/result', data: { turn: 9, step: index, message: { source: { kind: 'tool', callId: 'reused' }, isError: true }, error: { name: 'ToolArgsError', code: 'INVALID_ARGS', reason: 'sk-secret' } } },
    ))
  })
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  const diag = report.stages[1].runtimeDiagnostics
  assert.equal(report.ok, false)
  assert.equal(report.failure, 'usage-or-runtime-error')
  assert.deepEqual(diag.details.map(x => x.toolName), names)
  assert.ok(diag.details.every(x => x.unknownTool === false && x.errorCode === 'INVALID_ARGS'))
  assert.equal(diag.errorCounts.INVALID_ARGS, names.length)
  assert.doesNotMatch(JSON.stringify(report), /sk-secret/)
})

test('diagnostic correlation refuses cross-session, cross-step, cross-turn, missing and ambiguous identities', async () => {
  const { diagnoseModelRuntime } = await api()
  assert.equal(typeof diagnoseModelRuntime, 'function')
  const call = (name, turn = 1, step = 1, callId = 'same') => ({ type: 'tool/call', data: { turn, step, callId, name } })
  const result = (turn = 1, step = 1, callId = 'same') => ({ type: 'tool/result', data: { turn, step, message: { source: { callId }, isError: true } } })
  const cases = [
    [call('read', 2), result()], [call('read', 1, 2), result()],
    [call('read'), call('write'), result()], [call('read'), call('read'), result()],
    [call('read'), { ...result(), data: { ...result().data, callId: 'conflicting' } }],
    [call('read'), { ...result(), data: { ...result().data, callId: 'conflicting', name: 'read' } }],
    [call('read'), { ...result(), data: { ...result().data, name: 'write' } }],
    [{ ...result(), data: { ...result().data, name: 'read', message: { isError: true, source: { toolName: 'write' } } } }],
    [call('read'), result(undefined, undefined, '')],
    [call('read'), { type: 'tool/result', data: { message: { source: { callId: 'same' }, isError: true } } }],
    [result(), call('read')],
    [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'tool/ptc-dispatch-start', data: { subCallId: 'same', name: 'read' } }, result()],
  ]
  for (const events of cases) {
    const diag = diagnoseModelRuntime({ sessions: [{ id: 'a', events }] })
    assert.equal(diag.details[0].toolName, null)
    assert.equal(diag.details[0].unknownTool, true)
  }
  const crossSession = diagnoseModelRuntime({ sessions: [{ id: 'a', events: [call('read')] }, { id: 'b', events: [result()] }] })
  assert.equal(crossSession.details[0].toolName, null)
  const scoped = diagnoseModelRuntime({ sessions: [{ id: 'a', events: [call('read'), result(), call('write', 2), result(2)] }, { id: 'b', events: [call('edit'), result()] }] })
  assert.deepEqual(scoped.details.map(x => x.toolName), ['read', 'write', 'edit'])
  const ptc = diagnoseModelRuntime({ sessions: [{ events: [call('read'),
    { type: 'tool/ptc-dispatch', data: { turn: 1, step: 1, subCallId: 'same', name: 'edit', isError: true } }, result()] }] })
  assert.deepEqual(ptc.details.map(x => [x.category, x.toolName]), [['ptc-tool-error', 'edit'], ['native-tool-error', 'read']])
})

test('native and PTC error codes are finite enums with exact counters beyond bounded details', async () => {
  const { diagnoseModelRuntime } = await api()
  assert.equal(typeof diagnoseModelRuntime, 'function')
  const codes = ['INVALID_ARGS', 'UNKNOWN_TOOL', 'ABORTED', 'ABORTED_BEFORE_DISPATCH', 'INVALID_TOOL_OUTPUT', 'CODE_RUN_FAILED',
    'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE', 'FS_PERMISSION_DENIED',
    'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED']
  const events = codes.map(code => ({ type: 'tool/result', data: { message: { source: { toolName: 'read' }, isError: true, content: 'sk-secret' }, error: { name: 'sk-secret', code, reason: 'sk-secret' } } }))
  events.push({ type: 'tool/ptc-dispatch', data: { name: 'read', isError: true, subCallId: 'sk-secret', error: { code: 'FS_NOT_FOUND' } } })
  for (const code of ['sk-secret', '__proto__', 'toString', 'INVALID_ARGS\nsk-secret', { code: 'INVALID_ARGS' }, null]) {
    events.push({ type: 'tool/result', data: { name: 'sk-secret', message: { isError: true }, error: { code, name: 'ToolArgsError', reason: 'INVALID_ARGS' } } })
  }
  // Never infer categories by scraping model-facing content or speculative fields.
  events.push({ type: 'tool/result', data: { message: { isError: true, content: 'INVALID_ARGS' }, code: 'INVALID_ARGS' } })
  const diag = diagnoseModelRuntime({ sessions: [{ id: 'sk-secret', events }] })
  assert.equal(diag.details.length, 20)
  assert.equal(diag.truncated, true)
  assert.deepEqual(diag.details.slice(0, codes.length).map(x => x.errorCode), codes)
  assert.equal(diag.details[19].category, 'ptc-tool-error')
  assert.equal(diag.details[19].errorCode, 'FS_NOT_FOUND')
  assert.equal(diag.counts['native-tool-error'], 26)
  assert.equal(diag.counts['ptc-tool-error'], 1)
  assert.equal(diag.errorCounts.FS_NOT_FOUND, 2)
  assert.equal(diag.errorCounts.unknown, 7)
  for (const code of codes.filter(code => code !== 'FS_NOT_FOUND')) assert.equal(diag.errorCounts[code], 1)
  assert.doesNotMatch(JSON.stringify(diag), /sk-secret|__proto__|toString/)
  const unknown = diagnoseModelRuntime({ sessions: [{ events: events.slice(-7) }] })
  assert.ok(unknown.details.every(x => x.errorCode === 'unknown' && x.toolName === null))
})

test('model report declares the fixed output capacity without claiming custom harness effectiveness', async t => {
  const { runModelVerification } = await api()
  const h = setup(t)
  const report = await runModelVerification(h.options, { createHarness: h.factory })
  assert.equal(report.ok, true)
  assert.deepEqual(report.outputCapacity, { configuredMaxTokens: 8192, source: 'custom-harness-unverified' })
  assert.deepEqual(JSON.parse(readFileSync(join(h.outputDir, 'report.json'))).outputCapacity, report.outputCapacity)
  assert.equal(report.requestCap, 80)
})

for (const type of ['compaction/summary', 'compaction/end']) {
  test(`auxiliary ${type} cannot hide behind completed agent messages`, async t => {
    const { runModelVerification } = await api()
    const h = setup(t, undefined, ({ sessions }) => {
      sessions[0].events.push({ type, data: { error: 'private-error', usage: { inputTokens: 1000, outputTokens: 1000 }, provider: 'wrong', model: 'wrong' } })
    })
    const report = await runModelVerification(h.options, { createHarness: h.factory })
    assert.equal(report.ok, false)
    assert.equal(report.failure, 'usage-or-runtime-error')
    assert.equal(report.runtimeDiagnostics.counts[type === 'compaction/end' ? 'compaction-error' : 'auxiliary-call'], 1)
    assert.doesNotMatch(JSON.stringify(report), /private-error/)
  })
}

async function streamFixture(overrides = {}) {
  const { createModelStreamBoundary } = await api()
  const marked = new WeakSet(), signal = new AbortController().signal
  const agent = { id: 'private-agent' }, tracked = new Map([[agent.id, agent]])
  let admitted = 0, dispatched = 0, failures = 0
  const boundary = createModelStreamBoundary({ tracked, provider: 'p', model: 'm',
    isAgentLoopRequest: request => marked.has(request),
    onRequest() { if (admitted >= (overrides.cap ?? 80)) throw new Error('request-cap'); admitted++ },
    onFailure() { failures++ },
  })
  function request(step = 1, extra = {}) {
    boundary.observeRequest({ agent, turn: 1, step, signal })
    const value = Object.freeze({ sessionId: agent.id, provider: 'p', model: 'm', maxTokens: 8192, signal, ...extra })
    marked.add(value)
    return value
  }
  const next = () => (async function* () {
    dispatched++
    yield* (overrides.chunks ?? [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }, { type: 'finish', reason: { kind: 'stop' } }])
  })()
  const consume = async stream => { for await (const chunk of stream) {} }
  return { boundary, request, next, consume, counts: () => ({ admitted, dispatched, failures }) }
}

test('stream admission is lazy, single-use and accounts each consumed response once', async () => {
  const f = await streamFixture()
  const stream = f.boundary.intercept(f.request(), f.next)
  assert.deepEqual(f.counts(), { admitted: 0, dispatched: 0, failures: 0 })
  await f.consume(stream)
  await f.consume(stream)
  assert.deepEqual(f.counts(), { admitted: 1, dispatched: 1, failures: 0 })
  assert.deepEqual(f.boundary.snapshot().records.map(r => r.usage), [{ inputTokens: 2, outputTokens: 3 }])
})

for (const [name, extra, category] of [
  ['route', { model: 'wrong' }, 'route-mismatch'],
  ['capacity', { maxTokens: 65536 }, 'capacity-mismatch'],
  ['ownership', { sessionId: 'unknown' }, 'stream-attribution'],
  ['signal', { signal: new AbortController().signal }, 'stream-attribution'],
]) test(`stream ${name} mismatch refuses dispatch and latches even if caught`, async () => {
  const f = await streamFixture()
  await assert.rejects(f.consume(f.boundary.intercept(f.request(1, extra), f.next)))
  await assert.rejects(f.consume(f.boundary.intercept(f.request(2), f.next)))
  assert.equal(f.counts().dispatched, 0)
  assert.equal(f.counts().admitted, 0)
  assert.equal(f.boundary.snapshot().failures[category], 1)
})

for (const [name, chunks, category] of [
  ['missing usage', [{ type: 'finish', reason: { kind: 'stop' } }], 'missing-usage'],
  ['invalid usage', [{ type: 'usage', usage: { inputTokens: -1, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'stop' } }], 'invalid-usage'],
  ['missing terminal', [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }], 'stream-error'],
  ['error terminal', [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }, { type: 'finish', reason: { kind: 'error' } }], 'stream-error'],
  ['duplicate terminal', [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }, { type: 'finish', reason: { kind: 'stop' } }, { type: 'finish', reason: { kind: 'stop' } }], 'stream-error'],
]) test(`consumed stream ${name} fails accounting and prevents later dispatch`, async () => {
  const f = await streamFixture({ chunks })
  await assert.rejects(f.consume(f.boundary.intercept(f.request(), f.next)))
  await assert.rejects(f.consume(f.boundary.intercept(f.request(2), f.next)))
  assert.equal(f.counts().admitted, 1)
  assert.equal(f.counts().dispatched, 1)
  assert.equal(f.boundary.snapshot().failures[category], 1)
})

test('stream cap applies at consumption across concurrently prepared calls', async () => {
  const f = await streamFixture({ cap: 1 })
  const first = f.boundary.intercept(f.request(), f.next)
  // Independent calls may be in flight, but a repeated same-agent pending
  // request invalidates the unused earlier envelope instead of misattributing it.
  await f.consume(first)
  await assert.rejects(f.consume(f.boundary.intercept(f.request(2), f.next)))
  assert.equal(f.counts().admitted, 1)
  assert.equal(f.counts().dispatched, 1)
})

test('consumer cancellation closes upstream and latches incomplete consumption', async () => {
  const f = await streamFixture()
  let closed = false
  const stream = f.boundary.intercept(f.request(), () => (async function* () {
    try { yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }; yield { type: 'finish', reason: { kind: 'stop' } } }
    finally { closed = true }
  })())
  await stream.next()
  await stream.return()
  assert.equal(closed, true)
  assert.equal(f.boundary.snapshot().failures['stream-error'], 1)
})

test('two lazy iterators cannot reuse one native request admission', async () => {
  const f = await streamFixture(), request = f.request()
  const first = f.boundary.intercept(request, f.next), second = f.boundary.intercept(request, f.next)
  await f.consume(first)
  await assert.rejects(f.consume(second))
  assert.equal(f.counts().admitted, 1)
  assert.equal(f.counts().dispatched, 1)
  assert.equal(f.boundary.snapshot().failures['stream-attribution'], 1)
})

test('unbranded helper with copied route and owner is blocked before dispatch', async () => {
  const f = await streamFixture(), request = { ...f.request() }
  await assert.rejects(f.consume(f.boundary.intercept(Object.freeze(request), f.next)))
  assert.equal(f.counts().dispatched, 0)
  assert.equal(f.boundary.snapshot().failures['auxiliary-call'], 1)
})

test('cumulative usage frames use latest SDK sample once without summing frames', async () => {
  const f = await streamFixture({ chunks: [
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } },
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  await f.consume(f.boundary.intercept(f.request(), f.next))
  assert.deepEqual(f.boundary.snapshot().records[0].usage, { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4 })
})

test('actual stream records retain usage on a failed native-style response and override message-only totals', async t => {
  const { runModelVerification } = await api()
  const h = setup(t)
  const factory = async config => {
    const harness = await h.factory(config)
    const snapshot = harness.snapshot
    harness.snapshot = () => ({ ...snapshot(), streamAccounting: {
      records: snapshot().sessions.flatMap(session => session.events.filter(event => event.type === 'assistant/message').map(event => ({
        key: `${session.id}:${event.data.turn}:${event.data.step}`, complete: false, ended: true, usage: { inputTokens: 5, outputTokens: 7 },
      }))), failures: snapshot().sessions[0].events.length ? { 'stream-error': 1 } : {},
    } })
    return harness
  }
  const report = await runModelVerification(h.options, { createHarness: factory })
  assert.equal(report.ok, false)
  assert.equal(report.requests, 1)
  assert.equal(report.usage.inputTokens, 5)
  assert.equal(report.stages[0].usage.outputTokens, 7)
})

test('an in-flight consumed stream does not block another agent at admission', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, 'concurrent-pending')
  let sawPending = false
  const factory = async config => {
    const records = []
    const harness = await h.factory({ ...config, onRequest(payload) {
      config.onRequest(payload)
      records.push({ key: `${payload.agentId}:${payload.turn}:${payload.step}`, ended: false, complete: false, usage: null })
    } }), snapshot = harness.snapshot
    harness.snapshot = () => {
      const value = snapshot()
      for (const record of records) {
        const message = value.sessions.flatMap(session => session.events.filter(event => event.type === 'assistant/message')
          .map(event => ({ key: `${session.id}:${event.data.turn}:${event.data.step}`, usage: event.data.usage })))
          .find(message => message.key === record.key)
        if (message) Object.assign(record, { ended: true, complete: true, usage: message.usage })
      }
      if (records.some(record => !record.ended)) sawPending = true
      return { ...value, streamAccounting: { records, failures: {} } }
    }
    return harness
  }
  const report = await runModelVerification(h.options, { createHarness: factory })
  assert.equal(sawPending, true)
  assert.equal(report.ok, true)
  assert.equal(report.requests, 11)
})

test('cleanup retains usage arriving from an already admitted stream after the last stage snapshot', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, 'error')
  const factory = async config => {
    const harness = await h.factory(config)
    const records = [], failures = {}
    harness.runStage = async () => {
      config.onRequest({ agentId: 'root', turn: 1, step: 1 })
      records.push({ key: 'root:1:1', ended: false, complete: false, usage: null })
      failures['stream-error'] = 1
      throw new Error('local stream cancellation')
    }
    const snapshot = harness.snapshot
    harness.snapshot = () => ({ ...snapshot(), streamAccounting: { records, failures } })
    harness.streamSnapshot = () => structuredClone({ records, failures })
    const dispose = harness.dispose
    harness.dispose = async () => {
      records[0].usage = { inputTokens: 11, outputTokens: 13 }
      records[0].ended = true
      await dispose()
    }
    return harness
  }
  const report = await runModelVerification(h.options, { createHarness: factory })
  assert.equal(report.ok, false)
  assert.equal(report.requests, 1)
  assert.equal(report.usage.inputTokens, 11)
  assert.equal(report.stages[0].usage.outputTokens, 13)
})

test('alpha.2 retains independent checks, accounting, strict evidence and cleanup', async t => {
  const { runModelVerification } = await api()
  const h = setup(t)
  const report = await runModelVerification(h.options, {
    createHarness: async config => ({ ...await h.factory(config), hostVersion: '0.2.1-alpha.2' }),
  })
  assert.equal(report.ok, true)
  assert.equal(report.provenance.hostVersion, '0.2.1-alpha.2')
  assert.deepEqual(report.stages.map(s => s.independentChecks), [1, 4, 8, 8])
  assert.deepEqual(report.stages.map(s => s.newWorkers), [0, 1, 0, 0])
  assert.equal(report.stages[2].reuse, 1)
  assert.equal(report.stages[3].strictVerified, true)
  assert.deepEqual(report.stages[3].closure.tasks.map(task => task.evidencePolicy), ['legacy', 'legacy', 'execution'])
  assert.equal(report.requests, 7)
  assert.equal(report.usage.inputTokens, 14)
  assert.equal(h.disposed(), true)
  assert.doesNotMatch(JSON.stringify(report), /sk-secret|reasoning|credentials|marker/)
})
for (const [label, version] of [
  ['earlier release candidate', '0.2.0-rc.1'], ['earlier alpha', '0.2.1-alpha.1'],
  ['later alpha', '0.2.1-alpha.3'], ['stable release', '0.2.1'], ['future release', '0.3.0'],
  ['build suffix', '0.2.0-rc.2+local'], ['malformed value', 'sk-secret'],
]) {
  test('unsupported host ' + label + ' fails before stages or requests and disposes', async t => {
    const { runModelVerification } = await api()
    const h = setup(t)
    let stageRuns = 0
    const report = await runModelVerification(h.options, {
      createHarness: async config => {
        const harness = await h.factory(config)
        harness.hostVersion = version
        harness.runStage = async () => { stageRuns++; throw new Error('unsupported host entered a stage') }
        return harness
      },
    })
    assert.equal(report.ok, false)
    assert.equal(report.failure, 'host-version')
    assert.deepEqual(report.stages, [])
    assert.equal(stageRuns, 0)
    assert.equal(report.requests, 0)
    assert.equal(h.disposed(), true)
    const saved = readFileSync(join(h.outputDir, 'report.json'), 'utf8')
    assert.equal(JSON.parse(saved).failure, 'host-version')
    assert.doesNotMatch(saved, /sk-secret|reasoning|credentials|marker/)
  })
}

test('working-directory diagnostics accept only the literal native and PTC name', async () => {
  const { diagnoseModelRuntime } = await api()
  const names = ['working_directory', 'working_directory_sk-secret',
    'working_directory\nsk-secret', ' working_directory', 'working_directory ', '__proto__']
  const sessions = names.map(name => ({ id: 'sk-secret-session', events: [
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'same', name, arguments: 'sk-secret' } },
    { type: 'tool/result', data: { turn: 1, step: 1,
      message: { source: { kind: 'tool', callId: 'same' }, isError: true, content: [{ type: 'text', text: 'sk-secret' }] },
      error: { code: 'INVALID_ARGS', message: 'sk-secret' } } },
    { type: 'tool/ptc-dispatch', data: { turn: 1, step: 1, subCallId: 'same', name, isError: true,
      error: { code: 'INVALID_ARGS', message: 'sk-secret' } } },
  ] }))
  const diagnostics = diagnoseModelRuntime({ sessions })
  assert.deepEqual(diagnostics.details.map(detail => detail.toolName),
    names.flatMap(name => name === 'working_directory' ? [name, name] : [null, null]))
  assert.deepEqual(diagnostics.details.map(detail => detail.unknownTool),
    names.flatMap(name => [name !== 'working_directory', name !== 'working_directory']))
  assert.deepEqual(diagnostics.failureCodes, ['native-tool-error', 'ptc-tool-error'])
  assert.equal(diagnostics.counts['native-tool-error'], names.length)
  assert.equal(diagnostics.counts['ptc-tool-error'], names.length)
  assert.equal(diagnostics.errorCounts.INVALID_ARGS, names.length * 2)
  assert.doesNotMatch(JSON.stringify(diagnostics), /sk-secret|__proto__/)
})

const settlementShape = (overrides = {}) => ({ phase: 'waiting-idle', trackedAgents: 1, idleAgents: 0,
  runningAgents: 1, unknownAgents: 0, pendingIdleWaits: 1, requiredNotices: 0, deliveredNotices: 0, missingNotices: 0, ...overrides })
const deferred = () => Promise.withResolvers()

test('settlement progress freezes the actual timeout boundary before cancellation changes observations', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, 'timeout')
  h.options.stageTimeoutMs = 20
  let current = settlementShape(), cancelled = 0
  const report = await runModelVerification(h.options, { createHarness: async config => {
    const harness = await h.factory(config)
    harness.settlementSnapshot = () => current
    harness.runStage = async () => { config.onRequest({ agentId: 'root', turn: 1, step: 1 }); return new Promise(() => {}) }
    harness.cancel = () => { cancelled++; current.phase = 'settled'; current.pendingIdleWaits = 0 }
    return harness
  } })
  assert.equal(report.failure, 'timeout')
  assert.ok(cancelled >= 2)
  assert.deepEqual(report.stages[0].timeoutProgress?.settlement, settlementShape())
  assert.equal(report.stages[0].progress.settlement.phase, 'settled')
  assert.ok(Number.isSafeInteger(report.stages[0].timeoutProgress.lastRequestElapsedMs))
  assert.ok(report.stages[0].timeoutProgress.lastRequestElapsedMs <= report.stages[0].durationMs)
  assert.equal(report.outputCapacity.source, 'custom-harness-unverified')
  assert.deepEqual(JSON.parse(readFileSync(join(h.outputDir, 'report.json'))), report)
})

test('settlement progress remains optional, resets request time per stage and records normal settlement', async t => {
  const { runModelVerification } = await api()
  const h = setup(t)
  const report = await runModelVerification(h.options, { createHarness: async config => {
    const harness = await h.factory(config)
    harness.settlementSnapshot = () => settlementShape({ phase: 'settled', idleAgents: 1, runningAgents: 0, pendingIdleWaits: 0 })
    return harness
  } })
  assert.equal(report.ok, true)
  for (const stage of report.stages) {
    assert.equal(stage.progress?.settlement.phase, 'settled')
    assert.ok(Number.isSafeInteger(stage.progress.lastRequestElapsedMs))
    assert.equal(stage.timeoutProgress, null)
  }
  const absent = setup(t, 'timeout'); absent.options.stageTimeoutMs = 10
  const unavailable = await runModelVerification(absent.options, { createHarness: absent.factory })
  assert.deepEqual(unavailable.stages[0].timeoutProgress, { lastRequestElapsedMs: null, settlement: null })
})

for (const invalid of ['extra-key', 'unsafe', 'negative', 'fraction', 'phase', 'getter', 'method-getter', 'throws', 'promise', 'rejected-promise', 'thenable', 'inherited-thenable', 'then-getter', 'missing']) {
  test(`settlement progress rejects ${invalid} without leaking diagnostics or masking timeout and cleanup`, async t => {
    const { runModelVerification } = await api()
    const h = setup(t, 'timeout'); h.options.stageTimeoutMs = 10
    let cancellations = 0, foreignCalls = 0
    const marker = 'settlement-private-path-reasoning-sk-secret'
    const report = await runModelVerification(h.options, { createHarness: async config => {
      const harness = await h.factory(config)
      let value = settlementShape()
      if (invalid === 'extra-key') value[marker] = marker
      if (invalid === 'unsafe') value.trackedAgents = Number.MAX_SAFE_INTEGER + 1
      if (invalid === 'negative') value.pendingIdleWaits = -1
      if (invalid === 'fraction') value.pendingIdleWaits = 0.5
      if (invalid === 'phase') value.phase = marker
      if (invalid === 'getter') Object.defineProperty(value, 'phase', { get() { foreignCalls++; throw new Error(marker) } })
      if (invalid === 'promise') value = Promise.resolve(value)
      if (invalid === 'rejected-promise') value = Promise.reject(new Error(marker))
      if (invalid === 'thenable') value.then = () => { foreignCalls++; throw new Error(marker) }
      if (invalid === 'inherited-thenable') Object.setPrototypeOf(value, { then() { foreignCalls++; throw new Error(marker) } })
      if (invalid === 'then-getter') Object.defineProperty(value, 'then', { get() { foreignCalls++; throw new Error(marker) } })
      if (invalid === 'missing') delete value.runningAgents
      harness.settlementSnapshot = () => { if (invalid === 'throws') throw new Error(marker); return value }
      if (invalid === 'method-getter') Object.defineProperty(harness, 'settlementSnapshot', { get() { throw new Error(marker) } })
      harness.cancel = () => { cancellations++ }
      return harness
    } })
    assert.equal(report.failure, 'timeout')
    assert.ok(cancellations >= 2)
    assert.equal(foreignCalls, 0, 'foreign getters and thenables are never invoked')
    assert.deepEqual(report.stages[0].timeoutProgress, { lastRequestElapsedMs: null, settlement: null })
    assert.equal(report.stages[0].progress.settlement, null)
    assert.doesNotMatch(JSON.stringify(report), new RegExp(marker))
  })
}

test('settlement diagnostics preserve invalid observation and cleanup failure precedence', async t => {
  const { runModelVerification } = await api()
  for (const fault of ['invalid-observation', 'cleanup-error']) {
    const h = setup(t, 'timeout'); h.options.stageTimeoutMs = 10
    const report = await runModelVerification(h.options, { createHarness: async config => {
      const harness = await h.factory(config)
      harness.settlementSnapshot = () => { throw new Error('diagnostic-private') }
      if (fault === 'invalid-observation') harness.runStage = async () => { harness.snapshot = () => ({}) }
      else harness.dispose = async () => { throw new Error('cleanup-private') }
      return harness
    } })
    assert.equal(report.failure, fault)
    assert.equal(report.stages[0].progress?.settlement, null)
    assert.doesNotMatch(JSON.stringify(report), /diagnostic-private|cleanup-private/)
  }
})

function controlledSettlement(waitForNativeSettlement, definitions) {
  const histories = new Map(), tracked = new Map(), counts = new Map(), beforeCounts = new Map(), beforeNotices = new Map()
  const gates = new Set(), seen = [], subscribers = new Set()
  let disposed = false, read = () => undefined, hook = () => {}
  const add = (id, parent, status = 'idle') => {
    if (!histories.has(id)) histories.set(id, [])
    const gate = deferred(); gates.add(gate)
    const agent = { id, status, session: { header: { parentSession: parent }, snapshotEvents: () => histories.get(id) },
      idleCalls: 0, whenIdle() { this.idleCalls++; return gate.promise } }
    tracked.set(id, agent); counts.set(id, (counts.get(id) ?? 0) + 1)
    return { agent, gate }
  }
  for (const definition of definitions) add(...definition)
  const observe = snapshot => { read = snapshot; const value = snapshot(); seen.push(value); hook(value); for (const fn of subscribers) fn(value) }
  const waitPhase = phase => {
    const gate = deferred()
    const accept = value => { if (value?.phase === phase) { subscribers.delete(accept); gate.resolve(value) } }
    subscribers.add(accept); accept(read())
    return gate.promise
  }
  const notice = (parent, id) => histories.get(parent).push({ type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: id } } })
  return { tracked, counts, beforeCounts, beforeNotices, histories, add, notice, seen, waitPhase,
    read: () => read(), hook: fn => { hook = fn }, release: () => { for (const gate of gates) gate.resolve() },
    stop: () => { disposed = true; for (const gate of gates) gate.resolve() },
    run: extra => waitForNativeSettlement({ tracked, rootId: 'root', activationCounts: counts, beforeCounts, beforeNotices, isDisposed: () => disposed, observe, ...extra }) }
}

test('settlement progress distinguishes maintenance idle from resolved native idle promises', async () => {
  const { waitForNativeSettlement } = await api()
  const f = controlledSettlement(waitForNativeSettlement, [['root', null]])
  const pending = f.run()
  try {
    assert.deepEqual(f.read(), settlementShape({ idleAgents: 1, runningAgents: 0 }))
    assert.equal(f.tracked.get('root').idleCalls, 1, 'diagnostics do not call whenIdle again')
    f.release(); await pending
    assert.equal(f.read().phase, 'settled')
    assert.equal(f.read().pendingIdleWaits, 0)
  } finally { f.stop(); await pending.catch(() => {}) }
})

test('settlement progress caps each notice pair before summing, including nested and missing parents', async () => {
  const { waitForNativeSettlement } = await api()
  const f = controlledSettlement(waitForNativeSettlement, [['root', null], ['a', 'root'], ['b', 'root'], ['nested', 'a'], ['orphan', 'absent']])
  f.notice('root', 'a'); f.notice('root', 'a'); f.notice('root', 'a'); f.notice('a', 'nested')
  const pending = f.run()
  try {
    assert.equal(f.read()?.requiredNotices, 4)
    assert.equal(f.read().deliveredNotices, 2)
    assert.equal(f.read().missingNotices, 2)
    f.release()
    assert.equal((await f.waitPhase('waiting-notices')).phase, 'waiting-notices')
    f.tracked.get('orphan').session.header.parentSession = 'root'
    f.notice('root', 'b'); f.notice('root', 'orphan')
    await pending
    assert.equal(f.read().phase, 'settled')
  } finally { f.stop(); await pending.catch(() => {}) }
})

test('settlement progress follows parent reawakening and event or agent changes through original stable ticks', async () => {
  const { waitForNativeSettlement } = await api()
  const f = controlledSettlement(waitForNativeSettlement, [['root', null], ['child', 'root']])
  const parentWake = deferred(); let stableChecks = 0, completed = false
  f.hook(value => {
    if (value?.phase !== 'checking-stability') return
    stableChecks++
    if (stableChecks === 1) {
      f.histories.get('root').push({ type: 'local-change' })
      const root = f.tracked.get('root'); root.status = 'running'; root.whenIdle = () => parentWake.promise
    }
    if (stableChecks === 2) { const added = f.add('later', 'root'); f.notice('root', 'later'); added.gate.resolve() }
  })
  const pending = f.run().then(() => { completed = true })
  try {
    assert.equal(f.read()?.phase, 'waiting-idle')
    f.release(); await f.waitPhase('waiting-notices'); f.notice('root', 'child')
    await f.waitPhase('checking-stability'); await f.waitPhase('waiting-idle')
    assert.equal(completed, false)
    assert.equal(f.read().runningAgents, 1)
    await Promise.resolve() // resolved sibling callbacks drain; parent remains held
    assert.equal(f.read().pendingIdleWaits, 1)
    f.tracked.get('root').status = 'idle'; parentWake.resolve()
    await pending
    assert.ok(stableChecks >= 3)
    assert.equal(f.read().phase, 'settled')
  } finally { parentWake.resolve(); f.stop(); await pending.catch(() => {}) }
})

test('settlement progress separates cold activation baselines, live reuse, unknown status and stale agent promises', async () => {
  const { waitForNativeSettlement } = await api()
  const f = controlledSettlement(waitForNativeSettlement, [['root', null], ['child', 'root', 'maintenance-private']])
  f.beforeCounts.set('child', 1); f.notice('root', 'child'); f.beforeNotices.set(JSON.stringify(['root', 'child']), 1)
  const first = f.run()
  try {
    assert.equal(f.read()?.unknownAgents, 1)
    assert.equal(f.read().requiredNotices, 0, 'live continuation has no new activation')
    f.tracked.get('child').status = 'idle'; f.release(); await first
    const child = f.add('child', 'root')
    const second = f.run()
    assert.equal(f.read().requiredNotices, 1)
    assert.equal(f.read().deliveredNotices, 0, 'old notice cannot satisfy cold activation')
    assert.equal(f.read().pendingIdleWaits, 2)
    await Promise.resolve()
    assert.equal(f.read().pendingIdleWaits, 1)
    child.gate.resolve(); await f.waitPhase('waiting-notices')
    f.notice('root', 'child'); await second
    assert.equal(f.read().missingNotices, 0)
  } finally { f.stop(); await first.catch(() => {}) }
})

test('settlement observer exceptions and rejected original promises cannot alter wait semantics', async () => {
  const { waitForNativeSettlement } = await api()
  const rejection = new Error('native-idle-rejection')
  for (const reject of [false, true]) {
    const idle = deferred(); let calls = 0, observations = 0
    const agent = { id: 'root', status: 'idle', session: { header: {}, snapshotEvents: () => [] }, whenIdle() { calls++; return idle.promise } }
    const pending = waitForNativeSettlement({ tracked: new Map([['root', agent]]), rootId: 'root', activationCounts: new Map(),
      beforeCounts: new Map(), beforeNotices: new Map(), isDisposed: () => false,
      observe() { observations++; throw new Error('private-observer-failure') } })
    if (reject) { idle.reject(rejection); await assert.rejects(pending, error => error === rejection) }
    else { idle.resolve(); await pending }
    assert.equal(calls, 1)
    assert.ok(observations > 0)
  }
})

test('settlement side observations isolate async rejection and throwing native diagnostic getters at every phase', async () => {
  const { waitForNativeSettlement } = await api()
  let inspecting = false, calls = 0
  const phases = new Set(), observations = []
  const agent = { id: 'root', get status() { if (inspecting) throw new Error('private-diagnostic-getter'); return 'idle' },
    session: { header: {}, snapshotEvents: () => [] }, whenIdle() { calls++; return Promise.resolve() } }
  await waitForNativeSettlement({ tracked: new Map([['root', agent]]), rootId: 'root', activationCounts: new Map(),
    beforeCounts: new Map(), beforeNotices: new Map(), isDisposed: () => false,
    observe(read) {
      phases.add(read().phase)
      inspecting = true
      try { observations.push(read()) } finally { inspecting = false }
      return Promise.reject(new Error('private-async-observer'))
    },
  })
  assert.equal(calls, 1)
  assert.ok(observations.length >= 5)
  assert.ok(observations.every(value => value === null))
  assert.deepEqual([...phases], ['not-started', 'waiting-idle', 'waiting-notices', 'checking-stability', 'settled'])
})

test('settlement pending observations keep exact Promise.all inputs and late rejected-cohort callbacks isolated', async () => {
  const { waitForNativeSettlement } = await api()
  const oldRoot = deferred(), oldChild = deferred(), freshChild = deferred()
  const tracked = new Map()
  const make = (id, gate) => ({ id, status: 'idle', session: { header: { parentSession: id === 'root' ? null : 'root' }, snapshotEvents: () => [] }, whenIdle: () => gate.promise })
  tracked.set('root', make('root', oldRoot)); tracked.set('child', make('child', oldChild))
  const config = { tracked, rootId: 'root', activationCounts: new Map(), beforeCounts: new Map(), beforeNotices: new Map(), isDisposed: () => false }
  let oldRead, newRead, exactInputs
  const originalAll = Promise.all
  let oldPending
  try {
    Promise.all = function (inputs) { exactInputs = [...inputs]; return originalAll.call(this, exactInputs) }
    oldPending = waitForNativeSettlement({ ...config, observe: read => { oldRead = read } })
  } finally { Promise.all = originalAll }
  assert.equal(exactInputs.length, 2)
  assert.equal(exactInputs[0], oldRoot.promise, 'the original root Promise reaches Promise.all')
  assert.equal(exactInputs[1], oldChild.promise, 'the original child Promise reaches Promise.all')
  const error = new Error('original-idle-failure'); oldRoot.reject(error)
  await assert.rejects(oldPending, thrown => thrown === error)
  const rootReady = deferred(); rootReady.resolve()
  tracked.set('root', make('root', rootReady)); tracked.set('child', make('child', freshChild))
  const next = waitForNativeSettlement({ ...config, observe: read => { newRead = read } })
  await Promise.resolve()
  assert.equal(newRead().pendingIdleWaits, 1)
  oldChild.resolve(); await Promise.resolve()
  assert.equal(oldRead().pendingIdleWaits, 0)
  assert.equal(newRead().pendingIdleWaits, 1, 'the prior Agent/cohort cannot decrement the new one')
  freshChild.resolve(); await next
  assert.equal(newRead().phase, 'settled')
})

test('settlement last admitted request timestamp resets to null when a later stage makes no request', async t => {
  const { runModelVerification } = await api()
  const h = setup(t); h.options.stageTimeoutMs = 20
  const report = await runModelVerification(h.options, { createHarness: async config => {
    const harness = await h.factory(config), run = harness.runStage
    harness.runStage = stage => stage.name === 'readonly' ? run(stage) : new Promise(() => {})
    return harness
  } })
  assert.equal(report.failure, 'timeout')
  assert.equal(report.stages[0].ok, true)
  assert.ok(Number.isSafeInteger(report.stages[0].progress.lastRequestElapsedMs))
  assert.equal(report.stages[1].requests, 0)
  assert.deepEqual(report.stages[1].timeoutProgress, { lastRequestElapsedMs: null, settlement: null })
})

const settlementWindow = () => new Promise(resolve => setTimeout(resolve, 45))
async function settlementDeadline(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('settlement did not complete')), 500) })]) }
  finally { clearTimeout(timer) }
}

test('delegation contract: own mode uses the live host projection and rejects every untrusted identity', async () => {
  const exported = await api()
  // Old semantics classify all activations as continuable. This fallback lets
  // the RED assert wrong behavior rather than stop on a missing export.
  const classify = exported.nativeSubagentMode ?? (() => 'continuable')
  let value = { mode: 'one-shot', seq: 2 }, reads = 0, checks = 0, inheritedBoundary = 2
  const agent = { session: { isOwnSeq(seq) { checks++; return seq >= inheritedBoundary && seq < 10 } } }
  Object.defineProperty(agent, 'ctx', { get() { throw new Error('disposed child scope must never be consulted') } })
  const host = { sessionProjections: {
    snapshot(session, keys) { reads++; assert.equal(session, agent.session); assert.deepEqual(keys, ['subagent']); return { values: { subagent: value } } },
    cachedSnapshot() { throw new Error('cached mode may be stale') },
  } }
  assert.equal(classify(host, agent), 'one-shot')
  value = { mode: 'continuable', seq: 2 }; assert.equal(classify(host, agent), 'continuable')
  inheritedBoundary = 3; assert.equal(classify(host, agent), 'unknown', 'fork-inherited descriptor is not this child')
  inheritedBoundary = 2
  const invalid = [null, undefined, {}, { mode: 'one-shot' }, { mode: 'background', seq: 2 }, { mode: 'one-shot', seq: -1 },
    { mode: 'one-shot', seq: 1.5 }, { mode: 'one-shot', seq: Number.MAX_SAFE_INTEGER + 1 }, { mode: 'one-shot', seq: '2' },
    { mode: 'one-shot', seq: NaN }, { mode: 'one-shot', seq: Infinity }, { mode: 'one-shot', seq: 10 },
    Object.create({ mode: 'one-shot', seq: 2 }), { mode: 'one-shot', get seq() { throw new Error('seq accessor') } },
    { get mode() { return 'one-shot' }, seq: 2 }]
  for (value of invalid) assert.equal(classify(host, agent), 'unknown')
  value = { mode: 'one-shot', seq: 2 }
  assert.equal(classify({}, agent), 'unknown')
  assert.equal(classify({ sessionProjections: { snapshot: () => ({ values: {} }) } }, agent), 'unknown')
  assert.equal(classify({ get sessionProjections() { throw new Error('service read') } }, agent), 'unknown')
  assert.equal(classify({ sessionProjections: { snapshot() { throw new Error('projection failure') } } }, agent), 'unknown')
  assert.equal(classify(host, { session: {} }), 'unknown')
  assert.equal(classify(host, { session: { isOwnSeq() { throw new Error('own seq failure') } } }), 'unknown')
  assert.equal(classify(host, { session: { isOwnSeq: () => 1 } }), 'unknown')
  assert.ok(reads >= invalid.length + 3); assert.ok(checks >= 3)
  assert.equal(classify(host, agent), 'one-shot', 'unknown is read again, never cached at creation')
})

test('delegation contract: one-shot notice exemption retains the entire mixed tree and exact continuable pairs', async () => {
  const { waitForNativeSettlement } = await api()
  const f = controlledSettlement(waitForNativeSettlement, [['root', null], ['parent', 'root'], ['leaf', 'parent'], ['other', 'root']])
  const modes = new Map([['parent', 'continuable'], ['leaf', 'one-shot'], ['other', 'continuable']])
  f.notice('root', 'parent'); f.notice('root', 'parent'); f.notice('root', 'parent')
  let completed = false
  const pending = f.run({ classifyMode: agent => modes.get(agent.id) }).then(() => { completed = true })
  try {
    assert.equal(f.read().requiredNotices, 2)
    assert.equal(f.read().deliveredNotices, 1); assert.equal(f.read().missingNotices, 1)
    assert.equal(f.read().trackedAgents, 4); assert.equal(f.read().pendingIdleWaits, 4)
    f.release(); await settlementWindow(); assert.equal(completed, false)
    f.notice('root', 'other'); await settlementDeadline(pending)
    assert.equal(f.read().requiredNotices, 2); assert.equal(f.read().deliveredNotices, 2)
    assert.equal(f.tracked.get('leaf').idleCalls > 0, true)
  } finally { f.stop(); await pending.catch(() => {}) }
})

for (const result of ['unknown', 'undefined', 'throws']) {
  test(`delegation contract: ${result} mode blocks even with a delivered notice and zero missing count`, async () => {
    const { waitForNativeSettlement } = await api()
    const f = controlledSettlement(waitForNativeSettlement, [['root', null], ['child', 'root']])
    f.notice('root', 'child')
    let known = false, completed = false
    const pending = f.run({ classifyMode() { if (known) return 'continuable'; if (result === 'throws') throw new Error('mode read'); return result === 'undefined' ? undefined : 'unknown' } }).then(() => { completed = true })
    try {
      f.release(); await settlementWindow()
      assert.equal(completed, false, 'a notice does not establish a valid current own descriptor')
      assert.equal(f.read().phase, 'waiting-notices'); assert.equal(f.read().missingNotices, 0)
      assert.equal(f.read().unknownAgents, 0, 'mode uncertainty is not Agent status uncertainty')
      known = true; await settlementDeadline(pending)
      assert.equal(f.read().phase, 'settled')
    } finally { f.stop(); await pending.catch(() => {}) }
  })
}

test('delegation contract: late own one-shot descriptor is reread after creation instead of permanently unknown', async () => {
  const { waitForNativeSettlement } = await api()
  const f = controlledSettlement(waitForNativeSettlement, [['root', null], ['child', 'root']])
  let mode = 'unknown', completed = false
  const pending = f.run({ classifyMode: () => mode }).then(() => { completed = true })
  try {
    assert.equal(f.read().requiredNotices, 1)
    f.release(); await settlementWindow(); assert.equal(completed, false)
    mode = 'one-shot'; await settlementDeadline(pending)
    assert.equal(f.read().phase, 'settled'); assert.equal(f.read().requiredNotices, 0)
  } finally { f.stop(); await pending.catch(() => {}) }
})

for (const change of ['unknown', 'continuable', 'activation', 'replacement']) {
  test(`delegation contract: final stable window rechecks ${change} despite unchanged event lengths`, async () => {
    const { waitForNativeSettlement } = await api()
    const f = controlledSettlement(waitForNativeSettlement, [['root', null], ['child', 'root']])
    if (change !== 'continuable') f.notice('root', 'child')
    let mode = 'one-shot', changed = false, completed = false, replacement
    f.hook(value => {
      if (value?.phase !== 'checking-stability' || changed) return
      changed = true
      if (change === 'unknown' || change === 'continuable') mode = change
      if (change === 'activation') { f.counts.set('child', 2); mode = 'continuable' }
      if (change === 'replacement') replacement = f.add('child', 'root')
    })
    const pending = f.run({ classifyMode: () => mode }).then(() => { completed = true })
    try {
      f.release(); await settlementWindow()
      assert.equal(changed, true); assert.equal(completed, false)
      if (change === 'activation' || change === 'continuable') f.notice('root', 'child')
      if (change === 'replacement') { assert.ok(f.read().pendingIdleWaits >= 1); replacement.gate.resolve() }
      mode = 'one-shot'; await settlementDeadline(pending)
    } finally { f.stop(); await pending.catch(() => {}) }
  })
}

test('delegation contract: historical unknown child owes no new notice but still joins idle and cold activation checks', async () => {
  const { waitForNativeSettlement } = await api()
  const f = controlledSettlement(waitForNativeSettlement, [['root', null], ['child', 'root']])
  f.beforeCounts.set('child', 1); f.notice('root', 'child'); f.beforeNotices.set(JSON.stringify(['root', 'child']), 1)
  let mode = 'unknown'
  const first = f.run({ classifyMode: () => mode })
  try {
    assert.equal(f.read().requiredNotices, 0); assert.equal(f.read().pendingIdleWaits, 2)
    f.release(); await settlementDeadline(first)
    const child = f.add('child', 'root')
    let completed = false
    const second = f.run({ classifyMode: () => mode }).then(() => { completed = true })
    try {
      child.gate.resolve(); await settlementWindow(); assert.equal(completed, false)
      assert.equal(f.read().requiredNotices, 1); assert.equal(f.read().deliveredNotices, 0)
      f.notice('root', 'child'); await settlementWindow(); assert.equal(completed, false)
      mode = 'continuable'; await settlementDeadline(second)
      assert.equal(f.read().deliveredNotices, 1)
    } finally { f.stop(); await second.catch(() => {}) }
  } finally { f.stop(); await first.catch(() => {}) }
})

test('delegation contract: repair discloses the two future same-child stages before irreversible worker creation', async () => {
  const { MODEL_STAGES } = await import('../model-fixtures.mjs')
  const repair = MODEL_STAGES.find(stage => stage.name === 'repair').prompt
  assert.match(repair, /可续作.*continuable/)
  assert.match(repair, /后续两个阶段.*task_child_send.*同一 childId.*不新建代理/)
  assert.match(repair, /若派发工具提供 run_in_background 参数.*true.*未提供则不传/)
})

for (const fault of ['no-service', 'service-getter', 'no-projection', 'snapshot-throws', 'no-values', 'absent', 'null',
  'no-mode', 'unsupported', 'mode-getter', 'mode-throws', 'inherited-fields', 'no-seq', 'seq-getter', 'seq-throws',
  'negative-seq', 'fraction-seq', 'unsafe-seq', 'string-seq', 'nan-seq', 'infinite-seq', 'non-own', 'no-own-method', 'own-throws', 'own-truthy']) {
  test(`delegation contract: classifier fails closed for ${fault}`, async () => {
    const { nativeSubagentMode = () => 'continuable' } = await api()
    let identity = { mode: 'one-shot', seq: 2 }, calls = 0
    const agent = { session: { isOwnSeq: () => true } }
    let host = { sessionProjections: { snapshot: () => ({ values: { subagent: identity } }) } }
    if (fault === 'no-service') host = {}
    if (fault === 'service-getter') host = { get sessionProjections() { throw new Error('service') } }
    if (fault === 'no-projection') host.sessionProjections.snapshot = () => ({ values: {} })
    if (fault === 'snapshot-throws') host.sessionProjections.snapshot = () => { throw new Error('read') }
    if (fault === 'no-values') host.sessionProjections.snapshot = () => ({})
    if (fault === 'absent') identity = undefined
    if (fault === 'null') identity = null
    if (fault === 'no-mode') delete identity.mode
    if (fault === 'unsupported') identity.mode = 'background'
    if (fault === 'inherited-fields') identity = Object.create(identity)
    if (fault === 'mode-getter' || fault === 'mode-throws') Object.defineProperty(identity, 'mode', { get() { calls++; if (fault === 'mode-throws') throw new Error('mode'); return 'one-shot' } })
    if (fault === 'no-seq') delete identity.seq
    if (fault === 'seq-getter' || fault === 'seq-throws') Object.defineProperty(identity, 'seq', { get() { calls++; if (fault === 'seq-throws') throw new Error('seq'); return 2 } })
    if (fault === 'negative-seq') identity.seq = -1
    if (fault === 'fraction-seq') identity.seq = 0.5
    if (fault === 'unsafe-seq') identity.seq = Number.MAX_SAFE_INTEGER + 1
    if (fault === 'string-seq') identity.seq = '2'
    if (fault === 'nan-seq') identity.seq = NaN
    if (fault === 'infinite-seq') identity.seq = Infinity
    if (fault === 'non-own') agent.session.isOwnSeq = () => false
    if (fault === 'no-own-method') delete agent.session.isOwnSeq
    if (fault === 'own-throws') agent.session.isOwnSeq = () => { throw new Error('own') }
    if (fault === 'own-truthy') agent.session.isOwnSeq = () => 1
    assert.equal(nativeSubagentMode(host, agent), 'unknown')
    assert.equal(calls, 0, 'untrusted identity accessors are not invoked')
  })
}

for (const finish of ['success', 'timeout']) {
  test(`repair own direct-worker follow-up is counted before authority assignment: ${finish}`, async t => {
    const { runModelVerification } = await api()
    const h = setup(t, undefined, ({ stage, sessions }) => {
      if (stage.name !== 'repair') return
      sessions[0].events.push({ type: 'tool/call', data: { name: 'task_child_send', arguments: JSON.stringify({ target_id: 'worker' }) } })
      if (finish === 'timeout') return new Promise(() => {})
    })
    if (finish === 'timeout') h.options.stageTimeoutMs = 100
    const report = await runModelVerification(h.options, { createHarness: h.factory })
    assert.equal(report.ok, finish === 'success')
    assert.equal(report.failure, finish === 'success' ? null : 'timeout')
    assert.equal(report.stages.find(s => s.name === 'repair').reuse, 1)
    if (finish === 'success') assert.deepEqual(report.stages.slice(2).map(s => s.reuse), [1, 1])
  })
}

for (const invalid of ['unrelated', 'multiple', 'nondirect']) {
  test(`repair diagnostic candidate excludes ${invalid} worker observations`, async t => {
    const { runModelVerification } = await api()
    const h = setup(t, undefined, ({ stage, sessions }) => {
      if (stage.name !== 'repair') return
      sessions[0].events.push({ type: 'tool/call', data: { name: 'task_child_send', arguments: { target_id: invalid === 'unrelated' ? 'other' : 'worker' } } })
      if (invalid === 'multiple') sessions.push({ id: 'other', parent: 'root', events: [] })
      if (invalid === 'nondirect') sessions[1].parent = 'other'
    })
    const report = await runModelVerification(h.options, { createHarness: h.factory })
    assert.equal(report.stages.find(s => s.name === 'repair').reuse, 0)
    assert.equal(report.failure, invalid === 'unrelated' ? null : 'repair-worker-count')
  })
}

const taskToolNames = ['task_open', 'task_claim', 'task_fact', 'task_submit', 'task_accept', 'task_reject', 'task_close', 'task_board', 'task_child_send', 'task_child_stop', 'task_verify', 'task_checkpoint', 'task_workflow_create', 'task_workflow_submit', 'task_workflow_state']
const taskToolCodes = ['E_NO_AGENT', 'E_NO_SESSION', 'E_NO_AGENTS_SERVICE', 'E_TERMINAL', 'E_STATUS', 'E_EVIDENCE_MISSING', 'E_BLOCKERS', 'E_TASK_CONFLICT', 'E_CROSS_RUN', 'E_NOT_FOUND', 'E_CHILD_SERVICE', 'E_CHILD_INPUT', 'E_CHILD_NO_AGENT', 'E_CHILD_NOT_OWN', 'E_CHILD_MISSING', 'E_CHILD_SETTLED', 'E_CHILD_NO_ID', 'E_CONTROL_JOURNAL_UNAVAILABLE', 'E_CONTROL_OUTCOME_UNKNOWN', 'UNAUTHORIZED', 'NOT_RESUMABLE', 'ABORTED', 'unknown']
function taskProjection() {
  return { observedEvents: 2, unattributedResults: 0,
    byTool: Object.fromEntries(taskToolNames.map(name => [name, { calls: 0, nativeResults: 0, ptcResults: 0, envelopeOk: 0, envelopeError: 0, transportError: 0, unavailableResults: 0 }])),
    byRole: { root: 0, worker: 0, unknown: 0 }, errorCounts: Object.fromEntries(taskToolCodes.map(code => [code, 0])), details: [], truncated: false, saturated: false }
}

test('task diagnostics are isolated copied custom data with immutable pre-cancel snapshot and unchanged gates', async t => {
  const { runModelVerification } = await api()
  const h = setup(t, 'timeout'), projection = taskProjection()
  projection.byTool.task_open.calls = 1; projection.byRole.root = 1
  projection.byTool.task_open.nativeResults = 1; projection.byTool.task_open.envelopeError = 1
  projection.errorCounts.E_STATUS = 1
  projection.details.push({ toolName: 'task_open', role: 'root', presentation: 'native', outcome: 'envelope-error', errorCode: 'E_STATUS', eventIndex: 1 })
  let begins = 0
  const report = await runModelVerification({ ...h.options, stageTimeoutMs: 20 }, { createHarness: async config => {
    const harness = await h.factory(config)
    return { ...harness, beginTaskToolDiagnosticsStage() { begins++ }, taskToolDiagnosticsSnapshot: () => projection,
      cancel() { projection.byTool.task_open.envelopeError = 0; projection.byTool.task_open.envelopeOk = 1; projection.errorCounts.E_STATUS = 0; projection.details = [] } }
  } })
  assert.equal(report.failure, 'timeout'); assert.equal(begins, 1)
  const stage = report.stages[0]
  assert.equal(stage.timeoutTaskToolDiagnostics?.byTool.task_open.envelopeError, 1)
  assert.equal(stage.taskToolDiagnostics?.byTool.task_open.envelopeOk, 1)
  assert.equal(stage.taskToolDiagnostics.source, 'custom-harness-unverified')
  assert.deepEqual(Object.keys(stage.progress).sort(), ['lastRequestElapsedMs', 'settlement'])
  assert.deepEqual(Object.keys(stage.timeoutProgress).sort(), ['lastRequestElapsedMs', 'settlement'])
})

for (const fault of ['absent', 'hook-getter', 'inherited-hook', 'proxy-harness', 'throw', 'promise', 'promise-then-getter', 'thenable', 'getter', 'proxy', 'inherited', 'extra', 'counter', 'tool', 'code', 'detail', 'partition']) {
  test(`task diagnostics safely reject ${fault} without affecting original failure or cancellation`, async t => {
    const { runModelVerification } = await api()
    const h = setup(t, 'timeout')
    let invoked = 0, cancelled = 0
    const trap = () => { invoked++; throw new Error('SECRET_DIAGNOSTIC') }
    const report = await runModelVerification({ ...h.options, stageTimeoutMs: 10 }, { createHarness: async config => {
      const harness = await h.factory(config)
      harness.cancel = () => { cancelled++ }
      harness.beginTaskToolDiagnosticsStage = () => {}
      let value = taskProjection()
      if (fault === 'promise' || fault === 'promise-then-getter') {
        value = null
      }
      if (fault === 'thenable') Object.defineProperty(value, 'then', { get: trap })
      if (fault === 'getter') Object.defineProperty(value.byTool.task_open, 'calls', { get: trap })
      if (fault === 'proxy') value = new Proxy(value, { ownKeys: trap, get: trap })
      if (fault === 'inherited') value = Object.assign(Object.create({ marker: true }), value)
      if (fault === 'extra') value.unexpected = 'SECRET_DIAGNOSTIC'
      if (fault === 'counter') value.observedEvents = 65536
      if (fault === 'tool') value.details.push({ toolName: 'SECRET_DIAGNOSTIC', role: 'root', presentation: 'native', outcome: 'unavailable', errorCode: null, eventIndex: null })
      if (fault === 'code') value.errorCounts.SECRET_DIAGNOSTIC = 1
      if (fault === 'detail') value.details = Array(21).fill({ toolName: null, role: 'unknown', presentation: 'native', outcome: 'unavailable', errorCode: null, eventIndex: null })
      if (fault === 'partition') value.byTool.task_open.envelopeOk = 1
      harness.taskToolDiagnosticsSnapshot = () => {
        if (fault === 'throw') throw new Error('SECRET_DIAGNOSTIC')
        if (fault === 'promise' || fault === 'promise-then-getter') {
          const rejected = Promise.reject(new Error('SECRET_DIAGNOSTIC'))
          if (fault === 'promise-then-getter') Object.defineProperty(rejected, 'then', { get: trap })
          return rejected
        }
        return value
      }
      if (fault === 'absent') delete harness.taskToolDiagnosticsSnapshot
      if (fault === 'hook-getter') Object.defineProperty(harness, 'taskToolDiagnosticsSnapshot', { get: trap })
      if (fault === 'inherited-hook') { delete harness.taskToolDiagnosticsSnapshot; Object.setPrototypeOf(harness, { taskToolDiagnosticsSnapshot: trap }) }
      if (fault === 'proxy-harness') return new Proxy(harness, { getOwnPropertyDescriptor: trap })
      return harness
    } })
    assert.equal(report.failure, 'timeout')
    assert.equal(cancelled >= 2, true)
    assert.equal(invoked, 0, 'untrusted accessors/proxy traps must never run')
    assert.equal(report.stages[0].taskToolDiagnostics, null)
    assert.equal(report.stages[0].timeoutTaskToolDiagnostics, null)
    assert.doesNotMatch(JSON.stringify(report), /SECRET_DIAGNOSTIC/)
  })
}

async function taskCollectorFixture({ announceRoot = true, beginStage = true } = {}) {
  const { createTaskToolDiagnosticsCollector } = await api()
  const agents = new Map()
  const collector = createTaskToolDiagnosticsCollector({ rootId: 'root', agents })
  const create = (id, parent = null, { cut = 0, seq = cut, announce = true } = {}) => {
    const session = { id, header: { id, ...(parent === null ? {} : { parentSession: parent }) }, inheritedEventCount: cut, seq,
      isOwnSeq(value) { return value >= this.inheritedEventCount && value < this.seq },
      snapshotEvents() { throw new Error('diagnostics must not read history') }, ownEvents() { throw new Error('diagnostics must not read history') } }
    const agent = { id, session }; agents.set(id, agent)
    if (announce) collector.created(session)
    return session
  }
  const root = create('root', null, { announce: announceRoot })
  const emit = (session, type, data = {}, extra = {}) => {
    const event = { seq: session.seq++, type, data, ...extra }
    collector.published(session, event)
    return event
  }
  const step = (session = root, turn = 1, step = 1) => { emit(session, 'turn/start', { turn }); emit(session, 'step/start', { turn, step }) }
  const call = (session = root, name = 'task_open', callId = 'call', turn = 1, step = 1) => emit(session, 'tool/call', { turn, step, callId, name })
  const result = (session, call, body = { ok: true }, changes = {}) => {
    const { turn, step, callId } = call.data
    return emit(session, 'tool/result', { turn, step, message: { source: { kind: 'tool', callId }, toolCallId: callId,
      isError: false, content: [{ type: 'text', text: JSON.stringify(body) }], ...changes.message }, ...changes.data },
    { sourceEventSeqs: [call.seq], ...changes.event })
  }
  if (beginStage) collector.beginStage()
  return { collector, agents, root, create, emit, step, call, result }
}
function assertTaskPartition(report) {
  assert.ok(report)
  assert.deepEqual(Object.keys(report).sort(), ['observedEvents', 'unattributedResults', 'byTool', 'byRole', 'errorCounts', 'details', 'truncated', 'saturated'].sort())
  for (const row of Object.values(report.byTool)) assert.deepEqual(Object.keys(row).sort(), ['calls', 'nativeResults', 'ptcResults', 'envelopeOk', 'envelopeError', 'transportError', 'unavailableResults'].sort())
  assert.deepEqual(Object.keys(report.byTool), taskToolNames)
  assert.deepEqual(Object.keys(report.errorCounts), taskToolCodes)
  for (const row of Object.values(report.byTool)) assert.equal(row.nativeResults + row.ptcResults, row.envelopeOk + row.envelopeError + row.transportError + row.unavailableResults)
  assert.doesNotMatch(JSON.stringify(report), /SECRET_|private-path|private-id/)
}

test('model observation collector reserves control receipts and preserves cold lifetime ownership without text', async () => {
  const f = await taskCollectorFixture(), worker = f.create('private-worker', 'root')
  f.collector.beginObservations?.(0)
  f.step(); f.step(worker, 7, 2)
  for (let i = 0; i < 24; i++) f.result(f.root, f.call(f.root, 'read', `read-${i}`), { private: 'SECRET_BODY' })
  const operation = { status: 'accepted', durable: true, replayed: false, target_id: worker.id, message_id: 'SECRET_MESSAGE' }
  f.result(f.root, f.call(f.root, 'task_child_send', 'fresh'), { ok: true, operation,
    sent: { target_id: worker.id, message_id: 'SECRET_MESSAGE' },
    target: { id: worker.id, mode: 'continuable', activity_before: 'inactive', current_turn: 'running' }, route: { reported: false } })
  f.result(f.root, f.call(f.root, 'task_child_send', 'replay'), { ok: true, operation: { ...operation, replayed: true } })
  const before = f.collector.observationSnapshot?.('before-cancel')
  assert.equal(before?.taskTail.filter(row => row.kind === 'result' && row.toolName === 'task_child_send').length, 2,
    'ordinary results must not erase the reserved control receipts')
  const [fresh, replay] = before.taskTail.filter(row => row.kind === 'result')
  assert.equal(fresh.control.replayed, false); assert.equal(replay.control.replayed, true)
  assert.equal(fresh.control.targetSlot, 1); assert.equal(replay.control.targetSlot, 1)
  assert.equal(replay.control.mode, null); assert.equal(replay.control.activityBefore, null)
  assert.equal(replay.control.currentTurn, null); assert.equal(replay.control.routeReported, null)
  assert.equal(fresh.control.routeReported, false); assert.equal(replay.control.inboxIdPresent, true)
  assertTaskPartition(f.collector.snapshot()); assert.equal(f.collector.snapshot().byTool.task_child_send.envelopeOk, 2)
  const oldAgent = f.agents.get(worker.id)
  f.collector.observeIdle?.(oldAgent, 1)
  f.collector.disposed(worker)
  const restored = f.create(worker.id, 'root', { seq: worker.seq + 2 })
  f.step(restored, 8, 1)
  f.collector.observeIdle?.(oldAgent, 0)
  const after = f.collector.observationSnapshot('stage-end')
  assert.equal(after.agents[1].agentSlot, before.agents[1].agentSlot)
  assert.ok(after.agents[1].lifetime > before.agents[1].lifetime)
  assert.equal(before.agents[1].turn, 7); assert.equal(after.agents[1].turn, 8)
  assert.equal(after.coverage, 'partial', 'an old Agent idle wait cannot be attributed to the replacement lifetime')
  assert.doesNotMatch(JSON.stringify(after), /SECRET_|private-worker|read-\d/)
})

test('model observation stream links consumed requests to own messages and isolates cancellation phases', async () => {
  const { createModelStreamBoundary } = await api()
  const f = await taskCollectorFixture(), worker = f.create('private-worker', 'root')
  f.collector.beginObservations?.(0); f.step(); f.step(worker, 2, 1)
  const marked = new WeakSet(), signal = new AbortController().signal
  let admitted = 0
  const boundary = createModelStreamBoundary({ tracked: f.agents, provider: 'p', model: 'm',
    isAgentLoopRequest: options => marked.has(options), onRequest() { admitted++ },
    observe: data => f.collector.observeStream?.(data), onFailure() { f.collector.noteCancel?.() } })
  const run = (session, turn, next) => {
    const agent = f.agents.get(session.id)
    boundary.observeRequest({ agent, turn, step: 1, signal })
    const options = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 8192, signal })
    marked.add(options)
    return boundary.intercept(options, next)
  }
  const root = run(f.root, 1, async function* () { yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } } })
  assert.equal(admitted, 0)
  for await (const chunk of root) {}
  const message = f.emit(f.root, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'SECRET_MODEL' }] } })
  const child = run(worker, 2, async function* () { yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }; yield { type: 'text', text: 'SECRET_MODEL' } })
  await child.next()
  const before = f.collector.observationSnapshot?.('before-cancel')
  assert.equal(before?.requests.length, 2, 'both actual consumed request admissions must retain their own coordinates')
  assert.equal(before.requests[0].agentSlot, 0); assert.equal(before.requests[1].agentSlot, 1)
  assert.equal(before.requests[0].assistantSeq, message.seq); assert.equal(before.requests[0].assistantMessageSeen, true)
  assert.equal(before.requests[0].complete, true); assert.equal(before.requests[1].ended, false)
  f.collector.noteCancel(); await child.return()
  const after = f.collector.observationSnapshot('after-dispose')
  assert.equal(before.requests[1].firstFailure, null)
  assert.equal(after.requests[1].firstFailure, 'stream-error'); assert.equal(after.requests[1].failurePhase, 'after-cancel')
  assert.deepEqual(after.agents, []); assert.deepEqual(after.taskTail, []); assert.equal(after.tasks.available, false)
  assert.doesNotMatch(JSON.stringify(after), /SECRET_|private-worker/)
})

for (const fault of ['hook-getter', 'extra', 'accessor', 'proxy', 'inherited', 'thenable', 'promise', 'request-limit', 'agent-limit', 'unknown-enum']) {
  test(`model observation refuses ${fault} without changing timeout or invoking foreign properties`, async t => {
    const { runModelVerification } = await api(), h = setup(t, 'timeout')
    let traps = 0, cancels = 0
    const trap = () => { traps++; throw new Error('SECRET_DIAGNOSTIC') }
    const report = await runModelVerification({ ...h.options, stageTimeoutMs: 10 }, { createHarness: async config => {
      const harness = await h.factory(config)
      harness.beginModelObservationStage = () => {}
      harness.cancel = () => { cancels++ }
      let value = modelObservationProjection()
      if (fault === 'extra') value.source = 'native-own-published-events'
      if (fault === 'accessor') Object.defineProperty(value, 'requests', { get: trap })
      if (fault === 'proxy') value.requests = new Proxy(value.requests, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
      if (fault === 'inherited') value = Object.assign(Object.create({ extra: 'SECRET_DIAGNOSTIC' }), value)
      if (fault === 'thenable') Object.defineProperty(value, 'then', { get: trap })
      if (fault === 'request-limit') value.requests = Array.from({ length: 81 }, () => value.requests[0])
      if (fault === 'agent-limit') value.agents = Array.from({ length: 17 }, () => value.agents[0])
      if (fault === 'unknown-enum') value.requests[0].firstFailure = 'SECRET_CODE'
      if (fault === 'hook-getter') Object.defineProperty(harness, 'modelObservationSnapshot', { get: trap })
      else harness.modelObservationSnapshot = () => fault === 'promise' ? Promise.reject(new Error('SECRET_DIAGNOSTIC')) : value
      return harness
    } })
    assert.equal(report.failure, 'timeout'); assert.equal(report.ok, false)
    assert.equal(report.stages[0].timeoutObservations, null)
    assert.equal(traps, 0); assert.ok(cancels >= 2)
    assert.doesNotMatch(JSON.stringify(report), /SECRET_/)
  })
}

test('model observation bounds tails and keeps the first task failure plus a detached cached task view', async () => {
  const f = await taskCollectorFixture(), worker = f.create('private-worker', 'root')
  f.collector.beginObservations(0); f.step()
  const rows = [{ id: 1, status: 'claimed', owner_session: worker.id, evidence: 4, waived: false, evidence_policy: 'legacy', strictVerified: false }]
  f.collector.observeTasks(rows)
  rows[0].status = 'SECRET_MUTATION'
  f.result(f.root, f.call(f.root, 'task_submit', 'failure'), { ok: false, code: 'E_STATUS', error: 'SECRET_REASON' })
  for (let i = 0; i < 70; i++) f.result(f.root, f.call(f.root, 'task_board', `board-${i}`))
  const snapshot = f.collector.observationSnapshot()
  assert.equal(snapshot.taskTail.length, 64); assert.ok(snapshot.taskDropped > 0)
  assert.equal(snapshot.firstFailure.errorCode, 'E_STATUS')
  assert.equal(snapshot.firstFailure.toolName, 'task_submit')
  assert.equal(snapshot.tasks.rows[0].status, 'claimed'); assert.equal(snapshot.tasks.rows[0].ownerSlot, 1)
  snapshot.tasks.rows[0].status = 'mutated'; snapshot.taskTail[0].kind = 'mutated'
  assert.equal(f.collector.observationSnapshot().tasks.rows[0].status, 'claimed')
  assert.notEqual(f.collector.observationSnapshot().taskTail[0].kind, 'mutated')
  assert.equal(f.collector.snapshot().byTool.task_board.envelopeOk, 70)
  assert.equal(f.collector.snapshot().errorCounts.E_STATUS, 1)
  f.collector.beginObservations(1)
  assert.equal(f.collector.observationSnapshot().tasks.available, false)
  assert.equal(f.collector.observationSnapshot().taskTail.length, 0)
})

test('model observation saturates cached evidence counts and labels the first task error phase', async () => {
  for (const phase of ['before-cancel', 'after-cancel']) {
    const f = await taskCollectorFixture()
    f.collector.beginObservations(0); f.step()
    f.collector.observeTasks([{ id: 1, status: 'claimed', owner_session: 'root', evidence: 65536, waived: false, evidence_policy: 'legacy', strictVerified: false }])
    if (phase === 'after-cancel') f.collector.noteCancel()
    f.result(f.root, f.call(f.root, 'task_submit', 'failure'), { ok: false, code: 'E_STATUS' })
    const snapshot = f.collector.observationSnapshot()
    assert.equal(snapshot.firstFailure.failurePhase, phase)
    assert.equal(snapshot.tasks.rows[0].evidenceCount, 65535)
    assert.equal(snapshot.saturated, true); assert.equal(snapshot.coverage, 'partial')
    assert.equal(f.collector.snapshot().byTool.task_submit.envelopeError, 1)
  }
})

test('model observation reserves allowlisted child controls and retains fixed transport error codes', async () => {
  const f = await taskCollectorFixture()
  f.collector.beginObservations(0); f.step()
  const controls = ['task_child_spawn', 'task_child_fork', 'task_child_interrupt', 'task_child_list']
  for (const name of controls) f.result(f.root, f.call(f.root, name, name))
  for (let i = 0; i < 24; i++) f.result(f.root, f.call(f.root, 'read', `read-${i}`))
  f.result(f.root, f.call(f.root, 'read', 'failure'), {}, { message: { isError: true }, data: { error: { code: 'FS_NOT_FOUND', message: 'SECRET_ERROR' } } })
  const snapshot = f.collector.observationSnapshot()
  assert.deepEqual(snapshot.taskTail.filter(row => row.kind === 'result').map(row => row.toolName), controls)
  assert.equal(snapshot.firstFailure.errorCode, 'FS_NOT_FOUND')
  assert.equal(snapshot.firstFailure.failurePhase, 'before-cancel')
  assert.equal(snapshot.firstFailure.toolName, 'read')
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_ERROR/)
  assertTaskPartition(f.collector.snapshot())
})

test('model observation retains the first owned runtime failure after ordinary tail truncation', async () => {
  for (const [type, data, kind] of [
    ['step/error', { turn: 1, step: 1, error: 'SECRET_ERROR' }, 'step-error'],
    ['compaction/summary', { text: 'SECRET_ERROR' }, 'auxiliary-call'],
    ['compaction/end', { error: 'SECRET_ERROR' }, 'compaction-error'],
    ['turn/end', { turn: 1, reason: { kind: 'error', message: 'SECRET_ERROR' } }, 'turn-end'],
  ]) {
    const f = await taskCollectorFixture()
    f.collector.beginObservations(0); f.step()
    const failed = f.emit(f.root, type, data)
    for (let i = 0; i < 35; i++) f.emit(f.root, 'other/event', { text: 'SECRET_NOISE' })
    const snapshot = f.collector.observationSnapshot()
    assert.equal(snapshot.firstFailure?.kind, kind)
    assert.equal(snapshot.firstFailure.seq, failed.seq)
    assert.equal(snapshot.firstFailure.failurePhase, 'before-cancel')
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_/)
  }
})

test('model observation v2 degrades failed settlement refreshes without replacing native idle promises', async () => {
  const { waitForNativeSettlement } = await api()
  for (const fault of ['history', 'mixed-status', 'obligations', 'projection', 'collector']) {
    const f = await taskCollectorFixture(), child = f.create('private-child', 'root')
    f.collector.beginObservations(0)
    const rootIdle = deferred(), childIdle = deferred()
    const gates = [rootIdle, childIdle], originalAll = Promise.all
    let read, exactInputs, calls = 0, broken = false, unavailable = 0
    const observation = { ...f.collector, observationUnavailable() { unavailable++; f.collector.observationUnavailable?.() } }
    for (const [index, agent] of [...f.agents.values()].entries()) {
      agent.status = 'idle'; agent.session.snapshotEvents = () => {
        if (broken && fault === 'history') throw new Error('SECRET_HISTORY')
        return []
      }
      agent.whenIdle = () => { calls++; return gates[index].promise }
    }
    const activationCounts = new Map([['private-child', 1]])
    const beforeCounts = new Map([['private-child', 1]])
    let pending
    try {
      Promise.all = function (inputs) { exactInputs = [...inputs]; return originalAll.call(this, exactInputs) }
      pending = waitForNativeSettlement({ tracked: f.agents, rootId: 'root', activationCounts, beforeCounts,
        beforeNotices: new Map(), isDisposed: () => false, observation, observe: value => { read = value } })
    } finally { Promise.all = originalAll }
    try {
      assert.equal(read().idleAgents, 2)
      assert.equal(f.collector.observationSnapshot().coverage, 'complete')
      assert.equal(f.collector.observationSnapshot().agents[1].requiredNotices, 0)
      broken = true
      if (fault === 'mixed-status') {
        f.agents.get('root').status = 'running'
        Object.defineProperty(f.agents.get(child.id), 'status', { configurable: true, get() { throw new Error('SECRET_STATUS') } })
      }
      if (fault === 'obligations') activationCounts.get = () => { throw new Error('SECRET_OBLIGATIONS') }
      if (fault === 'projection') activationCounts.get = () => NaN
      if (fault === 'collector') child.isOwnSeq = () => false
      if (fault === 'collector') f.emit(child, 'turn/start', { turn: 1 })
      const progress = read(), diagnostic = f.collector.observationSnapshot('before-cancel')
      if (fault !== 'collector') assert.equal(progress, null)
      if (fault !== 'collector') assert.ok(unavailable > 0)
      assert.ok(diagnostic === null || diagnostic.coverage === 'partial', 'failed or mixed refresh cannot retain complete cached authority')
      assert.equal(exactInputs[0], rootIdle.promise); assert.equal(exactInputs[1], childIdle.promise)
      assert.equal(calls, 2)
    } finally {
      broken = false
      delete activationCounts.get
      for (const agent of f.agents.values()) Object.defineProperty(agent, 'status', { configurable: true, writable: true, value: 'idle' })
      rootIdle.resolve(); childIdle.resolve(); await pending
    }
  }
})

test('model observation v2 records only stable matching ended correspondence and preserves pending timeout evidence', async t => {
  const { runModelVerification, createModelStreamBoundary } = await api()
  for (const mode of ['stable', 'unmatched', 'pending', 'late']) {
    const f = await taskCollectorFixture(), h = setup(t, 'timeout'), active = []
    let afterSecond = null
    const report = await runModelVerification({ ...h.options, stageTimeoutMs: 40 }, { createHarness: async config => {
      const marked = new WeakSet(), signal = new AbortController().signal
      let settled = false
      const sessions = [{ id: 'root', parent: null, events: [] }]
      const boundary = createModelStreamBoundary({ tracked: f.agents, provider: config.provider, model: config.model,
        isAgentLoopRequest: options => marked.has(options), onRequest: config.onRequest,
        observe: data => f.collector.observeStream(data), onFailure() { f.collector.noteCancel() } })
      const streamSnapshot = () => {
        const value = boundary.snapshot()
        return mode === 'unmatched' ? { ...value, records: value.records.map(row => ({ ...row, key: 'unproved-coordinate' })) } : value
      }
      const consume = async (session, turn, held) => {
        f.step(session, turn, 1)
        boundary.observeRequest({ agent: f.agents.get(session.id), turn, step: 1, signal })
        const options = Object.freeze({ sessionId: session.id, provider: config.provider, model: config.model, maxTokens: 8192, signal })
        marked.add(options)
        const stream = boundary.intercept(options, async function* () {
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })
        active.push(stream)
        if (held) await stream.next()
        else for await (const chunk of stream) {}
      }
      return { hostVersion: '0.2.0-rc.2', rootId: 'root',
        snapshot: () => ({ sessions, tasks: [], settled, streamAccounting: streamSnapshot() }), streamSnapshot,
        beginModelObservationStage: index => f.collector.beginObservations(index),
        modelObservationSnapshot: phase => f.collector.observationSnapshot(phase),
        observeModelAccounting: value => f.collector.observeAccounting?.(value),
        async runStage() {
          await consume(f.root, 1, mode === 'pending')
          if (mode === 'pending') {
            const worker = f.create('private-worker', 'root'); sessions.push({ id: worker.id, parent: 'root', events: [] })
            await consume(worker, 1, true)
            afterSecond = f.collector.observationSnapshot('stage-end')
            return new Promise(() => {})
          }
          if (mode === 'late') return new Promise(() => {})
          settled = true
        },
        cancel() { f.collector.noteCancel(); if (mode === 'late') settled = true },
        async dispose() { f.collector.noteDisposing(); for (const stream of active) await stream.return() },
      }
    } })
    const stage = report.stages[0]
    assert.equal(report.ok, false)
    assert.equal(report.runtimeDiagnostics.counts['missing-message'], mode === 'pending' ? 2 : 1)
    if (mode === 'stable') {
      assert.equal(report.failure, 'usage-or-runtime-error')
      assert.equal(stage.observations.firstFailure?.kind, 'missing-message', 'stable accounting failure must reach first observed evidence')
      assert.equal(stage.observations.firstFailure.requestIndex, 0)
      assert.equal(stage.observations.requests[0].firstFailure, 'missing-message')
      assert.equal(stage.observations.requests[0].failurePhase, 'before-cancel')
      assert.deepEqual([stage.observations.firstFailure.agentSlot, stage.observations.firstFailure.turn, stage.observations.firstFailure.step], [0, 1, 1])
    } else if (mode === 'unmatched') {
      assert.equal(report.failure, 'usage-or-runtime-error')
      assert.equal(stage.observations.firstFailure, null)
      assert.equal(stage.observations.coverage, 'partial')
    } else if (mode === 'pending') {
      assert.equal(report.failure, 'timeout'); assert.equal(stage.requests, 2)
      assert.equal(afterSecond.firstFailure, null)
      assert.ok(afterSecond.requests.every(row => row.firstFailure === null && row.ended === false))
      assert.equal(stage.timeoutObservations.firstFailure, null)
      assert.ok(stage.timeoutObservations.requests.every(row => row.firstFailure === null && row.ended === false))
      assert.ok(stage.postDisposeObservations.requests.every(row => row.firstFailure === 'stream-error' && row.failurePhase === 'during-dispose'))
    } else {
      assert.equal(report.failure, 'timeout')
      assert.equal(stage.timeoutObservations.firstFailure, null)
      assert.equal(stage.timeoutObservations.requests[0].firstFailure, null)
      assert.equal(stage.observations.firstFailure.kind, 'missing-message')
      assert.equal(stage.observations.requests[0].failurePhase, 'after-cancel')
    }
    assert.equal(stage.postDisposeObservations.coverage, 'partial', 'retained sessions plus later streams do not prove a simultaneous observation')
    assert.doesNotMatch(JSON.stringify(report), /private-worker|unproved-coordinate/)
  }
})

test('model observation v2 accounting intake refuses malformed primitives without invoking foreign properties', async () => {
  for (const fault of ['accessor', 'proxy', 'extra', 'limit', 'count']) {
    const f = await taskCollectorFixture()
    f.collector.beginObservations(0)
    let traps = 0
    const trap = () => { traps++; throw new Error('SECRET_ACCOUNTING') }
    const value = { stable: true, mixed: false, truncated: false, missingCount: 0, otherFailures: false, missing: [] }
    if (fault === 'accessor') Object.defineProperty(value, 'missing', { get: trap })
    if (fault === 'proxy') value.missing = new Proxy([], { get: trap, ownKeys: trap })
    if (fault === 'extra') value.extra = 'SECRET_ACCOUNTING'
    if (fault === 'limit') value.missing = Array.from({ length: 21 }, () => ({ requestIndex: 0, matchedEnded: true }))
    if (fault === 'count') value.missingCount = 65536
    f.collector.observeAccounting(value)
    const snapshot = f.collector.observationSnapshot()
    assert.equal(snapshot.coverage, 'partial'); assert.equal(snapshot.firstFailure, null)
    assert.equal(traps, 0); assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_ACCOUNTING/)
  }
})

test('model observation v3 loses owned authority after a failed disposal identity read', async () => {
  const f = await taskCollectorFixture(), worker = f.create('private-worker', 'root')
  const agent = f.agents.get(worker.id)
  f.collector.beginObservations(0); f.step(worker, 4, 1)
  f.collector.observeStatus(agent, 'running'); f.collector.observeIdle(agent, 1)
  const before = f.collector.observationSnapshot('before-cancel'), frozen = JSON.stringify(before)
  assert.equal(before.coverage, 'complete')
  assert.equal(before.agents[1].status, 'running'); assert.equal(before.agents[1].pendingIdleWaits, 1)
  assert.notEqual(f.collector.snapshot(), null)
  Object.defineProperty(worker, 'id', { get() { throw new Error('SECRET_DISPOSAL_ID') } })
  assert.doesNotThrow(() => f.collector.disposed(worker))
  assert.equal(f.collector.snapshot(), null, 'legacy failed disposal observation remains unavailable')
  assert.equal(f.collector.observationSnapshot('stage-end'), null,
    'failed owned disposal identity must invalidate stale additive authority')
  assert.equal(JSON.stringify(before), frozen, 'earlier detached evidence stays immutable')
  f.collector.beginObservations(1)
  assert.equal(f.collector.observationSnapshot(), null, 'stage reset cannot recover unobserved disposal authority')
  assert.doesNotMatch(frozen, /private-worker|SECRET_DISPOSAL_ID/)
})

test('model observation rejects inherited or discontinuous publications and bounds event and lifetime coverage', async () => {
  const matrix = [], expectedCoverage = []
  const fresh = async () => {
    const fixture = await taskCollectorFixture()
    fixture.collector.beginObservations(0)
    return fixture
  }
  const capture = (label, fixture, fault, expected, coverage = 'partial') => {
    const before = fixture.collector.observationSnapshot()
    assert.equal(before.coverage, 'complete', `${label}: independent complete precondition`)
    assert.equal(before.taskDropped, 0); assert.equal(before.ordinaryDropped, 0)
    fault()
    const after = fixture.collector.observationSnapshot(), legacy = fixture.collector.snapshot()
    assert.ok(after, `${label}: owned authority remains available`)
    assertTaskPartition(legacy)
    const empty = { calls: 0, nativeResults: 0, ptcResults: 0, envelopeOk: 0, envelopeError: 0, transportError: 0, unavailableResults: 0 }
    const row = { ...empty, ...expected.row }, tool = expected.tool ?? 'task_board'
    for (const name of taskToolNames) assert.deepEqual(legacy.byTool[name], name === tool ? row : empty, `${label}: ${name} legacy partition`)
    assert.equal(legacy.unattributedResults, expected.unattributed ?? 0, `${label}: legacy unattributed`)
    assert.deepEqual(legacy.byRole, { root: row.calls, worker: 0, unknown: 0 })
    assert.ok(Object.values(legacy.errorCounts).every(value => value === 0))
    assert.equal(legacy.details.length, Math.min(20, row.nativeResults + row.ptcResults + (expected.unattributed ?? 0)))
    assert.equal(legacy.truncated, expected.truncated ?? false); assert.equal(legacy.saturated, false)
    assert.equal(after.firstFailure, null, `${label}: refusal is not an invented application failure`)
    assert.equal(after.taskDropped, 0); assert.equal(after.ordinaryDropped, 0)
    assert.doesNotMatch(JSON.stringify(after), /SECRET_|private-|wrapper|inner|padding/)
    matrix.push({ label, before: before.coverage, after: after.coverage, calls: row.calls,
      nativeResults: row.nativeResults, ptcResults: row.ptcResults, envelopeOk: row.envelopeOk,
      unavailableResults: row.unavailableResults, unattributedResults: legacy.unattributedResults, legacyTruncated: legacy.truncated })
    expectedCoverage.push({ label, before: 'complete', after: coverage })
    return after
  }
  {
    const fixture = await fresh(); fixture.step(); fixture.call(fixture.root, 'task_board', 'same')
    capture('duplicate-native', fixture, () => fixture.call(fixture.root, 'task_board', 'same'), { row: { calls: 2 } })
  }
  {
    const fixture = await fresh(), p = ptcFixture(fixture); p.start()
    capture('duplicate-ptc', fixture, () => p.start(), { row: { calls: 2 } })
  }
  for (const [label, change] of [
    ['empty-call-id', { callId: '' }], ['oversized-call-id', { callId: 'x'.repeat(257) }],
    ['invalid-turn', { turn: -1 }], ['invalid-step', { step: -1 }],
    ['empty-name', { name: '' }], ['oversized-name', { name: 'x'.repeat(257) }],
    ['utf8-name', { name: '界'.repeat(100) }],
  ]) {
    const fixture = await fresh(); fixture.step()
    capture(`native-${label}`, fixture,
      () => fixture.emit(fixture.root, 'tool/call', { turn: 1, step: 1, callId: 'valid', name: 'task_board', ...change }),
      { row: { calls: change.name === undefined ? 1 : 0 } })
  }
  for (const phase of ['start', 'result']) {
    for (const [label, change] of [
      ['root', { rootCallId: 'unknown' }], ['parent', { parentCallId: '' }], ['sub', { subCallId: '' }],
      ['name', { name: '' }], ['oversized-name', { name: 'x'.repeat(257) }],
      ['turn', { turn: 2 }], ['step', { step: 2 }],
    ]) {
      const fixture = await fresh(), p = ptcFixture(fixture)
      const data = phase === 'result' ? p.start() : { rootCallId: 'wrapper', parentCallId: 'wrapper', subCallId: 'inner', name: 'task_board' }
      capture(`ptc-${phase}-${label}`, fixture, () => phase === 'result' ? p.result(data, change)
        : fixture.emit(fixture.root, 'tool/ptc-dispatch-start', { ...data, ...change }),
      { row: { calls: phase === 'result' ? 1 : 0 }, unattributed: phase === 'result' ? 1 : 0 })
    }
  }
  for (const [label, change] of [['name-mismatch', { name: 'task_open' }], ['orphan', { subCallId: 'unknown' }]]) {
    const fixture = await fresh(), p = ptcFixture(fixture), data = p.start()
    capture(`ptc-result-${label}`, fixture, () => p.result(data, change), { row: { calls: 1 }, unattributed: 1 })
  }
  for (const nonunique of [false, true]) {
    const fixture = await fresh(), p = ptcFixture(fixture)
    if (nonunique) {
      p.start('parent-a'); p.start('shared', 'task_board', 'parent-a')
      p.start('parent-b'); p.start('shared', 'task_board', 'parent-b')
    }
    capture(`ptc-start-${nonunique ? 'nonunique' : 'unknown'}-parent`, fixture,
      () => p.start('child', 'task_board', nonunique ? 'shared' : 'unknown'), { row: { calls: nonunique ? 4 : 0 } })
  }
  for (const [label, padding, characters, bytes] of [
    ['character-cap', 'x'.repeat(65537), 65561, 65561], ['utf8-cap', '界'.repeat(30000), 30024, 90024],
  ]) {
    const fixture = await fresh(); fixture.step()
    const body = { ok: true, padding }, text = JSON.stringify(body), call = fixture.call(fixture.root, 'task_board')
    assert.equal(text.length, characters); assert.equal(Buffer.byteLength(text, 'utf8'), bytes)
    capture(label, fixture, () => fixture.result(fixture.root, call, body),
      { row: { calls: 1, nativeResults: 1, unavailableResults: 1 }, truncated: true })
  }
  {
    const fixture = await fresh(); fixture.step()
    const body = { ok: true, padding: 'x'.repeat(65500) }
    assert.equal(Buffer.byteLength(JSON.stringify(body), 'utf8'), 65524)
    for (let i = 0; i < 32; i++) fixture.result(fixture.root, fixture.call(fixture.root, 'task_board', `budget-${i}`), body)
    const beforeReset = fixture.collector.observationSnapshot()
    assert.equal(beforeReset.coverage, 'complete'); assert.equal(beforeReset.taskTail.length, 64)
    assert.equal(beforeReset.taskDropped, 0); assert.equal(fixture.collector.snapshot().details.length, 20)
    assert.equal(fixture.collector.snapshot().truncated, true, 'old detail truncation alone is not additive coverage loss')
    fixture.collector.beginObservations(1) // Clear only diagnostic tails; keep the spent decode budget.
    assert.deepEqual(fixture.collector.observationSnapshot().taskTail, [])
    const after = capture('cumulative-decode-cap', fixture,
      () => fixture.result(fixture.root, fixture.call(fixture.root, 'task_board', 'budget-32'), body),
      { row: { calls: 33, nativeResults: 33, envelopeOk: 32, unavailableResults: 1 }, truncated: true })
    assert.equal(after.taskTail.length, 2)
  }
  for (const name of ['read', 'private-unknown-tool']) {
    const fixture = await fresh(); fixture.step()
    const after = capture(name === 'read' ? 'ordinary-unattributed-control' : 'unknown-tool-control', fixture,
      () => fixture.result(fixture.root, fixture.call(fixture.root, name), { private: 'SECRET_BODY' }),
      { row: {}, unattributed: 1 }, 'complete')
    const rows = after.ordinaryTail.filter(row => row.kind === 'call' || row.kind === 'result')
    assert.equal(rows.length, 2); assert.equal(rows[1].outcome, 'transport-ok')
    if (name !== 'read') assert.ok(rows.every(row => row.toolName === null))
  }
  for (const [label, content] of [
    ['malformed-json', [{ type: 'text', text: '{SECRET_BROKEN' }]],
    ['missing-ok', [{ type: 'text', text: '{"private":"SECRET_BODY"}' }]],
    ['unsupported-content', [{ type: 'image', data: 'SECRET_BODY' }]],
  ]) {
    const fixture = await fresh(); fixture.step()
    const call = fixture.call(fixture.root, 'task_board')
    const after = capture(`${label}-control`, fixture,
      () => fixture.result(fixture.root, call, {}, { message: { content } }),
      { row: { calls: 1, nativeResults: 1, unavailableResults: 1 } }, 'complete')
    assert.equal(after.taskTail.at(-1).outcome, 'unavailable')
  }
  {
    const fixture = await fresh(); fixture.step()
    const after = capture('omitted-replay-fields-control', fixture,
      () => fixture.result(fixture.root, fixture.call(fixture.root, 'task_child_send'),
        { ok: true, operation: { status: 'accepted', durable: true, replayed: true, target_id: 'private-unknown-target' } }),
      { tool: 'task_child_send', row: { calls: 1, nativeResults: 1, envelopeOk: 1 } }, 'complete')
    assert.deepEqual(after.taskTail.at(-1).control, { status: 'accepted', durable: true, replayed: true,
      targetSlot: null, inboxIdPresent: null, mode: null, activityBefore: null, currentTurn: null, routeReported: null })
  }
  // All independent refusals execute before the single coverage assertion, including during RED.
  console.log('model-observation-refusal-matrix ' + JSON.stringify(matrix))
  assert.deepEqual(matrix.map(({ label, before, after }) => ({ label, before, after })), expectedCoverage)
  for (const fault of ['inherited', 'gap']) {
    const f = await taskCollectorFixture(), worker = f.create('private-worker', 'root', { cut: 5, seq: 5 })
    f.collector.beginObservations(0)
    if (fault === 'gap') worker.seq++
    else worker.isOwnSeq = () => false
    f.emit(worker, 'turn/start', { turn: 1 })
    assert.equal(f.collector.observationSnapshot(), null)
  }
  const f = await taskCollectorFixture()
  f.collector.beginObservations(0)
  for (let i = 0; i < 4100; i++) f.emit(f.root, 'other/event', { body: 'SECRET_BODY' })
  const bounded = f.collector.observationSnapshot()
  assert.equal(bounded.ordinaryTail.length, 32); assert.equal(bounded.coverage, 'partial')
  assert.equal(f.collector.snapshot().observedEvents, 4096)
  let worker = f.create('private-worker', 'root')
  for (let i = 0; i < 257; i++) {
    f.collector.disposed(worker)
    worker = f.create(worker.id, 'root', { seq: worker.seq })
  }
  assert.equal(f.collector.observationSnapshot().coverage, 'partial')
  assert.ok(f.collector.observationSnapshot().agents.every(row => row.lifetime < 256))
})

test('published task collector uses own native coordinates, role lineage, stages and exact envelope partition', async () => {
  const f = await taskCollectorFixture(), worker = f.create('private-id', 'root', { cut: 8, seq: 10 })
  f.step(); f.step(worker)
  const old = f.call(f.root), child = f.call(worker, 'task_board', 'worker-call')
  f.result(worker, child, { ok: false, code: 'E_CONTROL_OUTCOME_UNKNOWN', error: 'SECRET_reason', path: '/private-path' })
  assert.equal(f.collector.snapshot().byRole.worker, 1)
  f.collector.beginStage()
  f.result(f.root, old)
  const report = f.collector.snapshot()
  assertTaskPartition(report)
  assert.equal(report.byTool.task_open.calls, 0)
  assert.equal(report.byTool.task_open.envelopeOk, 1)
  assert.equal(report.observedEvents, 1)
  assert.deepEqual(report.byRole, { root: 0, worker: 0, unknown: 0 })
})

for (const mutation of ['source-kind', 'source-id', 'message-id', 'call-id', 'turn', 'step', 'name', 'source-name', 'seq', 'multiple-seqs', 'missing-seqs', 'orphan', 'duplicate']) {
  test(`published task collector rejects conflicting native association: ${mutation}`, async () => {
    const f = await taskCollectorFixture(); f.step()
    const call = f.call(), changes = {}
    if (mutation === 'source-kind') changes.message = { source: { kind: 'SECRET_source', callId: 'call' } }
    if (mutation === 'source-id') changes.message = { source: { kind: 'tool', callId: 'SECRET_id' } }
    if (mutation === 'message-id') changes.message = { toolCallId: 'SECRET_id' }
    if (mutation === 'call-id') changes.data = { callId: 'SECRET_id' }
    if (mutation === 'turn') changes.data = { turn: 2 }
    if (mutation === 'step') changes.data = { step: 2 }
    if (mutation === 'name') changes.data = { name: 'task_board' }
    if (mutation === 'source-name') changes.message = { source: { kind: 'tool', callId: 'call', toolName: 'SECRET_tool' } }
    if (mutation === 'seq') changes.event = { sourceEventSeqs: [call.seq - 1] }
    if (mutation === 'multiple-seqs') changes.event = { sourceEventSeqs: [call.seq, call.seq] }
    if (mutation === 'missing-seqs') changes.event = { sourceEventSeqs: undefined }
    if (mutation === 'orphan') changes.message = { source: { kind: 'tool', callId: 'orphan' }, toolCallId: 'orphan' }
    if (mutation === 'duplicate') f.result(f.root, call)
    f.result(f.root, call, { ok: true }, changes)
    const report = f.collector.snapshot(); assertTaskPartition(report)
    assert.equal(report.unattributedResults, 1)
    assert.equal(report.byTool.task_open.nativeResults, mutation === 'duplicate' ? 1 : 0)
    assert.equal(report.byTool.task_open.unavailableResults, 0)
  })
}

for (const shape of ['malformed', 'array', 'missing-ok', 'string-ok', 'multiple', 'nontext', 'oversize-char', 'oversize-utf8', 'transport', 'unknown-code']) {
  test(`published task collector bounds and decodes associated result: ${shape}`, async () => {
    const f = await taskCollectorFixture(); f.step(); const call = f.call()
    const message = {}, body = shape === 'unknown-code' ? { ok: false, code: 'SECRET_CODE' } : { ok: true }
    if (shape === 'malformed') message.content = [{ type: 'text', text: '{' }]
    if (shape === 'array') message.content = [{ type: 'text', text: '[{"ok":true}]' }]
    if (shape === 'missing-ok') message.content = [{ type: 'text', text: '{}' }]
    if (shape === 'string-ok') message.content = [{ type: 'text', text: '{"ok":"true"}' }]
    if (shape === 'multiple') message.content = [{ type: 'text', text: '{"ok":true}' }, { type: 'text', text: '{}' }]
    if (shape === 'nontext') message.content = [{ type: 'image', data: 'SECRET_' }]
    if (shape === 'oversize-char') message.content = [{ type: 'text', text: 'x'.repeat(65537) }]
    if (shape === 'oversize-utf8') message.content = [{ type: 'text', text: '界'.repeat(30000) }]
    if (shape === 'transport') { message.isError = true; message.content = [{ type: 'text', text: '{"ok":true}' }] }
    f.result(f.root, call, body, { message })
    const report = f.collector.snapshot(); assertTaskPartition(report)
    assert.equal(report.byTool.task_open.nativeResults, 1)
    assert.equal(report.byTool.task_open[shape === 'transport' ? 'transportError' : shape === 'unknown-code' ? 'envelopeError' : 'unavailableResults'], 1)
    assert.equal(report.errorCounts.unknown, shape === 'unknown-code' ? 1 : 0)
    assert.equal(report.truncated, shape.startsWith('oversize'))
  })
}

test('published task collector rejects inherited seed results and accepts legal cold unpublished suffix without replay', async () => {
  const f = await taskCollectorFixture(); f.step(); const parentCall = f.call()
  const child = f.create('worker', 'root', { cut: f.root.seq, seq: f.root.seq + 2 })
  f.result(child, parentCall)
  assert.equal(f.collector.snapshot().unattributedResults, 1)
  f.step(child); const pending = f.call(child, 'task_board')
  const savedSeq = child.seq
  f.collector.disposed(child); f.agents.delete(child.id)
  const restored = f.create('worker', 'root', { cut: f.root.seq, seq: savedSeq + 3 })
  f.collector.beginStage(); f.step(restored)
  f.result(restored, pending)
  const current = f.call(restored, 'task_board', 'current'); f.result(restored, current)
  const report = f.collector.snapshot(); assertTaskPartition(report)
  assert.equal(report.byTool.task_board.calls, 1)
  assert.equal(report.byTool.task_board.envelopeOk, 1)
  assert.equal(report.unattributedResults, 1)
})

for (const fault of ['gap', 'duplicate-publication', 'seq-rollback', 'cut', 'lineage', 'registry', 'concurrent', 'ownership-throw']) {
  test(`published task collector contains invalid ownership/publication: ${fault}`, async () => {
    const f = await taskCollectorFixture(), worker = f.create('worker', 'root'); f.step(worker)
    if (fault === 'gap') worker.seq++
    if (fault === 'duplicate-publication') worker.seq--
    if (fault === 'seq-rollback') { f.collector.disposed(worker); f.create('worker', 'root', { seq: 0 }) }
    if (fault === 'cut') worker.inheritedEventCount++
    if (fault === 'lineage') worker.header.parentSession = 'private-id'
    if (fault === 'registry') f.agents.set(worker.id, { id: worker.id, session: worker })
    if (fault === 'concurrent') f.create('worker', 'root', { seq: worker.seq })
    if (fault === 'ownership-throw') worker.isOwnSeq = () => { throw new Error('SECRET_fault') }
    assert.doesNotThrow(() => f.call(worker))
    assert.equal(f.collector.snapshot(), null)
  })
}

for (const role of ['first-root', 'new-direct-child']) {
  for (const fault of ['identity-mismatch', 'registry-throw', 'header-throw']) {
    test(`published task collector preserves unestablished ownership across stages: ${role} ${fault}`, async () => {
      const f = await taskCollectorFixture(role === 'first-root' ? { announceRoot: false, beginStage: false } : {})
      const session = role === 'first-root' ? f.root : f.create('worker', 'root', { announce: false })
      if (role === 'new-direct-child') {
        f.result(f.root, f.call(f.root, 'task_board', 'before-child'))
        assert.equal(f.collector.snapshot().byTool.task_board.envelopeOk, 1, 'root coverage is established before child acquisition fails')
      }
      const agent = f.agents.get(session.id), header = session.header
      if (fault === 'identity-mismatch') agent.session = { id: session.id }
      if (fault === 'registry-throw') f.agents.get = id => {
        if (id === session.id) throw new Error('acquisition lookup failed')
        return Map.prototype.get.call(f.agents, id)
      }
      if (fault === 'header-throw') Object.defineProperty(session, 'header', { configurable: true, get() { throw new Error('acquisition header failed') } })
      assert.doesNotThrow(() => f.collector.created(session))
      assert.equal(f.collector.snapshot(), null, 'failed acquisition is initially unavailable')
      agent.session = session
      delete f.agents.get
      Object.defineProperty(session, 'header', { configurable: true, writable: true, value: header })
      const observations = []
      for (let stage = 1; stage <= 3; stage++) {
        f.collector.beginStage()
        observations.push([`stage ${stage} reset`, f.collector.snapshot()])
        f.step(session, stage)
        f.result(session, f.call(session, 'task_board', `unobserved-${stage}`, stage))
        if (role === 'new-direct-child') f.result(f.root, f.call(f.root, 'task_board', `root-${stage}`, stage))
        observations.push([`stage ${stage} subsequent own publications`, f.collector.snapshot()])
      }
      for (const [boundary, snapshot] of observations) assert.equal(snapshot, null, `${boundary} cannot reestablish missing ownership`)
    })
  }
}

test('published task collector healthy repeated stage resets and cold restoration remain available', async () => {
  const f = await taskCollectorFixture()
  let worker = f.create('worker', 'root')
  for (let stage = 1; stage <= 3; stage++) {
    if (stage === 2) {
      const seq = worker.seq
      f.collector.disposed(worker); f.agents.delete(worker.id)
      worker = f.create('worker', 'root', { seq: seq + 2 })
    }
    f.collector.beginStage()
    assertTaskPartition(f.collector.snapshot())
    assert.equal(f.collector.snapshot().observedEvents, 0)
    f.step(worker, stage)
    f.result(worker, f.call(worker, 'task_board', `healthy-${stage}`, stage))
    const report = f.collector.snapshot(); assertTaskPartition(report)
    assert.equal(report.byTool.task_board.calls, 1)
    assert.equal(report.byTool.task_board.envelopeOk, 1)
    assert.equal(report.observedEvents, 4)
    assert.equal(report.truncated, false)
  }
})

test('published task collector bounds details, events, coordinates, cumulative bytes and counter saturation', async () => {
  const f = await taskCollectorFixture(); f.step()
  for (let i = 0; i < 34; i++) {
    const call = f.call(f.root, 'task_board', `call-${i}`)
    f.result(f.root, call, { ok: true, padding: 'x'.repeat(65500) })
  }
  let report = f.collector.snapshot(); assertTaskPartition(report)
  assert.equal(report.details.length, 20); assert.equal(report.truncated, true)
  assert.equal(report.byTool.task_board.envelopeOk, 32)
  assert.equal(report.byTool.task_board.unavailableResults, 2)
  const huge = f.call(f.root, 'task_board', 'x'.repeat(257)); f.result(f.root, huge)
  assert.equal(f.collector.snapshot().unattributedResults, 1)
  const pending = f.call(f.root, 'task_board', 'pending')
  while (f.collector.snapshot().observedEvents < 4096) f.emit(f.root, 'unknown/event')
  f.result(f.root, pending)
  report = f.collector.snapshot(); assertTaskPartition(report)
  assert.equal(report.observedEvents, 4096); assert.equal(report.byTool.task_board.unavailableResults, 3)
  for (let i = 0; i < 65536; i++) f.result(f.root, pending)
  report = f.collector.snapshot()
  assert.equal(report.unattributedResults, 65535); assert.equal(report.saturated, true)
})

for (const fault of ['begin-throws', 'begin-accessor', 'begin-promise', 'source-forgery']) {
  test(`task diagnostic stage boundary refuses ${fault} without stale success`, async t => {
    const { runModelVerification } = await api(), h = setup(t, 'timeout')
    let getters = 0
    const report = await runModelVerification({ ...h.options, stageTimeoutMs: 10 }, { createHarness: async config => {
      const harness = await h.factory(config)
      harness.beginTaskToolDiagnosticsStage = () => { if (fault === 'begin-throws') throw new Error('SECRET_'); if (fault === 'begin-promise') return Promise.reject(new Error('SECRET_')) }
      if (fault === 'begin-accessor') Object.defineProperty(harness, 'beginTaskToolDiagnosticsStage', { get() { getters++; throw new Error('SECRET_') } })
      harness.taskToolDiagnosticsSnapshot = () => ({ ...taskProjection(), ...(fault === 'source-forgery' ? { source: 'native-own-published-events' } : {}) })
      return harness
    } })
    assert.equal(report.failure, 'timeout'); assert.equal(getters, 0)
    assert.equal(report.stages[0].taskToolDiagnostics, null)
    assert.equal(report.stages[0].timeoutTaskToolDiagnostics, null)
  })
}

function ptcFixture(f) {
  f.step()
  const root = f.call(f.root, 'run_code', 'wrapper')
  const start = (subCallId = 'inner', name = 'task_board', parentCallId = 'wrapper', rootCallId = 'wrapper') => {
    const data = { rootCallId, parentCallId, subCallId, name }
    f.emit(f.root, 'tool/ptc-dispatch-start', data)
    return data
  }
  const result = (data, changes = {}) => f.emit(f.root, 'tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: '{"ok":true}' }], ...changes })
  return { root, start, result }
}
for (const fault of ['root', 'parent', 'sub', 'name', 'turn', 'step', 'orphan', 'duplicate', 'conflicting-start', 'outside-step']) {
  test(`published task collector requires full PTC association: ${fault}`, async () => {
    const f = await taskCollectorFixture(), p = ptcFixture(f), data = p.start()
    if (fault === 'duplicate') p.result(data)
    if (fault === 'conflicting-start') p.start('inner', 'task_open')
    if (fault === 'outside-step') f.emit(f.root, 'step/end', { turn: 1, step: 1 })
    const change = fault === 'root' ? { rootCallId: 'other' } : fault === 'parent' ? { parentCallId: 'other' } : fault === 'sub' || fault === 'orphan' ? { subCallId: 'other' } : fault === 'name' ? { name: 'task_open' } : fault === 'turn' ? { turn: 2 } : fault === 'step' ? { step: 2 } : {}
    p.result(data, change)
    const report = f.collector.snapshot(); assertTaskPartition(report)
    assert.equal(report.unattributedResults, 1)
    assert.equal(report.byTool.task_board.ptcResults, fault === 'duplicate' ? 1 : 0)
  })
}

test('published task collector accepts nested PTC and re-used sub-ID only under distinct native roots', async () => {
  const f = await taskCollectorFixture(), p = ptcFixture(f)
  const parent = p.start('parent', 'read'), nested = p.start('same', 'task_board', 'parent')
  p.result(nested); p.result(parent)
  f.result(f.root, p.root)
  const nextRoot = f.call(f.root, 'run_code', 'next-wrapper')
  const next = p.start('same', 'task_board', 'next-wrapper', 'next-wrapper'); p.result(next)
  f.result(f.root, nextRoot)
  const report = f.collector.snapshot(); assertTaskPartition(report)
  assert.equal(report.byTool.task_board.ptcResults, 2)
  assert.equal(report.byTool.task_board.envelopeOk, 2)
})

test('published task collector counts unexpected tool results only as unattributed', async () => {
  const f = await taskCollectorFixture(); f.step(); const call = f.call(f.root, 'SECRET_tool', 'unknown')
  f.result(f.root, call)
  const report = f.collector.snapshot(); assertTaskPartition(report)
  assert.equal(report.unattributedResults, 1)
  assert.deepEqual(report.byRole, { root: 0, worker: 0, unknown: 0 })
})

test('published task collector bounds scoped sessions and retained calls across stages', async () => {
  const f = await taskCollectorFixture()
  for (let i = 0; i < 16; i++) f.create(`worker-${i}`, 'root')
  assert.equal(f.collector.snapshot().truncated, true)
  f.collector.beginStage(); f.step()
  for (let i = 0; i < 4094; i++) f.call(f.root, 'task_open', `call-${i}`)
  f.collector.beginStage()
  for (let i = 4094; i < 4097; i++) f.call(f.root, 'task_open', `call-${i}`)
  const report = f.collector.snapshot()
  assert.equal(report.truncated, true)
  assert.equal(report.byTool.task_open.calls, 3)
})

test('published task collector accepts canonical append with surface replacement and ignores stale disposal identity', async () => {
  const f = await taskCollectorFixture(); f.step(); const call = f.call()
  f.result(f.root, call, { ok: true }, { event: { surfaceOp: 'replace', replaces: [1] } })
  const old = f.create('worker', 'root'); f.collector.disposed(old)
  const current = f.create('worker', 'root', { seq: old.seq + 1 })
  f.collector.disposed(old); f.step(current)
  const next = f.call(current, 'task_board'); f.result(current, next)
  const report = f.collector.snapshot(); assertTaskPartition(report)
  assert.equal(report.byTool.task_open.envelopeOk, 1)
  assert.equal(report.byTool.task_board.envelopeOk, 1)
})

test('task diagnostic Promise constructor accessors are refused without calling a getter', async t => {
  const { runModelVerification } = await api(), h = setup(t, 'timeout')
  let getters = 0
  const report = await runModelVerification({ ...h.options, stageTimeoutMs: 10 }, { createHarness: async config => {
    const harness = await h.factory(config)
    harness.beginTaskToolDiagnosticsStage = () => {}
    harness.taskToolDiagnosticsSnapshot = () => {
      const value = Promise.resolve(taskProjection())
      Object.defineProperty(value, 'constructor', { get() { getters++; throw new Error('SECRET_constructor') } })
      return value
    }
    return harness
  } })
  assert.equal(report.failure, 'timeout'); assert.equal(getters, 0)
  assert.equal(report.stages[0].taskToolDiagnostics, null)
})

test('published task collector keeps exhausted session coverage unavailable across stage boundaries', async () => {
  const f = await taskCollectorFixture()
  let overflow
  for (let i = 0; i < 16; i++) overflow = f.create(`worker-${i}`, 'root')
  f.collector.beginStage()
  f.step(overflow); const call = f.call(overflow); f.result(overflow, call)
  const report = f.collector.snapshot(); assertTaskPartition(report)
  assert.equal(report.truncated, true)
  assert.equal(report.unattributedResults, 1)
  assert.equal(report.byTool.task_open.envelopeOk, 0)
})

test('published task collector preserves known public sequence above counter saturation limit', async () => {
  const f = await taskCollectorFixture(), worker = f.create('worker', 'root', { cut: 100000 })
  f.step(worker); const call = f.call(worker), result = f.result(worker, call)
  assert.equal(f.collector.snapshot().details[0].eventIndex, result.seq)
})

test('task diagnostic application rejection remains report-only on all otherwise successful stages', async t => {
  const { runModelVerification } = await api(), h = setup(t)
  const report = await runModelVerification(h.options, { createHarness: async config => ({
    ...await h.factory(config), beginTaskToolDiagnosticsStage() {}, taskToolDiagnosticsSnapshot() {
      const value = taskProjection()
      value.byTool.task_board.nativeResults = 1; value.byTool.task_board.envelopeError = 1
      value.errorCounts.E_CONTROL_JOURNAL_UNAVAILABLE = 1
      return value
    },
  }) })
  assert.equal(report.ok, true); assert.equal(report.failure, null)
  assert.ok(report.stages.every(stage => stage.taskToolDiagnostics.errorCounts.E_CONTROL_JOURNAL_UNAVAILABLE === 1))
  assert.ok(report.stages.every(stage => stage.taskToolDiagnostics.source === 'custom-harness-unverified'))
})

test('task diagnostics remain independently available when the final runtime snapshot throws', async t => {
  const { runModelVerification } = await api(), h = setup(t), value = taskProjection()
  const report = await runModelVerification(h.options, { createHarness: async () => {
    let snapshots = 0
    return { hostVersion: '0.2.0-rc.2', rootId: 'root', beginTaskToolDiagnosticsStage() {}, taskToolDiagnosticsSnapshot: () => value,
      snapshot() { if (snapshots++) throw new Error('SECRET_snapshot'); return { sessions: [{ id: 'root', parent: null, events: [] }], tasks: [], settled: true } },
      runStage() { value.byTool.task_open.calls = 1; value.byRole.root = 1; throw new Error('SECRET_runtime') }, cancel() {}, dispose() {},
    }
  } })
  assert.equal(report.failure, 'runtime-error')
  assert.equal(report.stages[0].taskToolDiagnostics.byTool.task_open.calls, 1)
})

for (const source of ['native-own-published-events', 'custom-harness-unverified', 'accessor', 'inherited']) {
  test(`task diagnostic hook cannot declare source authority: ${source}`, async t => {
    const { runModelVerification } = await api(), h = setup(t, 'timeout')
    let getters = 0
    const report = await runModelVerification({ ...h.options, stageTimeoutMs: 10 }, { createHarness: async config => ({
      ...await h.factory(config), beginTaskToolDiagnosticsStage() {}, taskToolDiagnosticsSnapshot() {
        const value = taskProjection()
        if (source === 'accessor') Object.defineProperty(value, 'source', { get() { getters++; return 'native-own-published-events' } })
        else if (source === 'inherited') Object.setPrototypeOf(value, { source: 'native-own-published-events' })
        else value.source = source
        return value
      },
    }) })
    assert.equal(report.failure, 'timeout'); assert.equal(getters, 0)
    assert.equal(report.stages[0].taskToolDiagnostics, null)
  })
}

test('task diagnostic Promise foreign species is never invoked or assimilated', async t => {
  const { runModelVerification } = await api(), h = setup(t, 'timeout')
  let getters = 0
  const report = await runModelVerification({ ...h.options, stageTimeoutMs: 10 }, { createHarness: async config => ({
    ...await h.factory(config), beginTaskToolDiagnosticsStage() {}, taskToolDiagnosticsSnapshot() {
      const promise = Promise.resolve(taskProjection())
      Object.defineProperty(promise, 'constructor', { value: { get [Symbol.species]() { getters++; throw new Error('SECRET_species') } } })
      return promise
    },
  }) })
  assert.equal(report.failure, 'timeout'); assert.equal(getters, 0)
  assert.equal(report.stages[0].taskToolDiagnostics, null)
})

test('published task collector maps every exact application code and absent or invalid codes to unknown', async () => {
  const f = await taskCollectorFixture(); f.step()
  for (const [index, code] of taskToolCodes.entries()) f.result(f.root, f.call(f.root, 'task_board', `code-${index}`), { ok: false, code })
  f.result(f.root, f.call(f.root, 'task_board', 'absent-code'), { ok: false })
  f.result(f.root, f.call(f.root, 'task_board', 'invalid-code'), { ok: false, code: { secret: 'SECRET_' } })
  const report = f.collector.snapshot(); assertTaskPartition(report)
  for (const code of taskToolCodes) assert.equal(report.errorCounts[code], code === 'unknown' ? 3 : 1)
  assert.equal(report.byTool.task_board.envelopeError, 25)
  assert.equal(report.details.length, 20)
  assert.equal(report.truncated, true)
})

test('published task collector contains creation and disposal observer faults and out-of-scope events', async () => {
  const f = await taskCollectorFixture()
  const other = f.create('other'); f.step(other); f.result(other, f.call(other))
  assert.equal(f.collector.snapshot().observedEvents, 0)
  const hostile = Object.defineProperty({}, 'id', { get() { throw new Error('SECRET_callback') } })
  assert.doesNotThrow(() => f.collector.created(hostile)); assert.equal(f.collector.snapshot(), null)
  f.collector.beginStage()
  assert.equal(f.collector.snapshot(), null, 'a stage reset cannot erase an unresolved observer fault')
  assert.doesNotThrow(() => f.collector.disposed(hostile)); assert.equal(f.collector.snapshot(), null)
})

test('task diagnostic rejection handling uses captured invocation without an exposed call getter', async t => {
  const { runModelVerification } = await api(), h = setup(t, 'timeout')
  const then = Promise.prototype.then, original = Object.getOwnPropertyDescriptor(then, 'call')
  let getters = 0
  const restore = () => { if (original) Object.defineProperty(then, 'call', original); else delete then.call }
  t.after(restore)
  const report = await runModelVerification({ ...h.options, stageTimeoutMs: 10 }, { createHarness: async config => ({
    ...await h.factory(config), beginTaskToolDiagnosticsStage() {}, cancel: restore,
    taskToolDiagnosticsSnapshot() {
      const promise = Promise.resolve(taskProjection())
      Object.defineProperty(then, 'call', { configurable: true, get() { getters++; throw new Error('SECRET_invocation') } })
      return promise
    },
  }) })
  assert.equal(report.failure, 'timeout'); assert.equal(getters, 0)
  assert.equal(report.stages[0].taskToolDiagnostics, null)
})

for (const shape of ['subclass', 'foreign', 'own-native-constructor']) {
  test(`task diagnostic async ${shape} shape remains unsupported and never supplies report data`, async t => {
    const { runModelVerification } = await api(), h = setup(t, 'timeout')
    const { runInNewContext } = await import('node:vm')
    let getters = 0
    class ForeignSpecies extends Promise { static get [Symbol.species]() { getters++; throw new Error('SECRET_foreign') } }
    const report = await runModelVerification({ ...h.options, stageTimeoutMs: 10 }, { createHarness: async config => ({
      ...await h.factory(config), beginTaskToolDiagnosticsStage() {}, taskToolDiagnosticsSnapshot() {
        if (shape === 'foreign') return runInNewContext('Promise.resolve({})')
        if (shape === 'subclass') return new ForeignSpecies(resolve => resolve(taskProjection()))
        const promise = Promise.resolve(taskProjection())
        Object.defineProperty(promise, 'constructor', { value: Promise })
        return promise
      },
    }) })
    assert.equal(report.failure, 'timeout'); assert.equal(getters, 0)
    assert.equal(report.stages[0].taskToolDiagnostics, null)
  })
}

async function unstartedFixture(overrides = {}) {
  const { createNativeLifecycleTracker } = await api()
  class Session {
    constructor(id, parent = 'root', { cut = 0, firstLive = 0, prefix = [] } = {}) {
      this.header = Object.freeze({ id, parentSession: parent }); this.inheritedEventCount = cut
      this.firstLiveSeq = firstLive; this.history = prefix
    }
    snapshotEvents() { return [...this.history] }
    get id() { return this.header.id }
    get seq() { return this.history.length }
    isOwnSeq(seq) { return seq >= this.inheritedEventCount && seq < this.seq }
  }
  const agents = new Map(), sessions = new Map(), tracked = new Map()
  let mode = 'continuable', failRead = false
  const tracker = createNativeLifecycleTracker({ Session, rootId: 'root', tracked,
    agents: { get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) },
    classifyMode: () => { if (mode === 'throws') throw new Error('unavailable'); return mode },
    async readCreation(session) { if (failRead) throw new Error('unavailable'); return { header: session.header,
      inheritedEventCount: session.inheritedEventCount, cursor: session.seq - 1, source: 'live', events: [...session.history] } },
    ...overrides,
  })
  const create = async (id = 'child', fields) => {
    const session = new Session(id, id === 'root' ? null : 'root', fields)
    const agent = { id, session }; agents.set(id, agent); sessions.set(id, session)
    await tracker.created({ agent }); tracked.set(id, agent)
    return agent
  }
  const main = await create('root')
  const publish = (agent, type = 'agent-preset/selected') => {
    const event = Object.freeze({ seq: agent.session.seq, type })
    agent.session.history.push(event); tracker.published(agent.session, event); return event
  }
  const dispose = agent => { agents.delete(agent.id); tracker.disposed({ agent }); sessions.delete(agent.id) }
  return { Session, tracker, create, main, agents, sessions, tracked, publish, dispose,
    mode: value => { mode = value }, failRead: () => { failRead = true } }
}

for (const boundary of ['plain', 'historical-turn', 'seed-turn', 'same-id-retry', 'current-mode']) {
  test(`unstarted lifecycle: exact disposed lifetime rejects the stage (${boundary})`, async () => {
    const f = await unstartedFixture(), stage = f.tracker.beginStage()
    const prefix = boundary === 'historical-turn' || boundary === 'seed-turn'
      ? [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end' }, { seq: 2, type: 'session/end-seed' }] : []
    if (boundary === 'current-mode') f.mode('one-shot')
    const child = await f.create('child', { prefix, firstLive: prefix.length, cut: boundary === 'seed-turn' ? 2 : 0 })
    f.publish(child)
    if (boundary === 'current-mode') f.mode('continuable')
    f.dispose(child)
    const failure = await settlementDeadline(stage.failure)
    assert.equal(failure.verificationCode, 'unsettled-tree')
    if (boundary === 'same-id-retry') {
      const retry = await f.create(); f.publish(retry, 'turn/start'); f.dispose(retry)
      assert.equal(await stage.failure, failure, 'same ID cannot replace a failed actual Agent lifetime')
    }
    f.tracker.endStage(stage)
  })
}

for (const boundary of ['pending', 'started', 'one-shot', 'unknown-mode', 'mode-throws', 'cancel', 'out-of-stage', 'late-stage',
  'unmatched', 'replaced-session', 'missing-publication', 'precreated-turn', 'bad-offset', 'read-failure', 'foreign-agent', 'foreign-parent', 'own-seq-shadow', 'seq-getter', 'proxy-session', 'malformed-event']) {
  test(`unstarted lifecycle: incomplete or excluded evidence cannot reject (${boundary})`, async () => {
    const f = await unstartedFixture()
    let stage = boundary === 'out-of-stage' ? null : f.tracker.beginStage()
    if (boundary === 'read-failure') f.failRead()
    const child = await f.create('child', boundary === 'precreated-turn' ? { prefix: [{ seq: 0, type: 'turn/start' }] } : undefined)
    if (!stage) stage = f.tracker.beginStage()
    if (boundary === 'late-stage') { f.tracker.endStage(stage); stage = f.tracker.beginStage() }
    let rejected = false
    stage.failure.then(() => { rejected = true })
    if (boundary === 'started') f.publish(child, 'turn/start')
    if (boundary === 'one-shot') f.mode('one-shot')
    if (boundary === 'unknown-mode') f.mode('unknown')
    if (boundary === 'mode-throws') f.mode('throws')
    if (boundary === 'cancel') f.tracker.cancel()
    if (boundary === 'replaced-session') child.session = new f.Session('child')
    if (boundary === 'bad-offset') child.session.firstLiveSeq = -1
    if (boundary === 'missing-publication') child.session.history.push({ seq: 0, type: 'turn/start' })
    if (boundary === 'foreign-parent') f.tracked.set('root', { id: 'root', session: f.main.session })
    if (boundary === 'own-seq-shadow') child.session.isOwnSeq = () => true
    let reads = 0
    if (boundary === 'seq-getter') Object.defineProperty(child.session, 'seq', { get() { reads++; return 0 } })
    if (boundary === 'proxy-session') child.session = new Proxy(child.session, { get() { reads++; throw new Error('foreign trap') } })
    if (boundary === 'malformed-event') f.tracker.published(child.session, Object.defineProperty({}, 'seq', { get() { reads++; return 0 } }))
    if (boundary === 'unmatched' || boundary === 'foreign-agent') f.tracker.disposed({ agent: { ...child } })
    else if (boundary !== 'pending') f.dispose(child)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(rejected, false); assert.equal(reads, 0)
    f.tracker.endStage(stage)
  })
}

for (const primary of ['request-cap', 'usage-or-runtime-error', 'cleanup-error', 'unsettled-tree']) {
  test(`unstarted lifecycle rejection preserves ${primary} failure priority`, async t => {
    const { runModelVerification } = await api(), h = setup(t)
    h.options.requestCap = 1
    let cancelled = 0
    const report = await runModelVerification(h.options, { createHarness: async args => {
      const harness = await h.factory(args)
      harness.runStage = async () => {
        if (primary === 'request-cap') {
          args.onRequest({ agentId: 'root', turn: 1, step: 1 })
          try { args.onRequest({ agentId: 'root', turn: 1, step: 2 }) } catch {}
        }
        if (primary === 'usage-or-runtime-error') args.onFailure()
        throw Object.assign(new Error('unsettled-tree'), { verificationCode: 'unsettled-tree' })
      }
      harness.cancel = () => { cancelled++ }
      if (primary === 'cleanup-error') harness.dispose = async () => { throw new Error('original native cleanup failure') }
      return harness
    } })
    assert.equal(report.ok, false); assert.equal(report.failure, primary); assert.ok(cancelled > 0)
  })
}

test('unstarted lifecycle: a certified negative never changes the original native wait or grants success', async () => {
  const { waitForNativeSettlement } = await api(), f = await unstartedFixture()
  const stage = f.tracker.beginStage(), child = await f.create()
  const originalGate = deferred(), rootGate = deferred(), counts = new Map([['child', 1]])
  f.main.status = 'idle'; child.status = 'idle'
  f.main.whenIdle = () => rootGate.promise; child.whenIdle = () => originalGate.promise
  f.main.session.snapshotEvents = () => []; child.session.snapshotEvents = () => []
  let disposed = false, originalSettled = false
  const original = waitForNativeSettlement({ tracked: f.tracked, rootId: 'root', activationCounts: counts,
    beforeCounts: new Map(), beforeNotices: new Map(), classifyMode: () => 'continuable', isDisposed: () => disposed })
  const observed = original.then(() => { originalSettled = true }, error => { originalSettled = true; assert.equal(error.verificationCode, 'unsettled-tree') })
  try {
    // Restore the trusted Session prototype before lifetime checks; the waiter
    // above has already consumed the exact two controlled native promises.
    delete f.main.session.snapshotEvents; delete child.session.snapshotEvents
    f.dispose(child)
    assert.equal((await settlementDeadline(stage.failure)).verificationCode, 'unsettled-tree')
    assert.equal(originalSettled, false)
  } finally {
    disposed = true; rootGate.resolve(); originalGate.resolve(); await observed; f.tracker.endStage(stage)
  }
})

for (const boundary of ['missing-during-read', 'published-start-during-read', 'published-nonturn-during-read', 'gap-during-read', 'read-rejection', 'history-over-bound', 'creation-over-bound']) {
  test(`unstarted lifecycle: bounded asynchronous certification (${boundary})`, async () => {
    const entered = deferred(), release = deferred()
    let reads = 0, result
    const f = await unstartedFixture({ async readCreation(session) {
      reads++
      const proof = { source: 'live', header: session.header, inheritedEventCount: session.inheritedEventCount,
        cursor: session.seq - 1, events: session.snapshotEvents() }
      entered.resolve(); await release.promise
      if (boundary === 'read-rejection') throw new Error('reader failed')
      return proof
    } })
    const stage = f.tracker.beginStage(); stage.failure.then(error => { result = error })
    let child
    if (boundary === 'history-over-bound') {
      child = await f.create('child', { firstLive: 4097, prefix: Array.from({ length: 4097 }, (_, seq) => ({ seq, type: 'agent-preset/selected' })) })
      assert.equal(reads, 0)
    } else if (boundary === 'creation-over-bound') {
      release.resolve()
      for (let index = 0; index < 257; index++) child = await f.create(`child-${index}`)
      assert.equal(reads, 256)
    } else {
      const creation = f.create()
      await entered.promise; child = f.agents.get('child')
      if (boundary === 'missing-during-read') f.sessions.delete('child')
      if (boundary === 'published-start-during-read') f.publish(child, 'turn/start')
      if (boundary === 'published-nonturn-during-read') f.publish(child)
      if (boundary === 'gap-during-read') child.session.history.push({ seq: 0, type: 'turn/start' })
      release.resolve(); await creation
    }
    f.dispose(child)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(result?.verificationCode ?? null, boundary === 'published-nonturn-during-read' ? 'unsettled-tree' : null)
    f.tracker.endStage(stage)
  })
}

for (const fault of ['none', 'read', 'prepared', 'header', 'cursor', 'events-getter', 'release', 'shadow-reader']) {
  test(`unstarted lifecycle: public live observation owns and releases its lease (${fault})`, async () => {
    const { nativeCreationReader } = await api(), f = await unstartedFixture()
    const child = await f.create(), session = child.session
    let released = 0, eventReads = 0, shadowReads = 0, methodReads = 0
    const lease = { source: fault === 'prepared' ? 'prepared' : 'live', header: fault === 'header' ? { ...session.header } : session.header,
      inheritedEventCount: 0, cursor: fault === 'cursor' ? 2 : -1,
      get events() { eventReads++; if (fault === 'events-getter') throw new Error('native read failed'); return [] },
      [Symbol.dispose]() { released++; if (fault === 'release') throw new Error('native release failed') },
    }
    class Query {
      observeSession(id, options) {
        assert.equal(id, 'child'); assert.deepEqual(options, { projectionMode: 'none' })
        if (fault === 'read') return Promise.reject(new Error('native observation failed'))
        if (fault === 'shadow-reader') session.snapshotEvents = () => { shadowReads++; return [] }
        return Promise.resolve(lease)
      }
    }
    const service = Object.defineProperty({}, 'observeSession', { get() { methodReads++; throw new Error('foreign method getter') } })
    const reader = nativeCreationReader({ Session: f.Session, SessionQueryEngine: Query,
      host: { get: () => service }, sessions: { get: id => f.sessions.get(id) } })
    const expected = { seq: 0, header: session.header, cut: 0 }
    let value, error
    try { value = await reader(session, expected) } catch (caught) { error = caught }
    assert.equal(released, fault === 'read' ? 0 : 1)
    assert.equal(eventReads, ['none', 'events-getter', 'release'].includes(fault) ? 1 : 0)
    assert.equal(shadowReads, 0); assert.equal(methodReads, 0)
    if (fault === 'none') { assert.equal(error, undefined); assert.equal(value.source, 'live') }
    else assert.ok(error || value === null)
  })
}

for (const fault of ['identity-proxy', 'values-proxy', 'snapshot-proxy', 'identity-accessor', 'values-accessor']) {
  test(`unstarted lifecycle: live mode proof refuses ${fault} without reflection side effects`, async () => {
    const { nativeSubagentMode } = await api()
    let reads = 0
    const trap = { get(target, key) { reads++; return Reflect.get(target, key) },
      getOwnPropertyDescriptor(target, key) { reads++; return Reflect.getOwnPropertyDescriptor(target, key) } }
    let identity = { mode: 'continuable', seq: 0 }
    if (fault === 'identity-proxy') identity = new Proxy(identity, trap)
    let values = { subagent: identity }
    if (fault === 'values-proxy') values = new Proxy(values, trap)
    if (fault === 'identity-accessor') Object.defineProperty(values, 'subagent', { get() { reads++; return identity } })
    let snapshot = { values }
    if (fault === 'snapshot-proxy') snapshot = new Proxy(snapshot, trap)
    if (fault === 'values-accessor') Object.defineProperty(snapshot, 'values', { get() { reads++; return values } })
    const mode = nativeSubagentMode({ sessionProjections: { snapshot: () => snapshot } }, { session: { isOwnSeq: () => true } })
    assert.equal(mode, 'unknown'); assert.equal(reads, 0)
  })
}
