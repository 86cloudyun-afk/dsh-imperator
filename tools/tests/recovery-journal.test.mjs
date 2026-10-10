import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskforceStore } from '../../lib/store/index.js'
import { foldGuardSignal } from '../../lib/plugins/guard.mjs'
import { apply as applyTools } from '../../lib/tools/index.js'

const root = { sessionId: 'root', isRoot: true }
const worker = { sessionId: 'worker', isRoot: false }
const authority = { sessionId: 'root', runId: 'root' }
const intent = { request_key: 'request-1', action: 'send', target_id: 'worker', payload_hash: 'a'.repeat(64) }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'imperator-recovery-'))
  const store = new TaskforceStore(dir)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, dir, recovery: store.recovery }
}
function available(recovery) {
  assert.equal(typeof recovery?.beginControl, 'function', 'real store must expose its durable recovery journal')
  return recovery
}
function toolsHarness(store, { live, send, stop, parentSession } = {}) {
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } }]
  const agent = { id: 'root', session: { events, header: { id: 'root', version: 4, ...(parentSession ? { parentSession, origin: 'subagent', delegationDepth: 2 } : {}) } } }
  const definitions = new Map()
  let sends = 0, stops = 0
  const subagents = {
    async listChildren() { return [{ id: 'worker', mode: 'continuable', label: 'worker', createdAt: 0 }] },
    async sendMessage(...args) { sends++; return send ? send(...args) : 'message-1' },
    interrupt(...args) { stops++; return stop?.(...args) },
  }
  const ctx = {
    get(name) { return { taskforceStore: store, subagents, agents: { get(id) { return id === 'worker' ? live : undefined } } }[name] },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } },
    logger: { warn() {} },
  }
  applyTools(ctx)
  return {
    call(name, args, key = 'call-1') {
      return definitions.get(name).execute(args, { agent, callId: key, signal: new AbortController().signal }).then(JSON.parse)
    },
    events,
    get sends() { return sends }, get stops() { return stops },
  }
}
test('missing live agent after stop is unknown, never proved stopped', async t => {
  const { store } = fixture(t)
  const h = toolsHarness(store)
  const result = await h.call('task_child_stop', { target_id: 'worker' })
  assert.equal(result.execution.observed, 'unknown')
  assert.equal(result.execution.stopped, null)
  assert.equal(h.stops, 1)
})
test('explicit idle remains an observation and does not prove tree quiescence', async t => {
  const { store } = fixture(t)
  const h = toolsHarness(store, { live: { status: 'idle' } })
  const result = await h.call('task_child_stop', { target_id: 'worker' })
  assert.equal(result.execution.observed, 'inactive')
  assert.equal(result.execution.tree_quiescent, null)
})
test('durable intent precedes the external send and duplicate request invokes once', async t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const h = toolsHarness(store, { send() {
    const rows = recovery.inspect({}, 'root').operations
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'pending')
    return 'message-1'
  } })
  const first = await h.call('task_child_send', { target_id: 'worker', message: 'private payload' })
  const again = await h.call('task_child_send', { target_id: 'worker', message: 'private payload' })
  assert.equal(first.ok, true)
  assert.equal(first.operation.durable, true)
  assert.equal(again.operation.replayed, true)
  assert.equal(h.sends, 1)
  assert.equal(recovery.inspect({}, 'root').operations[0].status, 'accepted')
})
test('ambiguous send failure remains unknown and replay never repeats the effect', async t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const h = toolsHarness(store, { send() { throw new Error('SECRET accepted then disconnected') } })
  const one = await h.call('task_child_send', { target_id: 'worker', message: 'SECRET payload' })
  const two = await h.call('task_child_send', { target_id: 'worker', message: 'SECRET payload' })
  assert.equal(one.ok, false)
  assert.equal(two.operation.replayed, true)
  assert.equal(h.sends, 1)
  const state = recovery.inspect({}, 'root')
  assert.equal(state.operations[0].status, 'unknown')
  assert.equal(JSON.stringify(state).includes('SECRET'), false)
})
test('intent write failure prevents host invocation', async t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  store.open().exec("CREATE TRIGGER deny_intent BEFORE INSERT ON control_operation BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  const h = toolsHarness(store)
  const result = await h.call('task_child_send', { target_id: 'worker', message: 'hello' })
  assert.equal(result.ok, false)
  assert.equal(h.sends, 0)
})
test('accepted effect followed by failed outcome commit stays pending and is not resent', async t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  store.open().exec("CREATE TRIGGER deny_outcome BEFORE UPDATE ON control_operation BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  const h = toolsHarness(store)
  const result = await h.call('task_child_send', { target_id: 'worker', message: 'hello' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_CONTROL_OUTCOME_UNKNOWN')
  assert.equal(h.sends, 1)
  store.open().exec('DROP TRIGGER deny_outcome')
  const again = await h.call('task_child_send', { target_id: 'worker', message: 'hello' })
  assert.equal(again.operation.replayed, true)
  assert.equal(h.sends, 1)
  assert.equal(recovery.inspect({}, 'root').operations[0].status, 'pending')
})
test('persisted pending intent survives a second store and restart without abandonment', t => {
  const { store, dir, recovery } = fixture(t)
  const first = available(recovery).beginControl(intent, authority)
  const second = new TaskforceStore(dir)
  try {
    const replay = available(second.recovery).beginControl(intent, authority)
    assert.equal(replay.invoke, false)
    assert.equal(replay.operation_id, first.operation_id)
    assert.equal(second.recovery.inspect({}, 'root').operations[0].status, 'pending')
  } finally { second.close() }
  assert.equal(recovery.inspect({}, 'root').operations[0].status, 'pending')
  store.close()
  const restarted = new TaskforceStore(dir)
  try {
    assert.equal(restarted.recovery.beginControl(intent, authority).invoke, false)
    assert.equal(restarted.recovery.inspect({}, 'root').operations[0].status, 'pending')
  } finally { restarted.close() }
})
test('request-key conflicts and unauthorized finishes are rejected', t => {
  const { recovery } = fixture(t)
  const first = available(recovery).beginControl(intent, authority)
  assert.throws(() => recovery.beginControl({ ...intent, payload_hash: 'b'.repeat(64) }, authority), { code: 'E_RECOVERY_CONFLICT' })
  assert.throws(() => recovery.finishControl({ operation_id: first.operation_id, status: 'accepted' }, { sessionId: 'other' }), { code: 'E_RECOVERY_SCOPE' })
})
test('control result is immutable and equal completion is idempotent', t => {
  const { recovery } = fixture(t)
  const { operation_id } = available(recovery).beginControl(intent, authority)
  const result = { operation_id, status: 'accepted', message_id: 'message-1' }
  recovery.finishControl(result, authority)
  assert.equal(recovery.finishControl(result, authority).replayed, true)
  assert.throws(() => recovery.finishControl({ ...result, message_id: 'message-2' }, authority), { code: 'E_RECOVERY_CONFLICT' })
})
test('broken ancestry preserves direct control with caller-only recovery visibility', async t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const h = toolsHarness(store, { parentSession: 'missing-parent' })
  const result = await h.call('task_child_send', { target_id: 'worker', message: 'resume' })
  assert.equal(result.ok, true)
  assert.equal(recovery.inspect({}, 'root').operations.length, 0)
  assert.equal(recovery.inspect({}, null, { sessionId: 'root' }).operations.length, 1)
  assert.equal(recovery.inspect({}, null, { sessionId: 'other' }).operations.length, 0)
  assert.throws(() => recovery.inspect({}, null), { code: 'E_RECOVERY_SCOPE' })
})
test('task history is atomic with task mutation and contains owner/generation', t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const { task_id } = store.openTask({ title: 'secret task title' }, 'root')
  store.claimTask({ task_id, child_id: 'worker' }, 'root', worker, 'worker')
  const events = recovery.timeline({ task_id }, 'root').events
  assert.equal(events.length, 2)
  assert.equal(events[0].status, 'claimed')
  assert.equal(events[0].owner_session, 'worker')
  assert.equal(events[0].evidence_generation, 0)
  store.open().exec("CREATE TRIGGER deny_event BEFORE INSERT ON task_event BEGIN SELECT RAISE(ABORT, 'event failure'); END")
  assert.throws(() => store.submitTask({ task_id }, 'root', worker, 'worker'))
  assert.equal(store.taskOf(task_id, 'root').task.status, 'claimed')
  assert.equal(recovery.timeline({ task_id }, 'root').events.length, 2)
})
test('legacy tasks receive explicitly incomplete history baseline', t => {
  const { store, dir, recovery } = fixture(t)
  available(recovery)
  const { task_id } = store.openTask({ title: 'old task' }, 'root')
  store.open().exec('DROP TRIGGER recovery_task_insert; DROP TRIGGER recovery_task_update; DELETE FROM task_event')
  store.close()
  const reopened = new TaskforceStore(dir)
  try {
    const event = reopened.recovery.timeline({ task_id }, 'root').events[0]
    assert.equal(event.kind, 'baseline')
    assert.equal(event.history_complete, false)
  } finally { reopened.close() }
})
test('checkpoint captures trusted owner and generation without becoming evidence', t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const { task_id } = store.openTask({ title: 'work' }, 'root')
  store.claimTask({ task_id, child_id: 'worker' }, 'root', worker, 'worker')
  const c = recovery.checkpoint({ task_id, summary: 'SECRET context', next_action: 'read evidence' }, 'root', worker)
  assert.equal(c.owner_session, 'worker')
  assert.equal(c.evidence_generation, 0)
  assert.equal(c.evidence, false)
  assert.throws(() => recovery.checkpoint({ task_id, summary: 'steal' }, 'root', { sessionId: 'other', isRoot: false }), { code: 'E_RECOVERY_SCOPE' })
  assert.throws(() => recovery.checkpoint({ task_id, summary: 'steal' }, 'other-run', root))
  assert.equal(recovery.inspect({ task_id }, 'root').checkpoints[0].summary, 'SECRET context')
  assert.equal(JSON.stringify(recovery.diagnosticBundle({}, 'root')).includes('SECRET'), false)
  assert.throws(() => recovery.checkpoint({ task_id, summary: 'x'.repeat(4097) }, 'root', worker), { code: 'E_RECOVERY_INPUT' })
})
test('bounded pagination provides real continuation without exporting prose', t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  for (let i = 0; i < 140; i++) store.openTask({ title: 'SECRET-' + i }, 'root')
  const first = recovery.timeline({ limit: 2 }, 'root')
  const second = recovery.timeline({ limit: 2, cursor: first.next_cursor }, 'root')
  assert.equal(first.events.length, 2)
  assert.equal(second.events.length, 2)
  assert.equal(second.events[0].id < first.events[1].id, true)
  const bundle = recovery.diagnosticBundle({ limit: 100 }, 'root')
  assert.equal(Buffer.byteLength(JSON.stringify(bundle)) <= 16384, true)
  assert.equal(bundle.truncated, true)
  assert.equal(JSON.stringify(bundle).includes('SECRET'), false)
  assert.throws(() => recovery.timeline({ limit: 101 }, 'root'), { code: 'E_RECOVERY_INPUT' })
})
test('recovery and checkpoint are reachable through registered product tools', async t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const { task_id } = store.openTask({ title: 'work' }, 'root')
  const h = toolsHarness(store)
  const saved = await h.call('task_checkpoint', { task_id, summary: 'checkpoint' })
  assert.equal(saved.ok, true)
  const state = await h.call('task_board', { task_id, view: 'recovery' })
  assert.equal(state.checkpoints[0].summary, 'checkpoint')
  const timeline = await h.call('task_board', { task_id, view: 'timeline' })
  assert.equal(timeline.events[0].task_id, task_id)
})

test('database history does not infer actor identity from owner', t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const { task_id } = store.openTask({ title: 'work' }, 'root')
  store.claimTask({ task_id, child_id: 'worker' }, 'root', worker, 'worker')
  const event = recovery.timeline({ task_id }, 'root').events[0]
  assert.equal(event.actor_session, null)
  assert.equal(event.source, 'database_change')
})
test('adoption carries only unassigned recovery rows without laundering assigned history', t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const { task_id } = store.openTask({ title: 'old task' })
  recovery.checkpoint({ task_id, summary: 'private' }, null, root)
  store.adoptUnassigned('root')
  assert.equal(recovery.timeline({ task_id }, 'root').events.length >= 1, true)
  assert.equal(recovery.inspect({ task_id }, 'root').checkpoints.length, 1)
  const other = store.openTask({ title: 'other task' }).task_id
  store.open().prepare('UPDATE task_event SET run_id = ? WHERE task_id = ?').run('foreign', other)
  assert.throws(() => store.adoptUnassigned('root'), { code: 'E_STORE_INTEGRITY' })
  assert.equal(store.taskOf(other).task.run_id, null)
})
test('foreign checkpoint and event bodies are hidden and counted', t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const { task_id } = store.openTask({ title: 'work' }, 'root')
  recovery.checkpoint({ task_id, summary: 'FOREIGN_SECRET' }, 'root', root)
  store.open().prepare('UPDATE task_checkpoint SET run_id = ? WHERE task_id = ?').run('foreign', task_id)
  store.open().prepare('UPDATE task_event SET run_id = ? WHERE task_id = ?').run('foreign', task_id)
  const state = recovery.inspect({ task_id }, 'root')
  assert.equal(state.checkpoints.length, 0)
  assert.equal(state.scope_integrity.mismatched_checkpoints, 1)
  assert.equal(state.scope_integrity.mismatched_events, 1)
  assert.equal(JSON.stringify(state).includes('FOREIGN_SECRET'), false)
})
test('control task attribution requires matching run and actor ownership', t => {
  const { store, recovery } = fixture(t)
  available(recovery)
  const { task_id } = store.openTask({ title: 'work' }, 'root')
  assert.throws(() => recovery.beginControl({ ...intent, task_id }, { sessionId: 'other', runId: 'foreign' }))
  const operation = recovery.beginControl({ ...intent, task_id }, { ...authority, isRoot: true })
  assert.equal(operation.invoke, true)
  assert.equal(recovery.inspect({ task_id }, 'root').operations[0].task_id, task_id)
})

test('reused provider callId in another durable step is a new action', async t => {
  const { store } = fixture(t)
  const h = toolsHarness(store)
  await h.call('task_child_send', { target_id: 'worker', message: 'first' })
  h.events.push({ type: 'step/start', data: { turn: 1, step: 2 } })
  const result = await h.call('task_child_send', { target_id: 'worker', message: 'second' })
  assert.equal(result.ok, true)
  assert.equal(h.sends, 2)
})
test('missing durable call coordinates use new explicit retry keys', async t => {
  const { store } = fixture(t)
  const h = toolsHarness(store)
  h.events.length = 0
  const first = await h.call('task_child_send', { target_id: 'worker', message: 'repeat deliberately' })
  const second = await h.call('task_child_send', { target_id: 'worker', message: 'repeat deliberately' })
  assert.equal(h.sends, 2)
  assert.equal(typeof first.operation.retry_key, 'string')
  assert.notEqual(first.operation.retry_key, second.operation.retry_key)
  const replay = await h.call('task_child_send', { target_id: 'worker', message: 'repeat deliberately', request_key: first.operation.retry_key })
  assert.equal(replay.operation.replayed, true)
  assert.equal(h.sends, 2)
})
test('failed outcome persistence returns safe operation identity for reconciliation', async t => {
  const { store } = fixture(t)
  store.open().exec("CREATE TRIGGER failed_receipt BEFORE UPDATE ON control_operation BEGIN SELECT RAISE(ABORT, 'SECRET error'); END")
  const h = toolsHarness(store)
  const result = await h.call('task_child_send', { target_id: 'worker', message: 'SECRET' })
  assert.equal(typeof result.operation.operation_id, 'string')
  assert.equal(typeof result.operation.retry_key, 'string')
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})

test('checkpoint semantic failures participate in registered-tool ECHO', () => {
  const events = Array.from({ length: 3 }, (_, i) => [
    { type: 'tool/call', data: { callId: String(i), name: 'task_checkpoint', arguments: { task_id: 1, summary: 'x' } } },
    { type: 'tool/result', data: { callId: String(i), message: {
      isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'denied', code: 'E_RECOVERY_SCOPE', hint: 'read recovery' }) }],
    } } },
  ]).flat()
  assert.equal(foldGuardSignal(events, { echoFailures: 3, detectStall: false }).signal, 'echo')
})
test('unknown replay returns the complete semantic failure envelope', async t => {
  const { store } = fixture(t)
  const h = toolsHarness(store, { send() { throw new Error('unknown transport') } })
  await h.call('task_child_send', { target_id: 'worker', message: 'x' })
  const result = await h.call('task_child_send', { target_id: 'worker', message: 'x' })
  assert.equal(typeof result.error, 'string')
  assert.equal(typeof result.hint, 'string')
  assert.equal(h.sends, 1)
})
