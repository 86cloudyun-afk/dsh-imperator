import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskforceStore, STORE_CODES } from '../../lib/store/index.js'
import { apply as applyTools } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'

function rejected(store) {
  const id = store.openTask({ title: '重新复核' }, 'run-a').task_id
  store.claimTask({ task_id: id, child_id: 'old-child' }, 'run-a')
  store.submitTask({ task_id: id }, 'run-a')
  store.rejectTask({ task_id: id, reason: '原执行者不可用' }, 'run-a', 'lead')
  return id
}
const snapshot = (store, id) => ({
  task: store.taskOf(id, 'run-a').task,
  facts: store.handle.prepare('SELECT * FROM fact WHERE task_id = ? ORDER BY id').all(id),
  handoffs: store.handle.prepare('SELECT * FROM handoff WHERE task_id = ? ORDER BY id').all(id),
})

test('lead can reassign a rejected task after database restart with an atomic audit', (t) => {
  const original = tempStore(t)
  const id = rejected(original)
  original.close()
  const store = new TaskforceStore(original.root)
  t.after(() => store.close())
  const claimed = store.claimTask({ task_id: id, child_id: 'new-child' }, 'run-a', 'lead')
  assert.equal(claimed.owner, 'new-child')
  assert.equal(claimed.status, 'claimed')
  const board = store.board({ task_id: id }, 'run-a')
  assert.equal(board.handoffs.length, 1)
  assert.equal(board.handoffs[0].from_child, 'old-child')
  assert.equal(board.handoffs[0].to_child, 'new-child')
  assert.ok(board.facts.some(fact => fact.kind === 'decision' && fact.by === 'lead'
    && fact.statement.includes('old-child') && fact.statement.includes('new-child')))
  const before = snapshot(store, id)
  assert.equal(store.claimTask({ task_id: id, child_id: 'new-child' }, 'run-a', 'lead').already, true)
  // Repeat claims may update timestamps; no second audit is written.
  assert.deepEqual(snapshot(store, id).facts, before.facts)
  assert.deepEqual(snapshot(store, id).handoffs, before.handoffs)
})

test('ordinary claim, model-supplied actor and wrong trusted actor cannot change an owner', (t) => {
  const store = tempStore(t)
  const id = rejected(store)
  const before = snapshot(store, id)
  for (const actor of [undefined, 'child', 'admin']) {
    assert.throws(() => store.claimTask({ task_id: id, child_id: 'new-child', actor: 'lead' }, 'run-a', actor),
      { code: STORE_CODES.conflict })
    assert.deepEqual(snapshot(store, id), before)
  }
  assert.equal(store.claimTask({ task_id: id, child_id: 'old-child' }, 'run-a').owner, 'old-child')
})

for (const status of ['claimed', 'submitted', 'accepted', 'cancelled']) {
  test(`lead cannot steal an owner while status is ${status}`, (t) => {
    const store = tempStore(t)
    const id = store.openTask({ title: status }, 'run-a').task_id
    store.claimTask({ task_id: id, child_id: 'old-child' }, 'run-a')
    if (status === 'submitted' || status === 'accepted') store.submitTask({ task_id: id }, 'run-a')
    if (status === 'accepted') store.acceptTask({ task_id: id, waiver_reason: '人工复核' }, 'run-a', 'lead')
    if (status === 'cancelled') store.closeTask({ task_id: id, result: 'failed' }, 'run-a')
    const before = snapshot(store, id)
    assert.throws(() => store.claimTask({ task_id: id, child_id: 'new-child' }, 'run-a', 'lead'),
      { code: ['accepted', 'cancelled'].includes(status) ? STORE_CODES.terminal : STORE_CODES.conflict })
    assert.deepEqual(snapshot(store, id), before)
  })
}

test('cross-run and audit failures leave the owner, timestamp and all audit rows unchanged', (t) => {
  const store = tempStore(t)
  const id = rejected(store)
  const before = snapshot(store, id)
  assert.throws(() => store.claimTask({ task_id: id, child_id: 'new-child' }, 'run-b', 'lead'), { code: STORE_CODES.crossRun })
  for (const table of ['fact', 'handoff']) {
    store.handle.exec(`CREATE TEMP TRIGGER fail_reassign BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'reassignment audit failure'); END`)
    assert.throws(() => store.claimTask({ task_id: id, child_id: 'new-child' }, 'run-a', 'lead'), /reassignment audit failure/)
    assert.deepEqual(snapshot(store, id), before)
    store.handle.exec('DROP TRIGGER fail_reassign')
  }
  assert.equal(store.claimTask({ task_id: id, child_id: 'new-child' }, 'run-a', 'lead').status, 'claimed')
})

test('task_claim derives reassignment authority from the real caller, ignoring actor arguments', async (t) => {
  const store = tempStore(t)
  const id = rejected(store)
  const definitions = []
  const lead = { id: 'run-a', options: {}, session: { header: { id: 'run-a' } } }
  const child = { id: 'child-a', options: {}, session: { header: { id: 'child-a', origin: 'subagent',
    delegationDepth: 1, parentSession: 'run-a' } } }
  applyTools({ logger: { warn() {} }, get(name) {
    if (name === 'taskforceStore') return store
    if (name === 'agents') return { get: (id) => id === 'run-a' ? lead : child }
  }, tools: { register: definition => definitions.push(definition) } })
  const tool = definitions.find(({ name }) => name === 'task_claim')
  const args = { task_id: id, child_id: 'new-child', actor: 'lead' }
  const denied = JSON.parse(await tool.execute(args, { agent: child }))
  assert.equal(denied.code, STORE_CODES.conflict)
  assert.equal(store.taskOf(id, 'run-a').task.owner, 'old-child')
  const allowed = JSON.parse(await tool.execute(args, { agent: lead }))
  assert.equal(allowed.owner, 'new-child')
})
