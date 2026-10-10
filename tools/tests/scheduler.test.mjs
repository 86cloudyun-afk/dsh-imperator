import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskforceStore } from '../../lib/store/index.js'
import { TaskforceGovernor, createNativeGovernorAdapter } from '../../lib/governor/index.js'
import { withWriteTransaction } from '../../lib/store/sqlite.js'
import { tempStore } from './helpers.mjs'

const module = await import('../../lib/scheduler/index.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e })
const host = await import('../../lib/scheduler/dsh-host.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e })
const lead = { role: 'lead', sessionId: ' root ' }
const worker = { role: 'worker', sessionId: ' child ' }
const run = ' run '
const code = code => ({ code })
function setup(t) {
  assert.equal(typeof module.TaskforceScheduler, 'function', 'durable scheduler missing')
  const store = tempStore(t)
  return { store, scheduler: new module.TaskforceScheduler(store), governor: new TaskforceGovernor(store) }
}
function task(store, owner = worker.sessionId, scope = run) {
  const id = store.openTask({ title: 'queued' }, scope).task_id
  store.claimTask({ task_id: id, child_id: 'label' }, scope, { sessionId: owner, isRoot: false }, owner)
  return id
}
function input(id, extra = {}) {
  return { request_key: 'queue-' + id, task_id: id, generation: 0, mode: 'read', kind: 'reuse', resources: [], ...extra }
}
function admit(scheduler, key = 'admit') { return scheduler.admitNext({ request_key: key }, run, lead) }
function ref(row, extra = {}) { return { request_id: row.request_id, generation: row.generation, ...extra } }

test('queue replay, atomic admission, and dispatch-decision replay never consume the next request', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const a = s.enqueue(input(task(store)), run, worker)
  assert.deepEqual(s.enqueue(input(a.task_id), run, worker), a)
  s.enqueue(input(task(store)), run, lead)
  assert.equal(g.snapshot(run).active_total, 0)
  const first = admit(s)
  assert.equal(first.status, 'admitted')
  assert.equal(first.request.request_id, a.request_id)
  assert.equal(first.replay, false)
  const replay = admit(s)
  assert.equal(replay.replay, true)
  assert.equal(replay.request.request_id, a.request_id)
  assert.equal(g.snapshot(run).active_total, 1)
  assert.equal(s.state({}, run, lead).requests.filter(x => x.state === 'queued').length, 1)
  assert.throws(() => s.enqueue(input(a.task_id, { mode: 'write' }), run, lead), code('E_SCHEDULER_CONFLICT'))
})

test('queue and governor changes roll back together on admission metadata failure', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  s.enqueue(input(task(store), { mode: 'write', resources: ['repo'] }), run, lead)
  store.open().exec("CREATE TRIGGER reject_scheduler_decision BEFORE INSERT ON scheduler_decision BEGIN SELECT RAISE(ABORT, 'injected decision failure'); END")
  assert.throws(() => admit(s), /injected decision failure/)
  assert.equal(g.snapshot(run).active_total, 0)
  assert.equal(g.snapshot(run).holds.length, 0)
  assert.equal(s.state({}, run, lead).requests[0].state, 'queued')
  store.open().exec('DROP TRIGGER reject_scheduler_decision')
  assert.equal(admit(s).status, 'admitted')
})

test('cross-run resource contention preserves FIFO and blocked decision replay', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const external = task(store, worker.sessionId, 'other')
  const lock = g.reserve({ operation_key: 'lock', task_id: external, generation: 0, kind: 'reuse', mode: 'write', resources: ['repo'] }, 'other', lead)
  s.enqueue(input(task(store), { mode: 'write', resources: ['repo'] }), run, lead)
  s.enqueue(input(task(store)), run, lead)
  assert.equal(admit(s).code, 'E_RESOURCE_BUSY')
  assert.equal(g.snapshot(run).active_total, 0)
  g.settle({ reservation_id: lock.reservation_id, generation: lock.generation, proof: { kind: 'never_started' } }, 'other', lead)
  assert.equal(admit(s).status, 'blocked')
  assert.equal(admit(s, 'after-release').status, 'admitted')
})

test('unknown survives reopening and keeps shared locks without dispatch or automatic release', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  s.enqueue(input(task(store), { mode: 'write', resources: ['repo'] }), run, lead)
  const row = admit(s).request
  s.bind(ref(row, { session_id: worker.sessionId }), run, worker)
  s.markUnknown(ref(row, { reason: 'DELIVERY_UNKNOWN' }), run, worker)
  const root = store.root
  store.close()
  const reopened = new TaskforceStore(root)
  t.after(() => reopened.close())
  const r = new module.TaskforceScheduler(reopened)
  assert.equal(r.state({}, run, lead).requests[0].state, 'unknown')
  assert.throws(() => r.bind(ref(row, { session_id: worker.sessionId }), run, worker), code('E_GOVERNOR_CONFLICT'))
  assert.throws(() => r.settle(ref(row, { proof: { kind: 'never_started' } }), run, lead), code('E_GOVERNOR_CONFLICT'))
  assert.equal(new TaskforceGovernor(reopened).snapshot(run).holds.length, 1)
  r.settle(ref(row, { proof: { kind: 'terminal', outcome: 'failed', quiescent: true, evidence: 'trusted-supervisor-record' } }), run, lead)
  assert.equal(new TaskforceGovernor(reopened).snapshot(run).active_total, 0)
  assert.equal(r.state({}, run, lead).requests[0].state, 'settled')
})

test('trusted scope, actor, bounded resources, and exact whitespace identities are enforced', t => {
  const { store, scheduler: s } = setup(t)
  const id = task(store)
  assert.throws(() => s.enqueue(input(id), 'run', lead), code('E_SCHEDULER_CONFLICT'))
  assert.throws(() => s.enqueue(input(id), run, { ...worker, sessionId: 'child' }), code('E_SCHEDULER_CONFLICT'))
  assert.throws(() => s.enqueue(input(id, { run_id: 'forged' }), run, lead), code('E_SCHEDULER_CONFLICT'))
  assert.throws(() => s.enqueue(input(id, { resources: Array(65).fill('x') }), run, lead), code('E_SCHEDULER_CONFLICT'))
  assert.throws(() => s.admitNext({ request_key: 'x' }, run, worker), code('E_SCHEDULER_CONFLICT'))
  const row = s.enqueue(input(id), run, worker)
  assert.equal(row.run_id, run)
  assert.equal(s.state({}, run, { role: 'worker', sessionId: 'stranger' }).requests.length, 0)
})

test('bounded keyset state filters workers and retains stable sequence identifiers', t => {
  const { store, scheduler: s } = setup(t)
  for (let i = 0; i < 28; i++) s.enqueue(input(task(store)), run, lead)
  const page = s.state({}, run, lead)
  assert.equal(page.requests.length, 25)
  assert.equal(page.has_more, true)
  const rest = s.state({ after: page.next_after }, run, lead)
  assert.equal(rest.requests.length, 3)
  assert.equal(rest.has_more, false)
  assert.equal(rest.next_after, null)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536)
  assert.throws(() => s.state({ limit: 101 }, run, lead), code('E_SCHEDULER_CONFLICT'))
})

test('stale queue intents refuse without charging and subsequent queue work can progress', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const id = task(store)
  s.enqueue(input(id), run, lead)
  const direct = g.reserve({ operation_key: 'direct', task_id: id, generation: 0, kind: 'reuse', mode: 'read', resources: [] }, run, lead)
  g.settle({ reservation_id: direct.reservation_id, generation: direct.generation, proof: { kind: 'never_started' } }, run, lead)
  s.enqueue(input(task(store)), run, lead)
  assert.equal(admit(s).status, 'refused')
  assert.equal(s.state({}, run, lead).requests[0].state, 'refused')
  assert.equal(admit(s, 'next').status, 'admitted')
  assert.equal(g.snapshot(run).created_total, 0)
})

test('outer rollback does not cache absent scheduler tables or split governor state', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const id = task(store)
  assert.throws(() => withWriteTransaction(store.open(), () => {
    s.enqueue(input(id), run, lead)
    admit(s)
    throw new Error('outer rollback')
  }), /outer rollback/)
  assert.equal(s.state({}, run, lead).requests.length, 0)
  assert.equal(g.snapshot(run).active_total, 0)
  assert.equal(s.enqueue(input(id), run, lead).state, 'queued')
})

test('native diagnostics cannot enable official mode from versions flags or callbacks', () => {
  assert.equal(typeof host.nativeSchedulerCapabilities, 'function', 'native diagnostics missing')
  for (const version of ['0.2.0-rc.2', '0.2.1-alpha.2', '9.0.0']) {
    const report = host.nativeSchedulerCapabilities({ version, verified: true, admission: () => true })
    assert.equal(report.native_enabled, false)
    assert.equal(report.capabilities.length, 6)
    assert.ok(report.capabilities.every(c => c.enabled === false))
    assert.throws(() => createNativeGovernorAdapter(report), code('E_SCHEDULER_CAPABILITY'))
  }
})

test('strict checkpoint readback rejects listener-only success, mismatches, and closes raw reader', async () => {
  assert.equal(typeof host.flushNativeCheckpoint, 'function', 'strict checkpoint helper missing')
  const session = { header: { id: 'actual' }, events: [{ seq: 0, type: 'test', data: { value: 1 } }] }
  let closed = 0, durable = { header: session.header, events: session.events }
  const backend = { async flush() {}, async open(id, mode) { assert.equal(id, 'actual'); assert.equal(mode, 'read'); return { id, access: mode, header: session.header, async read() { return durable }, async close() { closed++ } } } }
  const sessions = { get: id => id === 'actual' ? session : undefined, async flush() { return true } }
  const ctx = { get: name => ({ sessions, sessionPersistence: backend })[name] }
  const args = { version: '0.2.0-rc.2', session, persistence: backend }
  const result = await host.flushNativeCheckpoint(ctx, args)
  assert.equal(result.session_id, 'actual')
  assert.equal(result.last_seq, 0)
  assert.match(result.digest, /^[a-f0-9]{64}$/)
  assert.equal(closed, 1)
  durable = { header: session.header, events: [] }
  await assert.rejects(() => host.flushNativeCheckpoint(ctx, args), code('E_SCHEDULER_CAPABILITY'))
  assert.equal(closed, 2)
  sessions.flush = async () => false
  await assert.rejects(() => host.flushNativeCheckpoint(ctx, args), code('E_SCHEDULER_CAPABILITY'))
  sessions.flush = async () => true
  await assert.rejects(() => host.flushNativeCheckpoint(ctx, { ...args, persistence: {} }), code('E_SCHEDULER_CAPABILITY'))
})

test('prepared identity uses the exact live ancestor chain and never creates or delivers an agent', () => {
  assert.equal(typeof host.prepareNativeIdentity, 'function', 'prepared identity helper missing')
  const root = { id: ' root ', session: { header: { id: ' root ', cwd: '/repo' } } }
  const child = { id: ' child ', session: { header: { id: ' child ', parentSession: root.id, origin: 'subagent', delegationDepth: 1 } } }
  const agents = { get: id => [root, child].find(a => a.id === id), create() { assert.fail('preparation must not create') } }
  const ctx = { get: name => name === 'agents' ? agents : undefined }
  const value = host.prepareNativeIdentity(ctx, { version: '0.2.0-rc.2', parentAgent: child, session_id: ' reserved ' })
  assert.equal(value.root_run_id, root.id)
  assert.equal(value.parent_session_id, child.id)
  assert.equal(value.session_id, ' reserved ')
  assert.equal(value.delegation_depth, 2)
  assert.throws(() => host.prepareNativeIdentity(ctx, { version: '0.2.0-rc.2', parentAgent: { ...child }, session_id: 'x' }), code('E_SCHEDULER_CAPABILITY'))
  child.session.header.parentSession = 'missing'
  assert.throws(() => host.prepareNativeIdentity(ctx, { version: '0.2.0-rc.2', parentAgent: child, session_id: 'x' }), code('E_SCHEDULER_CAPABILITY'))
})
