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
