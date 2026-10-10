import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { TaskforceStore } from '../../lib/store/index.js'
import { TaskforceGovernor } from '../../lib/governor/index.js'
import { TaskforceRecovery } from '../../lib/store/recovery.js'
import { workflowAdmission, workflowAudit, workflowDeliveryGate } from '../../lib/store/workflow.js'
import { runTaskVerification } from '../../lib/tools/verification.js'
import { apply as applyTools } from '../../lib/tools/index.js'
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
  let store
  t.after(() => store?.close())
  store = tempStore(t); store.open()
  writeFileSync(join(store.root, 'source.js'), 'export const answer = 42\n')
  let flow = new module.TaskforceWorkflow(store)
  let sequence = 0, executions = 0
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
        executions++
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
  const reopen = () => {
    const root = store.root; store.close()
    store = new TaskforceStore(root); store.open()
    flow = new module.TaskforceWorkflow(store)
  }
  return { get store() { return store }, get flow() { return flow }, actor, create, change, claim, open, verify, artifact, review, accept, key, reopen, executions: () => executions }
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

test('modified source and tampered logs invalidate accepted review', async t => {
  for (const mutation of ['source', 'log']) {
    const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
    if (mutation === 'source') writeFileSync(join(f.store.root, 'source.js'), 'export const answer = 43\n')
    if (mutation === 'log') writeFileSync(f.store.board({ task_id: id }, run).receipts[0].logs.stdout.path, 'tamper')
    f.store.submitTask({ task_id: id }, run, worker)
    assert.throws(() => f.store.acceptTask({ task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version,
      request_key: f.key() }, run, lead), error => assertWorkflowRecovery(error, 'E_WORKFLOW_EVIDENCE', 2))
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

test('public store decisions reject a root identity from a different run', async t => {
  for (const action of ['acceptTask', 'rejectTask']) {
    const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
    f.store.submitTask({ task_id: id }, run, worker)
    const before = f.flow.state({ task_id: id }, run)
    assert.throws(() => f.store[action]({ task_id: id, expected_version: before.row_version,
      request_key: 'wrong-root', reason: 'return' }, run, { sessionId: 'different-root', isRoot: true }), { code: 'E_WORKFLOW_ROLE' })
    assert.deepEqual(f.flow.state({ task_id: id }, run), before)
    assert.equal(f.store.taskOf(id, run).task.status, 'submitted')
  }
})

test('late blockers and damaged prerequisite ownership prevent readiness and claims', async t => {
  for (const failure of ['late-blocker', 'ownership']) {
    const f = fixture(t), upstream = f.open(); await f.artifact(upstream); f.review(upstream); f.accept(upstream)
    const id = f.create({ dependencies: [upstream] }).task_id
    f.change('approvePlan', id)
    if (failure === 'late-blocker') f.store.recordFact({ task_id: upstream, kind: 'blocker', statement: 'late issue' }, run, worker)
    else f.store.open().prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,'fact',?,'CONFIRMED','now')").run(upstream, 'foreign-scope', 'never expose this')
    const code = failure === 'late-blocker' ? 'E_WORKFLOW_DEPENDENCY' : 'E_STORE_INTEGRITY'
    assert.equal(f.flow.state({ task_id: id }, run).blocked_code, code)
    assert.throws(() => f.claim(id), { code })
    assert.equal(f.flow.ready({}, run).tasks.some(row => row.task_id === id), false)
  }
})

test('an untouched legacy task can adopt strict workflow but existing history cannot', t => {
  const f = fixture(t), id = f.store.openTask({ title: 'attach' }, run).task_id
  assert.equal(f.create({ task_id: id }).task_id, id)
  assert.equal(f.store.taskOf(id, run).task.evidence_policy, 'execution')
  const used = f.store.openTask({ title: 'used' }, run).task_id
  f.store.recordFact({ task_id: used, kind: 'fact', statement: 'existing history' }, run)
  assert.throws(() => f.create({ task_id: used }), { code: 'E_WORKFLOW_STAGE' })
  assert.equal(f.store.taskOf(used, run).task.evidence_policy, 'legacy')
})

test('failed create audit rolls back both workflow and newly created task', t => {
  const f = fixture(t)
  f.store.open().exec("CREATE TEMP TRIGGER fail_create BEFORE INSERT ON workflow_decision WHEN NEW.action='create' BEGIN SELECT RAISE(ABORT,'create rollback'); END")
  assert.throws(() => f.create(), /create rollback/)
  assert.equal(f.store.stats(run).tasks.total, 0)
  assert.equal(f.store.open().prepare('SELECT COUNT(*) AS n FROM workflow').get().n, 0)
})

test('a new observation of the same bytes never revives a historical revision or review', async t => {
  const f = fixture(t), id = f.open(), first = await f.artifact(id); f.review(id)
  f.change('returnForRework', id, { reason: 'repeat verification' }); f.claim(id)
  const second = await f.artifact(id)
  assert.notEqual(second.revision_id, first.revision_id)
  assert.deepEqual(second.snapshot, first.snapshot)
  assert.throws(() => f.change('recordReview', id, { revision_id: first.revision_id,
    requirements_result: 'pass', quality_result: 'pass', findings: [] }, reviewer), { code: 'E_WORKFLOW_REVIEW' })
  f.store.submitTask({ task_id: id }, run, worker)
  assert.throws(() => f.store.acceptTask({ task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }, run, lead), { code: 'E_WORKFLOW_EVIDENCE' })
})

test('failed manifest and oversized payloads leave no workflow mutation', t => {
  const f = fixture(t)
  assert.throws(() => f.create({ plan: { objective: 'x'.repeat(40000), scope: [], non_goals: [], deliverables: [] } }), { code: 'E_WORKFLOW_INPUT' })
  assert.equal(f.store.stats(run).tasks.total, 0)
  const id = f.create().task_id
  const output = JSON.stringify(f.flow.state({ task_id: id }, run))
  assert.ok(Buffer.byteLength(output) <= 65536)
  assert.equal(output.includes('verification_command'), false)
  assert.equal(output.includes(f.store.root), false)
})


test('returning an unapproved plan preserves approval requirement and rework generation', t => {
  const f = fixture(t), id = f.create().task_id
  f.change('returnForRework', id, { reason: 'revise before approval' })
  const after = f.flow.state({ task_id: id }, run)
  assert.equal(after.stage, 'plan')
  assert.equal(after.evidence_generation, 1)
  assert.equal(after.rework_count, 1)
  assert.throws(() => f.claim(id), { code: 'E_WORKFLOW_STAGE' })
  assert.equal(f.flow.ready({}, run).tasks.some(row => row.task_id === id), false)
  f.change('approvePlan', id)
  assert.equal(f.claim(id).status, 'claimed')
})

test('foreign prerequisite workflow header blocks readiness, claim and acceptance without exposing its run', async t => {
  const f = fixture(t), upstream = f.open()
  await f.artifact(upstream); f.review(upstream); f.accept(upstream)
  const active = f.open({ dependencies: [upstream] })
  await f.artifact(active); f.review(active); f.store.submitTask({ task_id: active }, run, worker)
  const pending = f.create({ dependencies: [upstream] }).task_id
  f.change('approvePlan', pending)
  f.store.open().prepare('UPDATE workflow SET run_id=? WHERE task_id=?').run('foreign header secret', upstream)
  for (const id of [active, pending]) {
    const state = f.flow.state({ task_id: id }, run)
    assert.equal(state.blocked, true)
    assert.equal(state.blocked_code, 'E_STORE_INTEGRITY')
    assert.equal(JSON.stringify(state).includes('foreign header secret'), false)
  }
  assert.equal(f.flow.ready({}, run).tasks.length, 0)
  assert.throws(() => f.claim(pending), { code: 'E_STORE_INTEGRITY' })
  assert.throws(() => f.store.submitTask({ task_id: active }, run, worker), { code: 'E_STORE_INTEGRITY' })
  assert.throws(() => f.store.acceptTask({ task_id: active, expected_version: f.flow.state({ task_id: active }, run).row_version,
    request_key: f.key() }, run, lead), { code: 'E_STORE_INTEGRITY' })
})

test('an accepted legacy prerequisite retains compatibility through workflow dependency checks', t => {
  const f = fixture(t), upstream = f.store.openTask({ title: 'legacy prerequisite' }, run).task_id
  f.store.recordFact({ task_id: upstream, kind: 'fact', statement: 'manual evidence' }, run)
  f.store.submitTask({ task_id: upstream }, run)
  f.store.acceptTask({ task_id: upstream }, run, lead)
  const id = f.open({ dependencies: [upstream] })
  assert.equal(f.flow.state({ task_id: id }, run).blocked, false)
  assert.equal(f.store.taskOf(id, run).task.status, 'claimed')
})

test('accepted intermediates cannot hide transitive rework from state, claim, submit or acceptance', async t => {
  const f = fixture(t)
  const completed = async dependencies => {
    const id = f.open({ dependencies }); await f.artifact(id); f.review(id); f.accept(id); return id
  }
  const a = await completed([]), b = await completed([a]), c = await completed([b])
  const pending = f.create({ dependencies: [c] }).task_id; f.change('approvePlan', pending)
  const active = f.open({ dependencies: [b] })
  await f.artifact(active); f.review(active); f.store.submitTask({ task_id: active }, run, worker)
  const fences = () => f.store.open().prepare('SELECT * FROM task_dependency_fence ORDER BY task_id,evidence_generation,prerequisite_task_id').all()
  const captured = fences()
  f.change('returnForRework', a, { reason: 'ancestor needs correction' })
  for (const id of [b,c,pending,active]) {
    const state = f.flow.state({ task_id: id }, run)
    assert.equal(state.blocked, true)
    assert.equal(state.blocked_code, 'E_WORKFLOW_DEPENDENCY')
  }
  assert.equal(f.store.taskOf(b, run).task.status, 'accepted')
  assert.equal(f.store.taskOf(c, run).task.evidence_generation, 0)
  assert.equal(f.flow.ready({}, run).tasks.some(row => [pending, active].includes(row.task_id)), false)
  assert.throws(() => f.claim(pending), { code: 'E_WORKFLOW_DEPENDENCY' })
  assert.throws(() => f.store.submitTask({ task_id: active }, run, worker), { code: 'E_WORKFLOW_DEPENDENCY' })
  assert.throws(() => f.store.acceptTask({ task_id: active, expected_version: f.flow.state({ task_id: active }, run).row_version,
    request_key: f.key() }, run, lead), { code: 'E_WORKFLOW_DEPENDENCY' })
  assert.deepEqual(fences(), captured, 'readiness and failed admission must not mend historical fences')
  f.claim(a); await f.artifact(a); f.review(a); f.accept(a)
  assert.equal(f.flow.state({ task_id: c }, run).blocked, true, 'reaccepted ancestor must not revive intermediate evidence')
})

test('shared accepted ancestors in a diamond remain ready without being mistaken for a cycle', async t => {
  const f = fixture(t)
  const completed = async dependencies => {
    const id = f.open({ dependencies }); await f.artifact(id); f.review(id); f.accept(id); return id
  }
  const a = await completed([]), b = await completed([a]), c = await completed([a])
  const id = f.create({ dependencies: [b,c] }).task_id; f.change('approvePlan', id)
  assert.equal(f.flow.state({ task_id: id }, run).blocked, false)
  assert.equal(f.claim(id).status, 'claimed')
  await f.artifact(id); f.review(id); assert.equal(f.accept(id).status, 'accepted')
})

test('corrupt accepted dependency cycles fail closed instead of recursing or reporting ready', async t => {
  const f = fixture(t), a = f.open()
  await f.artifact(a); f.review(a); f.accept(a)
  const b = f.open({ dependencies: [a] })
  await f.artifact(b); f.review(b); f.accept(b)
  const id = f.create({ dependencies: [b] }).task_id; f.change('approvePlan', id)
  f.store.open().prepare('INSERT INTO task_dependency(task_id,prerequisite_task_id,run_id,created_by_session,created_at) VALUES(?,?,?,?,?)').run(a,b,run,run,'now')
  f.store.open().prepare('INSERT INTO task_dependency_fence(task_id,run_id,evidence_generation,prerequisite_task_id,prerequisite_generation) VALUES(?,?,0,?,0)').run(a,run,b)
  assert.equal(f.flow.state({ task_id: id }, run).blocked_code, 'E_STORE_INTEGRITY')
  assert.throws(() => f.claim(id), { code: 'E_STORE_INTEGRITY' })
})

test('returned unapproved plans allow dependency revision until the first approval', async t => {
  const f = fixture(t), original = f.create().task_id, replacement = f.open()
  await f.artifact(replacement); f.review(replacement); f.accept(replacement)
  const id = f.create({ dependencies: [original] }).task_id
  f.change('returnForRework', id, { reason: 'replace the planned prerequisite' })
  const before = f.flow.state({ task_id: id }, run)
  const changed = f.change('setDependencies', id, { prerequisite_task_ids: [replacement] })
  const after = f.flow.state({ task_id: id }, run)
  assert.deepEqual(changed.dependencies, [replacement])
  assert.deepEqual(after.dependencies, [replacement])
  assert.equal(after.row_version, before.row_version + 1)
  assert.equal(after.stage, 'plan')
  assert.equal(after.task_status, 'rejected')
  assert.equal(after.evidence_generation, 1)
  assert.throws(() => f.claim(id), { code: 'E_WORKFLOW_STAGE' })
  f.change('approvePlan', id)
  assert.throws(() => f.change('setDependencies', id, { prerequisite_task_ids: [] }), { code: 'E_WORKFLOW_STAGE' })
  f.claim(id)
  f.change('returnForRework', id, { reason: 'approved implementation needs rework' })
  assert.throws(() => f.change('setDependencies', id, { prerequisite_task_ids: [] }), { code: 'E_WORKFLOW_STAGE' })
  assert.deepEqual(f.flow.state({ task_id: id }, run).dependencies, [replacement])
})

for (const table of ['task_event', 'task_checkpoint', 'control_operation']) {
  for (const transitive of [false, true]) {
    test(table + ' ownership corruption blocks ' + (transitive ? 'transitive' : 'direct') + ' workflow dependencies at every gate', async t => {
      const f = fixture(t), recovery = new TaskforceRecovery(f.store)
      const complete = async dependencies => {
        const id = f.open({ dependencies }); await f.artifact(id); f.review(id); f.accept(id); return id
      }
      const upstream = await complete([])
      const prerequisite = transitive ? await complete([upstream]) : upstream
      const pending = f.create({ dependencies: [prerequisite] }).task_id; f.change('approvePlan', pending)
      const active = f.open({ dependencies: [prerequisite] })
      await f.artifact(active); f.review(active); f.store.submitTask({ task_id: active }, run, worker)
      const bound = f.open({ dependencies: [prerequisite] })
      const governor = new TaskforceGovernor(f.store), authority = { role: 'lead', sessionId: run }
      const reservation = governor.reserve({ operation_key: 'before-corruption', task_id: bound, generation: 0,
        kind: 'new', mode: 'read', resources: [] }, run, authority)
      recovery.checkpoint({ task_id: upstream, summary: 'private checkpoint content', next_action: 'private next action' }, run, lead)
      recovery.beginControl({ task_id: upstream, action: 'stop', target_id: 'private control target',
        payload_hash: 'a'.repeat(64), request_key: 'control' }, { ...lead, runId: run })
      const db = f.store.open()
      const fences = () => db.prepare('SELECT * FROM task_dependency_fence ORDER BY task_id,evidence_generation,prerequisite_task_id').all()
      const beforeFences = fences(), beforeGovernor = governor.snapshot(run)
      const secretSafe = error => error.code === 'E_STORE_INTEGRITY' && !/private|foreign secret/.test(error.message + JSON.stringify(error))
      for (const corruptRun of ['foreign secret run', null]) {
        assert.ok(db.prepare('UPDATE ' + table + ' SET run_id=? WHERE task_id=?').run(corruptRun, upstream).changes > 0)
        for (const id of [pending, active, bound]) {
          const state = f.flow.state({ task_id: id }, run)
          assert.equal(state.blocked, true)
          assert.equal(state.blocked_code, 'E_STORE_INTEGRITY')
          assert.equal(/private|foreign secret/.test(JSON.stringify(state)), false)
        }
        assert.equal(f.flow.ready({}, run).tasks.some(row => [pending, active, bound].includes(row.task_id)), false)
        assert.throws(() => f.claim(pending), secretSafe)
        assert.throws(() => governor.reserve({ operation_key: 'after-corruption', task_id: pending, generation: 0,
          kind: 'new', mode: 'read', resources: [] }, run, authority), secretSafe)
        assert.throws(() => governor.bind({ reservation_id: reservation.reservation_id, generation: reservation.generation,
          session_id: worker.sessionId }, run, authority), secretSafe)
        assert.throws(() => f.store.submitTask({ task_id: active }, run, worker), secretSafe)
        assert.throws(() => f.store.acceptTask({ task_id: active,
          expected_version: f.flow.state({ task_id: active }, run).row_version, request_key: f.key() }, run, lead), secretSafe)
        assert.equal(f.store.taskOf(pending, run).task.status, 'open')
        assert.equal(f.store.taskOf(active, run).task.status, 'submitted')
        assert.deepEqual(fences(), beforeFences)
        assert.deepEqual(governor.snapshot(run), beforeGovernor)
      }
    })
  }
}

test('correct recovery attribution and nullable unassigned controls preserve workflow readiness', async t => {
  const f = fixture(t), recovery = new TaskforceRecovery(f.store), upstream = f.open()
  await f.artifact(upstream); f.review(upstream); f.accept(upstream)
  recovery.checkpoint({ task_id: upstream, summary: 'planning context' }, run, lead)
  recovery.beginControl({ task_id: upstream, action: 'stop', target_id: 'worker', payload_hash: 'b'.repeat(64),
    request_key: 'attached-control' }, { ...lead, runId: run })
  for (const runId of [null, 'foreign run']) recovery.beginControl({ action: 'stop', target_id: 'other',
    payload_hash: 'c'.repeat(64), request_key: 'unassigned-' + runId }, { sessionId: 'foreign caller', runId })
  const id = f.open({ dependencies: [upstream] })
  assert.equal(f.flow.state({ task_id: id }, run).blocked, false)
  await f.artifact(id); f.review(id); assert.equal(f.accept(id).status, 'accepted')
})

test('detached workflow gates remain usable without optional recovery tables', async t => {
  const f = fixture(t), upstream = f.open()
  await f.artifact(upstream); f.review(upstream); f.accept(upstream)
  const id = f.create({ dependencies: [upstream] }).task_id; f.change('approvePlan', id)
  const db = f.store.open()
  db.exec('DROP TRIGGER recovery_task_insert; DROP TRIGGER recovery_task_update; DROP TABLE task_event; DROP TABLE task_checkpoint; DROP TABLE control_operation;')
  assert.equal(f.flow.state({ task_id: id }, run).blocked, false)
  assert.doesNotThrow(() => workflowAdmission(db, db.prepare('SELECT * FROM task WHERE id=?').get(id)))
})

test('zero-rework coding tasks reject premature submission without stranding the workflow', async t => {
  const f = fixture(t), id = f.create({ max_reworks: 0 }).task_id
  for (const stage of ['plan', 'implement']) {
    const before = f.flow.state({ task_id: id }, run)
    assert.equal(before.stage, stage)
    const events = f.store.open().prepare('SELECT COUNT(*) AS n FROM task_event WHERE task_id=?').get(id).n
    for (const actor of [worker, lead]) {
      assert.throws(() => f.store.submitTask({ task_id: id, note: 'out of order' }, run, actor), { code: 'E_WORKFLOW_STAGE' })
      assert.deepEqual(f.flow.state({ task_id: id }, run), before)
      assert.equal(f.store.taskOf(id, run).task.status, 'open')
      assert.equal(f.store.open().prepare('SELECT COUNT(*) AS n FROM task_event WHERE task_id=?').get(id).n, events)
    }
    if (stage === 'plan') f.change('approvePlan', id)
  }
  assert.equal(f.claim(id).status, 'claimed')
  await f.artifact(id); f.review(id)
  assert.equal(f.accept(id).status, 'accepted')
  assert.equal(f.flow.state({ task_id: id }, run).rework_count, 0)
})

test('workflow submission preserves bound ownership, submitted replay and completed acceptance replay', async t => {
  const f = fixture(t), id = f.open()
  assert.throws(() => f.store.submitTask({ task_id: id }, run, reviewer), { code: 'E_TASK_CONFLICT' })
  assert.equal(f.store.taskOf(id, run).task.status, 'claimed')
  assert.equal(f.store.submitTask({ task_id: id }, run, lead).status, 'submitted')
  assert.equal(f.store.submitTask({ task_id: id }, run, worker).already, true)
  await f.artifact(id); f.review(id)
  const args = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
  const accepted = f.store.acceptTask(args, run, lead)
  assert.deepEqual(f.store.acceptTask(args, run, lead), accepted)
  assert.throws(() => f.store.submitTask({ task_id: id }, run, worker), { code: 'E_TERMINAL' })
  const legacy = f.store.openTask({ title: 'unowned legacy submission' }, run).task_id
  assert.equal(f.store.submitTask({ task_id: legacy }, run).status, 'submitted')
})

function deliveryRows(f, id) {
  return Object.fromEntries(['workflow', 'workflow_artifact', 'workflow_review', 'workflow_decision', 'execution_receipt']
    .map(table => [table, f.store.open().prepare('SELECT * FROM ' + table + ' WHERE task_id=? ORDER BY rowid').all(id)]))
}
function outcomeReview(f, id, result) {
  return f.change('recordReview', id, { revision_id: f.flow.state({ task_id: id }, run).revision_id,
    requirements_result: result, quality_result: 'pass', findings: result === 'pass' ? [] : ['requires root decision'] }, reviewer)
}

for (const outcome of ['unreviewed', 'fail', 'unverified', 'pass']) {
  test('delivered ' + outcome + ' revision refuses direct artifact replacement', async t => {
    const f = fixture(t), id = f.open({ max_reworks: 0 }); await f.artifact(id)
    if (outcome !== 'unreviewed') outcomeReview(f, id, outcome)
    const before = deliveryRows(f, id)
    assert.throws(() => f.change('recordArtifact', id, {}, worker), { code: 'E_WORKFLOW_STAGE' })
    assert.deepEqual(deliveryRows(f, id), before)
  })
  test('delivered ' + outcome + ' revision refuses fresh verification before intent or native execution', async t => {
    const f = fixture(t), id = f.open({ max_reworks: 0 }); await f.artifact(id)
    if (outcome !== 'unreviewed') outcomeReview(f, id, outcome)
    const before = deliveryRows(f, id), calls = f.executions()
    if (outcome !== 'pass') writeFileSync(join(f.store.root, 'source.js'), 'export const answer = 43\n')
    await assert.rejects(f.verify(id), { code: 'E_WORKFLOW_STAGE' })
    assert.equal(f.executions(), calls)
    assert.deepEqual(deliveryRows(f, id), before)
    assert.throws(() => f.store.recordExecution({ task_id: id, status: 'pending',
      command: 'node --check source.js', timeout_ms: 60000, call_id: 'blocked', root_call_id: 'root' }, run, worker),
      { code: 'E_WORKFLOW_STAGE' })
    assert.deepEqual(deliveryRows(f, id), before)
    assert.throws(() => f.change('recordArtifact', id, {}, worker), { code: 'E_WORKFLOW_STAGE' })
  })
}

for (const [dimension, result] of [['requirements_result','fail'], ['requirements_result','unverified'], ['quality_result','fail'], ['quality_result','unverified']]) {
  test('current ' + dimension + '=' + result + ' review cannot be superseded by another passing review', async t => {
    const f = fixture(t), id = f.open(); await f.artifact(id)
    f.change('recordReview', id, { revision_id: f.flow.state({ task_id: id }, run).revision_id,
      requirements_result: 'pass', quality_result: 'pass', [dimension]: result, findings: ['root return required'] }, reviewer)
    const before = deliveryRows(f, id)
    for (const nextReviewer of [reviewer, { sessionId: 'another independent reviewer', isRoot: false }]) {
      assert.throws(() => f.change('recordReview', id, { revision_id: f.flow.state({ task_id: id }, run).revision_id,
        requirements_result: 'pass', quality_result: 'pass', findings: [] }, nextReviewer), { code: 'E_WORKFLOW_REVIEW' })
      assert.deepEqual(deliveryRows(f, id), before)
    }
  })

  test('pre-upgrade active ' + dimension + '=' + result + '-then-pass history cannot be accepted without root return', async t => {
    const f = fixture(t), id = f.open({ max_reworks: 1 }); await f.artifact(id)
    f.change('recordReview', id, { revision_id: f.flow.state({ task_id: id }, run).revision_id,
      requirements_result: 'pass', quality_result: 'pass', [dimension]: result, findings: ['root return required'] }, reviewer)
    // Model durable rows produced by the former fail-to-pass API, not a new allowed write.
    const db = f.store.open()
    db.prepare("INSERT INTO workflow_review(task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) SELECT task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,'pass','pass','[]',created_at FROM workflow_review WHERE task_id=? ORDER BY id DESC LIMIT 1").run(id)
    db.prepare("UPDATE workflow SET stage='lead_acceptance',row_version=row_version+1 WHERE task_id=?").run(id)
    f.store.submitTask({ task_id: id }, run, worker)
    const before = deliveryRows(f, id)
    assert.throws(() => f.store.acceptTask({ task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version,
      request_key: f.key() }, run, lead), { code: 'E_WORKFLOW_EVIDENCE' })
    assert.deepEqual(deliveryRows(f, id), before)
    const oldRevision = f.flow.state({ task_id: id }, run).revision_id
    f.change('returnForRework', id, { reason: 'repair failed revision' }); f.claim(id)
    await f.artifact(id); f.review(id)
    assert.notEqual(f.flow.state({ task_id: id }, run).revision_id, oldRevision)
    assert.equal(f.accept(id).status, 'accepted')
    assert.equal(f.flow.state({ task_id: id }, run).evidence_generation, 1)
  })
}

test('original artifact and review requests replay without reopening frozen delivery', async t => {
  const f = fixture(t), id = f.open({ max_reworks: 1 }); await f.verify(id)
  const artifactArgs = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
  const artifact = f.flow.recordArtifact(artifactArgs, run, worker)
  const reviewArgs = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key(),
    revision_id: artifact.revision_id, requirements_result: 'fail', quality_result: 'pass', findings: ['return required'] }
  const failed = f.flow.recordReview(reviewArgs, run, reviewer)
  let before = deliveryRows(f, id)
  assert.deepEqual(f.flow.recordArtifact(artifactArgs, run, worker), artifact)
  assert.deepEqual(f.flow.recordReview(reviewArgs, run, reviewer), failed)
  assert.deepEqual(deliveryRows(f, id), before)
  f.change('returnForRework', id, { reason: 'approved correction' }); f.claim(id)
  await f.artifact(id); f.review(id); f.accept(id)
  before = deliveryRows(f, id)
  assert.deepEqual(f.flow.recordArtifact(artifactArgs, run, worker), artifact)
  assert.deepEqual(f.flow.recordReview(reviewArgs, run, reviewer), failed)
  assert.deepEqual(deliveryRows(f, id), before)
})

test('root return is required after passing review and exhausted budget cannot be bypassed', async t => {
  const f = fixture(t), id = f.open({ max_reworks: 1 }); await f.artifact(id); f.review(id)
  f.change('returnForRework', id, { reason: 'revalidate delivered work' }); f.claim(id)
  await f.artifact(id); f.review(id)
  const before = deliveryRows(f, id), calls = f.executions()
  assert.throws(() => f.change('returnForRework', id, { reason: 'one more retry' }), { code: 'E_WORKFLOW_BUDGET' })
  await assert.rejects(f.verify(id), { code: 'E_WORKFLOW_STAGE' })
  assert.throws(() => f.change('recordArtifact', id, {}, worker), { code: 'E_WORKFLOW_STAGE' })
  assert.equal(f.executions(), calls)
  assert.deepEqual(deliveryRows(f, id), before)
})

test('failure from another revision, plan or evidence generation does not poison the current delivery', async t => {
  for (const dimension of ['revision_id', 'plan_version', 'evidence_generation']) {
    const f = fixture(t), id = f.open(); await f.artifact(id)
    const state = f.flow.state({ task_id: id }, run)
    const history = { revision_id: state.revision_id, plan_version: state.plan_version, evidence_generation: state.evidence_generation }
    history[dimension] += 100
    f.store.open().prepare("INSERT INTO workflow_review(task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) VALUES(?,?,?,?,?,?,'fail','pass','[]','historical')")
      .run(id, run, history.revision_id, history.plan_version, history.evidence_generation, reviewer.sessionId)
    f.review(id)
    assert.equal(f.accept(id).status, 'accepted')
  }
})

test('historical completed fail-then-pass outcome keeps original acceptance replay read-only', async t => {
  const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
  f.store.submitTask({ task_id: id }, run, worker)
  const args = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
  const accepted = f.store.acceptTask(args, run, lead)
  f.store.open().prepare("INSERT INTO workflow_review(id,task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) SELECT 0,task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,'fail','pass','[]',created_at FROM workflow_review WHERE task_id=? LIMIT 1").run(id)
  const before = deliveryRows(f, id)
  assert.deepEqual(f.store.acceptTask(args, run, lead), accepted)
  assert.throws(() => f.store.acceptTask({ ...args, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }, run, lead), { code: 'E_TERMINAL' })
  assert.deepEqual(deliveryRows(f, id), before)
  assert.equal(f.store.taskOf(id, run).task.status, 'accepted')
})

/** Reproduce the exact durable writes of 0.4.0 (81b7ce6) after a nonpassing
 * review: recordExecution(pending) resets stage/revision without advancing
 * evidence_generation. Optional old artifact/review writes reproduce later
 * crash boundaries. Completion still uses the real store and real Node output.
 * SQL is intentional: the upgraded API must refuse these historical writes. */
async function legacyReplacement(f, id, stage, dimension = 'requirements_result', result = 'fail') {
  await f.verify(id)
  const artifactArgs = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
  const artifact = f.flow.recordArtifact(artifactArgs, run, worker)
  const reviewArgs = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key(),
    revision_id: artifact.revision_id, requirements_result: 'pass', quality_result: 'pass', [dimension]: result,
    findings: result === 'pass' ? [] : ['legacy failure requiring root return'] }
  const failed = result === 'unreviewed' ? null : f.flow.recordReview(reviewArgs, run, reviewer)
  const original = f.flow.state({ task_id: id }, run), db = f.store.open(), stamp = new Date().toISOString()
  const receiptId = randomUUID()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare("UPDATE workflow SET stage='test',revision_id=NULL,row_version=row_version+1,updated_at=? WHERE task_id=?").run(stamp, id)
    db.prepare("INSERT INTO execution_receipt(receipt_id,task_id,run_id,evidence_generation,owner_session,actor_session,command,cwd,verification_files,status,started_at,call_id,root_call_id,parent_call_id,timeout_ms,snapshot) SELECT ?,task_id,run_id,evidence_generation,owner_session,actor_session,command,cwd,verification_files,'pending',?,?,'legacy-root',NULL,timeout_ms,snapshot FROM execution_receipt WHERE receipt_id=?")
      .run(receiptId, stamp, 'legacy-call', artifact.receipt_id)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  if (stage !== 'test') {
    const processResult = spawnSync(process.execPath, ['--check', 'source.js'], { cwd: f.store.root, encoding: 'utf8' })
    const completed = f.store.recordExecution({ task_id: id, receipt_id: receiptId, native_result: { isError: false,
      value: { kind: 'foreground', exitCode: processResult.status, signal: processResult.signal, timedOut: false,
        aborted: false, timeoutMs: 60000, stdout: { text: processResult.stdout, truncated: false },
        stderr: { text: processResult.stderr, truncated: false } } } }, run, worker)
    assert.equal(completed.verified, true)
    db.exec('BEGIN IMMEDIATE')
    try {
      const task = db.prepare('SELECT * FROM task WHERE id=?').get(id)
      let flow = db.prepare('SELECT * FROM workflow WHERE task_id=?').get(id)
      const receipt = db.prepare('SELECT * FROM execution_receipt WHERE receipt_id=?').get(receiptId)
      const revision = Number(db.prepare('INSERT INTO workflow_artifact(task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, run, flow.plan_version, task.evidence_generation, worker.sessionId, receiptId, receipt.snapshot, receipt.logs, stamp).lastInsertRowid)
      const args = { task_id: id, expected_version: flow.row_version, request_key: f.key() }
      db.prepare("UPDATE workflow SET stage='review',revision_id=?,row_version=row_version+1,updated_at=? WHERE task_id=?").run(revision, stamp, id)
      workflowAudit(db, task, 'recordArtifact', args, worker, flow.row_version, { task_id: id, receipt_id: receiptId,
        snapshot: JSON.parse(receipt.snapshot), logs: JSON.parse(receipt.logs), evidence_generation: task.evidence_generation,
        row_version: flow.row_version + 1, revision_id: revision })
      if (stage === 'lead_acceptance') {
        flow = db.prepare('SELECT * FROM workflow WHERE task_id=?').get(id)
        const reviewId = Number(db.prepare("INSERT INTO workflow_review(task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) VALUES(?,?,?,?,?,?,'pass','pass','[]',?)")
          .run(id, run, revision, flow.plan_version, task.evidence_generation, reviewer.sessionId, stamp).lastInsertRowid)
        const args = { task_id: id, expected_version: flow.row_version, request_key: f.key(), revision_id: revision,
          requirements_result: 'pass', quality_result: 'pass', findings: [] }
        db.prepare("UPDATE workflow SET stage='lead_acceptance',row_version=row_version+1,updated_at=? WHERE task_id=?").run(stamp, id)
        workflowAudit(db, task, 'recordReview', args, reviewer, flow.row_version, { task_id: id, review_id: reviewId,
          revision_id: revision, stage: 'lead_acceptance', row_version: flow.row_version + 1 })
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const durable = deliveryRows(f, id)
  f.reopen()
  assert.deepEqual(deliveryRows(f, id), durable, 'upgrade fixture must survive closing and reopening SQLite')
  const state = f.flow.state({ task_id: id }, run)
  assert.equal(state.stage, stage)
  assert.equal(state.evidence_generation, original.evidence_generation)
  assert.equal(state.plan_version, original.plan_version)
  assert.equal(state.rework_count, 0)
  if (stage === 'test') assert.equal(state.revision_id, null)
  else assert.notEqual(state.revision_id, artifact.revision_id)
  return { artifactArgs, artifact, reviewArgs, failed }
}

for (const stage of ['test', 'review', 'lead_acceptance']) {
  for (const [dimension, result] of [['requirements_result','fail'], ['requirements_result','unverified'], ['quality_result','fail'], ['quality_result','unverified']]) {
    test('legacy ' + stage + ' replacement preserves ' + dimension + '=' + result + ' failure until root return', async t => {
      const f = fixture(t), id = f.open({ max_reworks: 0 })
      await legacyReplacement(f, id, stage, dimension, result)
      if (stage === 'lead_acceptance') f.store.submitTask({ task_id: id }, run, worker)
      const before = deliveryRows(f, id), calls = f.executions()
      if (stage === 'test') {
        await assert.rejects(async () => {
          await f.artifact(id); f.review(id)
          assert.equal(f.accept(id).status, 'accepted', 'unfixed old-generation replacement reaches acceptance')
        }, { code: 'E_WORKFLOW_STAGE' })
      } else if (stage === 'review') {
        assert.throws(() => f.review(id), { code: 'E_WORKFLOW_REVIEW' })
      } else {
        assert.throws(() => f.store.acceptTask({ task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version,
          request_key: f.key() }, run, lead), { code: 'E_WORKFLOW_EVIDENCE' })
      }
      assert.equal(f.executions(), calls)
      assert.deepEqual(deliveryRows(f, id), before)
      assert.throws(() => f.change('returnForRework', id, { reason: 'no budget remains' }), { code: 'E_WORKFLOW_BUDGET' })
      assert.deepEqual(deliveryRows(f, id), before)
    })
  }
}

for (const entry of ['pending', 'artifact', 'accept']) {
  test('legacy cleared revision rejects direct ' + entry + ' through the shared failure gate', async t => {
    const f = fixture(t), id = f.open({ max_reworks: 0 }); await legacyReplacement(f, id, 'test')
    if (entry === 'accept') f.store.submitTask({ task_id: id }, run, worker)
    const before = deliveryRows(f, id), calls = f.executions()
    const action = entry === 'pending' ? () => f.store.recordExecution({ task_id: id, status: 'pending',
      command: 'node --check source.js', timeout_ms: 60000, call_id: 'blocked', root_call_id: 'root' }, run, worker)
      : entry === 'artifact' ? () => f.change('recordArtifact', id, {}, worker)
      : () => f.store.acceptTask({ task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }, run, lead)
    assert.throws(action, { code: entry === 'accept' ? 'E_WORKFLOW_EVIDENCE' : 'E_WORKFLOW_STAGE' })
    assert.equal(f.executions(), calls)
    assert.deepEqual(deliveryRows(f, id), before)
  })
}

test('legacy replacement history preserves read-only replay and budgeted root-return recovery at every crash boundary', async t => {
  for (const stage of ['test', 'review', 'lead_acceptance']) {
    const f = fixture(t), id = f.open({ max_reworks: 1 })
    const original = await legacyReplacement(f, id, stage)
    let before = deliveryRows(f, id)
    assert.deepEqual(f.flow.recordArtifact(original.artifactArgs, run, worker), original.artifact)
    assert.deepEqual(f.flow.recordReview(original.reviewArgs, run, reviewer), original.failed)
    assert.deepEqual(deliveryRows(f, id), before)
    f.change('returnForRework', id, { reason: 'explicitly recover interrupted legacy replacement' }); f.claim(id)
    await f.artifact(id); f.review(id)
    assert.equal(f.accept(id).status, 'accepted')
    const state = f.flow.state({ task_id: id }, run)
    assert.equal(state.evidence_generation, 1)
    assert.equal(state.rework_count, 1)
    assert.notEqual(state.revision_id, original.artifact.revision_id)
    before = deliveryRows(f, id)
    assert.deepEqual(f.flow.recordArtifact(original.artifactArgs, run, worker), original.artifact)
    assert.deepEqual(f.flow.recordReview(original.reviewArgs, run, reviewer), original.failed)
    assert.deepEqual(deliveryRows(f, id), before)
  }
})

test('historical failure association requires matching artifact task, run, plan and generation', async t => {
  for (const dimension of ['task_id', 'run_id', 'plan_version', 'evidence_generation']) {
    const f = fixture(t), id = f.open(); await f.artifact(id)
    const db = f.store.open(), task = db.prepare('SELECT * FROM task WHERE id=?').get(id)
    const flow = db.prepare('SELECT * FROM workflow WHERE task_id=?').get(id)
    const prior = { ...db.prepare('SELECT * FROM workflow_artifact WHERE id=?').get(flow.revision_id) }
    prior[dimension] = dimension === 'run_id' ? 'foreign artifact run' : prior[dimension] + 100
    const revision = Number(db.prepare('INSERT INTO workflow_artifact(task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(prior.task_id, prior.run_id, prior.plan_version, prior.evidence_generation, prior.producer_session,
        prior.receipt_id, prior.snapshot, prior.logs, prior.created_at).lastInsertRowid)
    db.prepare("INSERT INTO workflow_review(task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) VALUES(?,?,?,?,?,?,'fail','pass','[]','historical')")
      .run(id, run, revision, flow.plan_version, task.evidence_generation, reviewer.sessionId)
    // Isolate attribution from the separate public scope-integrity check: a
    // foreign-run artifact attached to this task must still fail that check.
    for (const action of ['review', 'accept']) assert.doesNotThrow(() => workflowDeliveryGate(db, task, flow, action))
    if (dimension === 'run_id') {
      assert.throws(() => f.review(id), error => error.code === 'E_STORE_INTEGRITY' && !error.message.includes(prior.run_id))
    } else {
      f.review(id)
      assert.equal(f.accept(id).status, 'accepted')
    }
  }
})

function workflowToolCaller(f) {
  const definitions = [], agents = new Map()
  for (const identity of [lead, worker, reviewer]) {
    const header = { id: identity.sessionId, cwd: f.store.root,
      ...(identity.isRoot ? {} : { parentSession: run, origin: 'subagent', delegationDepth: 1 }) }
    agents.set(identity.sessionId, { id: identity.sessionId, session: { header } })
  }
  // Real plugin handlers, identity derivation and store; only the registry is a host boundary fixture.
  applyTools({ logger: { warn() {} }, get(name) {
    if (name === 'taskforceStore') return f.store
    if (name === 'agents') return { get: id => agents.get(id) }
  }, tools: { register(definition) { definitions.push(definition); return () => {} } } })
  return async (name, args, identity = lead) => {
    const definition = definitions.find(d => d.name === name)
    assert.ok(definition, name)
    return JSON.parse(await definition.execute(args, { agent: agents.get(identity.sessionId), token: {},
      rootCallId: f.key(), signal: new AbortController().signal }))
  }
}
function assertWorkflowRecovery(error, code, remaining) {
  assert.equal(error.code, code)
  assert.equal(typeof error.hint, 'string')
  assert.match(error.hint, /主会话/)
  assert.doesNotMatch((error.error ?? error.message ?? '') + error.hint, /waiver_reason|人工豁免/)
  if (remaining > 0) {
    for (const action of ['task_workflow_state', 'return_for_rework', 'task_claim', 'task_verify', 'record_artifact', 'record_review']) assert.ok(error.hint.includes(action), action)
    assert.ok(error.hint.indexOf('return_for_rework') < error.hint.indexOf('task_verify'))
  } else {
    assert.match(error.hint, /预算/); assert.match(error.hint, /授权/)
    assert.match(error.hint, /task_workflow_create/)
    assert.doesNotMatch(error.hint, /return_for_rework|task_verify/)
  }
  return true
}
function damageEvidence(f, id, kind) {
  if (kind === 'source') writeFileSync(join(f.store.root, 'source.js'), 'export const answer = 43\n')
  else {
    const row = f.store.open().prepare('SELECT logs FROM execution_receipt WHERE task_id=? ORDER BY id DESC LIMIT 1').get(id)
    writeFileSync(JSON.parse(row.logs).stdout.path, 'changed real log bytes')
  }
}

for (const verdict of ['unreviewed', 'pass']) {
  for (const stage of ['test', 'review', 'lead_acceptance']) {
    test('legacy ' + verdict + ' delivery stays frozen after persisted ' + stage + ' replacement', async t => {
      const f = fixture(t), id = f.open({ max_reworks: 0 })
      await legacyReplacement(f, id, stage, 'requirements_result', verdict)
      if (stage === 'lead_acceptance') f.store.submitTask({ task_id: id }, run, worker)
      const before = deliveryRows(f, id), calls = f.executions()
      if (stage === 'test') {
        await assert.rejects(async () => {
          await f.artifact(id); f.review(id)
          assert.equal(f.accept(id).status, 'accepted', 'unfixed same-generation delivery replacement reaches acceptance')
        }, { code: 'E_WORKFLOW_STAGE' })
        assert.throws(() => f.change('recordArtifact', id, {}, worker), { code: 'E_WORKFLOW_STAGE' })
      } else if (stage === 'review') assert.throws(() => f.review(id), { code: 'E_WORKFLOW_REVIEW' })
      else assert.throws(() => f.store.acceptTask({ task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version,
        request_key: f.key() }, run, lead), { code: 'E_WORKFLOW_EVIDENCE' })
      assert.equal(f.executions(), calls); assert.deepEqual(deliveryRows(f, id), before)
      assert.throws(() => f.change('returnForRework', id, { reason: 'cannot bypass zero budget' }), { code: 'E_WORKFLOW_BUDGET' })
      assert.deepEqual(deliveryRows(f, id), before)
    })
  }
  test('legacy direct artifact replacement of ' + verdict + ' delivery freezes even when the receipt is unchanged', async t => {
    const f = fixture(t), id = f.open({ max_reworks: 0 }); await f.artifact(id)
    if (verdict === 'pass') f.review(id)
    const db = f.store.open(), flow = f.flow.state({ task_id: id }, run), task = db.prepare('SELECT * FROM task WHERE id=?').get(id)
    const prior = db.prepare('SELECT * FROM workflow_artifact WHERE id=?').get(flow.revision_id)
    // Exact old recordArtifact writes: valid current receipt, second immutable artifact, version/audit.
    db.exec('BEGIN IMMEDIATE')
    try {
      const revision = Number(db.prepare('INSERT INTO workflow_artifact(task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at) SELECT task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at FROM workflow_artifact WHERE id=?')
        .run(prior.id).lastInsertRowid)
      const args = { task_id: id, expected_version: flow.row_version, request_key: f.key() }
      db.prepare("UPDATE workflow SET stage='review',revision_id=?,row_version=row_version+1 WHERE task_id=?").run(revision, id)
      workflowAudit(db, task, 'recordArtifact', args, worker, flow.row_version, { task_id: id, receipt_id: prior.receipt_id,
        snapshot: JSON.parse(prior.snapshot), logs: JSON.parse(prior.logs), evidence_generation: task.evidence_generation,
        row_version: flow.row_version + 1, revision_id: revision })
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    const durable = deliveryRows(f, id); f.reopen(); assert.deepEqual(deliveryRows(f, id), durable)
    assert.equal(durable.workflow_artifact[0].receipt_id, durable.workflow_artifact[1].receipt_id)
    assert.equal(durable.execution_receipt.length, 1)
    assert.throws(() => f.review(id), { code: 'E_WORKFLOW_REVIEW' })
    assert.deepEqual(deliveryRows(f, id), durable)
  })
}

test('root return authorizes a fresh generation after unreviewed or passing legacy delivery replacement', async t => {
  for (const verdict of ['unreviewed', 'pass']) for (const stage of ['test', 'review', 'lead_acceptance']) {
    const f = fixture(t), id = f.open({ max_reworks: 1 })
    const original = await legacyReplacement(f, id, stage, 'requirements_result', verdict), before = deliveryRows(f, id)
    assert.deepEqual(f.flow.recordArtifact(original.artifactArgs, run, worker), original.artifact)
    if (verdict === 'pass') assert.deepEqual(f.flow.recordReview(original.reviewArgs, run, reviewer), original.failed)
    assert.deepEqual(deliveryRows(f, id), before)
    f.change('returnForRework', id, { reason: 'root authorizes a new delivery generation' }); f.claim(id)
    await f.artifact(id); f.review(id); assert.equal(f.accept(id).status, 'accepted')
    assert.equal(f.flow.state({ task_id: id }, run).evidence_generation, 1)
    assert.equal(f.flow.state({ task_id: id }, run).rework_count, 1)
  }
})

for (const stage of ['review', 'lead_acceptance']) for (const damage of ['source', 'log']) for (const budget of [0, 1]) {
  test('frozen ' + stage + ' ' + damage + ' drift exposes actionable tool recovery with budget ' + budget, async t => {
    const f = fixture(t), id = f.open({ max_reworks: budget }); await f.artifact(id)
    if (stage === 'lead_acceptance') { f.review(id); f.store.submitTask({ task_id: id }, run, worker) }
    damageEvidence(f, id, damage)
    const before = deliveryRows(f, id), calls = f.executions(), call = workflowToolCaller(f)
    const args = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
    const response = stage === 'review'
      ? await call('task_workflow_submit', { ...args, action: 'record_review', revision_id: f.flow.state({ task_id: id }, run).revision_id,
        requirements_result: 'pass', quality_result: 'pass', findings: [] }, reviewer)
      : await call('task_accept', args)
    assert.equal(response.ok, false)
    assertWorkflowRecovery(response, stage === 'review' ? 'E_WORKFLOW_REVIEW' : 'E_WORKFLOW_EVIDENCE', budget)
    await assert.rejects(f.verify(id), { code: 'E_WORKFLOW_STAGE' })
    assert.equal(f.executions(), calls); assert.deepEqual(deliveryRows(f, id), before)
    const returned = await call('task_workflow_submit', { task_id: id, action: 'return_for_rework',
      expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key(), reason: 'explicit root recovery' })
    if (budget === 0) {
      assert.equal(returned.ok, false); assert.equal(returned.code, 'E_WORKFLOW_BUDGET')
      assert.deepEqual(deliveryRows(f, id), before)
      // A separate, explicit trusted-root creation; failure never creates or authorizes a task itself.
      const replacement = f.open({ max_reworks: 0 }); await f.artifact(replacement); f.review(replacement)
      assert.equal(f.accept(replacement).status, 'accepted')
    } else {
      assert.equal(returned.ok, true, JSON.stringify(returned)); f.claim(id)
      await f.artifact(id); f.review(id); assert.equal(f.accept(id).status, 'accepted')
      assert.equal(f.flow.state({ task_id: id }, run).evidence_generation, 1)
      assert.equal(f.flow.state({ task_id: id }, run).rework_count, 1)
    }
  })
}

for (const damage of ['source', 'log']) for (const budget of [0, 1]) {
  test('frozen acceptance second receipt read maps ' + damage + ' drift to budget ' + budget + ' workflow recovery', async t => {
    const f = fixture(t), id = f.open({ max_reworks: budget }); await f.artifact(id); f.review(id)
    f.store.submitTask({ task_id: id }, run, worker)
    const before = deliveryRows(f, id), call = workflowToolCaller(f), db = f.store.open(), prepare = db.prepare
    let receiptReads = 0
    // Inject an actual file mutation precisely between the two real strict reads;
    // every statement still executes on the real SQLite connection.
    db.prepare = function(sql) {
      if (sql === 'SELECT * FROM execution_receipt WHERE task_id = ? AND run_id IS ? ORDER BY id DESC LIMIT 1' && ++receiptReads === 2) damageEvidence(f, id, damage)
      return prepare.call(this, sql)
    }
    let response
    try {
      response = await call('task_accept', { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() })
    } finally { db.prepare = prepare }
    assert.equal(receiptReads, 2, 'retain both real strict evidence checks')
    assert.equal(response.ok, false); assertWorkflowRecovery(response, 'E_WORKFLOW_EVIDENCE', budget)
    assert.deepEqual(deliveryRows(f, id), before)
    assert.equal(f.store.taskOf(id, run).task.status, 'submitted')
  })
}

test('mutable workflows and ordinary strict tasks retain receipt retry guidance and real recovery', async t => {
  for (const kind of ['implement', 'test', 'ordinary']) {
    const f = fixture(t)
    const id = kind === 'ordinary' ? f.store.openTask({ title: 'ordinary strict', evidence_policy: 'execution',
      verification_files: ['source.js'], verification_command: 'node --check source.js' }, run, f.actor).task_id : f.open()
    if (kind === 'ordinary') f.claim(id)
    if (kind !== 'implement') { await f.verify(id); damageEvidence(f, id, 'source') }
    f.store.submitTask({ task_id: id }, run, worker)
    const call = workflowToolCaller(f), response = await call('task_accept', { task_id: id,
      ...(kind === 'ordinary' ? {} : { expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }) })
    assert.equal(response.ok, false); assert.equal(response.code, 'E_VERIFICATION_RECEIPT')
    assert.match(response.hint, /task_verify/); assert.doesNotMatch(response.hint, /return_for_rework|task_workflow_create/)
    if (kind === 'ordinary') {
      assert.match(response.hint, /人工豁免/)
      const waived = await call('task_accept', { task_id: id, waiver_reason: 'explicit root acceptance of unverified ordinary task' })
      assert.equal(waived.ok, true); assert.equal(waived.execution_verified, false)
    } else {
      await f.verify(id); await f.verify(id)
      f.change('recordArtifact', id, {}, worker); f.review(id); assert.equal(f.accept(id).status, 'accepted')
      assert.equal(f.flow.state({ task_id: id }, run).rework_count, 0)
    }
  }
})

test('sole current delivery accepts with zero budget and completed request replays ignore later evidence drift', async t => {
  const f = fixture(t), id = f.open({ max_reworks: 0 }); await f.verify(id)
  const artifactArgs = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
  const artifact = f.flow.recordArtifact(artifactArgs, run, worker)
  const reviewArgs = { task_id: id, revision_id: artifact.revision_id, expected_version: f.flow.state({ task_id: id }, run).row_version,
    request_key: f.key(), requirements_result: 'pass', quality_result: 'pass', findings: [] }
  const review = f.flow.recordReview(reviewArgs, run, reviewer)
  f.store.submitTask({ task_id: id }, run, worker)
  const acceptArgs = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
  const accepted = f.store.acceptTask(acceptArgs, run, lead)
  damageEvidence(f, id, 'source'); damageEvidence(f, id, 'log')
  const before = deliveryRows(f, id)
  assert.deepEqual(f.flow.recordArtifact(artifactArgs, run, worker), artifact)
  assert.deepEqual(f.flow.recordReview(reviewArgs, run, reviewer), review)
  assert.deepEqual(f.store.acceptTask(acceptArgs, run, lead), accepted)
  assert.deepEqual(deliveryRows(f, id), before)
  assert.equal(f.flow.state({ task_id: id }, run).rework_count, 0)
})
