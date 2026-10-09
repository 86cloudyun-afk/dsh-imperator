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
