import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { TaskforceStore, STORE_CODES } from '../../lib/store/index.js'
import { apply as applyTools } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'

const root = (id) => ({ options: {}, session: { header: { id } } })
const child = (id, parent = 'run-a', depth = 1) => ({ options: {}, session: { header: {
  id, parentSession: parent, origin: 'subagent', delegationDepth: depth,
} } })
const lead = root('run-a')
const worker = child('real-worker')
const sibling = child('sibling')
const replacement = child('replacement')
const grandchild = child('grandchild', 'real-worker', 2)
const foreign = child('foreign', 'run-b')
function caller(store, agents = [lead, worker, sibling, replacement, grandchild, foreign, root('run-b')]) {
  const definitions = []
  const byId = new Map(agents.map(agent => [agent.session.header.id, agent]))
  applyTools({ logger: { warn() {} }, get(name) {
    if (name === 'taskforceStore') return store
    if (name === 'agents') return { get: id => byId.get(id) }
  }, tools: { register: definition => definitions.push(definition) } })
  return async (name, args, agent = lead) => JSON.parse(await definitions.find(d => d.name === name).execute(args, { agent }))
}
const snapshot = (store, id) => ({ task: store.taskOf(id, 'run-a').task,
  facts: store.handle.prepare('SELECT * FROM fact WHERE task_id = ? ORDER BY id').all(id),
  handoffs: store.handle.prepare('SELECT * FROM handoff WHERE task_id = ? ORDER BY id').all(id) })
const task = store => store.openTask({ title: 'session ownership' }, 'run-a').task_id

for (const action of ['task_submit', 'task_close']) {
  test(`real owner with a display label can ${action}; sibling cannot claim or act using the same label`, async t => {
    const store = tempStore(t), call = caller(store), id = task(store)
    const claimed = await call('task_claim', { task_id: id, child_id: 'worker-label', owner_session: 'sibling' }, worker)
    assert.equal(claimed.owner_session, 'real-worker')
    assert.equal(store.taskOf(id, 'run-a').task.owner_session, 'real-worker')
    const before = snapshot(store, id)
    assert.equal((await call('task_claim', { task_id: id, child_id: 'worker-label' }, sibling)).code, STORE_CODES.conflict)
    const args = { task_id: id, note: 'completed', ...(action === 'task_close' ? { result: 'failed' } : {}) }
    assert.equal((await call(action, args, sibling)).code, STORE_CODES.conflict)
    assert.deepEqual(snapshot(store, id), before)
    assert.equal((await call(action, args, worker)).ok, true)
    assert.equal(snapshot(store, id).facts.at(-1).actor_session, 'real-worker')
    if (action === 'task_submit') {
      assert.equal((await call(action, args, sibling)).code, STORE_CODES.conflict, 'idempotence does not grant non-owner authority')
      assert.equal((await call(action, args, worker)).already, true)
    }
  })
}

test('fact collaboration is allowed but forged display authors cannot replace host audit identity', async t => {
  const store = tempStore(t), call = caller(store), id = task(store)
  await call('task_claim', { task_id: id, child_id: 'worker-label' }, worker)
  for (const [agent, expected] of [[sibling, 'sibling'], [lead, 'run-a']]) {
    const result = await call('task_fact', { task_id: id, kind: 'fact', statement: 'evidence', child_id: 'forged', actor_session: 'forged' }, agent)
    assert.equal(result.ok, true)
    const fact = store.handle.prepare('SELECT * FROM fact WHERE id = ?').get(result.fact_id)
    assert.equal(fact.actor_session, expected)
    assert.equal(fact.created_by, agent === lead ? 'lead' : expected)
    assert.equal(store.board(id, 'run-a').facts.find(f => f.id === fact.id).actor_session, expected)
  }
})

test('lead resolves descendant targets, rebinds only rejected tasks and audits every lead action', async t => {
  const store = tempStore(t), call = caller(store), id = task(store)
  assert.equal((await call('task_claim', { task_id: id, child_id: 'real-worker' })).owner_session, 'real-worker')
  const before = snapshot(store, id)
  assert.equal((await call('task_claim', { task_id: id, child_id: 'grandchild' })).code, STORE_CODES.conflict)
  assert.deepEqual(snapshot(store, id), before)
  await call('task_submit', { task_id: id, note: 'lead submits' })
  await call('task_reject', { task_id: id, reason: 'reassign' })
  const reassigned = await call('task_claim', { task_id: id, child_id: 'grandchild' })
  assert.equal(reassigned.owner_session, 'grandchild')
  assert.equal(reassigned.reassigned, true)
  const rebound = snapshot(store, id)
  assert.equal(rebound.handoffs.length, 1)
  for (const name of ['task_submit', 'task_close']) {
    assert.equal((await call(name, { task_id: id, result: 'failed' }, worker)).code, STORE_CODES.conflict)
  }
  assert.deepEqual(snapshot(store, id), rebound)
  await call('task_submit', { task_id: id, note: 'ready' })
  assert.equal((await call('task_accept', { task_id: id, waiver_reason: 'manual' })).ok, true)
  assert(snapshot(store, id).facts.every(fact => fact.actor_session === 'run-a'))
})

test('lead cannot bind a cross-run target or an unverifiable descendant', async t => {
  const store = tempStore(t), call = caller(store, [lead, foreign, root('run-b'), child('broken', 'missing', 2)])
  const id = task(store), before = snapshot(store, id)
  assert.equal((await call('task_claim', { task_id: id, child_id: 'foreign' })).code, STORE_CODES.crossRun)
  assert.equal((await call('task_claim', { task_id: id, child_id: 'broken' })).ok, false)
  assert.deepEqual(snapshot(store, id), before)
})

test('label-only preassignment remains unbound until that worker claims it', async t => {
  const store = tempStore(t), call = caller(store), id = task(store)
  const assigned = await call('task_claim', { task_id: id, child_id: 'worker-label' })
  assert.equal(assigned.owner_session, null)
  assert(assigned.warnings.some(w => /未绑定/.test(w)))
  const claimed = await call('task_claim', { task_id: id, child_id: 'worker-label' }, worker)
  assert.equal(claimed.owner_session, 'real-worker')
  assert.equal((await call('task_close', { task_id: id, result: 'failed' }, worker)).ok, true)
})

test('legacy unbound submission warns, while old label-based cancellation remains unchanged', t => {
  const store = tempStore(t), id = task(store)
  store.claimTask({ task_id: id, child_id: 'legacy-label' }, 'run-a')
  const submitted = store.submitTask({ task_id: id }, 'run-a', 'sibling', 'sibling')
  assert(submitted.warnings.some(w => /未绑定/.test(w)))
  assert.throws(() => store.closeTask({ task_id: id, result: 'failed' }, 'run-a', 'sibling', 'sibling'), { code: STORE_CODES.conflict })
  assert.equal(store.closeTask({ task_id: id, result: 'failed' }, 'run-a', 'legacy-label', 'legacy-label').status, 'cancelled')
})

test('additive migration preserves historical rows and leaves identities NULL without guessing labels', t => {
  const dir = mkdtempSync(join(tmpdir(), 'taskforce-owner-migration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new DatabaseSync(join(dir, 'taskforce.db'))
  db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT, status TEXT NOT NULL, owner TEXT, run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE fact (id INTEGER PRIMARY KEY, task_id INTEGER, kind TEXT NOT NULL, statement TEXT NOT NULL, evidence_path TEXT, evidence_line INTEGER, confidence TEXT NOT NULL, created_by TEXT, run_id TEXT, resolves_fact_id INTEGER, created_at TEXT NOT NULL);
    INSERT INTO task VALUES (41, 'old', NULL, 'claimed', 'real-worker', 'run-a', 'old-time', 'old-time');
    INSERT INTO fact VALUES (42, 41, 'fact', 'old evidence', NULL, NULL, 'PLAUSIBLE', 'real-worker', 'run-a', NULL, 'old-time');`)
  const oldTask = db.prepare('SELECT * FROM task').get(), oldFact = db.prepare('SELECT * FROM fact').get()
  db.close()
  const store = new TaskforceStore(dir)
  t.after(() => store.close())
  store.taskOf(41, 'run-a') // lazy connection performs migration before reading physical rows
  assert.deepEqual({ ...store.handle.prepare('SELECT * FROM task').get() }, { ...oldTask, owner_session: null })
  assert.deepEqual({ ...store.handle.prepare('SELECT * FROM fact').get() }, { ...oldFact, actor_session: null })
})

test('failed reassignment audit rolls back the real binding and all rows together', t => {
  const store = tempStore(t), id = task(store)
  store.claimTask({ task_id: id, child_id: 'same-label' }, 'run-a', 'real-worker', 'real-worker')
  store.submitTask({ task_id: id }, 'run-a', 'real-worker', 'real-worker')
  store.rejectTask({ task_id: id, reason: 'new owner' }, 'run-a', 'lead', 'run-a')
  const before = snapshot(store, id)
  for (const table of ['fact', 'handoff']) {
    store.handle.exec(`CREATE TEMP TRIGGER fail_owner_audit BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'owner audit failed'); END`)
    assert.throws(() => store.claimTask({ task_id: id, child_id: 'same-label' }, 'run-a', 'lead', 'replacement'), /owner audit failed/)
    assert.deepEqual(snapshot(store, id), before)
    store.handle.exec('DROP TRIGGER fail_owner_audit')
  }
  assert.equal(store.claimTask({ task_id: id, child_id: 'same-label' }, 'run-a', 'lead', 'replacement').owner_session, 'replacement')
  assert.throws(() => store.submitTask({ task_id: id }, 'run-a', 'real-worker', 'real-worker'), { code: STORE_CODES.conflict })
})

test('bound state errors stay ahead of ownership conflicts and late blockers retain the collaborator audit', async t => {
  const store = tempStore(t), call = caller(store), id = task(store)
  await call('task_claim', { task_id: id, child_id: 'worker-label' }, worker)
  await call('task_submit', { task_id: id }, worker)
  await call('task_reject', { task_id: id, reason: 'redo' })
  assert.equal((await call('task_submit', { task_id: id }, sibling)).code, STORE_CODES.status)
  await call('task_claim', { task_id: id, child_id: 'worker-label' }, worker)
  await call('task_close', { task_id: id, result: 'failed' }, worker)
  for (const name of ['task_submit', 'task_claim', 'task_close']) {
    const result = await call(name, { task_id: id, child_id: 'worker-label', result: 'failed' }, sibling)
    assert.equal(result.code, STORE_CODES.terminal)
  }
  const late = await call('task_fact', { task_id: id, kind: 'blocker', statement: 'late issue', child_id: 'forged' }, sibling)
  assert.equal(late.late, true)
  assert.equal(store.board({}, 'run-a').late_blockers[0].blockers[0].actor_session, 'sibling')
  assert.equal(store.taskOf(id, 'run-a').task.status, 'cancelled')
})
