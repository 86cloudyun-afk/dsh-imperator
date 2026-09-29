import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { STORE_CODES } from '../../lib/store/index.js'
import { apply as applyTools } from '../../lib/tools/index.js'
import { seedSubmitted, tempStore } from './helpers.mjs'

const worker = fileURLToPath(new URL('./fixtures/claim-worker.mjs', import.meta.url))

function facts(store, id) {
  return store.handle.prepare('SELECT kind, statement FROM fact WHERE task_id = ? ORDER BY id').all(id)
}

function snapshot(store, id, run = 'run-a') {
  return { task: store.taskOf({ task_id: id }, run).task, facts: facts(store, id) }
}

test('accept_audit_failure_rolls_back_and_is_retryable', (t) => {
  const store = tempStore(t)
  const id = seedSubmitted(store, 'run-a')
  const before = snapshot(store, id)
  store.handle.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON fact WHEN NEW.kind='decision' BEGIN SELECT RAISE(ABORT,'audit failure'); END")
  assert.throws(() => store.acceptTask({ task_id: id }, 'run-a', 'lead'), /audit failure/)
  assert.deepEqual(snapshot(store, id), before)
  store.handle.exec('DROP TRIGGER fail_audit')
  assert.equal(store.acceptTask({ task_id: id }, 'run-a', 'lead').status, 'accepted')
  assert.equal(facts(store, id).filter((fact) => fact.statement.startsWith('验收通过')).length, 1)
})

test('reject audit failure rolls back status and timestamp', (t) => {
  const store = tempStore(t)
  const id = seedSubmitted(store, 'run-a')
  const before = snapshot(store, id)
  store.handle.exec("CREATE TEMP TRIGGER fail_reject BEFORE INSERT ON fact WHEN NEW.statement LIKE '验收打回：%' BEGIN SELECT RAISE(ABORT,'reject audit failure'); END")
  assert.throws(() => store.rejectTask({ task_id: id, reason: '补产物' }, 'run-a', 'lead'), /reject audit failure/)
  assert.deepEqual(snapshot(store, id), before)
})

test('submit note failure rolls back task transition and leaves no audit', (t) => {
  const store = tempStore(t)
  const id = store.openTask({ title: '提交' }, 'run-a').task_id
  const before = snapshot(store, id)
  store.handle.exec("CREATE TEMP TRIGGER fail_submit BEFORE INSERT ON fact BEGIN SELECT RAISE(ABORT,'submit audit failure'); END")
  assert.throws(() => store.submitTask({ task_id: id, note: '说明' }, 'run-a'), /submit audit failure/)
  assert.deepEqual(snapshot(store, id), before)
})

test('failed close note failure rolls back cancellation; no-note close and aliases remain compatible', (t) => {
  const store = tempStore(t)
  const id = store.openTask({ title: '取消' }, 'run-a').task_id
  const before = snapshot(store, id)
  store.handle.exec("CREATE TEMP TRIGGER fail_cancel BEFORE INSERT ON fact BEGIN SELECT RAISE(ABORT,'cancel audit failure'); END")
  assert.throws(() => store.closeTask({ task_id: id, result: 'failed', note: '原因' }, 'run-a'), /cancel audit failure/)
  assert.deepEqual(snapshot(store, id), before)
  assert.equal(store.closeTask({ task_id: id, result: 'failed' }, 'run-a').status, 'cancelled')
  assert.deepEqual(facts(store, id), [])
  store.handle.exec('DROP TRIGGER fail_cancel')
  for (const result of ['done', 'partial']) {
    const other = store.openTask({ title: result }, 'run-a').task_id
    assert.equal(store.closeTask({ task_id: other, result, note: '交付附注' }, 'run-a').status, 'submitted')
    assert.equal(facts(store, other).filter((fact) => fact.statement === '提交验收：交付附注').length, 1)
  }
})

test('recordFact timestamp failure rolls back inserted fact', (t) => {
  const store = tempStore(t)
  const id = store.openTask({ title: '事实' }, 'run-a').task_id
  const before = snapshot(store, id)
  store.handle.exec("CREATE TEMP TRIGGER fail_timestamp BEFORE UPDATE OF updated_at ON task BEGIN SELECT RAISE(ABORT,'timestamp failure'); END")
  assert.throws(() => store.recordFact({ task_id: id, statement: '新事实' }, 'run-a'), /timestamp failure/)
  assert.deepEqual(snapshot(store, id), before)
})

test('ignored timestamp update does not commit an orphaned fact', (t) => {
  const store = tempStore(t)
  const id = store.openTask({ title: '时间戳静默失败' }, 'run-a').task_id
  const before = snapshot(store, id)
  store.handle.exec('CREATE TEMP TRIGGER ignore_timestamp BEFORE UPDATE OF updated_at ON task BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => store.recordFact({ task_id: id, statement: '不应留下' }, 'run-a'), { code: STORE_CODES.conflict })
  assert.deepEqual(snapshot(store, id), before)
})

test('adoptUnassigned failure rolls back run assignment across tables', (t) => {
  const store = tempStore(t)
  const id = store.openTask({ title: '遗留' }).task_id
  store.recordFact({ task_id: id, statement: '遗留事实' })
  store.recordHandoff({ task_id: id, from_child: 'a', to_child: 'b', note: '交接' })
  const before = store.handle.prepare('SELECT run_id, updated_at FROM task WHERE id = ?').get(id)
  store.handle.exec("CREATE TEMP TRIGGER fail_adopt BEFORE UPDATE OF run_id ON handoff BEGIN SELECT RAISE(ABORT,'adopt failure'); END")
  assert.throws(() => store.adoptUnassigned('run-a'), /adopt failure/)
  assert.deepEqual(store.handle.prepare('SELECT run_id, updated_at FROM task WHERE id = ?').get(id), before)
  assert.equal(store.handle.prepare('SELECT run_id FROM fact WHERE task_id = ?').get(id).run_id, null)
  assert.equal(store.handle.prepare('SELECT run_id FROM handoff WHERE task_id = ?').get(id).run_id, null)
  assert.equal(store.taskOf({ task_id: id }).task.run_id, null)
})

test('cross-run and terminal errors take precedence without side effects', (t) => {
  const store = tempStore(t)
  const id = seedSubmitted(store, 'run-a')
  store.acceptTask({ task_id: id }, 'run-a', 'lead')
  const before = snapshot(store, id)
  assert.throws(() => store.claimTask({ task_id: id, child_id: 'other' }, 'run-b'), { code: STORE_CODES.crossRun })
  assert.throws(() => store.claimTask({ task_id: id, child_id: 'other' }, 'run-a'), { code: STORE_CODES.terminal })
  assert.deepEqual(snapshot(store, id), before)
})

function toolCalls(store) {
  const definitions = []
  const lead = { id: 'run-a', options: {}, session: { header: { id: 'run-a', isSeeded: false } } }
  applyTools({
    logger: { warn() {} },
    get(name) {
      if (name === 'taskforceStore') return store
      if (name === 'agents') return { get: () => lead }
    },
    tools: { register: (definition) => definitions.push(definition) },
  })
  const tool = (name) => definitions.find((definition) => definition.name === name)
  return { tool, call: async (name, args) => JSON.parse(await tool(name).execute(args, { agent: lead })) }
}

test('tool preserves conflict code with board-check hint and close note', async (t) => {
  const store = tempStore(t)
  const id = store.openTask({ title: '工具层' }, 'run-a').task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, 'run-a')
  const { tool, call } = toolCalls(store)
  const conflict = await call('task_claim', { task_id: id, child_id: 'worker-b' })
  assert.equal(conflict.code, STORE_CODES.conflict)
  assert.match(conflict.hint, /task_board/)
  assert.match(conflict.hint, /竞争|认领者/)
  assert.equal(tool('task_close').parameters.properties.note.type, 'string')
  const closed = await call('task_close', { task_id: id, result: 'failed', note: '停止原因' })
  assert.equal(closed.status, 'cancelled')
  assert.equal(facts(store, id).filter((fact) => fact.statement === '取消任务：停止原因').length, 1)
})

test('tool reports SQLite busy as bounded retry', async (t) => {
  const store = tempStore(t, { busyTimeoutMs: 0 })
  store.open()
  const blocker = new DatabaseSync(store.dbPath)
  t.after(() => blocker.close())
  blocker.exec('BEGIN IMMEDIATE')
  try {
    const { call } = toolCalls(store)
    const busy = await call('task_open', { title: '锁等待' })
    assert.equal(busy.code, 'E_STORE_BUSY')
    assert.match(busy.hint, /稍后/)
    assert.match(busy.hint, /有限/)
  } finally {
    blocker.exec('ROLLBACK')
  }
})

function receive(child) {
  return new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`claim worker exited before reply: ${code}`)))
  })
}

test('two connected processes claiming one task produce one owner and one conflict', { timeout: 15000 }, async (t) => {
  const store = tempStore(t, { busyTimeoutMs: 5000, journalMode: 'wal' })
  const id = store.openTask({ title: '竞争' }, 'run-a').task_id
  const children = ['worker-a', 'worker-b'].map((name) => fork(worker, [store.root, String(id), name], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
  t.after(() => children.forEach((child) => child.kill()))
  await Promise.all(children.map(receive))
  const replies = children.map((child) => receive(child))
  children.forEach((child) => child.send('claim'))
  const results = await Promise.all(replies)
  const winner = results.find((reply) => reply.result)?.result
  assert.ok(winner, JSON.stringify(results))
  assert.equal(results.filter((reply) => reply.result).length, 1)
  assert.deepEqual(results.filter((reply) => reply.code), [{ code: STORE_CODES.conflict, error: results.find((reply) => reply.code)?.error }])
  assert.equal(store.taskOf({ task_id: id }, 'run-a').task.owner, winner.owner)
})
