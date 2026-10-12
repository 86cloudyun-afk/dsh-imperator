import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
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
function fixture(t, options = {}, identities = { run, lead, worker, reviewer }) {
  const { run, lead, worker, reviewer } = identities
  assert.equal(typeof module.TaskforceWorkflow, 'function', 'workflow core must be implemented')
  let store
  t.after(() => store?.close())
  store = tempStore(t, options); store.open()
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

test('Task16 workflow carries complete run, owner and independent reviewer through real evidence and replay', async t => {
  const full = 'root\0suffix', owner = { sessionId: 'writer\0suffix', isRoot: false }
  const f = fixture(t, {}, { run: full, lead: { sessionId: full, isRoot: true }, worker: owner,
    reviewer: { sessionId: 'writer\0independent', isRoot: false } })
  const id = f.open(); await f.artifact(id); f.review(id)
  assert.equal(f.store.taskOf(id, full).task.owner_session, owner.sessionId)
  assert.throws(() => f.flow.state({ task_id: id }, 'root'), { code: 'E_CROSS_RUN' })
  f.store.submitTask({ task_id: id }, full, owner)
  const args = { task_id: id, expected_version: f.flow.state({ task_id: id }, full).row_version, request_key: f.key() }
  const accepted = f.store.acceptTask(args, full, { sessionId: full, isRoot: true })
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.execution_verified, true)
  assert.deepEqual(f.store.acceptTask(args, full, { sessionId: full, isRoot: true }), accepted)
  assert.equal(f.executions(), 1)
})

for (const route of ['artifact metadata', 'review metadata', 'latest review']) {
  test(`SQLite TEXT workflow ${route} preserves complete persisted identities`, async t => {
    const f = fixture(t), id = f.open(); await f.artifact(id)
    const identity = 'reviewer\0中文😀e\u0301'
    f.change('recordReview', id, { revision_id: f.flow.state({ task_id: id }, run).revision_id,
      requirements_result: 'pass', quality_result: 'pass', findings: ['finding\0suffix'] }, { sessionId: identity, isRoot: false })
    const producer = worker.sessionId + '\0suffix'
    f.store.open().prepare('UPDATE workflow_artifact SET producer_session=? WHERE task_id=?').run(producer, id)
    f.reopen()
    const state = f.flow.state({ task_id: id, include_context: true }, run)
    if (route === 'artifact metadata') assert.equal(state.artifacts[0].producer_session, producer)
    if (route === 'review metadata') assert.equal(state.reviews[0].reviewer_session, identity)
    if (route === 'latest review') assert.equal(state.context.latest_review.reviewer_session, identity)
    assert.deepEqual(state.context.latest_review.findings, ['finding\0suffix'])
  })
}

test('SQLite TEXT acceptance rejects a producer whose ordinary owner is only a prefix', async t => {
  const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
  f.store.open().prepare('UPDATE workflow_artifact SET producer_session=? WHERE task_id=?').run(worker.sessionId + '\0suffix', id)
  f.store.submitTask({ task_id: id }, run, worker)
  const before = f.store.open().prepare('SELECT total_changes() AS n').get().n
  assert.throws(() => f.store.acceptTask({ task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version,
    request_key: f.key() }, run, lead), { code: 'E_WORKFLOW_EVIDENCE' })
  assert.equal(f.store.taskOf(id, run).task.status, 'submitted')
  assert.equal(f.store.open().prepare('SELECT total_changes() AS n').get().n, before)
})

for (const exact of [false, true]) {
  test(`SQLite TEXT acceptance uses ${exact ? 'exact' : 'distinct prefix'} reviewer writer history`, async t => {
    const f = fixture(t), id = f.open(); await f.artifact(id)
    const identity = 'auditor\0suffix'
    f.change('recordReview', id, { revision_id: f.flow.state({ task_id: id }, run).revision_id,
      requirements_result: 'pass', quality_result: 'pass', findings: [] }, { sessionId: identity, isRoot: false })
    f.store.open().prepare('INSERT INTO workflow_writer(task_id,run_id,evidence_generation,session_id) VALUES(?,?,?,?)').run(id, run, 0, exact ? identity : 'auditor')
    if (exact) assert.throws(() => f.accept(id), { code: 'E_WORKFLOW_EVIDENCE' })
    else assert.equal(f.accept(id).execution_verified, true)
    assert.equal(f.store.taskOf(id, run).task.status, exact ? 'submitted' : 'accepted')
  })
}

for (const route of ['artifacts', 'reviews', 'latest', 'accept artifact', 'accept review']) {
  test(`SQLite TEXT workflow ${route} rejects corrupt evidence before output or acceptance`, async t => {
    const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
    f.store.submitTask({ task_id: id }, run, worker)
    const version = f.flow.state({ task_id: id }, run).row_version
    const db = f.store.open(), prepare = db.prepare.bind(db), before = db.prepare('SELECT total_changes() AS n').get().n
    let corruptReads = 0, writerLookups = 0, writerGets = 0
    db.prepare = sql => {
      const statement = prepare(sql)
      if (sql === 'SELECT 1 FROM workflow_writer WHERE task_id=? AND session_id=? LIMIT 1') {
        writerLookups++
        const get = statement.get.bind(statement)
        statement.get = (...args) => { writerGets++; return get(...args) }
      }
      const match = route === 'artifacts' ? sql.startsWith('SELECT id AS revision_id,receipt_id,')
        : route === 'reviews' ? sql.startsWith('SELECT id,revision_id,evidence_generation,reviewer_session,')
          : route === 'latest' ? sql.startsWith('SELECT id,revision_id,plan_version,evidence_generation,reviewer_session,')
            : route === 'accept artifact' ? sql.includes("THEN 'J'||json_quote(") && sql.includes('FROM workflow_artifact')
              : sql.includes("THEN 'J'||json_quote(") && sql.includes('FROM workflow_review')
      if (match) {
        const method = ['artifacts', 'reviews'].includes(route) ? 'all' : 'get', read = statement[method].bind(statement)
        const corrupt = row => {
          corruptReads++
          if (route.startsWith('accept')) row[route === 'accept artifact' ? 'producer_session' : 'reviewer_session'] = 'J"private sentinel"'
          else row[route.includes('artifact') ? '__imperator_nul_producer_session' : '__imperator_nul_reviewer_session'] = '"private sentinel"'
          return row
        }
        statement[method] = (...args) => { const result = read(...args); return method === 'all' ? result.map(corrupt) : corrupt(result) }
      }
      return statement
    }
    assert.throws(() => route.startsWith('accept')
      ? f.store.acceptTask({ task_id: id, expected_version: version, request_key: f.key() }, run, lead)
      : f.flow.state({ task_id: id, include_context: true }, run), { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
    assert.equal(corruptReads, 1); assert.equal(writerLookups, 0); assert.equal(writerGets, 0)
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
    assert.equal(db.isTransaction, false)
    assert.equal(f.store.taskOf(id, run).task.status, 'submitted')
  })
}

for (const table of ['workflow_artifact', 'workflow_review']) {
  test(`SQLite TEXT acceptance retains legacy ${table} columns and native integer errors`, async t => {
    const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
    const db = f.store.open(), field = table === 'workflow_artifact' ? 'producer_session' : 'reviewer_session'
    db.exec(`ALTER TABLE ${table} ADD COLUMN __imperator_nul_${field} TEXT; ALTER TABLE ${table} ADD COLUMN "__proto__" TEXT;`
      + ` ALTER TABLE ${table} ADD COLUMN constructor INTEGER; ALTER TABLE ${table} ADD COLUMN "2" TEXT;`
      + ` ALTER TABLE ${table} ADD COLUMN extra_blob BLOB; ALTER TABLE ${table} ADD COLUMN extra_null; ALTER TABLE ${table} ADD COLUMN extra_integer INTEGER`)
    db.prepare(`UPDATE ${table} SET __imperator_nul_${field}=?,"__proto__"=?,constructor=27,"2"=?,extra_blob=?,extra_integer=? WHERE task_id=?`)
      .run('legacy companion', 'prototype data', 'two', new Uint8Array([0,255]), 9007199254740993n, id)
    f.store.submitTask({ task_id: id }, run, worker)
    const args = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
    const before = db.prepare('SELECT total_changes() AS n').get().n
    assert.throws(() => f.store.acceptTask(args, run, lead), { code: 'ERR_OUT_OF_RANGE' })
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
    assert.equal(f.store.taskOf(id, run).task.status, 'submitted')
    db.prepare(`UPDATE ${table} SET extra_integer=42 WHERE task_id=?`).run(id)
    assert.equal(f.store.acceptTask(args, run, lead).execution_verified, true)
  })
}

test('SQLite TEXT acceptance factories prepare metadata without executing either original star', async t => {
  const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
  f.store.submitTask({ task_id: id }, run, worker)
  const version = f.flow.state({ task_id: id }, run).row_version
  const db = f.store.open(), prepare = db.prepare.bind(db), records = []
  db.prepare = sql => {
    const statement = prepare(sql)
    if ((sql.startsWith('SELECT * FROM') || sql.includes("THEN 'J'||json_quote(")) && / FROM workflow_(artifact|review) WHERE/.test(sql)) {
      const record = { table: sql.includes('FROM workflow_artifact') ? 'artifact' : 'review',
        original: sql.startsWith('SELECT *'), get: 0, all: 0, iterate: 0, run: 0 }
      records.push(record)
      for (const method of ['get', 'all', 'iterate', 'run']) {
        const execute = statement[method].bind(statement)
        statement[method] = (...args) => { record[method]++; return execute(...args) }
      }
    }
    return statement
  }
  assert.equal(f.store.acceptTask({ task_id: id, expected_version: version, request_key: f.key() }, run, lead).execution_verified, true)
  assert.deepEqual(records, ['artifact', 'review'].flatMap(table => [
    { table, original: true, get: 0, all: 0, iterate: 0, run: 0 },
    { table, original: false, get: 1, all: 0, iterate: 0, run: 0 },
  ]))
  t.diagnostic('acceptance SQL lifecycle=' + JSON.stringify(records))
})

test('SQLite TEXT workflow history still caps metadata at the twenty newest complete rows', async t => {
  const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
  const db = f.store.open(), producer = 'producer\0suffix', reviewIdentity = 'reviewer\0suffix'
  db.prepare('UPDATE workflow_artifact SET producer_session=? WHERE task_id=?').run(producer, id)
  db.prepare('UPDATE workflow_review SET reviewer_session=? WHERE task_id=?').run(reviewIdentity, id)
  for (let i = 0; i < 20; i++) {
    db.prepare('INSERT INTO workflow_artifact(task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at) SELECT task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at FROM workflow_artifact WHERE task_id=? ORDER BY id LIMIT 1').run(id)
    db.prepare('INSERT INTO workflow_review(task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) SELECT task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at FROM workflow_review WHERE task_id=? ORDER BY id LIMIT 1').run(id)
  }
  const before = db.prepare('SELECT total_changes() AS n').get().n
  const state = f.flow.state({ task_id: id, include_context: true }, run)
  assert.equal(state.history_truncated, true)
  assert.deepEqual(state.artifacts.map(row => row.revision_id), Array.from({ length: 20 }, (_, i) => 21 - i))
  assert.deepEqual(state.reviews.map(row => row.id), Array.from({ length: 20 }, (_, i) => 21 - i))
  assert.ok(state.artifacts.every(row => row.producer_session === producer))
  assert.ok(state.reviews.every(row => row.reviewer_session === reviewIdentity))
  assert.equal(state.context.latest_review.reviewer_session, reviewIdentity)
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
})

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
function terminalRows(f, id) {
  return { task: f.store.open().prepare('SELECT * FROM task WHERE id=?').get(id), ...deliveryRows(f, id),
    ...Object.fromEntries(['fact', 'task_event', 'task_dependency', 'task_dependency_fence', 'workflow_writer']
      .map(table => [table, f.store.open().prepare('SELECT * FROM ' + table + ' WHERE task_id=? ORDER BY rowid').all(id)])) }
}

// Removing the terminal guard must permit these first, correctly versioned
// decisions after normal cancellation; neither test constructs terminal rows.
test('cancelled plan refuses a first approval without writes before and after database reopen', t => {
  const f = fixture(t), id = f.create().task_id
  const args = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
  assert.equal(f.store.closeTask({ task_id: id, result: 'failed' }, run, lead).status, 'cancelled')
  const before = terminalRows(f, id)
  for (const reopen of [false, true]) {
    if (reopen) f.reopen()
    assert.equal(f.flow.state({ task_id: id }, run).task_status, 'cancelled')
    assert.equal(f.flow.ready({}, run).tasks.some(row => row.task_id === id), false)
    assert.throws(() => f.flow.approvePlan(args, run, f.actor), { code: 'E_TERMINAL' })
    assert.deepEqual(terminalRows(f, id), before)
  }
})

test('cancellation committed on another connection refuses the prepared first review without writes', async t => {
  const f = fixture(t), id = f.open(), artifact = await f.artifact(id)
  const peer = new TaskforceStore(f.store.root); t.after(() => peer.close())
  const peerFlow = new module.TaskforceWorkflow(peer)
  const args = { task_id: id, expected_version: peerFlow.state({ task_id: id }, run).row_version, request_key: f.key(),
    revision_id: artifact.revision_id, requirements_result: 'pass', quality_result: 'pass', findings: [] }
  assert.equal(f.store.closeTask({ task_id: id, result: 'failed' }, run, lead).status, 'cancelled')
  const before = terminalRows(f, id)
  assert.equal(peerFlow.state({ task_id: id }, run).row_version, args.expected_version)
  assert.throws(() => peerFlow.recordReview(args, run, reviewer), { code: 'E_TERMINAL' })
  assert.deepEqual(terminalRows({ store: peer }, id), before)
  f.reopen()
  assert.throws(() => f.flow.recordReview({ ...args, request_key: f.key() }, run, reviewer), { code: 'E_TERMINAL' })
  assert.deepEqual(terminalRows(f, id), before)
})

for (const status of ['accepted', 'cancelled', 'done', 'partial', 'failed']) {
  test(status + ' task refuses every new ordinary workflow mutation before version checks', async t => {
    const f = fixture(t), id = f.create().task_id
    if (status === 'accepted') {
      f.change('approvePlan', id); f.claim(id); await f.artifact(id); f.review(id); f.accept(id)
    } else if (status === 'cancelled') {
      f.store.closeTask({ task_id: id, result: 'failed' }, run, lead)
    } else {
      // Persisted compatibility fixture only: today's close(done/partial)
      // submits, and close(failed) cancels; none creates these legacy statuses.
      f.store.open().prepare('UPDATE task SET status=? WHERE id=?').run(status, id)
    }
    f.reopen()
    const state = f.flow.state({ task_id: id }, run), before = terminalRows(f, id)
    assert.equal(state.task_status, status)
    for (const expected_version of [state.row_version, 0]) {
      for (const [method, extra, actor] of [
        ['setDependencies', { prerequisite_task_ids: [] }, f.actor],
        ['approvePlan', {}, f.actor],
        ['recordArtifact', {}, worker],
        ['recordReview', { revision_id: state.revision_id, requirements_result: 'pass', quality_result: 'pass', findings: [] }, reviewer],
      ]) {
        assert.throws(() => f.flow[method]({ task_id: id, expected_version, request_key: f.key(), ...extra }, run, actor),
          { code: 'E_TERMINAL' }, method + ' on ' + status)
        assert.deepEqual(terminalRows(f, id), before)
      }
    }
  })
}

for (const status of ['cancelled', 'accepted']) {
  test('original workflow requests replay read-only after ' + status + ' and database reopen', async t => {
    const f = fixture(t), id = f.create().task_id, requests = []
    const record = (method, extra, actor) => {
      const args = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key(), ...extra }
      const result = f.flow[method](args, run, actor)
      requests.push({ method, args, actor, result })
      return result
    }
    record('setDependencies', { prerequisite_task_ids: [] }, f.actor)
    record('approvePlan', {}, f.actor); f.claim(id); await f.verify(id)
    const artifact = record('recordArtifact', {}, worker)
    record('recordReview', { revision_id: artifact.revision_id, requirements_result: 'pass', quality_result: 'pass', findings: [] }, reviewer)
    let acceptArgs, accepted
    if (status === 'cancelled') f.store.closeTask({ task_id: id, result: 'failed' }, run, lead)
    else {
      f.store.submitTask({ task_id: id }, run, worker)
      acceptArgs = { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() }
      accepted = f.store.acceptTask(acceptArgs, run, lead)
    }
    f.reopen()
    const before = terminalRows(f, id)
    for (const { method, args, actor, result } of requests) {
      assert.deepEqual(f.flow[method](args, run, actor), result)
      assert.throws(() => f.flow[method]({ ...args, request_key: f.key() }, run, actor), { code: 'E_TERMINAL' })
      assert.throws(() => f.flow[method]({ ...args, expected_version: args.expected_version + 1 }, run, actor), { code: 'E_WORKFLOW_REPLAY' })
      assert.deepEqual(terminalRows(f, id), before)
    }
    const review = requests.at(-1)
    assert.throws(() => f.flow.recordReview(review.args, run, { ...reviewer, sessionId: 'other reviewer' }), { code: 'E_WORKFLOW_REPLAY' })
    if (accepted) assert.deepEqual(f.store.acceptTask(acceptArgs, run, lead), accepted)
    assert.deepEqual(terminalRows(f, id), before)
    const returned = f.change('returnForRework', id, { reason: 'explicit terminal reconsideration' })
    assert.equal(returned.reopened, true)
    assert.equal(returned.previous_status, status)
    const reopened = terminalRows(f, id)
    assert.equal(reopened.task.status, 'rejected')
    assert.equal(reopened.task.evidence_generation, 1)
    assert.equal(reopened.workflow[0].rework_count, 1)
    for (const { method, args, actor, result } of requests) assert.deepEqual(f.flow[method](args, run, actor), result)
    if (accepted) assert.deepEqual(f.store.acceptTask(acceptArgs, run, lead), accepted)
    assert.deepEqual(terminalRows(f, id), reopened)
  })
}

test('terminal tasks preserve root role, run and attached-record integrity checks before replay', t => {
  const f = fixture(t), id = f.create().task_id
  const args = { task_id: id, expected_version: 1, request_key: f.key() }
  const approved = f.flow.approvePlan(args, run, f.actor)
  f.store.closeTask({ task_id: id, result: 'failed' }, run, lead)
  const before = terminalRows(f, id)
  assert.throws(() => f.flow.approvePlan(args, run, worker), { code: 'E_WORKFLOW_ROLE' })
  assert.throws(() => f.flow.approvePlan(args, run, { sessionId: 'foreign root', isRoot: true }), { code: 'E_WORKFLOW_ROLE' })
  assert.throws(() => f.flow.approvePlan(args, 'foreign run', { sessionId: 'foreign run', isRoot: true }), { code: 'E_CROSS_RUN' })
  assert.deepEqual(f.flow.approvePlan(args, run, f.actor), approved)
  assert.deepEqual(terminalRows(f, id), before)
  f.store.open().prepare('UPDATE workflow_decision SET run_id=? WHERE task_id=? AND request_key=?').run('private foreign record', id, args.request_key)
  const damaged = terminalRows(f, id)
  for (const request_key of [args.request_key, f.key()]) {
    assert.throws(() => f.flow.approvePlan({ ...args, request_key }, run, f.actor),
      error => error.code === 'E_STORE_INTEGRITY' && !error.message.includes('private foreign record'))
    assert.deepEqual(terminalRows(f, id), damaged)
  }
})

test('explicit root return reopens a cancelled plan for fresh approval and verified acceptance', async t => {
  const f = fixture(t), id = f.create({ max_reworks: 1 }).task_id
  f.store.closeTask({ task_id: id, result: 'failed' }, run, lead)
  f.reopen()
  const before = terminalRows(f, id)
  assert.throws(() => f.change('returnForRework', id, { reason: 'worker cannot reopen' }, worker), { code: 'E_WORKFLOW_ROLE' })
  assert.deepEqual(terminalRows(f, id), before)
  assert.equal(f.change('returnForRework', id, { reason: 'root authorizes another attempt' }).reopened, true)
  const returned = f.flow.state({ task_id: id }, run)
  assert.equal(returned.stage, 'plan')
  assert.equal(returned.evidence_generation, 1)
  assert.equal(returned.rework_count, 1)
  assert.throws(() => f.claim(id), { code: 'E_WORKFLOW_STAGE' })
  f.change('approvePlan', id); f.claim(id); await f.artifact(id); f.review(id)
  assert.equal(f.accept(id).execution_verified, true)
  const accepted = terminalRows(f, id)
  assert.throws(() => f.change('returnForRework', id, { reason: 'budget exhausted' }), { code: 'E_WORKFLOW_BUDGET' })
  assert.deepEqual(terminalRows(f, id), accepted)
})

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
    let receiptReads = 0, originalExecutions = 0, injections = 0
    const generatedCalls = { get: 0, all: 0, iterate: 0, run: 0 }
    // Inject an actual file mutation precisely between the two real strict reads;
    // every statement still executes on the real SQLite connection.
    db.prepare = function(sql) {
      const statement = prepare.call(this, sql)
      if (sql.endsWith(' FROM execution_receipt WHERE task_id = ? AND run_id IS ? ORDER BY id DESC LIMIT 1')) {
        const original = sql.startsWith('SELECT *')
        for (const method of ['get', 'all', 'iterate', 'run']) {
          const read = statement[method].bind(statement)
          statement[method] = (...args) => {
            if (original) originalExecutions++
            else {
              generatedCalls[method]++
              if (method === 'get' && ++receiptReads === 2) { damageEvidence(f, id, damage); injections++ }
            }
            return read(...args)
          }
        }
      }
      return statement
    }
    let response
    try {
      response = await call('task_accept', { task_id: id, expected_version: f.flow.state({ task_id: id }, run).row_version, request_key: f.key() })
    } finally { db.prepare = prepare }
    assert.equal(receiptReads, 2, 'retain both real strict evidence checks')
    assert.equal(originalExecutions, 0); assert.equal(injections, 1)
    assert.deepEqual(generatedCalls, { get: 2, all: 0, iterate: 0, run: 0 })
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

// Dropping include_context, parsing outside the authorized snapshot, coercing
// its Boolean, or weakening any currentness fence must break these assertions.
test('explicit workflow context restores the exact plan and failed findings after reopen without writes', async t => {
  const f = fixture(t)
  const plan = { objective: '保留完整计划 “quoted”\nnext', scope: ['source.js', '边界'], non_goals: ['publish'], deliverables: ['tested \\ source'] }
  const findings = ['缺少边界测试\nsecond line', 'preserve "quotes" and \\ slashes']
  const id = f.open({ plan }), artifact = await f.artifact(id)
  const reviewed = f.change('recordReview', id, { revision_id: artifact.revision_id,
    requirements_result: 'fail', quality_result: 'unverified', findings }, reviewer)
  const compact = f.flow.state({ task_id: id }, run), rows = terminalRows(f, id), executions = f.executions()
  f.reopen()
  const db = f.store.open(), changes = db.prepare('SELECT total_changes() AS n').get().n
  const restored = f.flow.state({ task_id: id, include_context: true }, run)
  assert.deepEqual(restored.context.plan, plan)
  const storedReview = db.prepare('SELECT id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,created_at FROM workflow_review WHERE id=?').get(reviewed.review_id)
  assert.deepEqual(restored.context.latest_review, { ...storedReview, findings, is_current: true })
  const { context, ...metadata } = restored
  assert.deepEqual(metadata, compact)
  assert.deepEqual(f.flow.state({ task_id: id }, run), compact)
  assert.deepEqual(f.flow.state({ task_id: id, include_context: false }, run), compact)
  assert.equal(Object.hasOwn(compact, 'context'), false)
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
  assert.deepEqual(terminalRows(f, id), rows)
  assert.equal(f.executions(), executions)
})

test('explicit workflow context has a null latest review before the first review and remains readable when terminal', t => {
  const f = fixture(t), id = f.create().task_id
  const before = f.flow.state({ task_id: id, include_context: true }, run)
  assert.equal(before.context.latest_review, null)
  f.store.closeTask({ task_id: id, result: 'failed' }, run, lead)
  const db = f.store.open(), changes = db.prepare('SELECT total_changes() AS n').get().n
  const terminal = f.flow.state({ task_id: id, include_context: true }, run)
  assert.equal(terminal.task_status, 'cancelled')
  assert.deepEqual(terminal.context, before.context)
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
})

test('explicit workflow context preserves historical review after real rework and uses the newest review', async t => {
  const f = fixture(t), id = f.open(), artifact = await f.artifact(id)
  const first = f.change('recordReview', id, { revision_id: artifact.revision_id,
    requirements_result: 'fail', quality_result: 'pass', findings: ['fix boundary'] }, reviewer)
  assert.equal(f.flow.state({ task_id: id, include_context: true }, run).context.latest_review.is_current, true)
  f.change('returnForRework', id, { reason: 'fix boundary' })
  f.reopen()
  let context = f.flow.state({ task_id: id, include_context: true }, run).context
  assert.equal(context.latest_review.id, first.review_id)
  assert.equal(context.latest_review.is_current, false)
  assert.deepEqual(context.latest_review.findings, ['fix boundary'])
  f.claim(id); await f.artifact(id)
  assert.equal(f.flow.state({ task_id: id, include_context: true }, run).context.latest_review.is_current, false)
  const second = f.review(id)
  context = f.flow.state({ task_id: id, include_context: true }, run).context
  assert.equal(context.latest_review.id, second.review_id)
  assert.equal(context.latest_review.is_current, true)
  assert.deepEqual(context.latest_review.findings, [])
  f.accept(id)
  assert.equal(f.flow.state({ task_id: id, include_context: true }, run).context.latest_review.is_current, true)
})

for (const fence of ['revision_id', 'plan_version', 'evidence_generation']) {
  test('explicit workflow context currentness independently compares ' + fence, async t => {
    const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
    const db = f.store.open(), table = fence === 'evidence_generation' ? 'task' : 'workflow'
    const column = table === 'task' ? 'id' : 'task_id'
    db.prepare('UPDATE ' + table + ' SET ' + fence + '=' + fence + '+1 WHERE ' + column + '=?').run(id)
    const changes = db.prepare('SELECT total_changes() AS n').get().n
    const state = f.flow.state({ task_id: id, include_context: true }, run)
    assert.equal(state.context.latest_review.is_current, false)
    assert.equal(state.context.latest_review[fence], state[fence] - 1)
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
  })
}

test('workflow context flag is a strict optional Boolean and cannot forge direct API scope', t => {
  const f = fixture(t), id = f.create().task_id, db = f.store.open()
  const changes = db.prepare('SELECT total_changes() AS n').get().n
  for (const include_context of [null, 0, 1, '', 'true', 'false', [], {}]) {
    assert.throws(() => f.flow.state({ task_id: id, include_context }, run), { code: 'E_WORKFLOW_INPUT' })
  }
  assert.deepEqual(f.flow.state({ task_id: id, include_context: undefined }, run), f.flow.state({ task_id: id }, run))
  assert.throws(() => f.flow.state({ task_id: id, include_context: true }, 'foreign'), { code: 'E_CROSS_RUN' })
  assert.throws(() => f.flow.state({ task_id: id, include_context: true, run_id: run, actor: lead }, run), { code: 'E_WORKFLOW_INPUT' })
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
})

for (const table of ['workflow', 'workflow_review', 'workflow_artifact']) {
  test('explicit workflow context refuses mixed-run ' + table + ' without data disclosure', async t => {
    const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
    const db = f.store.open()
    db.prepare('UPDATE ' + table + ' SET run_id=? WHERE task_id=?').run('foreign private sentinel', id)
    const changes = db.prepare('SELECT total_changes() AS n').get().n
    assert.throws(() => f.flow.state({ task_id: id, include_context: true }, run), error => {
      assert.equal(error.code, 'E_STORE_INTEGRITY')
      assert.doesNotMatch(error.message, /foreign|private sentinel/)
      return true
    })
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
  })
}

test('explicit workflow context keeps its authorization and payload in one SQLite snapshot', async t => {
  const f = fixture(t, { journalMode: 'wal' }), id = f.open(); await f.artifact(id); f.review(id)
  const db = f.store.open(), originalPlan = JSON.parse(db.prepare('SELECT plan FROM workflow WHERE task_id=?').get(id).plan)
  const writer = new DatabaseSync(f.store.dbPath); t.after(() => writer.close())
  const prepare = db.prepare.bind(db)
  let fired = false
  db.prepare = sql => {
    const statement = prepare(sql)
    if (sql.endsWith(' FROM workflow WHERE task_id=?') && sql.includes("THEN 'J'||json_quote(")) {
      const get = statement.get.bind(statement)
      statement.get = (...args) => {
        const result = get(...args)
        if (!fired) {
          fired = true
          writer.exec('BEGIN IMMEDIATE')
          writer.prepare('UPDATE task SET run_id=? WHERE id=?').run('foreign', id)
          writer.prepare('UPDATE workflow SET run_id=?,plan=? WHERE task_id=?').run('foreign', '{"secret":"FOREIGN_CONTEXT"}', id)
          writer.prepare('UPDATE workflow_review SET run_id=?,findings=? WHERE task_id=?').run('foreign', '["FOREIGN_FINDINGS"]', id)
          writer.exec('COMMIT')
        }
        return result
      }
    }
    return statement
  }
  t.after(() => { db.prepare = prepare })
  const changes = db.prepare('SELECT total_changes() AS n').get().n
  const state = f.flow.state({ task_id: id, include_context: true }, run)
  assert.equal(fired, true, 'real second connection committed during the authorized read')
  assert.deepEqual(state.context.plan, originalPlan)
  assert.deepEqual(state.context.latest_review.findings, [])
  assert.equal(state.context.latest_review.is_current, true)
  assert.doesNotMatch(JSON.stringify(state), /FOREIGN_CONTEXT|FOREIGN_FINDINGS/)
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
  assert.equal(db.isTransaction, false)
  assert.throws(() => f.flow.state({ task_id: id, include_context: true }, run), { code: 'E_CROSS_RUN' })
})

// Corrupt storage is intentionally seeded only for integrity tests; compact
// reads must not suddenly parse context that was never requested.
for (const part of ['plan', 'findings']) {
  test('explicit workflow context validates stored ' + part + ' shape and its UTF-8 JSON budget generically', async t => {
    const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
    const db = f.store.open(), compact = f.flow.state({ task_id: id }, run)
    const goodPlan = { objective: 'private sentinel', scope: [], non_goals: [], deliverables: [] }
    const invalid = part === 'plan' ? [
      '{private sentinel', 'null', '[]', '"private sentinel"',
      JSON.stringify({ ...goodPlan, extra: 'private sentinel' }),
      JSON.stringify({ ...goodPlan, objective: '' }),
      JSON.stringify({ ...goodPlan, objective: 'x'.repeat(4097) }),
      JSON.stringify({ ...goodPlan, scope: 'private sentinel' }),
      JSON.stringify({ ...goodPlan, scope: [1] }),
      JSON.stringify({ ...goodPlan, scope: ['x'.repeat(513)] }),
      JSON.stringify({ ...goodPlan, scope: Array(65).fill('x') }),
      JSON.stringify({ ...goodPlan, non_goals: [null] }),
      JSON.stringify({ ...goodPlan, deliverables: ['  '] }),
      JSON.stringify({ objective: '界'.repeat(4096), scope: ['界'.repeat(512), '界'.repeat(512), '界'.repeat(512)], non_goals: [], deliverables: [] }),
      JSON.stringify(goodPlan) + ' '.repeat(16384),
    ] : [
      '[private sentinel', 'null', '{}', '"private sentinel"', '[1]', '[null]', '[""]', '["  "]',
      JSON.stringify(['x'.repeat(1025)]), JSON.stringify(Array(65).fill('x')),
      JSON.stringify(Array(6).fill('界'.repeat(1024))), JSON.stringify(['private sentinel']) + ' '.repeat(16384),
    ]
    const table = part === 'plan' ? 'workflow' : 'workflow_review'
    for (const encoded of invalid) {
      db.prepare('UPDATE ' + table + ' SET ' + part + '=? WHERE task_id=?').run(encoded, id)
      const changes = db.prepare('SELECT total_changes() AS n').get().n
      assert.deepEqual(f.flow.state({ task_id: id }, run), compact)
      assert.deepEqual(f.flow.state({ task_id: id, include_context: false }, run), compact)
      assert.throws(() => f.flow.state({ task_id: id, include_context: true }, run), error => {
        assert.equal(error.code, 'E_STORE_INTEGRITY')
        assert.equal(error.message, 'workflow context storage is invalid')
        return true
      })
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
      assert.equal(db.isTransaction, false)
    }
  })
}

function fullContextPayload(escaped) {
  const chunk = escaped ? '\u0000' : '界'
  const factor = escaped ? 2 : 1
  const plan = { objective: chunk.repeat(4096 / factor), scope: [chunk.repeat(512 / factor), chunk.repeat(512 / factor), 'x'.repeat(512)], non_goals: [], deliverables: [] }
  plan.scope.push('x'.repeat(16384 - Buffer.byteLength(JSON.stringify(plan)) - 3))
  const findings = Array(5).fill(chunk.repeat(1024 / factor))
  findings.push('x'.repeat(16384 - Buffer.byteLength(JSON.stringify(findings)) - 3))
  assert.equal(Buffer.byteLength(JSON.stringify(plan)), 16384)
  assert.equal(Buffer.byteLength(JSON.stringify(findings)), 16384)
  return { plan, findings }
}

for (const escaped of [false, true]) {
  test('explicit workflow context prunes whole oldest metadata within the real tool byte budget: ' + (escaped ? 'JSON escapes' : 'Unicode'), async t => {
    const f = fixture(t), { plan, findings } = fullContextPayload(escaped), id = f.open({ plan })
    const artifact = await f.artifact(id)
    f.change('recordReview', id, { revision_id: artifact.revision_id, requirements_result: 'fail', quality_result: 'fail', findings }, reviewer)
    const db = f.store.open()
    // Simulate bounded history from earlier writers. Every string is within
    // existing writer String.length limits, even when its JSON expands 6x.
    const producer = 'p' + '\u0000'.repeat(199), reviewerId = 'r' + '\u0000'.repeat(199)
    db.prepare('UPDATE workflow_artifact SET producer_session=? WHERE task_id=?').run(producer, id)
    db.prepare('UPDATE workflow_review SET reviewer_session=? WHERE task_id=?').run(reviewerId, id)
    for (let index = 1; index < 20; index++) {
      const at = '2026-10-11T00:00:' + String(index).padStart(2, '0') + '.000Z'
      db.prepare('INSERT INTO workflow_artifact(task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at) SELECT task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,? FROM workflow_artifact WHERE id=?').run(at, artifact.revision_id)
      db.prepare('INSERT INTO workflow_review(task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) SELECT task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,? FROM workflow_review WHERE task_id=? ORDER BY id LIMIT 1').run(at, id)
    }
    const compact = f.flow.state({ task_id: id }, run)
    assert.equal(compact.history_truncated, false)
    const changes = db.prepare('SELECT total_changes() AS n').get().n
    const state = f.flow.state({ task_id: id, include_context: true }, run)
    const bytes = Buffer.byteLength(JSON.stringify({ ok: true, ...state }))
    assert.ok(bytes <= 65536, 'actual success envelope must fit: ' + bytes)
    assert.equal(state.history_truncated, true)
    assert.deepEqual(state.context.plan, plan)
    assert.deepEqual(state.context.latest_review.findings, findings)
    assert.equal(state.context.latest_review.id, compact.reviews[0].id)
    assert.ok(state.artifacts.length + state.reviews.length < 40)
    assert.deepEqual(state.artifacts, compact.artifacts.slice(0, state.artifacts.length))
    assert.deepEqual(state.reviews, compact.reviews.slice(0, state.reviews.length))
    const removed = [...compact.artifacts.slice(state.artifacts.length), ...compact.reviews.slice(state.reviews.length)]
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, ...state, artifacts: [...state.artifacts, removed[0]] })) > 65536,
      'pruning stops at the first whole-item boundary that fits')
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
    t.diagnostic('full context bytes=' + bytes + ', artifacts=' + state.artifacts.length + ', reviews=' + state.reviews.length)
  })
}

test('explicit workflow context fails closed when essential metadata alone cannot fit the response', async t => {
  const f = fixture(t), id = f.open(); await f.artifact(id); f.review(id)
  const db = f.store.open()
  db.prepare('UPDATE workflow_review SET reviewer_session=? WHERE task_id=?').run('private sentinel'.repeat(5000), id)
  const changes = db.prepare('SELECT total_changes() AS n').get().n
  assert.throws(() => f.flow.state({ task_id: id, include_context: true }, run), error => {
    assert.equal(error.code, 'E_STORE_INTEGRITY')
    assert.doesNotMatch(error.message, /private sentinel/)
    return true
  })
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
})
