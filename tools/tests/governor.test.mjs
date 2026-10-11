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

for (const action of ['bind', 'settle']) test('Task16 governor ' + action + ' rejects a prefix without changing holds or audit', t => {
  const { store, governor: g } = setup(t), full = 'worker\0suffix'
  const id = task(store, 'run', full), args = input(id, 'operation\0suffix', { mode: 'write', resources: ['resource\0suffix'] })
  const row = g.reserve(args, 'run', lead)
  const snapshot = () => ({ rows: ['governor_reservation', 'governor_hold', 'governor_audit'].map(table =>
    store.open().prepare('SELECT * FROM ' + table).all()), exact: store.open().prepare('SELECT json_quote(run_id) AS run, json_quote(owner_session) AS owner, json_quote(session_id) AS session FROM governor_reservation').all() })
  const before = snapshot()
  const invoke = sessionId => action === 'bind'
    ? g.bind(ref(row, { session_id: sessionId }), 'run', { role: 'worker', sessionId })
    : g.settle(ref(row, { proof: { kind: 'never_started' } }), 'run', { role: 'worker', sessionId })
  assert.throws(() => invoke('worker'), code('E_GOVERNOR_CONFLICT'))
  assert.deepEqual(snapshot(), before)
  assert.equal(g.reserve(args, 'run', { role: 'worker', sessionId: full }).reservation_id, row.reservation_id)
  assert.equal(invoke(full).state, action === 'bind' ? 'running' : 'settled')
  if (action === 'bind') assert.equal(invoke(full).session_id, full)
})

test('Task16 leading NUL bound governor session is not an unbound reservation', t => {
  const { store, governor: g } = setup(t), sessionId = '\0suffix'
  const row = g.reserve(input(task(store, 'run', sessionId)), 'run', lead)
  g.bind(ref(row, { session_id: sessionId }), 'run', { role: 'worker', sessionId })
  const before = g.snapshot('run')
  assert.throws(() => never(g, row), code('E_GOVERNOR_CONFLICT'))
  assert.deepEqual(g.snapshot('run'), before)
})

for (const side of ['current', 'captured']) test('Task16 governor independently rejects different full ' + side + ' owner', t => {
  const { store, governor: g } = setup(t), a = 'worker\0first', b = 'worker\0second'
  const captured = side === 'current' ? b : a, current = side === 'current' ? a : b
  const id = task(store, 'run', captured), args = input(id)
  g.reserve(args, 'run', lead)
  store.submitTask({ task_id: id }, 'run', { sessionId: captured, isRoot: false })
  store.rejectTask({ task_id: id, reason: 'reassign' }, 'run', { sessionId: 'root', isRoot: true })
  store.claimTask({ task_id: id, child_id: 'replacement' }, 'run', { sessionId: 'root', isRoot: true }, current)
  const before = g.snapshot('run')
  assert.throws(() => g.reserve(args, 'run', { role: 'worker', sessionId: b }), code('E_GOVERNOR_CONFLICT'))
  assert.deepEqual(g.snapshot('run'), before)
})

test('Task16 governor SQL resource and operation selectors keep NUL keys distinct', t => {
  const { store, governor: g } = setup(t), id = task(store)
  const first = g.reserve(input(id, 'op\0suffix', { mode: 'write', resources: ['resource\0suffix'] }), 'run', lead)
  const second = g.reserve(input(task(store), 'op', { resources: ['resource'] }), 'run', lead)
  assert.notEqual(second.reservation_id, first.reservation_id)
  const third = task(store), before = g.snapshot('run')
  assert.throws(() => g.reserve(input(third, 'third', { resources: ['resource\0suffix'] }), 'run', lead), code('E_RESOURCE_BUSY'))
  assert.deepEqual(g.snapshot('run'), before)
  assert.throws(() => g.reserve(input(id, 'op\0suffix', { resources: ['resource\0suffix'] }), 'run', lead), code('E_GOVERNOR_CONFLICT'))
  assert.deepEqual(g.snapshot('run'), before)
})

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

test('generation fences admission and mutations while settled replay remains row-bound', t => {
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
  const before = JSON.stringify(g.snapshot('run'))
  assert.equal(never(g, r).state, 'settled')
  assert.equal(JSON.stringify(g.snapshot('run')), before)
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

function rejectAndReclaim(store, id) {
  store.submitTask({ task_id: id }, 'run', { isRoot: false, sessionId: 'child' })
  store.rejectTask({ task_id: id, reason: 'observable rework' }, 'run', { isRoot: true, sessionId: 'root' })
  store.claimTask({ task_id: id, child_id: 'display' }, 'run', { isRoot: false, sessionId: 'child' }, 'child')
}
function finishRejected(store, g, r) {
  store.submitTask({ task_id: r.task_id }, 'run', { isRoot: false, sessionId: 'child' })
  store.rejectTask({ task_id: r.task_id, reason: 'observable rework' }, 'run', { isRoot: true, sessionId: 'root' })
  g.settle(ref(r, { proof: { kind: 'terminal', outcome: 'failed', quiescent: true, evidence: 'host verified stopped subtree' } }), 'run', lead)
  store.claimTask({ task_id: r.task_id, child_id: 'display' }, 'run', { isRoot: false, sessionId: 'child' }, 'child')
}

for (const kind of ['reuse', 'new']) {
  test(`real rejected-task rework charges retries independently of ${kind}, across replay and reopen`, t => {
    let { store, governor: g } = setup(t)
    // Isolate retry enforcement from the independent cumulative-new limit.
    if (kind === 'new') g.extendBudget({ max_created: 5, reason: 'exercise independent real-task retry cap' }, 'run', lead)
    const id = task(store)
    let r = g.reserve(input(id, 'initial', { kind: 'new' }), 'run', worker)
    g.bind(ref(r, { session_id: 'child' }), 'run', worker)
    for (let retry = 1; retry <= 2; retry++) {
      finishRejected(store, g, r)
      assert.equal(store.taskOf({ task_id: id }, 'run').task.status, 'claimed')
      const request = input(id, `rework-${retry}`, { generation: retry, kind })
      r = g.reserve(request, 'run', worker)
      assert.equal(g.snapshot('run').retries[id], retry, 'physical executor kind must not erase task rework')
      assert.deepEqual(g.reserve(request, 'run', worker), r)
      store.close()
      store = new TaskforceStore(store.root)
      t.after(() => store.close())
      g = new TaskforceGovernor(store)
      assert.deepEqual(g.reserve(request, 'run', worker), r)
      assert.equal(g.snapshot('run').retries[id], retry)
      g.bind(ref(r, { session_id: 'child' }), 'run', worker)
    }
    finishRejected(store, g, r)
    const before = g.snapshot('run')
    assert.throws(() => g.reserve(input(id, 'third-rework', { generation: 3, kind }), 'run', worker), code('E_BUDGET_EXHAUSTED'))
    assert.deepEqual(g.snapshot('run'), before)
    assert.equal(before.created_total, kind === 'new' ? 3 : 1)
    // Even an old settled replay after another rejection remains lookup-only.
    assert.equal(g.reserve(input(id, 'rework-1', { generation: 1, kind }), 'run', worker).state, 'settled')
    assert.equal(g.snapshot('run').retries[id], 2)
  })
}

test('explicit retry and observed same-admission rework charge once; unchanged-revision reuse does not reset or double charge', t => {
  const { store, governor: g } = setup(t)
  const id = task(store)
  rejectAndReclaim(store, id)
  never(g, g.reserve(input(id, 'explicit-rework', { kind: 'retry' }), 'run', worker))
  assert.equal(g.snapshot('run').retries[id], 1)
  never(g, g.reserve(input(id, 'same-revision-reuse', { generation: 1 }), 'run', worker))
  assert.equal(g.snapshot('run').retries[id], 1)
  never(g, g.reserve(input(id, 'another-explicit-retry', { generation: 2, kind: 'retry' }), 'run', worker))
  assert.equal(g.snapshot('run').retries[id], 2)
  rejectAndReclaim(store, id)
  assert.throws(() => g.reserve(input(id, 'actual-next-rework', { generation: 3 }), 'run', worker), code('E_BUDGET_EXHAUSTED'))
})

test('pre-admission rejection history cannot be reset by first governor admission', t => {
  const { store, governor: g } = setup(t)
  const id = task(store)
  for (let i = 0; i < 3; i++) rejectAndReclaim(store, id)
  assert.throws(() => g.reserve(input(id), 'run', worker), code('E_BUDGET_EXHAUSTED'))
  assert.equal(g.snapshot('run').reservations.length, 0)
})

test('real rework debit rolls back with audit failure and retries exactly once after reopening', t => {
  const { store, governor: g } = setup(t)
  const id = task(store)
  rejectAndReclaim(store, id)
  const request = input(id, 'audit-rework', { resources: ['repo'] })
  const before = g.snapshot('run')
  store.open().exec("CREATE TEMP TRIGGER fail_rework_audit BEFORE INSERT ON governor_audit BEGIN SELECT RAISE(ABORT,'rework audit failure'); END")
  assert.throws(() => g.reserve(request, 'run', worker), /rework audit failure/)
  assert.deepEqual(g.snapshot('run'), before)
  store.open().exec('DROP TRIGGER fail_rework_audit')
  const r = g.reserve(request, 'run', worker)
  assert.equal(g.snapshot('run').retries[id], 1)
  store.close()
  const reopened = new TaskforceStore(store.root)
  t.after(() => reopened.close())
  const g2 = new TaskforceGovernor(reopened)
  assert.deepEqual(g2.reserve(request, 'run', worker), r)
  assert.equal(g2.snapshot('run').retries[id], 1)
  assert.equal(g2.snapshot('run').holds.length, 1)
})

test('legacy reservations acquire additive retry accounting without erasing explicit charges or real rejection history', t => {
  const store = tempStore(t), id = task(store)
  // The task history is generated by public APIs; only the old governor schema
  // and old persisted intents are fixture SQL, matching the shipped v1 format.
  rejectAndReclaim(store, id)
  rejectAndReclaim(store, id)
  const db = store.open()
  db.exec(`CREATE TABLE governor_reservation (
    reservation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id INTEGER NOT NULL,
    operation_key TEXT NOT NULL, payload TEXT NOT NULL, generation INTEGER NOT NULL,
    mode TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    owner_session TEXT, session_id TEXT, settlement TEXT,
    UNIQUE(run_id, operation_key), UNIQUE(task_id, generation)
  )`)
  const requests = ['new', 'reuse', 'retry'].map((kind, i) => input(id, `legacy-${i}`, { kind, generation: i }))
  for (const [i, request] of requests.entries()) {
    const { operation_key, ...payload } = request
    db.prepare('INSERT INTO governor_reservation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`legacy-id-${i}`, 'run', id, operation_key, JSON.stringify(payload), i + 1, 'read', request.kind, i === 2 ? 'reserved' : 'settled', 'child', null, JSON.stringify({ kind: 'never_started' }))
  }
  const g = new TaskforceGovernor(store)
  assert.throws(() => withWriteTransaction(db, () => {
    assert.equal(g.snapshot('run').retries[id], 3)
    throw new Error('rollback legacy migration')
  }), /rollback legacy migration/)
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'governor_retry_charge'").get(), undefined)
  // Old rows did not capture rejection generations: conservatively preserve
  // the explicit charge AND two observed reworks, without guessing overlap.
  assert.equal(g.snapshot('run').retries[id], 3)
  assert.equal(g.snapshot('run').created_total, 1)
  assert.equal(g.reserve(requests[0], 'run', worker).reservation_id, 'legacy-id-0')
  const pending = g.reserve(requests[2], 'run', worker)
  assert.equal(pending.state, 'reserved')
  // A migration baseline cannot invent the revision of the old admission.
  assert.throws(() => g.bind(ref(pending, { session_id: 'child' }), 'run', worker), code('E_GOVERNOR_FENCE'))
  assert.equal(g.snapshot('run').active_total, 1)
  never(g, pending)
  assert.throws(() => g.reserve(input(id, 'after-migration', { generation: 3 }), 'run', worker), code('E_BUDGET_EXHAUSTED'))
  store.close()
  const reopened = new TaskforceStore(store.root)
  t.after(() => reopened.close())
  const g2 = new TaskforceGovernor(reopened)
  assert.equal(g2.snapshot('run').retries[id], 3)
  assert.equal(g2.reserve(requests[2], 'run', worker).reservation_id, 'legacy-id-2')
  g2.extendBudget({ max_retries: 4, reason: 'reviewed conservative legacy overlap' }, 'run', lead)
  g2.reserve(input(id, 'after-migration', { generation: 3 }), 'run', worker)
  assert.equal(g2.snapshot('run').retries[id], 3)
})

for (const hidden of [null, 'task_run', 'evidence_generation']) test('Task16 legacy joined projection preserves legal width and hidden native conversion: ' + hidden, t => {
  const store = tempStore(t), full = 'root\0suffix', id = store.openTask({ title: 'legacy width' }, full).task_id, db = store.open()
  // Compatibility characterization: public task plus an old schema with extension columns.
  // The two original joined columns consume the remaining SQLite result slots.
  const extra = ['task_run', 'evidence_generation', '', '__proto__', '12', '2', 'odd"列', ...Array.from({ length: 1979 }, (_, i) => 'extra_' + i)]
  const quote = name => '"' + name.replaceAll('"', '""') + '"'
  db.exec(`CREATE TABLE governor_reservation (
    reservation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id INTEGER NOT NULL,
    operation_key TEXT NOT NULL, payload TEXT NOT NULL, generation INTEGER NOT NULL,
    mode TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    owner_session TEXT, session_id TEXT, settlement TEXT, ${extra.map(quote).join(',')},
    UNIQUE(run_id, operation_key), UNIQUE(task_id, generation));
    CREATE TABLE governor_retry_charge (reservation_id TEXT PRIMARY KEY, rework_generation INTEGER NOT NULL, retry_charge INTEGER NOT NULL, source TEXT NOT NULL)`)
  db.prepare('INSERT INTO governor_reservation(reservation_id,run_id,task_id,operation_key,payload,generation,mode,kind,state,owner_session,task_run,evidence_generation,"","__proto__","12","2","odd""列") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('legacy', full, id, 'op', JSON.stringify({ resources: [] }), 1, 'read', 'retry', 'settled', 'safe',
      hidden === 'task_run' ? 9007199254740993n : 'hidden\0old', hidden === 'evidence_generation' ? 9007199254740993n : 73,
      'empty', 'prototype', 'twelve', 'two', 'quoted')
  const sql = `SELECT r.*, t.evidence_generation, t.run_id AS task_run
          FROM governor_reservation r LEFT JOIN task t ON t.id = r.task_id
          LEFT JOIN governor_retry_charge c USING(reservation_id)
          WHERE c.reservation_id IS NULL ORDER BY r.task_id, r.generation DESC`
  const original = db.prepare(sql)
  assert.equal(original.columns().length, 2000)
  let native, nativeError
  try { native = original.all()[0] } catch (error) { nativeError = error }
  if (hidden) assert.equal(nativeError?.code, 'ERR_OUT_OF_RANGE')
  else { assert.equal(nativeError, undefined); assert.equal(Object.keys(native).length, 1998) }
  const prepare = db.prepare.bind(db), calls = { original: { get: 0, all: 0, iterate: 0, run: 0 }, generated: { get: 0, all: 0, iterate: 0, run: 0 } }
  let returned
  const preparations = { original: 0, generated: 0 }, names = original.columns().map(column => column.name)
  db.prepare = query => {
    const statement = prepare(query)
    if (query.includes('WHERE c.reservation_id IS NULL ORDER BY r.task_id, r.generation DESC')) {
      const kind = query.startsWith('SELECT r.*') ? 'original' : 'generated'
      preparations[kind]++
      assert.equal(statement.columns().length, 2000)
      assert.deepEqual(statement.columns().map(column => column.name), names)
      for (const method of ['get', 'all', 'iterate', 'run']) {
        const read = statement[method].bind(statement)
        statement[method] = (...args) => { calls[kind][method]++; const result = read(...args); if (kind === 'generated' && method === 'all') returned = result[0]; return result }
      }
    }
    return statement
  }
  const g = new TaskforceGovernor(store)
  if (hidden) {
    assert.throws(() => g.snapshot(full), error => error.code === nativeError.code && error.message === nativeError.message)
    assert.equal(db.prepare('SELECT count(*) AS n FROM governor_retry_charge').get().n, 0)
    assert.equal(db.isTransaction, false)
  } else {
    assert.equal(g.snapshot(full).retries[id], 1)
    assert.equal(returned.run_id, full); assert.equal(returned.task_run, full); assert.equal(returned.evidence_generation, 0)
    const descriptors = Object.getOwnPropertyDescriptors(native); descriptors.run_id.value = full; descriptors.task_run.value = full
    assert.deepEqual(Object.getOwnPropertyDescriptors(returned), descriptors)
    assert.deepEqual(Object.keys(returned), Object.keys(native)); assert.equal(Object.getPrototypeOf(returned), null)
    assert.equal(db.prepare('SELECT retry_charge FROM governor_retry_charge').get().retry_charge, 1)
  }
  assert.deepEqual(calls, { original: { get: 0, all: 0, iterate: 0, run: 0 }, generated: { get: 0, all: 1, iterate: 0, run: 0 } })
  assert.deepEqual(preparations, { original: 1, generated: 1 })
})

test('rejection after reservation fences bind until rework is admitted and charged', t => {
  const { store, governor: g } = setup(t)
  const id = task(store), request = input(id, 'before-rejection', { mode: 'write', resources: ['repo'] })
  const r = g.reserve(request, 'run', worker)
  rejectAndReclaim(store, id)
  // Same-key lookup must remain idempotent but cannot authorize the new revision.
  assert.deepEqual(g.reserve(request, 'run', worker), r)
  assert.throws(() => g.bind(ref(r, { session_id: 'child' }), 'run', worker), code('E_GOVERNOR_FENCE'))
  assert.equal(g.snapshot('run').holds.length, 1)
  assert.equal(g.snapshot('run').active_total, 1)
  never(g, r)
  const rework = g.reserve(input(id, 'after-rejection', { generation: 1, resources: ['repo'] }), 'run', worker)
  assert.equal(g.snapshot('run').retries[id], 1)
  assert.equal(g.bind(ref(rework, { session_id: 'child' }), 'run', worker).state, 'running')
})

function durableGovernorRows(store) {
  return JSON.stringify(['governor_run', 'governor_reservation', 'governor_retry_charge', 'governor_hold', 'governor_audit']
    .map(table => ({ table, rows: store.open().prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all() })))
}

for (const kind of ['never_started', 'terminal']) {
  test(`historical settled ${kind} replay is read-only after a newer admission and reopening`, t => {
    const { store, governor: g } = setup(t)
    const id = task(store)
    const r1 = g.reserve(input(id, 'historical', { kind: 'new', mode: 'write', resources: ['repo'] }), 'run', worker)
    const proof = kind === 'never_started' ? { kind } : { kind, outcome: 'succeeded', quiescent: true, evidence: 'trusted stopped subtree' }
    if (kind === 'terminal') g.bind(ref(r1, { session_id: 'child' }), 'run', worker)
    const settled = g.settle(ref(r1, { proof }), 'run', worker)
    const r2 = g.reserve(input(id, 'current', { generation: r1.generation, kind: 'retry', mode: 'write', resources: ['repo'] }), 'run', worker)
    const before = JSON.stringify(g.snapshot('run')), rows = durableGovernorRows(store)
    assert.equal(g.snapshot('run').active_total, 1)
    assert.equal(g.snapshot('run').active_writers, 1)
    assert.equal(g.snapshot('run').created_total, 1)
    assert.equal(g.snapshot('run').retries[id], 1)
    assert.equal(g.snapshot('run').holds[0].reservation_id, r2.reservation_id)
    assert.throws(() => g.bind(ref(r1, { session_id: 'child' }), 'run', worker), code('E_GOVERNOR_FENCE'))
    assert.throws(() => g.markUnknown(ref(r1, { reason: 'late observation' }), 'run', worker), code('E_GOVERNOR_FENCE'))
    assert.throws(() => g.settle(ref(r1, { generation: r2.generation, proof }), 'run', worker), code('E_GOVERNOR_FENCE'))
    // Normalization makes property order irrelevant without changing trusted evidence.
    const replayProof = kind === 'terminal'
      ? { evidence: proof.evidence, quiescent: true, outcome: proof.outcome, kind }
      : { kind }
    assert.deepEqual(g.settle(ref(r1, { proof: replayProof }), 'run', worker), settled)
    assert.equal(JSON.stringify(g.snapshot('run')), before)
    assert.equal(durableGovernorRows(store), rows)
    store.close()
    const reopened = new TaskforceStore(store.root)
    t.after(() => reopened.close())
    const restored = new TaskforceGovernor(reopened)
    assert.deepEqual(restored.settle(ref(r1, { proof: replayProof }), 'run', worker), settled)
    assert.equal(JSON.stringify(restored.snapshot('run')), before)
    assert.equal(durableGovernorRows(reopened), rows)
  })
}

test('historical settlement conflicts and scope or row-generation mistakes cannot mutate a newer reservation', t => {
  const { store, governor: g } = setup(t)
  const id = task(store)
  const r1 = g.reserve(input(id, 'old'), 'run', worker)
  never(g, r1, 'run', worker)
  const r2 = g.reserve(input(id, 'new', { generation: r1.generation, mode: 'write', resources: ['repo'] }), 'run', worker)
  const before = JSON.stringify(g.snapshot('run')), rows = durableGovernorRows(store)
  assert.throws(() => g.settle(ref(r1, { proof: { kind: 'terminal', outcome: 'failed', quiescent: true, evidence: 'different proof' } }), 'run', worker),
    error => error.code === 'E_GOVERNOR_CONFLICT' && error.message === 'settlement conflicts with durable proof')
  assert.throws(() => never(g, { ...r1, generation: r2.generation }, 'run', worker), code('E_GOVERNOR_FENCE'))
  assert.throws(() => never(g, r1, 'other', lead), code('E_GOVERNOR_CONFLICT'))
  assert.throws(() => never(g, r1, 'run', { role: 'worker', sessionId: 'stranger' }), code('E_GOVERNOR_CONFLICT'))
  assert.equal(JSON.stringify(g.snapshot('run')), before)
  assert.equal(durableGovernorRows(store), rows)
})

test('historical settled replay still requires both current and captured worker ownership', t => {
  const { store, governor: g } = setup(t)
  const id = task(store)
  const r1 = g.reserve(input(id, 'old-owner'), 'run', worker)
  const settled = never(g, r1, 'run', worker)
  g.reserve(input(id, 'current-owner', { generation: r1.generation, mode: 'write', resources: ['repo'] }), 'run', worker)
  store.submitTask({ task_id: id }, 'run', { isRoot: false, sessionId: 'child' })
  store.rejectTask({ task_id: id, reason: 'replace executor' }, 'run', { isRoot: true, sessionId: 'root' })
  store.claimTask({ task_id: id, child_id: 'replacement' }, 'run', { isRoot: true, sessionId: 'root' }, 'replacement')
  const before = JSON.stringify(g.snapshot('run')), rows = durableGovernorRows(store)
  for (const actor of [worker, { role: 'worker', sessionId: 'replacement' }]) {
    assert.throws(() => never(g, r1, 'run', actor), code('E_GOVERNOR_CONFLICT'))
  }
  assert.deepEqual(never(g, r1, 'run', lead), settled)
  assert.equal(JSON.stringify(g.snapshot('run')), before)
  assert.equal(durableGovernorRows(store), rows)
})

// Task19 P5: public fresh cases; inherited Node24 seed coverage is separate.
for (const [position, resources, independent] of [
  ['leading', ['\u0000lock-A', '\u0000lock-B'], ['lock-A', '\u0000lock-C']],
  ['middle', ['lock\u0000A', 'lock\u0000B'], ['lock', 'lock\u0000C']],
  ['trailing', ['lock-A\u0000', 'lock-B\u0000'], ['lock-A', 'lock-B']],
  ['literal', ['Tlock', 'J"lock"', '{"lock":true}', 'lock\\u0000', '锁🔑'], ['ordinary-lock']],
]) test('Task19 opaque resource hold identities agree with reservation payload: ' + position, t => {
  const { store, governor: g } = setup(t)
  const expected = [...resources].sort()
  const held = g.reserve(input(task(store), 'held', { mode: 'write', resources }), 'run', lead)
  const independentRow = g.reserve(input(task(store), 'independent', { resources: independent }), 'run', lead)
  const blocked = input(task(store), 'blocked')
  const check = (governor, source) => {
    const stored = source.open().prepare('SELECT json_quote(resource_key) AS value, typeof(resource_key) AS type FROM governor_hold WHERE reservation_id = ?').all(held.reservation_id)
    assert.deepEqual(stored.map(row => { assert.equal(row.type, 'text'); return JSON.parse(row.value) }).sort(), expected)
    const snapshot = governor.snapshot('run')
    const row = snapshot.reservations.find(row => row.reservation_id === held.reservation_id)
    assert.ok(row)
    assert.deepEqual(row.resources, expected)
    assert.deepEqual(snapshot.holds.filter(row => row.reservation_id === held.reservation_id)
      .map(row => row.resource_key).sort(), expected)
    assert.equal(snapshot.active_total, 2)
    assert.equal(snapshot.active_writers, 1)
    for (const resource of resources) {
      assert.throws(() => governor.reserve({ ...blocked, resources: [resource] }, 'run', lead), code('E_RESOURCE_BUSY'))
    }
    assert.deepEqual(governor.snapshot('run'), snapshot)
  }
  check(g, store)
  store.close()
  const reopened = new TaskforceStore(store.root)
  try {
    const restored = new TaskforceGovernor(reopened)
    check(restored, reopened)
    assert.equal(never(restored, held).state, 'settled')
    const remaining = restored.snapshot('run').holds
    assert.ok(remaining.every(row => row.reservation_id === independentRow.reservation_id))
    assert.deepEqual(remaining.map(row => row.resource_key).sort(), [...independent].sort())
    const released = restored.reserve({ ...blocked, resources }, 'run', lead)
    assert.deepEqual(released.resources, expected)
  } finally { reopened.close() }
})

for (const [position, fullRun, fullActor] of [
  ['leading', '\u0000run', '\u0000lead'],
  ['middle', 'run\u0000tail', 'lead\u0000tail'],
  ['trailing', 'run\u0000', 'lead\u0000'],
  ['literal-T', 'Trun', 'Tlead'],
  ['literal-J', 'J"run"', 'J"lead"'],
  ['literal-JSON', '{"run":true}', '{"lead":true}'],
  ['literal-backslash', 'run\\u0000tail', 'lead\\u0000tail'],
  ['Unicode', '运行🔑', '负责人🔑'],
]) for (const selected of ['run', 'actor', 'both']) {
  test('Task19 governor snapshot preserves full audit run and actor: ' + position + '/' + selected, t => {
    const { store, governor: g } = setup(t)
    const scope = selected === 'actor' ? 'run' : fullRun
    const actor = { role: 'lead', sessionId: selected === 'run' ? 'lead' : fullActor }
    const limits = g.extendBudget({ reason: 'audit', max_active: 7 }, scope, actor)
    g.extendBudget({ reason: 'other audit', max_active: 8 }, 'other-run', lead)
    const check = (governor, source) => {
      const stored = source.open().prepare("SELECT json_quote(run_id) AS run, typeof(run_id) AS run_type, json_quote(session_id) AS actor, typeof(session_id) AS actor_type FROM governor_audit WHERE run_id = ? AND action = 'extendBudget'").all(scope)
      assert.deepEqual(stored.map(row => [JSON.parse(row.run), row.run_type, JSON.parse(row.actor), row.actor_type]),
        [[scope, 'text', actor.sessionId, 'text']])
      const snapshot = governor.snapshot(scope)
      assert.equal(snapshot.run_id, scope)
      assert.deepEqual(snapshot.limits, limits)
      assert.equal(snapshot.audit.length, 1)
      assert.equal(snapshot.audit[0].run_id, scope)
      assert.equal(snapshot.audit[0].session_id, actor.sessionId)
      assert.equal(snapshot.audit[0].action, 'extendBudget')
      assert.equal(snapshot.audit[0].reservation_id, null)
      assert.equal(snapshot.audit[0].details.reason, 'audit')
      assert.equal(snapshot.audit[0].details.after.max_active, 7)
      assert.deepEqual(snapshot.reservations, [])
      assert.deepEqual(snapshot.holds, [])
      assert.equal(governor.snapshot('other-run').audit.length, 1)
      assert.equal(governor.snapshot('missing-run').audit.length, 0)
    }
    check(g, store)
    store.close()
    const reopened = new TaskforceStore(store.root)
    try {
      check(new TaskforceGovernor(reopened), reopened)
    } finally { reopened.close() }
  })
}

for (const [position, scope, owner] of [
  ['leading', '\u0000run', '\u0000worker'],
  ['middle', 'run\u0000tail', 'worker\u0000tail'],
  ['trailing', 'run\u0000', 'worker\u0000'],
  ['literal', 'J"run"\\u0000', 'Tworker\\u0000'],
]) test('Task19 post16 governor full-run results survive creation, transitions and reopen: ' + position, t => {
  const { store, governor: g } = setup(t), actor = { role: 'worker', sessionId: owner }
  const args = input(task(store, scope, owner), 'bound')
  const row = g.reserve(args, scope, actor)
  const checkStored = (source, reservation, session) => {
    const stored = source.open().prepare('SELECT json_quote(run_id) AS run, typeof(run_id) AS run_type, json_quote(owner_session) AS owner, typeof(owner_session) AS owner_type, json_quote(session_id) AS session, typeof(session_id) AS session_type FROM governor_reservation WHERE reservation_id = ?').get(reservation.reservation_id)
    assert.deepEqual([JSON.parse(stored.run), stored.run_type, JSON.parse(stored.owner), stored.owner_type, JSON.parse(stored.session), stored.session_type],
      [scope, 'text', owner, 'text', session, session === null ? 'null' : 'text'])
  }
  checkStored(store, row, null)
  assert.equal(row.run_id, scope)
  assert.equal(row.session_id, null)
  assert.equal(row.generation, 1)
  assert.deepEqual(g.reserve(args, scope, actor), row)
  const bound = g.bind(ref(row, { session_id: owner }), scope, actor)
  checkStored(store, bound, owner)
  assert.equal(bound.run_id, scope)
  assert.equal(bound.session_id, owner)
  assert.equal(bound.state, 'running')
  assert.deepEqual(g.bind(ref(row, { session_id: owner }), scope, actor), bound)
  assert.deepEqual(g.reserve(args, scope, actor), bound)
  assert.deepEqual(g.snapshot(scope).reservations, [bound])
  const unknown = g.markUnknown(ref(row, { reason: 'delivery unknown' }), scope, actor)
  assert.equal(unknown.run_id, scope)
  assert.equal(unknown.session_id, owner)
  assert.equal(unknown.state, 'unknown')
  assert.deepEqual(g.markUnknown(ref(row, { reason: 'delivery unknown' }), scope, actor), unknown)

  // A separate unbound reservation exercises never_started without inventing a terminal proof.
  const unboundArgs = input(task(store, scope, owner), 'unbound', { resources: ['unbound-resource'] })
  const unbound = g.reserve(unboundArgs, scope, actor)
  assert.equal(unbound.run_id, scope)
  assert.equal(unbound.session_id, null)
  const settled = never(g, unbound, scope, actor)
  assert.equal(settled.run_id, scope)
  assert.equal(settled.session_id, null)
  assert.equal(settled.state, 'settled')
  assert.deepEqual(never(g, unbound, scope, actor), settled)
  const check = (governor, source) => {
    checkStored(source, unknown, owner)
    checkStored(source, settled, null)
    const snapshot = governor.snapshot(scope)
    assert.deepEqual(snapshot.reservations, [unknown, settled])
    assert.equal(snapshot.active_total, 1)
    assert.equal(snapshot.unknown_total, 1)
    assert.equal(snapshot.retry_charges.length, 2)
    assert.ok(snapshot.retry_charges.every(row => row.source === 'admission' && row.retry_charge === 0))
    assert.deepEqual(snapshot.holds, [])
    assert.deepEqual(governor.reserve(args, scope, actor), unknown)
    assert.deepEqual(governor.reserve(unboundArgs, scope, actor), settled)
    assert.deepEqual(never(governor, unbound, scope, actor), settled)
  }
  check(g, store)
  store.close()
  const reopened = new TaskforceStore(store.root)
  try {
    const restored = new TaskforceGovernor(reopened)
    check(restored, reopened)
    const before = reopened.open().prepare('SELECT total_changes() AS n').get().n
    check(restored, reopened)
    assert.equal(reopened.open().prepare('SELECT total_changes() AS n').get().n, before)
  } finally { reopened.close() }
})
