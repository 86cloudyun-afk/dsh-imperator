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
function setup(t, fault) {
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
  assert.equal(report.requests, 7)
  assert.equal(report.usage.inputTokens, 14)
  assert.match(report.provenance.sourceSha256, /^[0-9a-f]{64}$/)
  assert.equal(report.provenance.packageVersion, JSON.parse(readFileSync(join(root, 'package.json'))).version)
  assert.equal(h.disposed(), true)
  assert.doesNotMatch(JSON.stringify(report), /sk-secret|reasoning|credentials|marker/)
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
