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
  assert.deepEqual({ ...store.handle.prepare('SELECT * FROM task').get() }, { ...oldTask, owner_session: null, evidence_policy: 'legacy', verification_files: null, verification_command: null, verification_cwd: null, evidence_generation: 0 })
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

test('root real-session preassignment permits the actual worker nickname retry while preserving the original display label', async t => {
  const store = tempStore(t), call = caller(store), id = task(store)
  const assigned = await call('task_claim', { task_id: id, child_id: 'real-worker' })
  assert.equal(assigned.owner_session, 'real-worker')
  store.handle.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', id)
  const before = snapshot(store, id)
  const retry = await call('task_claim', { task_id: id, child_id: 'worker-label' }, worker)
  assert.equal(retry.ok, true, 'a nickname cannot revoke the real owner authority')
  assert.equal(retry.already, true)
  assert.equal(retry.owner, 'real-worker', 'idempotent claim retains the existing display label')
  assert.equal(retry.owner_session, 'real-worker')
  const after = snapshot(store, id)
  const { updated_at: beforeTime, ...beforeTask } = before.task
  const { updated_at: afterTime, ...afterTask } = after.task
  assert.notEqual(afterTime, beforeTime)
  assert.equal(retry.claimed_at, afterTime)
  assert.deepEqual(afterTask, beforeTask)
  assert.deepEqual(after.facts, before.facts)
  assert.deepEqual(after.handoffs, before.handoffs)
  assert.equal((await call('task_claim', { task_id: id, child_id: 'worker-label' }, sibling)).code, STORE_CODES.conflict)
  assert.deepEqual(snapshot(store, id), after, 'same nickname does not authorize a different real session')
})

test('host claim cannot rebind a claimed task to a different session under the same display label', t => {
  const store = tempStore(t), id = task(store)
  store.claimTask({ task_id: id, child_id: 'worker-label' }, 'run-a', 'real-worker', 'real-worker')
  const before = snapshot(store, id)
  for (const actor of ['sibling', 'lead']) {
    assert.throws(() => store.claimTask({ task_id: id, child_id: 'worker-label' }, 'run-a', actor, 'replacement'), { code: STORE_CODES.conflict })
    assert.deepEqual(snapshot(store, id), before)
  }
  store.submitTask({ task_id: id }, 'run-a', 'real-worker', 'real-worker')
  store.rejectTask({ task_id: id, reason: 'replacement required' }, 'run-a', 'lead', 'run-a')
  const reassigned = store.claimTask({ task_id: id, child_id: 'worker-label' }, 'run-a', 'lead', 'replacement')
  assert.equal(reassigned.reassigned, true)
  assert.equal(reassigned.owner_session, 'replacement')
  assert.equal(snapshot(store, id).handoffs.length, 1)
})

test('legacy unbound tasks still reject a nickname change as a label-based owner conflict', async t => {
  const store = tempStore(t), call = caller(store), id = task(store)
  store.claimTask({ task_id: id, child_id: 'legacy-label' }, 'run-a')
  const before = snapshot(store, id)
  assert.equal((await call('task_claim', { task_id: id, child_id: 'worker-label' }, worker)).code, STORE_CODES.conflict)
  assert.deepEqual(snapshot(store, id), before)
})

test('structured child lead has owner rights without gaining root permissions, including legacy cancellation', t => {
  const store = tempStore(t), special = { sessionId: 'lead', isRoot: false }, rootActor = { sessionId: 'run-a', isRoot: true }
  const own = task(store)
  assert.equal(store.claimTask({ task_id: own, child_id: 'nickname' }, 'run-a', special, 'lead').owner_session, 'lead')
  assert.doesNotThrow(() => store.recordFact({ task_id: own, statement: 'own evidence', child_id: 'forged' }, 'run-a', special), 'valid structured child identity must support audited facts')
  assert.equal(store.submitTask({ task_id: own, note: 'own submission' }, 'run-a', special).status, 'submitted')
  assert(snapshot(store, own).facts.every(f => f.actor_session === 'lead' && f.created_by === 'lead'))
  assert.throws(() => store.acceptTask({ task_id: own }, 'run-a', special), { code: STORE_CODES.notLead })
  assert.throws(() => store.rejectTask({ task_id: own, reason: 'not root' }, 'run-a', special), { code: STORE_CODES.notLead })
  assert.equal(store.closeTask({ task_id: own, result: 'failed', note: 'own cancellation' }, 'run-a', special).status, 'cancelled')
  assert.equal(snapshot(store, own).facts.at(-1).actor_session, 'lead')
  const other = task(store)
  store.claimTask({ task_id: other, child_id: 'sibling-label' }, 'run-a', 'sibling', 'sibling')
  assert.throws(() => store.submitTask({ task_id: other }, 'run-a', special), { code: STORE_CODES.conflict })
  assert.throws(() => store.closeTask({ task_id: other, result: 'failed' }, 'run-a', special), { code: STORE_CODES.conflict })
  store.submitTask({ task_id: other }, 'run-a', 'sibling', 'sibling')
  store.rejectTask({ task_id: other, reason: 'redo' }, 'run-a', rootActor)
  const before = snapshot(store, other)
  assert.throws(() => store.claimTask({ task_id: other, child_id: 'nickname' }, 'run-a', special, 'lead'), { code: STORE_CODES.conflict })
  assert.deepEqual(snapshot(store, other), before)
  const legacy = task(store)
  store.claimTask({ task_id: legacy, child_id: 'sibling-label' }, 'run-a')
  assert.throws(() => store.closeTask({ task_id: legacy, result: 'failed' }, 'run-a', special), { code: STORE_CODES.conflict })
})

test('structured root audits use its actual session and ignore appended identity overrides', t => {
  const store = tempStore(t), actor = { sessionId: 'run-a', isRoot: true }, id = task(store)
  store.claimTask({ task_id: id, child_id: 'old' }, 'run-a', 'worker', 'worker')
  assert.doesNotThrow(() => store.recordFact({ task_id: id, statement: 'root evidence', created_by: 'forged' }, 'run-a', actor, 'forged-session'), 'valid structured root identity must support audited facts')
  store.submitTask({ task_id: id, note: 'root submission' }, 'run-a', actor, 'forged-session')
  store.rejectTask({ task_id: id, reason: 'redo' }, 'run-a', actor, 'forged-session')
  assert.equal(store.claimTask({ task_id: id, child_id: 'new' }, 'run-a', actor, 'replacement').reassigned, true)
  store.submitTask({ task_id: id, note: 'ready' }, 'run-a', actor)
  store.acceptTask({ task_id: id }, 'run-a', actor)
  assert(snapshot(store, id).facts.every(f => f.actor_session === 'run-a' && f.created_by === 'lead'))
  const legalRoot = { sessionId: 'lead', isRoot: true }, rootTask = store.openTask('root named lead', 'lead').task_id
  store.recordFact({ task_id: rootTask, statement: 'evidence' }, 'lead', legalRoot)
  store.submitTask({ task_id: rootTask, note: 'root submits' }, 'lead', legalRoot)
  assert.equal(store.acceptTask({ task_id: rootTask }, 'lead', legalRoot).status, 'accepted')
  assert(store.board(rootTask, 'lead').facts.every(f => f.actor_session === 'lead'))
})

for (const actor of [{ sessionId: 'lead' }, { sessionId: 'lead', isRoot: 'true' }, { isRoot: true }]) {
  test(`invalid structured role ${JSON.stringify(actor)} cannot authorize any mutation`, t => {
    const store = tempStore(t), id = task(store), before = snapshot(store, id)
    for (const action of [
      () => store.claimTask({ task_id: id, child_id: 'nickname' }, 'run-a', actor, 'lead'),
      () => store.recordFact({ task_id: id, statement: 'forged' }, 'run-a', actor),
      () => store.submitTask({ task_id: id }, 'run-a', actor),
      () => store.closeTask({ task_id: id, result: 'failed' }, 'run-a', actor),
      () => store.acceptTask({ task_id: id }, 'run-a', actor),
      () => store.rejectTask({ task_id: id, reason: 'forged' }, 'run-a', actor),
    ]) {
      assert.throws(action)
      assert.deepEqual(snapshot(store, id), before)
    }
  })
}

test('legacy positional host lead remains privileged and omitted actor audit identity stays NULL', t => {
  const store = tempStore(t), id = task(store)
  store.claimTask({ task_id: id, child_id: 'sibling-label' }, 'run-a', 'sibling', 'sibling')
  store.recordFact({ task_id: id, statement: 'legacy positional fact' }, 'run-a', 'sibling')
  assert.equal(snapshot(store, id).facts.at(-1).actor_session, null)
  assert.equal(store.submitTask({ task_id: id, note: 'host override' }, 'run-a', 'lead').status, 'submitted')
  assert.equal(store.acceptTask({ task_id: id }, 'run-a', 'lead').status, 'accepted')
  assert.equal(snapshot(store, id).facts.at(-1).actor_session, null)
})

test('legacy unbound label cancellation accepts its old caller slot and records the appended real audit session', t => {
  const store = tempStore(t), id = task(store)
  store.claimTask({ task_id: id, child_id: 'legacy-label' }, 'run-a')
  assert.equal(store.closeTask({ task_id: id, result: 'failed', note: 'legacy caller' }, 'run-a', 'legacy-label', 'real-session').status, 'cancelled')
  assert.equal(snapshot(store, id).facts.at(-1).created_by, 'legacy-label')
  assert.equal(snapshot(store, id).facts.at(-1).actor_session, 'real-session')
})

test('legacy padded lead caller cannot submit a sibling bound task or obtain root mutation roles', t => {
  const store = tempStore(t), id = task(store)
  store.claimTask({ task_id: id, child_id: 'sibling-label' }, 'run-a', 'sibling', 'sibling')
  const before = snapshot(store, id)
  assert.throws(() => store.submitTask({ task_id: id }, 'run-a', ' lead ', 'other-worker'), { code: STORE_CODES.conflict })
  assert.throws(() => store.closeTask({ task_id: id, result: 'failed' }, 'run-a', ' lead ', 'other-worker'), { code: STORE_CODES.conflict })
  assert.deepEqual(snapshot(store, id), before)
  store.submitTask({ task_id: id }, 'run-a', 'sibling', 'sibling')
  assert.throws(() => store.acceptTask({ task_id: id, waiver_reason: 'not root' }, 'run-a', ' lead '), { code: STORE_CODES.notLead })
  assert.throws(() => store.rejectTask({ task_id: id, reason: 'not root' }, 'run-a', ' lead '), { code: STORE_CODES.notLead })
  store.rejectTask({ task_id: id, reason: 'root rejects' }, 'run-a', 'lead')
  const rejected = snapshot(store, id)
  assert.throws(() => store.claimTask({ task_id: id, child_id: 'replacement' }, 'run-a', ' lead ', 'other-worker'), { code: STORE_CODES.conflict })
  assert.deepEqual(snapshot(store, id), rejected)
})

for (const callerId of [' ', '', ' sibling-label ']) {
  test(`legacy explicit caller ${JSON.stringify(callerId)} cannot use omitted-host bypass or normalized owner matching`, t => {
    const store = tempStore(t), id = task(store)
    store.claimTask({ task_id: id, child_id: 'sibling-label' }, 'run-a')
    const before = snapshot(store, id)
    assert.throws(() => store.closeTask({ task_id: id, result: 'failed' }, 'run-a', callerId), { code: STORE_CODES.conflict })
    assert.deepEqual(snapshot(store, id), before)
  })
}

test('legacy bound caller and appended authority session retain exact comparisons while audit formatting stays normalized', t => {
  const store = tempStore(t), id = task(store)
  store.claimTask({ task_id: id, child_id: 'sibling-label' }, 'run-a', 'sibling', 'sibling')
  const before = snapshot(store, id)
  for (const [callerId, actorSessionId] of [[' sibling ', undefined], ['other-worker', ' sibling ']]) {
    assert.throws(() => store.submitTask({ task_id: id }, 'run-a', callerId, actorSessionId), { code: STORE_CODES.conflict })
    assert.deepEqual(snapshot(store, id), before)
  }
  const fact = store.recordFact({ task_id: id, statement: 'audit formatting' }, 'run-a', ' sibling ', ' audit-session ')
  const row = store.handle.prepare('SELECT * FROM fact WHERE id = ?').get(fact.fact_id)
  assert.equal(row.created_by, 'sibling')
  assert.equal(row.actor_session, 'audit-session')
  assert.equal(store.submitTask({ task_id: id }, 'run-a', 'lead', ' actual-root ').status, 'submitted')
})

test('only genuinely omitted or null legacy callers keep the unbound host cancellation bypass', t => {
  const store = tempStore(t)
  for (const callerId of [undefined, null]) {
    const id = task(store)
    store.claimTask({ task_id: id, child_id: 'sibling-label' }, 'run-a')
    assert.equal(store.closeTask({ task_id: id, result: 'failed' }, 'run-a', callerId).status, 'cancelled')
  }
})

test('direct host exact nonblank run keys remain distinct, blanks keep unassigned and full key length is bounded', t => {
  const store = tempStore(t)
  const id = store.openTask('exact padded run', ' root ').task_id
  assert.equal(store.taskOf(id, ' root ').task.run_id, ' root ')
  assert.equal(store.board({}, 'root').tasks.length, 0)
  assert.throws(() => store.taskOf(id, 'root'), { code: STORE_CODES.crossRun })
  for (const run of [undefined, null, '', ' ']) {
    assert.equal(store.openTask('unassigned', run).run_id, null)
  }
  const maximum = ` ${'r'.repeat(198)} `
  assert.equal(store.openTask('maximum exact key', maximum).run_id, maximum)
  assert.throws(() => store.openTask('overlong exact key', ` ${'r'.repeat(199)} `), /run_id 过长/)
})
