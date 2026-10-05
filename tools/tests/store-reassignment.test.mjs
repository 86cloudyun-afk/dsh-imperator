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

test('owner-conflict E_TASK_CONFLICT guidance is status-aware (no blind task_reject)', (t) => {
  const store = tempStore(t)
  const expectConflict = (fn, checks) => {
    assert.throws(fn, (error) => {
      assert.equal(error.code, STORE_CODES.conflict)
      for (const check of checks) check(error.message)
      return true
    })
  }

  const claimedId = store.openTask({ title: 'claimed-conflict' }, 'run-a').task_id
  store.claimTask({ task_id: claimedId, child_id: 'old-child' }, 'run-a')
  expectConflict(
    () => store.claimTask({ task_id: claimedId, child_id: 'new-child' }, 'run-a', 'lead'),
    [
      (msg) => assert.match(msg, /不能直接 task_reject/),
      (msg) => assert.match(msg, /当前认领者 task_submit/),
      (msg) => assert.doesNotMatch(msg, /task_close/),
      (msg) => assert.doesNotMatch(msg, /先 task_reject 显式驳回/),
    ],
  )

  const submittedId = store.openTask({ title: 'submitted-conflict' }, 'run-a').task_id
  store.claimTask({ task_id: submittedId, child_id: 'old-child' }, 'run-a')
  store.submitTask({ task_id: submittedId }, 'run-a')
  expectConflict(
    () => store.claimTask({ task_id: submittedId, child_id: 'new-child' }, 'run-a', 'lead'),
    [
      (msg) => assert.match(msg, /先 task_reject/),
      (msg) => assert.match(msg, /再由主会话 task_claim/),
    ],
  )

  const rejectedId = rejected(store)
  expectConflict(
    () => store.claimTask({ task_id: rejectedId, child_id: 'new-child' }, 'run-a'),
    [
      (msg) => assert.match(msg, /已是 rejected/),
      (msg) => assert.match(msg, /不要再调 task_reject/),
      (msg) => assert.doesNotMatch(msg, /先 task_reject/),
    ],
  )
})

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

function conflictCaller(store) {
  const lead = { id: 'run-a', options: {}, session: { header: { id: 'run-a' } } }
  const children = ['old-child', 'new-child'].map(id => ({ id, options: {},
    session: { header: { id, origin: 'subagent', delegationDepth: 1, parentSession: 'run-a' } } }))
  const agents = [lead, ...children]
  const definitions = []
  applyTools({ logger: { warn() {} }, get(name) {
    if (name === 'taskforceStore') return store
    if (name === 'agents') return { get: id => agents.find(agent => agent.id === id) }
  }, tools: { register: definition => definitions.push(definition) } })
  return { lead, owner: children[0], competitor: children[1],
    call: async (name, args, agent = lead) =>
      JSON.parse(await definitions.find(tool => tool.name === name).execute(args, { agent })) }
}

test('competing child claimed-conflict never suggests cancelling the current owner', async (t) => {
  const store = tempStore(t)
  const { call, owner, competitor } = conflictCaller(store)
  const { task_id } = await call('task_open', { title: '竞争认领' })
  assert.equal((await call('task_claim', { task_id, child_id: owner.id }, owner)).ok, true)
  assert.equal((await call('task_fact', { task_id, statement: '原执行者的证据', child_id: owner.id }, owner)).ok, true)
  const before = snapshot(store, task_id)
  const denied = await call('task_claim', { task_id, child_id: competitor.id, actor: 'lead' }, competitor)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, STORE_CODES.conflict)
  assert.deepEqual(snapshot(store, task_id), before)
  for (const text of [denied.error, denied.hint]) assert.doesNotMatch(text, /task_close/)
  assert.match(denied.error, /当前认领者 task_submit/)
  // The owner can still finish; only the real lead can reject and reassign.
  assert.equal((await call('task_submit', { task_id }, owner)).status, 'submitted')
  assert.equal((await call('task_reject', { task_id, reason: '换人复核' }, competitor)).code, STORE_CODES.notLead)
  assert.equal((await call('task_reject', { task_id, reason: '换人复核' })).status, 'rejected')
  assert.equal((await call('task_claim', { task_id, child_id: competitor.id }, competitor)).code, STORE_CODES.conflict)
  const reassigned = await call('task_claim', { task_id, child_id: competitor.id })
  assert.equal(reassigned.reassigned, true)
  assert.equal(reassigned.owner, competitor.id)
})

for (const status of ['claimed', 'submitted', 'rejected']) {
  test(`task_claim JSON hint carries ${status} owner-conflict guidance without writes`, async (t) => {
    const store = tempStore(t)
    const { call, lead, owner, competitor } = conflictCaller(store)
    const { task_id } = await call('task_open', { title: status })
    assert.equal((await call('task_claim', { task_id, child_id: owner.id }, owner)).ok, true)
    if (status !== 'claimed') assert.equal((await call('task_submit', { task_id }, owner)).status, 'submitted')
    if (status === 'rejected') assert.equal((await call('task_reject', { task_id, reason: '换人复核' })).status, 'rejected')
    const before = snapshot(store, task_id)
    // On rejected the lead is allowed to reassign, so only the competitor is refused.
    for (const agent of status === 'rejected' ? [competitor] : [lead, competitor]) {
      const denied = await call('task_claim', { task_id, child_id: competitor.id, actor: 'lead' }, agent)
      assert.equal(denied.ok, false)
      assert.equal(denied.code, STORE_CODES.conflict)
      assert.deepEqual(snapshot(store, task_id), before)
      assert.ok(denied.error.endsWith(denied.hint), 'the inline hint must carry the store next step')
      assert.match(denied.hint, /先 task_board 核对最新 owner 与状态/)
      assert.doesNotMatch(denied.hint, /task_close/)
      if (status === 'claimed') {
        assert.match(denied.hint, /当前为 claimed/)
        assert.match(denied.hint, /不能直接 task_reject/)
        assert.match(denied.hint, /当前认领者 task_submit 后由主会话 task_reject/)
      } else if (status === 'submitted') {
        assert.match(denied.hint, /当前为 submitted/)
        assert.match(denied.hint, /由主会话先 task_reject/)
        assert.match(denied.hint, /再由主会话 task_claim/)
      } else {
        assert.match(denied.hint, /已是 rejected/)
        assert.match(denied.hint, /只能由主会话直接 task_claim/)
        assert.match(denied.hint, /不要再调 task_reject/)
        assert.doesNotMatch(denied.hint, /先 task_reject/)
      }
    }
  })
}
