import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
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

test('Task16 scheduler withdrawal checks complete owner before replay and preserves decisions on refusal', t => {
  const { store, scheduler: s } = setup(t), full = 'worker\0suffix', id = task(store, full)
  const args = input(id), queued = s.enqueue(args, run, lead)
  const withdraw = sessionId => s.withdraw({ request_id: queued.request_id, request_key: 'withdraw' }, run, { role: 'worker', sessionId })
  const snapshot = () => ({ rows: ['scheduler_request', 'scheduler_decision'].map(table => store.open().prepare('SELECT * FROM ' + table).all()),
    exact: store.open().prepare('SELECT json_quote(run_id) AS run, json_quote(owner_session) AS owner FROM scheduler_request').all() })
  let before = snapshot()
  assert.throws(() => withdraw('worker'), code('E_SCHEDULER_CONFLICT')); assert.deepEqual(snapshot(), before)
  assert.equal(s.state({}, run, { role: 'worker', sessionId: 'worker' }).requests.length, 0)
  assert.equal(s.enqueue(args, run, { role: 'worker', sessionId: full }).request_id, queued.request_id)
  assert.equal(withdraw(full).status, 'withdrawn')
  before = snapshot()
  assert.throws(() => withdraw('worker'), code('E_SCHEDULER_CONFLICT')); assert.deepEqual(snapshot(), before)
})

test('Task16 full run survives withdrawal response, persisted decision and exact replay', t => {
  const { store, scheduler: s } = setup(t), full = 'root\0suffix', owner = 'worker\0suffix'
  const id = task(store, owner, full), queued = s.enqueue(input(id), full, { role: 'lead', sessionId: full })
  const args = { request_id: queued.request_id, request_key: 'withdraw\0suffix' }, actor = { role: 'worker', sessionId: owner }
  const result = s.withdraw(args, full, actor)
  assert.equal(result.request.run_id, full)
  const saved = store.open().prepare('SELECT result FROM scheduler_decision WHERE run_id=? AND request_key=?').get(full, args.request_key).result
  assert.equal(JSON.parse(saved).result.request.run_id, full)
  const changes = store.open().prepare('SELECT total_changes() AS n').get().n
  const replay = s.withdraw(args, full, actor)
  assert.equal(replay.replay, true); assert.equal(replay.request.run_id, full)
  assert.equal(store.open().prepare('SELECT total_changes() AS n').get().n, changes)
})

test('Task16 full run flows through FIFO admission, queued and admitted state and transition', t => {
  const { store, scheduler: s } = setup(t), full = 'root\0suffix', owner = 'worker\0suffix'
  const id = task(store, owner, full), authority = { role: 'lead', sessionId: full }
  s.enqueue(input(id), full, authority)
  assert.equal(s.state({}, full, authority).requests[0].run_id, full)
  const admitted = s.admitNext({ request_key: 'admit' }, full, authority)
  assert.equal(admitted.status, 'admitted'); assert.equal(admitted.request.run_id, full)
  assert.equal(s.state({}, full, authority).requests[0].run_id, full)
  assert.equal(s.bind(ref(admitted.request, { session_id: owner }), full, { role: 'worker', sessionId: owner }).run_id, full)
})

for (const side of ['current', 'captured']) test('Task16 scheduler independently rejects different full ' + side + ' owner', t => {
  const { store, scheduler: s } = setup(t), a = 'worker\0first', b = 'worker\0second'
  const captured = side === 'current' ? b : a, current = side === 'current' ? a : b
  const id = task(store, captured), args = input(id)
  s.enqueue(args, run, lead)
  store.submitTask({ task_id: id }, run, { sessionId: captured, isRoot: false })
  store.rejectTask({ task_id: id, reason: 'reassign' }, run, { sessionId: run, isRoot: true })
  store.claimTask({ task_id: id, child_id: 'replacement' }, run, { sessionId: run, isRoot: true }, current)
  const before = s.state({}, run, lead), decisions = store.open().prepare('SELECT * FROM scheduler_decision').all()
  assert.throws(() => s.enqueue(args, run, { role: 'worker', sessionId: b }), code('E_SCHEDULER_CONFLICT'))
  assert.deepEqual(s.state({}, run, lead), before)
  assert.deepEqual(store.open().prepare('SELECT * FROM scheduler_decision').all(), decisions)
})

test('Task16 scheduler SQL request keys keep NUL keys distinct', t => {
  const { store, scheduler: s } = setup(t), id = task(store)
  const first = s.enqueue(input(id, { request_key: 'queue\0suffix' }), run, lead)
  const second = s.enqueue(input(id, { request_key: 'queue' }), run, lead)
  assert.notEqual(first.request_id, second.request_id)
  const before = s.state({}, run, lead)
  assert.throws(() => s.enqueue(input(id, { request_key: 'queue\0suffix', mode: 'write' }), run, lead), code('E_SCHEDULER_CONFLICT'))
  assert.deepEqual(s.state({}, run, lead), before)
})

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
  const session = { snapshotEvents() { return this.events }, header: { id: 'actual' }, events: [{ seq: 0, type: 'test', data: { value: 1 } }] }
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

function identityAgent(id, header = {}, options) {
  return { id, session: { header: { id, ...header } }, ...(options === undefined ? {} : { options }) }
}
function identityFixture(version, nodes) {
  const live = new Map(nodes.map(agent => [agent.id, agent])), lookups = []
  const agents = { get(id) { lookups.push(id); return live.get(id) },
    create() { assert.fail('identity preparation must not create an agent') } }
  return { live, lookups, prepare(parentAgent, session_id = ' reserved ') {
    return host.prepareNativeIdentity({ get: name => name === 'agents' ? agents : undefined },
      { version, parentAgent, session_id })
  } }
}
function preparedIdentity(fixture, parent, root, depth) {
  const value = fixture.prepare(parent)
  assert.deepEqual(value, { session_id: ' reserved ', parent_session_id: parent.id,
    root_run_id: root.id, delegation_depth: depth, native_enabled: false })
  assert.ok(Object.isFrozen(value))
}

for (const version of ['0.2.0-rc.2', '0.2.1-alpha.2']) {
  test(`H01 ${version}: an ordinary fork starts its own run without reading seed ancestry`, () => {
    const source = identityAgent('source', { origin: 'subagent', delegationDepth: 2, parentSession: 'offline' })
    const fork = identityAgent('fork', { parentSession: source.id, isSeeded: true })
    const fixture = identityFixture(version, [source, fork])
    preparedIdentity(fixture, fork, fork, 1)
    assert.ok(!fixture.lookups.includes(source.id))
  })
  test(`H01 ${version}: a fork and its real child work with the seed source offline`, () => {
    const fork = identityAgent('fork', { parentSession: 'offline-seed', isSeeded: true })
    const child = identityAgent('child', { parentSession: fork.id, origin: 'subagent', delegationDepth: 1 })
    const fixture = identityFixture(version, [fork, child])
    preparedIdentity(fixture, fork, fork, 1)
    preparedIdentity(fixture, child, fork, 2)
    assert.ok(!fixture.lookups.includes('offline-seed'))
  })
  test(`H01 ${version}: ordinary roots stop before even reading a seed parent field`, () => {
    const root = identityAgent('root', { delegationDepth: 0 }, { subagentDepth: 0 })
    Object.defineProperty(root.session.header, 'parentSession', { get() { assert.fail('seed ancestry must not be read') } })
    preparedIdentity(identityFixture(version, [root]), root, root, 1)
  })
  for (const [label, headerDepth, runtimeDepth, expected] of [
    ['ordinary root', undefined, undefined, 1],
    ['runtime-only child', undefined, 1, 2],
    ['runtime-only depth two', undefined, 2, null],
    ['durable depth survives runtime zero', 1, 0, 2],
    ['runtime deepens durable zero', 0, 1, 2],
    ['durable two survives runtime one', 2, 1, null],
    ['runtime two deepens durable one', 1, 2, null],
  ]) {
    test(`H01 ${version}: ${label}`, () => {
      const root = identityAgent('root')
      const current = label === 'ordinary root' ? root : identityAgent('child',
        { parentSession: root.id, delegationDepth: headerDepth }, { subagentDepth: runtimeDepth })
      const fixture = identityFixture(version, [root, current])
      if (expected === null) assert.throws(() => fixture.prepare(current), code('E_SCHEDULER_CAPABILITY'))
      else preparedIdentity(fixture, current, root, expected)
    })
  }
  test(`H01 ${version}: origin-only live delegation edges count toward the depth limit`, () => {
    const root = identityAgent('root', { parentSession: 'offline-seed' })
    const child = identityAgent('child', { parentSession: root.id, origin: 'subagent' })
    const grandchild = identityAgent('grandchild', { parentSession: child.id, origin: 'subagent' })
    const fixture = identityFixture(version, [root, child, grandchild])
    preparedIdentity(fixture, child, root, 2)
    assert.throws(() => fixture.prepare(grandchild), code('E_SCHEDULER_CAPABILITY'))
  })
  test(`H01 ${version}: a fork grandchild cannot prepare depth three`, () => {
    const fork = identityAgent('fork', { parentSession: 'offline-seed' })
    const child = identityAgent('child', { parentSession: fork.id, origin: 'subagent', delegationDepth: 1 })
    const grandchild = identityAgent('grandchild', { parentSession: child.id, origin: 'subagent', delegationDepth: 2 })
    assert.throws(() => identityFixture(version, [fork, child, grandchild]).prepare(grandchild), code('E_SCHEDULER_CAPABILITY'))
  })
  for (const [label, value] of [['negative', -1], ['negative zero', -0], ['fraction', 1.5], ['NaN', NaN],
    ['infinity', Infinity], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['null', null], ['string', '1'], ['boolean', true]]) {
    for (const source of ['durable', 'runtime']) {
      test(`H01 ${version}: rejects ${source} ${label} depth`, () => {
        const root = identityAgent('root')
        const current = identityAgent('child', { parentSession: root.id, delegationDepth: source === 'durable' ? value : 1 },
          { subagentDepth: source === 'runtime' ? value : 1 })
        assert.throws(() => identityFixture(version, [root, current]).prepare(current), code('E_SCHEDULER_CAPABILITY'))
      })
    }
  }
  test(`H01 ${version}: validates runtime depths on live ancestors too`, () => {
    const root = identityAgent('root', {}, { subagentDepth: -1 })
    const child = identityAgent('child', { parentSession: root.id, origin: 'subagent', delegationDepth: 1 })
    assert.throws(() => identityFixture(version, [root, child]).prepare(child), code('E_SCHEDULER_CAPABILITY'))
  })
  for (const parentSession of [undefined, null, '', 'offline']) {
    for (const classification of ['origin', 'durable', 'runtime']) {
      test(`H01 ${version}: ${classification} delegation refuses missing parent ${String(parentSession)}`, () => {
        const child = identityAgent('child', { parentSession,
          ...(classification === 'origin' ? { origin: 'subagent' } : {}),
          ...(classification === 'durable' ? { delegationDepth: 1 } : {}) },
        classification === 'runtime' ? { subagentDepth: 1 } : undefined)
        assert.throws(() => identityFixture(version, [child]).prepare(child), code('E_SCHEDULER_CAPABILITY'))
      })
    }
  }
  test(`H01 ${version}: reconstructed objects and fresh proxies cannot replace exact live agents`, () => {
    const root = identityAgent('root')
    const fixture = identityFixture(version, [root])
    assert.throws(() => fixture.prepare({ ...root }), code('E_SCHEDULER_CAPABILITY'))
    assert.throws(() => fixture.prepare(new Proxy(root, {})), code('E_SCHEDULER_CAPABILITY'))
    root.session.header.id = 'other'
    assert.throws(() => fixture.prepare(root), code('E_SCHEDULER_CAPABILITY'))
  })
  test(`H01 ${version}: occupied reserved IDs and cyclic delegated ancestry refuse`, () => {
    const root = identityAgent('root')
    const child = identityAgent('child', { parentSession: root.id, origin: 'subagent' })
    const fixture = identityFixture(version, [root, child])
    assert.throws(() => fixture.prepare(root, child.id), code('E_SCHEDULER_CAPABILITY'))
    root.session.header.origin = 'subagent'
    root.session.header.parentSession = child.id
    assert.throws(() => fixture.prepare(child), { code: 'E_SCHEDULER_CAPABILITY', message: 'broken live ancestor identity' })
  })
  test(`H01 ${version}: ancestry traversal remains bounded at 64 live nodes`, () => {
    const nodes = Array.from({ length: 65 }, (_, i) => identityAgent('node-' + i,
      i === 64 ? {} : { parentSession: 'node-' + (i + 1), origin: 'subagent' }))
    assert.throws(() => identityFixture(version, nodes).prepare(nodes[0]),
      { code: 'E_SCHEDULER_CAPABILITY', message: 'ancestor chain exceeds bound' })
  })
}

test('binding a lead-queued unbound task captures its actual worker for scoped state and replay', t => {
  const { store, scheduler: s } = setup(t)
  const id = store.openTask({ title: 'unbound' }, run).task_id
  s.enqueue(input(id), run, lead)
  const row = admit(s).request
  store.claimTask({ task_id: id, child_id: 'display' }, run, { sessionId: worker.sessionId, isRoot: false }, worker.sessionId)
  s.bind(ref(row, { session_id: worker.sessionId }), run, lead)
  assert.equal(s.state({}, run, worker).requests.length, 1)
  assert.equal(s.enqueue(input(id), run, worker).state, 'running')
})

test('closed stores stay closed and transition failure retains the queue reservation', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  s.enqueue(input(task(store)), run, lead)
  const row = admit(s).request
  assert.throws(() => s.bind(ref(row, { session_id: 'impostor' }), run, lead), code('E_GOVERNOR_CONFLICT'))
  assert.equal(g.snapshot(run).active_total, 1)
  assert.equal(s.state({}, run, lead).requests[0].state, 'reserved')
  store.close()
  assert.throws(() => s.state({}, run, lead), /closed|关闭|卸载/)
})

test('stale task rework and changed queue owner refuse before governor budget debit', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const id = task(store)
  s.enqueue(input(id), run, lead)
  store.open().prepare('UPDATE task SET evidence_generation = evidence_generation + 1 WHERE id = ?').run(id)
  assert.equal(admit(s).code, 'E_SCHEDULER_STALE')
  assert.equal(g.snapshot(run).active_total, 0)
  const id2 = task(store)
  s.enqueue(input(id2), run, lead)
  store.open().prepare('UPDATE task SET owner_session = ? WHERE id = ?').run('replacement', id2)
  assert.equal(admit(s, 'owner').status, 'refused')
  assert.equal(g.snapshot(run).active_total, 0)
})

test('checkpoint failures never promote to quiescence and preserve close errors', async () => {
  assert.equal(typeof host.flushNativeCheckpoint, 'function')
  const session = { snapshotEvents() { return this.events }, header: { id: 's' }, events: [] }
  let opened = 0, flushFailure
  const closeFailure = new Error('reader close failure')
  const backend = { async flush() { if (flushFailure) throw flushFailure }, async open() {
    opened++
    return { id: 's', access: 'read', header: session.header, async read() { return [] }, async close() { throw closeFailure } }
  } }
  const sessions = { get: () => session, async flush() { return true } }
  const ctx = { get: n => ({ sessions, sessionPersistence: backend })[n] }
  const args = { version: '0.2.1-alpha.2', session, persistence: backend }
  await assert.rejects(() => host.flushNativeCheckpoint(ctx, args), closeFailure)
  flushFailure = new Error('durability failure')
  await assert.rejects(() => host.flushNativeCheckpoint(ctx, args), flushFailure)
  assert.equal(opened, 1)
})

test('two processes cannot admit the same request twice or replay into the next queue row', async t => {
  const { store, scheduler: s, governor: g } = setup(t)
  s.enqueue(input(task(store)), run, lead)
  s.enqueue(input(task(store)), run, lead)
  const children = [0, 1].map(() => fork(new URL('./fixtures/scheduler-worker.mjs', import.meta.url), [store.root, run, 'same-decision'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }))
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill() })
  await Promise.all(children.map(child => once(child, 'message')))
  const replies = children.map(child => once(child, 'message'))
  const exits = children.map(child => once(child, 'exit'))
  for (const child of children) child.send('go')
  const results = (await Promise.all(replies)).map(([reply]) => { assert.equal(reply.error, undefined); return reply.result })
  await Promise.all(exits)
  assert.equal(results[0].request.request_id, results[1].request.request_id)
  assert.equal(results.filter(x => x.replay).length, 1)
  assert.equal(g.snapshot(run).active_total, 1)
  assert.equal(s.state({}, run, lead).requests.filter(x => x.state === 'queued').length, 1)
})

test('state byte budget includes JSON escaping of the exact trusted run identity', t => {
  const { store, scheduler: s } = setup(t)
  const escapedRun = String.fromCharCode(1).repeat(194) + 'x'
  for (let i = 0; i < 100; i++) s.enqueue(input(task(store, worker.sessionId, escapedRun)), escapedRun, lead)
  const page = s.state({ limit: 100 }, escapedRun, lead)
  assert.ok(page.requests.length > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536)
  assert.equal(page.has_more, true)
})

test('scheduler bind enforces its session identity bound before changing governor state', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const oversized = 's'.repeat(513)
  s.enqueue(input(task(store, oversized)), run, lead)
  const row = admit(s).request
  assert.throws(() => s.bind(ref(row, { session_id: oversized }), run, lead), code('E_SCHEDULER_CONFLICT'))
  assert.equal(g.snapshot(run).active_total, 1)
  assert.equal(s.state({}, run, lead).requests[0].state, 'reserved')
})

test('oversized external governor state fails explicitly without an empty-page cursor crash', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const oversized = 's'.repeat(70000)
  s.enqueue(input(task(store, oversized)), run, lead)
  const row = admit(s).request
  g.bind({ reservation_id: row.reservation_id, generation: row.generation, session_id: oversized }, run, lead)
  assert.throws(() => s.state({}, run, lead), code('E_SCHEDULER_CONFLICT'))
  assert.equal(g.snapshot(run).active_total, 1)
})

test('lead bind refuses a replaced captured owner after public rejected-task reassignment', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const id = task(store)
  const root = { sessionId: lead.sessionId, isRoot: true }
  const original = { sessionId: worker.sessionId, isRoot: false }
  const replacement = { role: 'worker', sessionId: 'replacement-owner' }
  store.submitTask({ task_id: id }, run, original)
  store.rejectTask({ task_id: id, reason: 'rework before scheduling' }, run, root)
  s.enqueue(input(id, { mode: 'write', resources: ['repo'] }), run, lead)
  const row = admit(s).request
  assert.ok(row)
  store.claimTask({ task_id: id, child_id: 'replacement' }, run, root, replacement.sessionId)
  assert.throws(() => s.bind(ref(row, { session_id: replacement.sessionId }), run, lead), code('E_SCHEDULER_CONFLICT'))
  const current = s.state({}, run, lead).requests[0]
  assert.equal(current.state, 'reserved')
  assert.equal(current.session_id, null)
  assert.equal(g.snapshot(run).active_total, 1)
  assert.equal(g.snapshot(run).holds.length, 1)
  assert.throws(() => s.bind(ref(row, { session_id: replacement.sessionId }), run, replacement), code('E_SCHEDULER_CONFLICT'))
  s.settle(ref(row, { proof: { kind: 'never_started' } }), run, lead)
  assert.equal(g.snapshot(run).active_total, 0)
})

for (const boundary of ['open', 'read', 'close']) {
  for (const change of ['dispose', 'replace-session', 'replace-sessions-service', 'replace-backend']) {
    test('checkpoint rejects ' + change + ' during awaited reader ' + boundary, async () => {
      const session = { header: { id: 's' }, snapshotEvents: () => [] }
      let live = session, closed = 0
      const sessions = { get: () => live, async flush() { return true } }
      let currentSessions = sessions, currentBackend
      function mutate() {
        if (change === 'dispose') live = undefined
        if (change === 'replace-session') live = { ...session }
        if (change === 'replace-sessions-service') currentSessions = { get: () => session, async flush() { return true } }
        if (change === 'replace-backend') currentBackend = { ...backend }
      }
      const backend = { async flush() {}, async open() {
        if (boundary === 'open') mutate()
        return { id: 's', access: 'read', header: session.header,
          async read() { if (boundary === 'read') mutate(); return [] },
          async close() { closed++; if (boundary === 'close') mutate() } }
      } }
      currentBackend = backend
      const ctx = { get: name => name === 'sessions' ? currentSessions : currentBackend }
      await assert.rejects(() => host.flushNativeCheckpoint(ctx, {
        version: '0.2.1-alpha.2', session, persistence: backend,
      }), code('E_SCHEDULER_CAPABILITY'))
      assert.equal(closed, 1)
    })
  }
}

test('reader close rejection remains the outcome even when cleanup replaces native services', async () => {
  const session = { header: { id: 's' }, snapshotEvents: () => [] }
  const closeFailure = new Error('strict reader cleanup failed')
  const sessions = { get: () => session, async flush() { return true } }
  let currentSessions = sessions, currentBackend
  const backend = { async flush() {}, async open() {
    return { id: 's', access: 'read', header: session.header, async read() { return [] }, async close() {
      currentSessions = { get: () => undefined }
      currentBackend = {}
      throw closeFailure
    } }
  } }
  currentBackend = backend
  const ctx = { get: name => name === 'sessions' ? currentSessions : currentBackend }
  await assert.rejects(() => host.flushNativeCheckpoint(ctx, {
    version: '0.2.0-rc.2', session, persistence: backend,
  }), error => error === closeFailure)
})

test('checkpoint compares underlying Cordis service identities across fresh contextual proxies', async () => {
  const original = Symbol.for('cordis.original')
  const session = { header: { id: 's' }, snapshotEvents: () => [] }
  const sessions = { get: () => session, async flush() { return true } }
  let target = sessions, replace = false
  const backend = { async flush() {}, async open() {
    return { id: 's', access: 'read', header: session.header, async read() { return [] },
      async close() { if (replace) target = { ...sessions } } }
  } }
  const ctx = { get: name => name === 'sessions'
    ? new Proxy(target, { get: (object, key) => key === original ? object : object[key] }) : backend }
  const args = { version: '0.2.0-rc.2', session, persistence: backend }
  assert.equal((await host.flushNativeCheckpoint(ctx, args)).native_enabled, false)
  replace = true
  await assert.rejects(() => host.flushNativeCheckpoint(ctx, args), code('E_SCHEDULER_CAPABILITY'))
})

function durableSchedulingRows(store) {
  return JSON.stringify(['governor_run', 'governor_reservation', 'governor_retry_charge', 'governor_hold', 'governor_audit', 'scheduler_request', 'scheduler_decision']
    .map(table => ({ table, rows: store.open().prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all() })))
}

function withdraw(scheduler, row, requestKey = 'withdraw', authority = worker, scope = run) {
  assert.equal(typeof scheduler.withdraw, 'function', 'host-only withdraw API missing')
  return scheduler.withdraw({ request_id: row.request_id, request_key: requestKey }, scope, authority)
}
function rowBytes(store, tables) {
  return JSON.stringify(tables.map(table => [table, store.open().prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
}
function taskGovernorBytes(store) {
  return rowBytes(store, ['task', 'governor_run', 'governor_reservation', 'governor_retry_charge', 'governor_hold', 'governor_audit'])
}
function changes(store) { return store.open().prepare('SELECT total_changes() AS n').get().n }
function queueRow(store, row) { return { ...store.open().prepare('SELECT * FROM scheduler_request WHERE request_id = ?').get(row.request_id) } }

test('withdraw removes only a queued intent and preserves ordinary FIFO, exact payload, and bounded state', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const a = s.enqueue(input(task(store), { mode: 'write', resources: ['repo'] }), run, worker)
  const b = s.enqueue(input(task(store)), run, worker)
  const c = s.enqueue(input(task(store)), run, worker)
  g.snapshot(run)
  const before = taskGovernorBytes(store), original = queueRow(store, b)
  const result = withdraw(s, b)
  assert.deepEqual(result, { status: 'withdrawn', request: { ...b, state: 'withdrawn' }, replay: false })
  assert.deepEqual(queueRow(store, b), { ...original, state: 'withdrawn' })
  assert.equal(taskGovernorBytes(store), before)
  assert.deepEqual(s.enqueue(input(b.task_id), run, worker), result.request)
  const page = s.state({ limit: 2 }, run, worker)
  assert.deepEqual(page.requests.map(row => row.state), ['queued', 'withdrawn'])
  assert.equal(page.has_more, true)
  assert.deepEqual(s.state({ after: page.next_after, limit: 2 }, run, worker).requests, [c])
  assert.equal(admit(s, 'first').request.request_id, a.request_id)
  assert.equal(admit(s, 'second').request.request_id, c.request_id)
  assert.equal(admit(s, 'empty').status, 'empty')
})

for (const kind of ['new', 'retry']) {
  test('withdraw unblocks FIFO after default cumulative ' + kind + ' budget is exhausted without changing task or governor rows', t => {
    const { store, scheduler: s, governor: g } = setup(t)
    const id = task(store), limits = g.snapshot(run).limits
    let generation = 0
    const count = kind === 'new' ? limits.max_created : limits.max_retries
    for (let i = 0; i < count; i++) {
      const reservation = g.reserve({ operation_key: 'consume-' + i, task_id: id, generation,
        kind, mode: 'read', resources: [] }, run, lead)
      generation = reservation.generation
      g.settle({ reservation_id: reservation.reservation_id, generation, proof: { kind: 'never_started' } }, run, lead)
    }
    const head = s.enqueue(input(id, { generation, kind }), run, worker)
    const tail = s.enqueue(input(task(store)), run, worker)
    assert.equal(g.snapshot(run).active_total, 0)
    for (const decision of ['blocked-once', 'blocked-again']) {
      const blocked = admit(s, decision)
      assert.equal(blocked.status, 'blocked')
      assert.equal(blocked.code, 'E_BUDGET_EXHAUSTED')
      assert.equal(blocked.request.request_id, head.request_id)
    }
    const before = taskGovernorBytes(store), original = queueRow(store, head)
    assert.equal(withdraw(s, head).status, 'withdrawn')
    assert.equal(taskGovernorBytes(store), before)
    assert.deepEqual(queueRow(store, head), { ...original, state: 'withdrawn' })
    assert.equal(admit(s, 'blocked-once').status, 'blocked', 'historical admission decision stays historical')
    assert.equal(admit(s, 'after-withdraw').request.request_id, tail.request_id)
    const snapshot = g.snapshot(run)
    assert.deepEqual(snapshot.limits, limits)
    assert.equal(kind === 'new' ? snapshot.created_total : snapshot.retries[id], count)
  })
}

test('withdraw explicitly clears temporary resource FIFO blockage without releasing the other run hold', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const external = task(store, worker.sessionId, 'other')
  g.reserve({ operation_key: 'external', task_id: external, generation: 0, kind: 'new', mode: 'write', resources: ['repo'] }, 'other', lead)
  const head = s.enqueue(input(task(store), { mode: 'write', resources: ['repo'] }), run, worker)
  const tail = s.enqueue(input(task(store)), run, worker)
  for (const decision of ['blocked-a', 'blocked-b']) {
    const blocked = admit(s, decision)
    assert.equal(blocked.code, 'E_RESOURCE_BUSY')
    assert.equal(blocked.request.request_id, head.request_id)
    assert.equal(s.state({}, run, worker).requests[1].state, 'queued')
  }
  const before = taskGovernorBytes(store)
  withdraw(s, head)
  assert.equal(taskGovernorBytes(store), before)
  assert.equal(admit(s, 'after-withdraw').request.request_id, tail.request_id)
  assert.equal(g.snapshot('other').holds.length, 1)
})

test('withdraw validates exact bounded keys, input shape, trusted authority and root run without writes', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const row = s.enqueue(input(task(store)), run, worker)
  assert.equal(typeof s.withdraw, 'function', 'host-only withdraw API missing')
  g.snapshot(run)
  const before = durableSchedulingRows(store), initialChanges = changes(store)
  const valid = { request_id: row.request_id, request_key: ' withdraw ' }
  for (const value of [undefined, null, 1, '', ' ', 'x'.repeat(513), '界'.repeat(171)]) {
    for (const field of ['request_id', 'request_key']) {
      assert.throws(() => s.withdraw({ ...valid, [field]: value }, run, worker), code('E_SCHEDULER_CONFLICT'))
    }
  }
  for (const invalid of [null, [], {}, { ...valid, generation: 0 }, { ...valid, run_id: run }]) {
    assert.throws(() => s.withdraw(invalid, run, worker), code('E_SCHEDULER_CONFLICT'))
  }
  for (const authority of [undefined, {}, { role: 'root', sessionId: lead.sessionId },
    { ...worker, sessionId: '' }, { ...worker, sessionId: 's'.repeat(513) }, { ...worker, sessionId: 'child' }]) {
    assert.throws(() => s.withdraw(valid, run, authority), code('E_SCHEDULER_CONFLICT'))
  }
  for (const scope of ['', 'run', 'other', 'r'.repeat(513)]) {
    assert.throws(() => s.withdraw(valid, scope, lead), code('E_SCHEDULER_CONFLICT'))
  }
  assert.throws(() => s.withdraw({ ...valid, request_id: 'missing' }, run, lead), code('E_SCHEDULER_CONFLICT'))
  assert.equal(changes(store), initialChanges)
  assert.equal(durableSchedulingRows(store), before)
  assert.equal(s.withdraw(valid, run, worker).replay, false)
  assert.equal(s.withdraw(valid, run, worker).replay, true)
  assert.throws(() => s.withdraw({ ...valid, request_key: 'withdraw' }, run, worker), code('E_SCHEDULER_CONFLICT'))
})

test('withdraw requires current and captured owners before first mutation and before replay; same-run lead can recover', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const root = { sessionId: lead.sessionId, isRoot: true }, original = { sessionId: worker.sessionId, isRoot: false }
  const replacement = { role: 'worker', sessionId: 'replacement' }
  const rows = []
  for (let i = 0; i < 2; i++) {
    const id = task(store)
    store.submitTask({ task_id: id }, run, original)
    store.rejectTask({ task_id: id, reason: 'reassignment' }, run, root)
    rows.push(s.enqueue(input(id), run, worker))
  }
  const historical = withdraw(s, rows[0], 'historical')
  for (const row of rows) store.claimTask({ task_id: row.task_id, child_id: 'replacement' }, run, root, replacement.sessionId)
  g.snapshot(run)
  const before = durableSchedulingRows(store), taskBefore = taskGovernorBytes(store), initialChanges = changes(store)
  for (const authority of [worker, replacement]) {
    assert.throws(() => withdraw(s, rows[0], 'historical', authority), code('E_SCHEDULER_CONFLICT'))
    assert.throws(() => withdraw(s, rows[1], 'new', authority), code('E_SCHEDULER_CONFLICT'))
  }
  assert.throws(() => withdraw(s, rows[0], 'historical', lead, 'other'), code('E_SCHEDULER_CONFLICT'))
  assert.equal(changes(store), initialChanges)
  assert.equal(durableSchedulingRows(store), before)
  assert.deepEqual(withdraw(s, rows[0], 'historical', lead), { ...historical, replay: true })
  assert.equal(changes(store), initialChanges)
  assert.equal(withdraw(s, rows[1], 'lead-recovery', lead).status, 'withdrawn')
  assert.equal(taskGovernorBytes(store), taskBefore)
})

test('withdraw rejects worker claim of a lead-queued null captured owner without capturing it; lead can withdraw', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const id = store.openTask({ title: 'unbound intent' }, run).task_id
  const row = s.enqueue(input(id), run, lead)
  store.claimTask({ task_id: id, child_id: 'label' }, run, { sessionId: worker.sessionId, isRoot: false }, worker.sessionId)
  g.snapshot(run)
  const before = taskGovernorBytes(store), queue = queueRow(store, row), initialChanges = changes(store)
  assert.equal(queue.owner_session, null)
  assert.throws(() => withdraw(s, row), code('E_SCHEDULER_CONFLICT'))
  assert.equal(changes(store), initialChanges)
  assert.deepEqual(queueRow(store, row), queue)
  const first = withdraw(s, row, 'lead-only', lead)
  assert.throws(() => withdraw(s, row, 'lead-only'), code('E_SCHEDULER_CONFLICT'))
  assert.equal(taskGovernorBytes(store), before)
  assert.equal(queueRow(store, row).owner_session, null)
  assert.deepEqual(withdraw(s, row, 'lead-only', lead), { ...first, replay: true })
})

test('withdraw decision binds action and target, rejects fresh keys on withdrawn intents, and replays read-only after reopen', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const row = s.enqueue(input(task(store)), run, worker), other = s.enqueue(input(task(store)), run, worker)
  g.snapshot(run)
  const first = withdraw(s, row, ' exact-withdraw ')
  const record = store.open().prepare('SELECT * FROM scheduler_decision WHERE request_key = ?').get(' exact-withdraw ')
  assert.deepEqual(JSON.parse(record.result), { action: 'withdraw', request_id: row.request_id,
    result: { status: 'withdrawn', request: first.request } })
  assert.equal(record.actor_session, worker.sessionId)
  const before = durableSchedulingRows(store), taskBefore = taskGovernorBytes(store), initialChanges = changes(store)
  assert.throws(() => withdraw(s, row, 'new-key'), code('E_SCHEDULER_CONFLICT'))
  assert.throws(() => withdraw(s, other, ' exact-withdraw '), code('E_SCHEDULER_CONFLICT'))
  assert.throws(() => admit(s, ' exact-withdraw '), code('E_SCHEDULER_CONFLICT'))
  assert.deepEqual(withdraw(s, row, ' exact-withdraw '), { ...first, replay: true })
  assert.equal(changes(store), initialChanges)
  assert.equal(durableSchedulingRows(store), before)
  store.close()
  const reopened = new TaskforceStore(store.root)
  t.after(() => reopened.close())
  const restored = new module.TaskforceScheduler(reopened)
  const reopenedChanges = changes(reopened)
  assert.deepEqual(withdraw(restored, row, ' exact-withdraw '), { ...first, replay: true })
  assert.deepEqual(withdraw(restored, row, ' exact-withdraw ', lead), { ...first, replay: true })
  assert.equal(changes(reopened), reopenedChanges)
  assert.equal(durableSchedulingRows(reopened), before)
  assert.equal(taskGovernorBytes(reopened), taskBefore)
  assert.deepEqual(restored.enqueue(input(row.task_id), run, worker), first.request)
})

test('withdraw refuses an existing untagged admission key while historical admission replay stays compatible', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const old = admit(s, 'empty-admission')
  assert.equal(old.status, 'empty')
  const row = s.enqueue(input(task(store)), run, worker)
  g.snapshot(run)
  const before = durableSchedulingRows(store), initialChanges = changes(store)
  assert.throws(() => withdraw(s, row, 'empty-admission'), code('E_SCHEDULER_CONFLICT'))
  assert.deepEqual(admit(s, 'empty-admission'), { ...old, replay: true })
  assert.equal(changes(store), initialChanges)
  assert.equal(durableSchedulingRows(store), before)
  assert.equal(withdraw(s, row, 'fresh-key').status, 'withdrawn')
})

for (const state of ['reserved', 'running', 'unknown', 'settled', 'refused']) {
  test('withdraw refuses ' + state + ' requests without changing reservations, holds, tasks or decisions', t => {
    const { store, scheduler: s, governor: g } = setup(t)
    const row = s.enqueue(input(task(store), { mode: 'write', resources: ['repo'] }), run, worker)
    if (state === 'refused') {
      const direct = g.reserve({ operation_key: 'advance', task_id: row.task_id, generation: 0, kind: 'reuse', mode: 'read', resources: [] }, run, lead)
      g.settle({ reservation_id: direct.reservation_id, generation: direct.generation, proof: { kind: 'never_started' } }, run, lead)
      assert.equal(admit(s).status, 'refused')
    } else {
      const admitted = admit(s).request
      assert.equal(queueRow(store, row).state, 'admitted')
      if (['running', 'unknown'].includes(state)) s.bind(ref(admitted, { session_id: worker.sessionId }), run, worker)
      if (state === 'unknown') s.markUnknown(ref(admitted, { reason: 'DELIVERY_UNKNOWN' }), run, worker)
      if (state === 'settled') s.settle(ref(admitted, { proof: { kind: 'never_started' } }), run, lead)
    }
    assert.equal(s.state({}, run, lead).requests[0].state, state)
    g.snapshot(run)
    const before = durableSchedulingRows(store), taskBefore = taskGovernorBytes(store), initialChanges = changes(store)
    for (const authority of [lead, worker]) assert.throws(() => withdraw(s, row, 'invalid', authority), code('E_SCHEDULER_CONFLICT'))
    assert.equal(changes(store), initialChanges)
    assert.equal(durableSchedulingRows(store), before)
    assert.equal(taskGovernorBytes(store), taskBefore)
  })
}

test('withdraw refuses even a queued row if a reservation is already attached', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const row = s.enqueue(input(task(store), { mode: 'write', resources: ['repo'] }), run, worker)
  admit(s)
  store.open().prepare("UPDATE scheduler_request SET state = 'queued' WHERE request_id = ?").run(row.request_id)
  g.snapshot(run)
  const before = durableSchedulingRows(store), initialChanges = changes(store)
  assert.throws(() => withdraw(s, row, 'invalid', lead), code('E_SCHEDULER_CONFLICT'))
  assert.equal(changes(store), initialChanges)
  assert.equal(durableSchedulingRows(store), before)
})

for (const fault of ['cas', 'decision-insert', 'outer-rollback']) {
  test('withdraw rolls back queue and decision on ' + fault + ' failure', t => {
    const { store, scheduler: s, governor: g } = setup(t)
    const row = s.enqueue(input(task(store)), run, worker)
    g.snapshot(run)
    const before = durableSchedulingRows(store), taskBefore = taskGovernorBytes(store)
    if (fault === 'cas') store.open().exec("CREATE TRIGGER reject_withdraw BEFORE UPDATE OF state ON scheduler_request WHEN NEW.state = 'withdrawn' BEGIN SELECT RAISE(IGNORE); END")
    if (fault === 'decision-insert') store.open().exec("CREATE TRIGGER reject_withdraw BEFORE INSERT ON scheduler_decision BEGIN SELECT RAISE(ABORT, 'injected withdraw decision failure'); END")
    if (fault === 'outer-rollback') {
      assert.throws(() => withWriteTransaction(store.open(), () => {
        assert.equal(withdraw(s, row).status, 'withdrawn')
        throw new Error('outer withdraw rollback')
      }), /outer withdraw rollback/)
    } else assert.throws(() => withdraw(s, row), fault === 'cas' ? code('E_SCHEDULER_CONFLICT') : /injected withdraw decision failure/)
    assert.equal(durableSchedulingRows(store), before)
    assert.equal(taskGovernorBytes(store), taskBefore)
    if (fault !== 'outer-rollback') store.open().exec('DROP TRIGGER reject_withdraw')
    assert.equal(withdraw(s, row).replay, false)
  })
}

async function schedulerRace(t, store, commands) {
  const children = commands.map(({ action, key, target = '' }) => fork(new URL('./fixtures/scheduler-worker.mjs', import.meta.url),
    [store.root, run, key, action, target], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }))
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill() })
  const ready = (await Promise.all(children.map(child => once(child, 'message')))).map(([message]) => message)
  assert.ok(ready.every(message => message.ready))
  assert.equal(new Set(ready.map(message => message.pid)).size, 2, 'two independent child processes opened SQLite connections')
  const replies = children.map(child => once(child, 'message')), exits = children.map(child => once(child, 'exit'))
  for (const child of children) child.send('go')
  const results = (await Promise.all(replies)).map(([reply]) => reply)
  for (const [exitCode, signal] of await Promise.all(exits)) { assert.equal(exitCode, 0); assert.equal(signal, null) }
  return results
}

for (const sameKey of [false, true]) {
  test('withdraw and admit race on two process connections with ' + (sameKey ? 'one shared key' : 'distinct keys') + ' has only serial outcomes', { timeout: 12000 }, async t => {
    const { store, scheduler: s, governor: g } = setup(t)
    assert.equal(typeof s.withdraw, 'function', 'host-only withdraw API missing')
    const head = s.enqueue(input(task(store), { kind: 'new', mode: 'write', resources: ['repo'] }), run, worker)
    const tail = s.enqueue(input(task(store)), run, worker)
    g.snapshot(run)
    const taskBefore = rowBytes(store, ['task'])
    const [withdrawal, admission] = await schedulerRace(t, store, [
      { action: 'withdraw', key: 'race-withdraw', target: head.request_id },
      { action: 'admit', key: sameKey ? 'race-withdraw' : 'race-admit' },
    ])
    const rows = s.state({}, run, lead).requests, snapshot = g.snapshot(run)
    if (withdrawal.result) {
      assert.equal(withdrawal.result.status, 'withdrawn')
      assert.equal(rows[0].state, 'withdrawn')
      assert.equal(rows[0].reservation_id, null)
      if (sameKey) {
        assert.equal(admission.error, 'E_SCHEDULER_CONFLICT')
        assert.equal(rows[1].state, 'queued')
        assert.equal(snapshot.active_total, 0)
      } else {
        assert.equal(admission.error, undefined)
        assert.equal(admission.result.request.request_id, tail.request_id)
        assert.equal(snapshot.active_total, 1)
      }
      assert.equal(snapshot.created_total, 0)
      assert.equal(snapshot.holds.length, 0)
    } else {
      assert.equal(withdrawal.error, 'E_SCHEDULER_CONFLICT')
      assert.equal(admission.error, undefined)
      assert.equal(admission.result.request.request_id, head.request_id)
      assert.equal(rows[0].state, 'reserved')
      assert.equal(rows[1].state, 'queued')
      assert.equal(snapshot.active_total, 1)
      assert.equal(snapshot.created_total, 1)
      assert.equal(snapshot.holds.length, 1)
    }
    assert.equal(snapshot.reservations.length, snapshot.active_total)
    assert.equal(snapshot.retry_charges.length, snapshot.active_total)
    assert.equal(rowBytes(store, ['task']), taskBefore)
    assert.equal(store.open().prepare('SELECT COUNT(*) AS n FROM scheduler_decision').get().n,
      withdrawal.result && !sameKey ? 2 : 1)
  })
}

test('withdraw same-key race on two process connections commits once with a zero-write replay', { timeout: 12000 }, async t => {
  const { store, scheduler: s, governor: g } = setup(t)
  assert.equal(typeof s.withdraw, 'function', 'host-only withdraw API missing')
  const row = s.enqueue(input(task(store)), run, worker)
  g.snapshot(run)
  const before = taskGovernorBytes(store)
  const command = { action: 'withdraw', key: 'shared-withdraw', target: row.request_id }
  const replies = await schedulerRace(t, store, [command, command])
  assert.ok(replies.every(reply => reply.error === undefined))
  const first = replies.find(reply => !reply.result.replay), replay = replies.find(reply => reply.result.replay)
  assert.ok(first)
  assert.ok(replay)
  assert.deepEqual(replay.result, { ...first.result, replay: true })
  assert.equal(replay.changes, 0)
  assert.equal(first.changes, 2)
  assert.equal(taskGovernorBytes(store), before)
  assert.equal(store.open().prepare('SELECT COUNT(*) AS n FROM scheduler_decision').get().n, 1)
  assert.equal(s.state({}, run, lead).requests[0].state, 'withdrawn')
})

test('scheduler historical settled replay preserves the newer admission through reopening', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const id = task(store)
  s.enqueue(input(id, { kind: 'new', mode: 'write', resources: ['repo'] }), run, worker)
  const first = admit(s, 'first-admission').request
  s.bind(ref(first, { session_id: worker.sessionId }), run, worker)
  const proof = { kind: 'terminal', outcome: 'succeeded', quiescent: true, evidence: 'trusted scheduler subtree stopped' }
  const settled = s.settle(ref(first, { proof }), run, worker)
  s.enqueue(input(id, { request_key: 'second-queue', generation: first.generation, kind: 'retry', mode: 'write', resources: ['repo'] }), run, worker)
  const second = admit(s, 'second-admission').request
  const before = JSON.stringify(g.snapshot(run)), queue = JSON.stringify(s.state({}, run, lead)), rows = durableSchedulingRows(store)
  assert.equal(g.snapshot(run).active_total, 1)
  assert.equal(g.snapshot(run).active_writers, 1)
  assert.equal(g.snapshot(run).created_total, 1)
  assert.equal(g.snapshot(run).retries[id], 1)
  assert.equal(g.snapshot(run).holds[0].reservation_id, second.reservation_id)
  assert.throws(() => s.bind(ref(first, { session_id: worker.sessionId }), run, worker), code('E_GOVERNOR_FENCE'))
  assert.throws(() => s.markUnknown(ref(first, { reason: 'late observation' }), run, worker), code('E_GOVERNOR_FENCE'))
  assert.deepEqual(s.settle(ref(first, { proof }), run, worker), settled)
  assert.throws(() => s.settle(ref(first, { proof: { ...proof, outcome: 'failed' } }), run, worker),
    error => error.code === 'E_GOVERNOR_CONFLICT' && error.message === 'settlement conflicts with durable proof')
  assert.equal(JSON.stringify(g.snapshot(run)), before)
  assert.equal(JSON.stringify(s.state({}, run, lead)), queue)
  assert.equal(durableSchedulingRows(store), rows)
  store.close()
  const reopened = new TaskforceStore(store.root)
  t.after(() => reopened.close())
  const restored = new module.TaskforceScheduler(reopened), restoredGovernor = new TaskforceGovernor(reopened)
  assert.deepEqual(restored.settle(ref(first, { proof }), run, worker), settled)
  assert.equal(JSON.stringify(restoredGovernor.snapshot(run)), before)
  assert.equal(JSON.stringify(restored.state({}, run, lead)), queue)
  assert.equal(durableSchedulingRows(reopened), rows)
})

// Task19 P6: fresh post16 closure; inherited Node24 Q1 fixtures remain separate.
for (const [position, fullRun, owner] of [
  ['leading', '\u0000run', '\u0000worker'],
  ['middle', 'run\u0000tail', 'worker\u0000tail'],
  ['trailing', 'run\u0000', 'worker\u0000'],
  ['literal-T', 'Trun', 'Tworker'],
  ['literal-J', 'J"run"', 'J"worker"'],
  ['literal-JSON', '{"run":true}', '{"worker":true}'],
  ['literal-backslash', 'run\\u0000tail', 'worker\\u0000tail'],
  ['Unicode', '运行🔑', '工作人员🔑'],
]) for (const scopeKind of ['safe-run', 'full-run']) {
  test('Task19 scheduler view preserves session and new request run: ' + position + '/' + scopeKind, t => {
    const { store, scheduler: s } = setup(t)
    const scope = scopeKind === 'safe-run' ? run : fullRun
    const actor = { role: 'worker', sessionId: owner }
    const args = input(task(store, owner, scope))
    const queued = s.enqueue(args, scope, actor)
    const checkQueueStorage = source => {
      const stored = source.open().prepare('SELECT json_quote(run_id) AS run, typeof(run_id) AS run_type, json_quote(owner_session) AS owner, typeof(owner_session) AS owner_type FROM scheduler_request WHERE request_id = ?').get(queued.request_id)
      assert.deepEqual([JSON.parse(stored.run), stored.run_type, JSON.parse(stored.owner), stored.owner_type],
        [scope, 'text', owner, 'text'])
    }
    checkQueueStorage(store)
    assert.equal(queued.run_id, scope)
    assert.equal(queued.session_id, null)
    assert.equal(queued.reservation_id, null)
    assert.equal(queued.generation, 0)
    assert.equal(queued.state, 'queued')
    assert.deepEqual(s.enqueue(args, scope, actor), queued)
    const admitted = s.admitNext({ request_key: 'admit' }, scope, lead)
    assert.equal(admitted.status, 'admitted')
    assert.equal(admitted.request.run_id, scope)
    assert.equal(admitted.request.session_id, null)
    assert.equal(admitted.request.generation, 1)
    const bound = s.bind(ref(admitted.request, { session_id: owner }), scope, actor)
    const checkSessionStorage = source => {
      const stored = source.open().prepare('SELECT json_quote(session_id) AS session, typeof(session_id) AS session_type FROM governor_reservation WHERE reservation_id = ? AND run_id = ? AND task_id = ?').get(bound.reservation_id, scope, queued.task_id)
      assert.deepEqual([JSON.parse(stored.session), stored.session_type], [owner, 'text'])
    }
    checkSessionStorage(store)
    assert.equal(bound.run_id, scope)
    assert.equal(bound.session_id, owner)
    assert.equal(bound.state, 'running')
    const check = (scheduler, source) => {
      checkQueueStorage(source)
      checkSessionStorage(source)
      assert.deepEqual(scheduler.enqueue(args, scope, actor), bound)
      for (const authority of [lead, actor]) {
        const page = scheduler.state({}, scope, authority)
        assert.equal(page.run_id, scope)
        assert.deepEqual(page.requests, [bound])
        assert.equal(page.has_more, false)
        assert.equal(page.next_after, null)
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536)
      }
      const prefix = owner.split('\u0000')[0]
      const other = prefix && prefix !== owner ? prefix : 'different-worker'
      assert.deepEqual(scheduler.state({}, scope, { role: 'worker', sessionId: other }).requests, [])
      assert.deepEqual(scheduler.admitNext({ request_key: 'admit' }, scope, lead), { ...admitted, replay: true })
    }
    check(s, store)
    store.close()
    const reopened = new TaskforceStore(store.root)
    try {
      const restored = new module.TaskforceScheduler(reopened)
      check(restored, reopened)
      const before = reopened.open().prepare('SELECT total_changes() AS n').get().n
      check(restored, reopened)
      assert.equal(reopened.open().prepare('SELECT total_changes() AS n').get().n, before)
      const unknown = restored.markUnknown(ref(bound, { reason: 'delivery unknown' }), scope, actor)
      assert.equal(unknown.run_id, scope)
      assert.equal(unknown.session_id, owner)
      assert.equal(unknown.state, 'unknown')
      assert.deepEqual(restored.state({}, scope, actor).requests, [unknown])
      assert.deepEqual(restored.enqueue(args, scope, actor), unknown)
    } finally { reopened.close() }
  })
}

test('Task19 restored long NUL governor session drives the original scheduler byte refusal', t => {
  const { store, scheduler: s, governor: g } = setup(t)
  const owner = 's\u0000' + 'x'.repeat(70000)
  const args = input(task(store, owner))
  const queued = s.enqueue(args, run, lead)
  const admitted = admit(s).request
  assert.equal(admitted.request_id, queued.request_id)
  // The public governor accepts this identity; scheduler.bind retains its own 512-byte bound.
  g.bind({ reservation_id: admitted.reservation_id, generation: admitted.generation, session_id: owner }, run, lead)
  const check = (scheduler, source) => {
    const stored = source.open().prepare('SELECT json_quote(session_id) AS session, typeof(session_id) AS session_type FROM governor_reservation WHERE reservation_id = ? AND run_id = ? AND task_id = ?').get(admitted.reservation_id, run, queued.task_id)
    assert.deepEqual([JSON.parse(stored.session), stored.session_type], [owner, 'text'])
    assert.throws(() => scheduler.state({}, run, lead), error =>
      error.code === 'E_SCHEDULER_CONFLICT' && error.message === 'scheduler state item exceeds response byte limit')
  }
  check(s, store)
  store.close()
  const reopened = new TaskforceStore(store.root)
  try {
    const restored = new module.TaskforceScheduler(reopened)
    check(restored, reopened)
    const before = reopened.open().prepare('SELECT total_changes() AS n').get().n
    check(restored, reopened)
    assert.equal(reopened.open().prepare('SELECT total_changes() AS n').get().n, before)
  } finally { reopened.close() }
})

// Q3 stays Task16-owned: assert its durable closure without another product decoder.
test('Task19 delegated withdrawal closure preserves full run after reopen without duplicate writes', t => {
  const { store, scheduler: s } = setup(t), scope = 'task19-withdraw\0full', owner = 'worker\0full'
  const actor = { role: 'worker', sessionId: owner }
  const queued = s.enqueue(input(task(store, owner, scope)), scope, lead)
  const args = { request_id: queued.request_id, request_key: 'task19-withdraw' }
  const first = s.withdraw(args, scope, actor)
  assert.equal(first.status, 'withdrawn'); assert.equal(first.request.run_id, scope)
  assert.equal(first.request.request_id, queued.request_id)
  function check(db) {
    const rows = db.prepare('SELECT json_quote(result) AS result_json, typeof(result) AS result_type'
      + ' FROM scheduler_decision WHERE run_id=? AND request_key=?').all(scope, args.request_key)
    assert.equal(rows.length, 1); assert.equal(rows[0].result_type, 'text')
    const wrapper = JSON.parse(JSON.parse(rows[0].result_json))
    assert.equal(wrapper.action, 'withdraw'); assert.equal(wrapper.result.request.run_id, scope)
    assert.equal(wrapper.result.request.request_id, queued.request_id)
  }
  check(store.open())
  const before = store.open().prepare('SELECT total_changes() AS n').get().n
  assert.deepEqual(s.withdraw(args, scope, actor), { ...first, replay: true })
  assert.equal(store.open().prepare('SELECT total_changes() AS n').get().n, before)
  store.close()
  const reopened = new TaskforceStore(store.root)
  try {
    const restored = new module.TaskforceScheduler(reopened)
    restored.state({}, scope, lead)
    const db = reopened.open(), before = db.prepare('SELECT total_changes() AS n').get().n
    assert.deepEqual(restored.withdraw(args, scope, actor), { ...first, replay: true })
    check(db)
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
  } finally { reopened.close() }
})
