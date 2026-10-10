import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { TaskforceStore } from '../../lib/store/index.js'
import { TaskforceGovernor } from '../../lib/governor/index.js'
import { runTaskVerification } from '../../lib/tools/verification.js'
import { tempStore } from './helpers.mjs'

const module = await import('../../lib/workflow/index.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  return {}
})
const run = ' workflow-run ', lead = { sessionId: run, isRoot: true }
const worker = { sessionId: ' worker ', isRoot: false }
const reviewer = { sessionId: ' reviewer ', isRoot: false }
function fixture(t) {
  assert.equal(typeof module.TaskforceWorkflow, 'function', 'workflow core must be implemented')
  const store = tempStore(t); store.open()
  writeFileSync(join(store.root, 'source.js'), 'export const answer = 42\n')
  const flow = new module.TaskforceWorkflow(store)
  let sequence = 0
  const key = () => 'request-' + (++sequence)
  const actor = { ...lead, cwd: store.root }
  const create = (extra = {}) => flow.create({ title: 'coding task', plan: { objective: 'ship code', scope: ['source.js'], non_goals: [], deliverables: ['tested source'] },
    verification_files: ['source.js'], verification_command: 'node --check source.js', request_key: key(), ...extra }, run, actor)
  const change = (method, id, extra = {}, auth = actor) => flow[method]({ task_id: id,
    expected_version: flow.state({ task_id: id }, run).row_version, request_key: key(), ...extra }, run, auth)
  const claim = id => store.claimTask({ task_id: id, child_id: 'worker' }, run, worker, worker.sessionId)
  const open = extra => { const id = create(extra).task_id; change('approvePlan', id); claim(id); return id }
  const verify = async id => {
    const agent = { session: { header: { id: worker.sessionId } } }
    return runTaskVerification({ store, identity: { ...worker, runId: run }, agent,
      exec: { agent, token: {}, rootCallId: key(), signal: new AbortController().signal },
      task_id: id, command: 'node --check source.js', execute: async () => {
        const result = spawnSync(process.execPath, ['--check', 'source.js'], { cwd: store.root, encoding: 'utf8' })
        return { isError: false, content: [], value: { kind: 'foreground', exitCode: result.status, signal: result.signal,
          timedOut: false, aborted: false, timeoutMs: 60000,
          stdout: { text: result.stdout, truncated: false }, stderr: { text: result.stderr, truncated: false } } }
      } })
  }
  const artifact = async id => { await verify(id); return change('recordArtifact', id, {}, worker) }
  const review = id => change('recordReview', id, { revision_id: flow.state({ task_id: id }, run).revision_id,
    requirements_result: 'pass', quality_result: 'pass', findings: [] }, reviewer)
  const accept = id => { store.submitTask({ task_id: id }, run, worker); return store.acceptTask({ task_id: id,
    expected_version: flow.state({ task_id: id }, run).row_version, request_key: key() }, run, lead) }
  return { store, flow, actor, create, change, claim, open, verify, artifact, review, accept, key }
}

// Replacing the template with legacy policy or accepting model provenance breaks these.
test('coding creation is atomic, defaults strict execution, and preserves ordinary legacy tasks', t => {
  const f = fixture(t), result = f.create()
  assert.equal(f.store.taskOf(result.task_id, run).task.evidence_policy, 'execution')
  assert.equal(f.flow.state({ task_id: result.task_id }, run).stage, 'plan')
  const plain = f.store.openTask({ title: 'legacy' }, run).task_id
  assert.equal(f.store.taskOf(plain, run).task.evidence_policy, 'legacy')
  const before = f.store.stats(run).tasks.total
  for (const extra of [{ evidence_policy: 'legacy' }, { verification_files: ['missing.js'] }, { verification_command: '' }]) {
    assert.throws(() => f.create(extra))
  }
  assert.equal(f.store.stats(run).tasks.total, before)
})

test('mutations require real root identity, request keys and optimistic versions', t => {
  const f = fixture(t), input = { title: 'replay', plan: { objective: 'ship', scope: [], non_goals: [], deliverables: [] },
    verification_files: ['source.js'], verification_command: 'node --check source.js', request_key: 'same' }
  const created = f.flow.create(input, run, f.actor)
  assert.deepEqual(f.flow.create(input, run, f.actor), created)
  assert.throws(() => f.flow.create({ ...input, title: 'different' }, run, f.actor), { code: 'E_WORKFLOW_REPLAY' })
  assert.throws(() => f.flow.approvePlan({ task_id: created.task_id, expected_version: 0, request_key: 'stale' }, run, f.actor), { code: 'E_WORKFLOW_VERSION' })
  assert.throws(() => f.change('approvePlan', created.task_id, {}, { sessionId: 'lead', isRoot: false }), { code: 'E_WORKFLOW_ROLE' })
  assert.throws(() => f.flow.state({ task_id: created.task_id }, 'other-run'), { code: 'E_CROSS_RUN' })
})

test('same-run DAG rejects cycles and freezes dependencies after plan approval', t => {
  const f = fixture(t), a = f.create().task_id, b = f.create({ dependencies: [a] }).task_id
  assert.throws(() => f.change('setDependencies', a, { prerequisite_task_ids: [b] }), { code: 'E_WORKFLOW_CYCLE' })
  assert.throws(() => f.change('setDependencies', a, { prerequisite_task_ids: [a] }), { code: 'E_WORKFLOW_CYCLE' })
  const foreign = f.store.openTask({ title: 'private' }, 'foreign').task_id
  assert.throws(() => f.change('setDependencies', a, { prerequisite_task_ids: [foreign] }), { code: 'E_CROSS_RUN' })
  assert.deepEqual(f.flow.state({ task_id: a }, run).dependencies, [])
  f.change('approvePlan', a)
  assert.throws(() => f.change('setDependencies', a, { prerequisite_task_ids: [b] }), { code: 'E_WORKFLOW_STAGE' })
})

test('claim and governor admission both block unsatisfied dependencies', t => {
  const f = fixture(t), upstream = f.create().task_id, id = f.create({ dependencies: [upstream] }).task_id
  f.change('approvePlan', id)
  assert.throws(() => f.claim(id), { code: 'E_WORKFLOW_DEPENDENCY' })
  const governor = new TaskforceGovernor(f.store)
  assert.throws(() => governor.reserve({ operation_key: 'admit', task_id: id, generation: 0,
    kind: 'new', mode: 'write', resources: ['repository'] }, run, { role: 'lead', sessionId: run }), { code: 'E_WORKFLOW_DEPENDENCY' })
  assert.equal(governor.snapshot(run).active_total, 0)
})

test('upstream reject and reaccept cannot revive downstream evidence', async t => {
  const f = fixture(t), upstream = f.open()
  await f.artifact(upstream); f.review(upstream); f.accept(upstream)
  const id = f.open({ dependencies: [upstream] })
  await f.artifact(id); f.review(id)
  f.change('returnForRework', upstream, { reason: 'recheck' })
  f.claim(upstream); await f.artifact(upstream); f.review(upstream); f.accept(upstream)
  assert.throws(() => f.store.submitTask({ task_id: id }, run, worker), { code: 'E_WORKFLOW_DEPENDENCY' })
  assert.equal(f.flow.state({ task_id: id }, run).blocked, true)
  assert.equal(f.flow.ready({}, run).tasks.some(x => x.task_id === id), false)
})

test('ordinary store acceptance and waiver cannot bypass workflow evidence', t => {
  const f = fixture(t), id = f.open()
  f.store.submitTask({ task_id: id }, run, worker)
  assert.throws(() => f.store.acceptTask({ task_id: id, waiver_reason: 'skip', expected_version: 2, request_key: 'waive' }, run, lead), { code: 'E_WORKFLOW_EVIDENCE' })
  assert.equal(f.store.taskOf(id, run).task.status, 'submitted')
})

test('artifacts capture actual receipt snapshot and independent review binds exact revision', async t => {
  const f = fixture(t), id = f.open()
  const artifact = await f.artifact(id)
  const receipt = f.store.board({ task_id: id }, run).receipts[0]
  assert.equal(artifact.receipt_id, receipt.receipt_id)
  assert.deepEqual(artifact.snapshot, receipt.snapshot)
  assert.deepEqual(artifact.logs, receipt.logs)
  assert.throws(() => f.change('recordReview', id, { revision_id: artifact.revision_id,
    requirements_result: 'pass', quality_result: 'pass', findings: [] }, worker), { code: 'E_WORKFLOW_REVIEW' })
  f.review(id)
  const accepted = f.accept(id)
  assert.equal(accepted.execution_verified, true)
  assert.equal(f.flow.state({ task_id: id }, run).stage, 'completed')
})

test('review and artifact cannot accept model supplied receipt/provenance overrides', async t => {
  const f = fixture(t), id = f.open()
  await f.verify(id)
  assert.throws(() => f.change('recordArtifact', id, { receipt_id: 'fake', snapshot: [] }, worker), { code: 'E_WORKFLOW_INPUT' })
  assert.throws(() => f.change('recordArtifact', id, {}, { sessionId: 'worker', isRoot: false }), { code: 'E_WORKFLOW_ROLE' })
})

test('latest failed execution, modified source and tampered logs invalidate accepted review', async t => {
  for (const mutation of ['source', 'log', 'pending']) {
    const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
    if (mutation === 'source') writeFileSync(join(f.store.root, 'source.js'), 'export const answer = 43\n')
    if (mutation === 'log') writeFileSync(f.store.board({ task_id: id }, run).receipts[0].logs.stdout.path, 'tamper')
    if (mutation === 'pending') f.store.recordExecution({ task_id: id, status: 'pending',
      command: 'node --check source.js', timeout_ms: 60000, call_id: 'pending', root_call_id: 'root' }, run, worker)
    f.store.submitTask({ task_id: id }, run, worker)
    assert.throws(() => f.store.acceptTask({ task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version,
      request_key: f.key() }, run, lead), { code: 'E_VERIFICATION_RECEIPT' })
  }
})

test('review failure and bounded root returns require new artifacts and independent reviews', async t => {
  const f = fixture(t), id = f.open({ max_reworks: 1 }); await f.artifact(id)
  f.change('recordReview', id, { revision_id: f.flow.state({ task_id: id }, run).revision_id,
    requirements_result: 'fail', quality_result: 'pass', findings: ['missing case'] }, reviewer)
  assert.equal(f.flow.state({ task_id: id }, run).stage, 'review')
  f.change('returnForRework', id, { reason: 'fix missing case' })
  assert.equal(f.store.taskOf(id, run).task.evidence_generation, 1)
  f.claim(id); await f.artifact(id); f.review(id); f.accept(id)
  assert.throws(() => f.change('returnForRework', id, { reason: 'again' }), { code: 'E_WORKFLOW_BUDGET' })
  assert.equal(f.flow.state({ task_id: id }, run).artifacts.length, 2)
})

test('successful acceptance replay is stable and conflicting replay fails after terminal status', async t => {
  const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
  f.store.submitTask({ task_id: id }, run, worker)
  const input = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: 'accept' }
  const first = f.store.acceptTask(input, run, lead)
  assert.deepEqual(f.store.acceptTask(input, run, lead), first)
  assert.throws(() => f.store.acceptTask({ ...input, note: 'changed' }, run, lead), { code: 'E_WORKFLOW_REPLAY' })
})

test('audit failure rolls back task acceptance and workflow transition together', async t => {
  const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
  f.store.submitTask({ task_id: id }, run, worker)
  f.store.open().exec("CREATE TEMP TRIGGER fail_workflow BEFORE INSERT ON workflow_decision WHEN NEW.action = 'accept' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END")
  assert.throws(() => f.accept(id), /injected audit failure/)
  assert.equal(f.store.taskOf(id, run).task.status, 'submitted')
  assert.equal(f.flow.state({ task_id: id }, run).stage, 'lead_acceptance')
})

test('reopening store preserves workflow history without executing effects', async t => {
  const f = fixture(t), id = f.open(); await f.artifact(id)
  const before = f.flow.state({ task_id: id }, run)
  f.store.close()
  const reopened = new TaskforceStore(f.store.root); t.after(() => reopened.close())
  const flow = new module.TaskforceWorkflow(reopened)
  assert.deepEqual(flow.state({ task_id: id }, run), before)
  assert.equal(typeof flow.dispatch, 'undefined')
  assert.equal(typeof flow.publish, 'undefined')
})

test('two connections racing opposite dependency edges cannot commit a cycle', async t => {
  const f = fixture(t), a = f.create().task_id, b = f.create().task_id
  const code = "const { parentPort, workerData: d } = require('node:worker_threads'); (async () => { const { TaskforceStore } = await import(d.storeUrl); const { TaskforceWorkflow } = await import(d.flowUrl); const s = new TaskforceStore(d.root); try { new TaskforceWorkflow(s).setDependencies({task_id:d.id,prerequisite_task_ids:[d.dep],expected_version:1,request_key:'edge'+d.id},d.run,{sessionId:d.run,isRoot:true}); parentPort.postMessage('ok') } catch(e) { parentPort.postMessage(e.code) } finally { s.close() } })().catch(e=>{throw e})"
  const attempt = (id, dep) => new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { root: f.store.root, run, id, dep,
      storeUrl: new URL('../../lib/store/index.js', import.meta.url).href,
      flowUrl: new URL('../../lib/workflow/index.js', import.meta.url).href } })
    w.once('message', resolve); w.once('error', reject)
  })
  assert.deepEqual((await Promise.all([attempt(a, b), attempt(b, a)])).sort(), ['E_WORKFLOW_CYCLE', 'ok'])
})

test('bounded state refuses cross-run child record corruption without disclosing contents', t => {
  const f = fixture(t), id = f.create().task_id
  assert.throws(() => f.create({ dependencies: Array.from({ length: 65 }, (_, i) => i + 1) }), { code: 'E_WORKFLOW_INPUT' })
  assert.throws(() => f.flow.ready({ limit: 101 }, run), { code: 'E_WORKFLOW_INPUT' })
  f.store.open().prepare("INSERT INTO task_dependency(task_id,prerequisite_task_id,run_id,created_by_session,created_at) VALUES(?,?,?,?,?)")
    .run(id, id, 'secret foreign run', 'private author', 'now')
  assert.throws(() => f.flow.state({ task_id: id }, run), error => error.code === 'E_STORE_INTEGRITY' && !error.message.includes('secret'))
})
