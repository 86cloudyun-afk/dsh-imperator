import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { apply } from '../../lib/index.js'
import { fakePresetHost } from './helpers.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskforceStore } from '../../lib/store/index.js'
import { attachRecoveryLifecycle } from '../../lib/plugins/lifecycle.mjs'
const owners = Symbol.for('dsh-taskforce.mount-owners')
const settle = () => new Promise(resolve => setImmediate(resolve))
afterEach(() => { delete globalThis[owners] })

test('effect registration failure before start releases the slot for retry', async () => {
  const error = new Error('effect registry unavailable')
  assert.throws(() => apply({ effect() { throw error } }), e => e === error)
  let created = 0
  const host = fakePresetHost({ register: () => { created++; return () => {} } })
  apply(host.ctx)
  await settle()
  assert.equal(created, 1)
  await host.disposeAll()
})
test('effect registration failure after callback cannot leave an unowned pending mount', async () => {
  let created = 0
  const host = fakePresetHost({ register: () => { created++; return () => {} } })
  const error = new Error('effect registration rejected')
  host.ctx.effect = callback => { callback(); throw error }
  assert.throws(() => apply(host.ctx), e => e === error)
  await settle()
  assert.equal(created, 0, 'rejected effect must not mount later in a microtask')
  const retry = fakePresetHost({ register: () => { created++; return () => {} } })
  apply(retry.ctx)
  await settle()
  assert.equal(created, 1)
  await retry.disposeAll()
})
test('immediate unload cancels registration before it starts', async () => {
  let created = 0
  const host = fakePresetHost({ register: () => { created++; return () => {} } })
  apply(host.ctx)
  await host.disposeAll()
  assert.equal(created, 0)
  assert.equal(globalThis[owners].has('@local/dsh-taskforce'), false)
})
test('unprintable registration failure still releases ownership with safe diagnostics', async () => {
  const error = { toString() { throw new Error('bad string conversion') } }
  const host = fakePresetHost({ register: () => { throw error } })
  apply(host.ctx)
  await settle()
  assert.match(host.logs.join('\n'), /declaring preset failed/)
  assert.equal(globalThis[owners].has('@local/dsh-taskforce'), false)
  await host.disposeAll()
})
test('unprintable disposal failure retains ownership without rejecting cleanup', async () => {
  const error = { toString() { throw new Error('bad string conversion') } }
  const host = fakePresetHost({ register: () => () => { throw error } })
  apply(host.ctx)
  await settle()
  await assert.doesNotReject(host.disposeAll())
  assert.equal(globalThis[owners].has('@local/dsh-taskforce'), true)
  assert.match(host.logs.join('\n'), /unmounting preset failed/)
})

function lifecycleFixture(t, session) {
  const directory = mkdtempSync(join(tmpdir(), 'taskforce-owned-lifecycle-'))
  const store = new TaskforceStore(directory)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const hooks = new Map()
  attachRecoveryLifecycle({ preset: 'taskforce', on: (name, fn) => hooks.set(name, fn),
    get: name => name === 'agentPresets' ? { composedPreset: ctx => ctx?.preset } : undefined,
  }, { identity: () => ({ runId: 'root' }), recovery: () => store.recovery })
  const agent = { session, ctx: { preset: 'taskforce' } }
  const rows = () => store.open().prepare('SELECT * FROM lifecycle_event WHERE session_id=? ORDER BY id').all(session.header.id)
  return { agent, store, rows,
    pre: () => hooks.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] })) }
}
const turnEvent = (seq, type) => ({ seq, type, data: { turn: 1,
  ...(type === 'turn/end' ? { reason: { kind: 'completed' } } : {}) } })

test('lifecycle stores only owned turn coordinates, replays restore and preserves existing audit', async t => {
  const session = { header: { id: 'child' }, inheritedEventCount: 2,
    events: [turnEvent(0, 'turn/start'), turnEvent(1, 'turn/end'), { seq: 2, type: 'session/end-seed' }, turnEvent(3, 'turn/start')] }
  const h = lifecycleFixture(t, session)
  await h.pre()
  assert.deepEqual(h.rows().filter(row => row.source === 'session_event').map(row => row.event_seq), [3])
  session.events.push(turnEvent(4, 'turn/end'))
  await h.pre(); await h.pre()
  h.agent.session = { ...session, firstLiveSeq: 5 }
  await h.pre()
  assert.deepEqual(h.rows().filter(row => row.source === 'session_event').map(row => row.event_seq), [3, 4])
  h.store.recovery.recordLifecycle({ source: 'session_event', event_type: 'turn/end', event_seq: 1,
    turn: 1, reason_kind: 'completed' }, { sessionId: 'child', runId: 'root' })
  const old = h.rows().find(row => row.event_seq === 1)
  await h.pre()
  assert.deepEqual(h.rows().find(row => row.event_seq === 1), old, 'prior mistaken attribution remains append-only audit')
  assert.deepEqual([...h.store.recovery.observationGaps], [])
})

test('lifecycle invalid ownership records a fixed gap without reinterpreting parent records', async t => {
  const session = { header: { id: 'invalid-cut' }, events: [turnEvent(0, 'turn/end')] }
  const h = lifecycleFixture(t, session)
  for (const cut of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, 2]) {
    session.inheritedEventCount = cut
    await h.pre()
  }
  Object.defineProperty(session, 'inheritedEventCount', { get() { throw new Error('private metadata') } })
  await h.pre()
  assert.deepEqual(h.rows().filter(row => row.source === 'session_event'), [])
  assert.equal(h.rows().filter(row => row.source === 'host_hook').length, 9)
  assert.deepEqual([...h.store.recovery.observationGaps], ['lifecycle_ownership_unavailable'])
})

test('lifecycle window measures owned history and root zero cuts retain durable own turns', async t => {
  const session = { header: { id: 'window' }, inheritedEventCount: 300,
    events: Array.from({ length: 300 }, (_, seq) => turnEvent(seq, 'turn/end')) }
  session.events.push(turnEvent(300, 'turn/start'))
  const h = lifecycleFixture(t, session)
  await h.pre()
  assert.deepEqual(h.rows().map(row => [row.event_seq, row.window_truncated]), [[300, 0], [null, 0]])
  session.events.push(...Array.from({ length: 256 }, (_, index) => turnEvent(index + 301, 'turn/end')))
  await h.pre()
  assert.equal(h.rows().at(-1).window_truncated, 1)
  assert.equal(h.rows().filter(row => row.source === 'session_event').length, 257)
  for (const cut of [undefined, 0]) {
    h.agent.session = { header: session.header, inheritedEventCount: cut, firstLiveSeq: 2,
      events: [turnEvent(0, 'turn/start'), turnEvent(1, 'turn/end')] }
    await h.pre()
  }
  assert.equal(h.rows().filter(row => row.event_seq === 1).length, 1)
  h.agent.ctx.preset = 'standard'
  h.agent.session.inheritedEventCount = -1
  await h.pre()
  assert.deepEqual([...h.store.recovery.observationGaps], [], 'out-of-scope observations never reach ownership or store')
})
