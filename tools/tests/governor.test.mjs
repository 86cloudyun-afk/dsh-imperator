import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withWriteTransaction } from '../../lib/store/sqlite.js'
import { TaskforceStore } from '../../lib/store/index.js'
import { tempStore } from './helpers.mjs'

// Missing implementation is an assertion failure, before any implementation exists.
const governorModule = await import('../../lib/governor/index.js').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw e
})
const { TaskforceGovernor, createNativeGovernorAdapter } = governorModule
const lead = { role: 'lead', sessionId: 'root' }
const worker = { role: 'worker', sessionId: 'child' }
function setup(t) {
  assert.equal(typeof TaskforceGovernor, 'function', 'durable governor admission is missing')
  const store = tempStore(t, { busyTimeoutMs: 5000 })
  const governor = new TaskforceGovernor(store)
  return { store, governor }
}
function task(store, run = 'run', session = 'child') {
  const id = store.openTask({ title: 'governed' }, run).task_id
  store.claimTask({ task_id: id, child_id: 'display' }, run, { sessionId: session, isRoot: false }, session)
  return id
}
function input(id, key = `op-${id}`, extra = {}) {
  return { operation_key: key, task_id: id, generation: 0, mode: 'read', kind: 'reuse', resources: [], ...extra }
}
function never(governor, reservation, run = 'run', authority = lead) {
  return governor.settle({ reservation_id: reservation.reservation_id, generation: reservation.generation, proof: { kind: 'never_started' } }, run, authority)
}
function ref(r, extra = {}) { return { reservation_id: r.reservation_id, generation: r.generation, ...extra } }
const code = value => ({ code: value })

test('six active across nested callers and reuse does not debit new count', t => {
  const { store, governor: g } = setup(t)
  for (let i = 0; i < 6; i++) {
    const session = `nested-${i}`
    g.reserve(input(task(store, 'run', session)), 'run', { role: 'worker', sessionId: session })
  }
  assert.throws(() => g.reserve(input(task(store)), 'run', worker), code('E_BUDGET_EXHAUSTED'))
  assert.equal(g.snapshot('run').active_total, 6)
  assert.equal(g.snapshot('run').created_total, 0)
})

test('two writers count inside total and retain holds when reserved running or unknown', t => {
  const { store, governor: g } = setup(t)
  const a = g.reserve(input(task(store), 'a', { mode: 'write' }), 'run', lead)
  const b = g.reserve(input(task(store), 'b', { mode: 'write' }), 'run', lead)
  g.bind(ref(a, { session_id: 'child' }), 'run', lead)
  g.markUnknown(ref(b, { reason: 'delivery uncertain' }), 'run', lead)
  assert.throws(() => g.reserve(input(task(store), 'c', { mode: 'write' }), 'run', lead), code('E_BUDGET_EXHAUSTED'))
  assert.equal(g.snapshot('run').active_writers, 2)
  assert.equal(g.snapshot('run').unknown_total, 1)
})

test('new cumulative limit is three even after settlement and new tasks do not reset it', t => {
  const { store, governor: g } = setup(t)
  for (let i = 0; i < 3; i++) never(g, g.reserve(input(task(store), `new-${i}`, { kind: 'new' }), 'run', lead))
  assert.throws(() => g.reserve(input(task(store), 'new-4', { kind: 'new' }), 'run', lead), code('E_BUDGET_EXHAUSTED'))
  assert.equal(g.snapshot('run').created_total, 3)
})

test('retry has durable per real-task limit two; fake milestone cannot reset it', t => {
  const { store, governor: g } = setup(t)
  const id = task(store)
  for (let i = 0; i < 2; i++) never(g, g.reserve(input(id, `retry-${i}`, { kind: 'retry', generation: i }), 'run', lead))
  assert.throws(() => g.reserve(input(id, 'retry-3', { kind: 'retry', generation: 2 }), 'run', lead), code('E_BUDGET_EXHAUSTED'))
  assert.throws(() => g.reserve(input(id, 'retry-3', { kind: 'retry', generation: 2, milestone: 'fresh' }), 'run', lead), code('E_GOVERNOR_CONFLICT'))
  assert.equal(g.snapshot('run').retries[id], 2)
})

test('resource readers share across runs; write conflicts with reads and writes across runs', t => {
  const { store, governor: g } = setup(t)
  const a = g.reserve(input(task(store, 'a'), 'a', { resources: ['repo'] }), 'a', lead)
  const b = g.reserve(input(task(store, 'b'), 'b', { resources: ['repo'] }), 'b', lead)
  const c = input(task(store, 'c'), 'c', { mode: 'write', resources: ['repo'] })
  assert.throws(() => g.reserve(c, 'c', lead), code('E_RESOURCE_BUSY'))
  never(g, a, 'a'); never(g, b, 'b')
  g.reserve(c, 'c', lead)
  assert.throws(() => g.reserve(input(task(store, 'a'), 'd', { resources: ['repo'] }), 'a', lead), code('E_RESOURCE_BUSY'))
  assert.throws(() => g.reserve(input(task(store, 'b'), 'e', { mode: 'write', resources: ['repo'] }), 'b', lead), code('E_RESOURCE_BUSY'))
})

test('operation key is durable idempotent with canonical resource set and rejects changed content', t => {
  const { store, governor: g } = setup(t)
  const request = input(task(store), 'once', { kind: 'new', resources: ['b', 'a'] })
  const r = g.reserve(request, 'run', lead)
  assert.deepEqual(g.reserve({ ...request, resources: ['a', 'b', 'a'] }, 'run', lead), r)
  for (const patch of [{ mode: 'write' }, { kind: 'reuse' }, { resources: ['c'] }, { task_id: task(store) }, { generation: 2 }]) {
    assert.throws(() => g.reserve({ ...request, ...patch }, 'run', lead), code('E_GOVERNOR_CONFLICT'))
  }
  never(g, r)
  const reopened = new TaskforceStore(store.root)
  t.after(() => reopened.close())
  const g2 = new TaskforceGovernor(reopened)
  assert.equal(g2.reserve(request, 'run', lead).state, 'settled')
  assert.equal(g2.snapshot('run').created_total, 1)
  assert.equal(g2.snapshot('run').audit.filter(a => a.action === 'reserve').length, 1)
})

test('generation fences reserve and all transitions, including stale prior settled generation', t => {
  const { store, governor: g } = setup(t)
  const id = task(store)
  const r = g.reserve(input(id), 'run', worker)
  for (const method of ['bind', 'markUnknown', 'settle']) {
    assert.throws(() => g[method](ref(r, { generation: 0, ...({ bind: { session_id: 'child' }, markUnknown: { reason: 'lost' }, settle: { proof: { kind: 'never_started' } } }[method]) }), 'run', worker), code('E_GOVERNOR_FENCE'))
  }
  never(g, r)
  assert.throws(() => g.reserve(input(id, 'second'), 'run', lead), code('E_GOVERNOR_FENCE'))
  const next = g.reserve(input(id, 'second', { generation: 1 }), 'run', lead)
  assert.equal(next.generation, 2)
  assert.throws(() => never(g, r), code('E_GOVERNOR_FENCE'))
})

test('cancel and idle cannot release; running settlement needs terminal plus trusted quiescence', t => {
  const { store, governor: g } = setup(t)
  const r = g.reserve(input(task(store), 'live', { mode: 'write', resources: ['repo'] }), 'run', worker)
  g.bind(ref(r, { session_id: 'child' }), 'run', worker)
  for (const proof of [{ kind: 'cancel_requested' }, { kind: 'idle' }, { kind: 'never_started' }, { kind: 'terminal', outcome: 'succeeded' }, { kind: 'terminal', outcome: 'succeeded', quiescent: true }]) {
    assert.throws(() => g.settle(ref(r, { proof }), 'run', lead), code('E_GOVERNOR_CONFLICT'))
    assert.equal(g.snapshot('run').active_total, 1)
  }
  const proof = { kind: 'terminal', outcome: 'cancelled', quiescent: true, evidence: 'host-proof-123' }
  const settled = g.settle(ref(r, { proof }), 'run', lead)
  assert.equal(settled.state, 'settled')
  assert.equal(g.snapshot('run').active_total, 0)
  assert.deepEqual(g.settle(ref(r, { proof }), 'run', lead), settled)
  assert.throws(() => never(g, r), code('E_GOVERNOR_CONFLICT'))
})

test('unknown survives restart with locks and counters; duplicate intent never redispatches', t => {
  const { store, governor: g } = setup(t)
  const request = input(task(store), 'uncertain', { kind: 'new', mode: 'write', resources: ['repo'] })
  const r = g.reserve(request, 'run', lead)
  g.bind(ref(r, { session_id: 'child' }), 'run', lead)
  g.markUnknown(ref(r, { reason: 'crash after dispatch' }), 'run', lead)
  store.close()
  const reopened = new TaskforceStore(store.root)
  t.after(() => reopened.close())
  const g2 = new TaskforceGovernor(reopened)
  assert.equal(g2.snapshot('run').unknown_total, 1)
  assert.equal(g2.snapshot('run').created_total, 1)
  assert.equal(g2.reserve(request, 'run', lead).state, 'unknown')
  assert.throws(() => g2.bind(ref(r, { session_id: 'child' }), 'run', lead), code('E_GOVERNOR_CONFLICT'))
  assert.throws(() => g2.reserve(input(task(reopened, 'other'), 'other', { resources: ['repo'] }), 'other', lead), code('E_RESOURCE_BUSY'))
})

test('scope and real owner validated for every mutation; lead-named worker has no lead authority', t => {
  const { store, governor: g } = setup(t)
  const id = task(store, ' run ', ' child ')
  const owner = { role: 'worker', sessionId: ' child ' }
  assert.throws(() => g.reserve(input(id), 'run', lead), code('E_GOVERNOR_CONFLICT'))
  assert.throws(() => g.reserve(input(id), ' run ', worker), code('E_GOVERNOR_CONFLICT'))
  assert.throws(() => g.reserve(input(id), ' run ', { sessionId: ' child ' }), code('E_GOVERNOR_CONFLICT'))
  const r = g.reserve(input(id), ' run ', owner)
  for (const [method, fields] of [['bind', { session_id: ' child ' }], ['markUnknown', { reason: 'lost' }], ['settle', { proof: { kind: 'never_started' } }]]) {
    assert.throws(() => g[method](ref(r, fields), 'run', lead), code('E_GOVERNOR_CONFLICT'))
    assert.throws(() => g[method](ref(r, fields), ' run ', worker), code('E_GOVERNOR_CONFLICT'))
  }
  assert.throws(() => g.bind(ref(r, { session_id: 'child' }), ' run ', lead), code('E_GOVERNOR_CONFLICT'))
  const leadWorker = { role: 'worker', sessionId: 'lead' }
  g.reserve(input(task(store, 'lead-run', 'lead')), 'lead-run', leadWorker)
  assert.throws(() => g.extendBudget({ reason: 'more', max_active: 7 }, 'lead-run', leadWorker), code('E_GOVERNOR_CONFLICT'))
  assert.equal(g.snapshot('run').active_total, 0)
  assert.equal(g.snapshot(' run ').active_total, 1)
})

test('lead extension requires reason, increases limits durably and audits exact authority', t => {
  const { store, governor: g } = setup(t)
  assert.throws(() => g.extendBudget({ max_created: 4 }, 'run', lead), code('E_GOVERNOR_CONFLICT'))
  assert.throws(() => g.extendBudget({ max_created: 4, reason: ' ' }, 'run', lead), code('E_GOVERNOR_CONFLICT'))
  assert.throws(() => g.extendBudget({ max_created: 4, reason: 'more' }, 'run', worker), code('E_GOVERNOR_CONFLICT'))
  g.extendBudget({ max_created: 4, reason: 'approved fourth worker' }, 'run', { role: 'lead', sessionId: ' root ' })
  for (let i = 0; i < 4; i++) never(g, g.reserve(input(task(store), `n${i}`, { kind: 'new' }), 'run', lead))
  assert.equal(g.snapshot('run').limits.max_created, 4)
  const audit = g.snapshot('run').audit.find(a => a.action === 'extendBudget')
  assert.equal(audit.session_id, ' root ')
  assert.equal(audit.details.reason, 'approved fourth worker')
})

test('SQL audit fault rolls back counters reservations resources and extension', t => {
  const { store, governor: g } = setup(t)
  const request = input(task(store), 'rollback', { kind: 'new', resources: ['repo'] })
  const before = g.snapshot('run')
  store.open().exec("CREATE TEMP TRIGGER fail_governor BEFORE INSERT ON governor_audit BEGIN SELECT RAISE(ABORT,'governor audit fault'); END")
  assert.throws(() => g.reserve(request, 'run', lead), /governor audit fault/)
  assert.deepEqual(g.snapshot('run'), before)
  assert.throws(() => g.extendBudget({ max_created: 4, reason: 'increase' }, 'run', lead), /governor audit fault/)
  assert.deepEqual(g.snapshot('run'), before)
  store.open().exec('DROP TRIGGER fail_governor')
  const r = g.reserve(request, 'run', lead)
  const occupied = g.snapshot('run')
  store.open().exec("CREATE TEMP TRIGGER fail_governor BEFORE INSERT ON governor_audit BEGIN SELECT RAISE(ABORT,'governor audit fault'); END")
  assert.throws(() => never(g, r), /governor audit fault/)
  assert.deepEqual(g.snapshot('run'), occupied)
})

test('closed store cannot be revived by governor, and replacement handle is respected', t => {
  const { store, governor: g } = setup(t)
  g.snapshot('run')
  const old = store.open()
  old.close()
  assert.equal(g.snapshot('run').active_total, 0)
  assert.notEqual(store.open(), old)
  store.close()
  for (const method of ['snapshot', 'reserve', 'bind', 'markUnknown', 'settle', 'extendBudget']) {
    assert.throws(() => method === 'snapshot' ? g[method]('run') : g[method]({}, 'run', lead), /关闭/)
  }
})

test('separate SQLite processes compete for last slot and exactly one commits', { timeout: 15000 }, async t => {
  const { store, governor: g } = setup(t)
  for (let i = 0; i < 5; i++) g.reserve(input(task(store)), 'run', lead)
  const workers = [task(store), task(store)].map(id => fork(fileURLToPath(new URL('./fixtures/governor-worker.mjs', import.meta.url)), [store.root, String(id)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))
  t.after(() => workers.forEach(w => w.kill()))
  await Promise.all(workers.map(w => once(w, 'message')))
  const results = workers.map(w => once(w, 'message').then(([m]) => m))
  workers.forEach(w => w.send('go'))
  const done = await Promise.all(results)
  assert.equal(done.filter(r => r.state === 'reserved').length, 1, JSON.stringify(done))
  assert.equal(done.filter(r => r.code === 'E_BUDGET_EXHAUSTED').length, 1, JSON.stringify(done))
  assert.equal(g.snapshot('run').active_total, 6)
  assert.equal(g.snapshot('run').audit.filter(a => a.action === 'reserve').length, 6)
})

test('native adapter is always blocked with all six unresolved capabilities', () => {
  assert.equal(typeof createNativeGovernorAdapter, 'function', 'fail-closed native adapter is missing')
  for (const config of [undefined, { enabled: true, capabilities: { H01: true, H02: true, H03: true, H04: true, H05: true, H06: true } }]) {
    assert.throws(() => createNativeGovernorAdapter(config), e => e.code === 'E_SCHEDULER_CAPABILITY' && e.blockers.map(b => b.code).join(',') === 'H01,H02,H03,H04,H05,H06')
  }
})


test('one active admission per task; task cancellation does not release a hold', t => {
  const { store, governor: g } = setup(t)
  const id = task(store)
  const r = g.reserve(input(id, 'first'), 'run', worker)
  assert.throws(() => g.reserve(input(id, 'parallel', { generation: 1 }), 'run', lead), code('E_GOVERNOR_CONFLICT'))
  store.closeTask({ task_id: id, result: 'failed' }, 'run', { isRoot: false, sessionId: 'child' })
  assert.equal(g.snapshot('run').active_total, 1)
  assert.throws(() => g.bind(ref(r, { session_id: 'child' }), 'run', lead), code('E_GOVERNOR_CONFLICT'))
  never(g, r)
  assert.throws(() => g.reserve(input(id, 'terminal', { generation: 1 }), 'run', lead), code('E_GOVERNOR_CONFLICT'))
})

test('owner reassignment cannot acquire the old operation or release the old execution', t => {
  const { store, governor: g } = setup(t)
  const id = task(store), request = input(id)
  const r = g.reserve(request, 'run', worker)
  g.bind(ref(r, { session_id: 'child' }), 'run', worker)
  store.submitTask({ task_id: id }, 'run', { isRoot: false, sessionId: 'child' })
  store.rejectTask({ task_id: id, reason: 'new executor' }, 'run', { isRoot: true, sessionId: 'root' })
  store.claimTask({ task_id: id, child_id: 'new display' }, 'run', { isRoot: true, sessionId: 'root' }, 'replacement')
  for (const actor of [worker, { role: 'worker', sessionId: 'replacement' }]) {
    assert.throws(() => g.reserve(request, 'run', actor), code('E_GOVERNOR_CONFLICT'))
    assert.throws(() => g.markUnknown(ref(r, { reason: 'lost' }), 'run', actor), code('E_GOVERNOR_CONFLICT'))
    assert.throws(() => g.settle(ref(r, { proof: { kind: 'terminal', outcome: 'failed', quiescent: true, evidence: 'proof' } }), 'run', actor), code('E_GOVERNOR_CONFLICT'))
  }
  assert.equal(g.snapshot('run').active_total, 1)
})

test('operation and resource keys preserve nonblank surrounding whitespace', t => {
  const { store, governor: g } = setup(t)
  g.reserve(input(task(store), ' op ', { resources: [' repo '], mode: 'write' }), 'run', lead)
  g.reserve(input(task(store), 'op', { resources: ['repo'], mode: 'write' }), 'run', lead)
  assert.equal(g.snapshot('run').active_total, 2)
  assert.deepEqual(g.snapshot('run').holds.map(h => h.resource_key).sort(), [' repo ', 'repo'])
  for (const patch of [{ operation_key: ' ' }, { resources: [' '] }, { mode: 'invalid' }, { kind: 'invalid' }, { resources: [] , root_run: 'other' }]) {
    assert.throws(() => g.reserve(input(task(store), 'invalid', patch), 'run', lead), code('E_GOVERNOR_CONFLICT'))
  }
  assert.throws(() => g.snapshot(' '), code('E_GOVERNOR_CONFLICT'))
})

test('ignored resource insert or release fails atomically', t => {
  const { store, governor: g } = setup(t)
  const request = input(task(store), 'hold', { kind: 'new', resources: ['repo'] })
  g.snapshot('run')
  const db = store.open()
  db.exec('CREATE TEMP TRIGGER ignore_hold BEFORE INSERT ON governor_hold BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => g.reserve(request, 'run', lead), code('E_GOVERNOR_CONFLICT'))
  assert.equal(g.snapshot('run').created_total, 0)
  assert.equal(g.snapshot('run').audit.length, 0)
  db.exec('DROP TRIGGER ignore_hold')
  const r = g.reserve(request, 'run', lead)
  db.exec('CREATE TEMP TRIGGER ignore_release BEFORE DELETE ON governor_hold BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => never(g, r), code('E_GOVERNOR_CONFLICT'))
  assert.equal(g.snapshot('run').active_total, 1)
  assert.equal(g.snapshot('run').holds.length, 1)
})

test('rollback failure invalidates store handle; governor resumes from durable state', t => {
  const { store, governor: g } = setup(t)
  const request = input(task(store), 'rollback-failure', { kind: 'new' })
  g.snapshot('run')
  const db = store.open(), execute = db.exec.bind(db)
  db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON governor_audit BEGIN SELECT RAISE(ABORT,'audit failure'); END")
  db.exec = sql => { if (sql === 'ROLLBACK') throw new Error('rollback failed'); return execute(sql) }
  assert.throws(() => g.reserve(request, 'run', lead), e => e.transactionStateUnknown === true)
  assert.equal(store.handle, null)
  assert.equal(db.isOpen, false)
  assert.equal(g.snapshot('run').created_total, 0)
  assert.equal(g.reserve(request, 'run', lead).state, 'reserved')
})

test('governor schema and admission survive initialization rolled back by outer store transaction', t => {
  const { store, governor: g } = setup(t)
  const id = task(store), db = store.open()
  assert.throws(() => withWriteTransaction(db, () => {
    g.reserve(input(id), 'run', lead)
    throw new Error('outer rollback')
  }), /outer rollback/)
  assert.equal(g.snapshot('run').created_total, 0)
  assert.equal(g.reserve(input(id), 'run', lead).generation, 1)
})
