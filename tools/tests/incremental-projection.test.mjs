import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as projections from '../../lib/plugins/event-projection.mjs'
import * as guard from '../../lib/plugins/guard.mjs'
import * as context from '../../lib/plugins/working-context.mjs'

const freeze = value => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const event = (type, data = {}) => ({ type, data })
const call = (id, name = 'read') => event('tool/call', { callId: id, name, arguments: { path: 'missing' } })
const result = (id, isError = true) => event('tool/result', { callId: id, isError })
const reasoning = () => event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'x'.repeat(300) }] } })
const options = { stallSteps: 2, stallReasoningChars: 200, globalStallCap: 3, echoFailures: 2 }
const ptc = (phase, id, name = 'read') => event(`tool/ptc-dispatch${phase === 'call' ? '-start' : ''}`,
  { rootCallId: 'wrapper', subCallId: id, name, arguments: { path: 'missing' }, isError: true })
const notice = id => event('user/message', { id, source: { kind: 'subagent-settled', senderSessionId: 'same-child' } })

// Removing full-prefix comparison, recursive immutability checks, or reducer
// cursor persistence must respectively break replacement, mutation or parity.
test('cursor checks the entire immutable prefix and replays every unsafe history', () => {
  assert.equal(typeof projections.createEventCursor, 'function', 'immutable cursor API is required')
  const cursor = projections.createEventCursor()
  const events = freeze([call('a'), call('b'), call('c')])
  assert.deepEqual(cursor.read(events), { reset: true, events })
  assert.deepEqual(cursor.read([...events]), { reset: false, events: [] })
  const appended = freeze([...events, result('c')])
  assert.deepEqual(cursor.read(appended), { reset: false, events: [appended.at(-1)] })
  const replaced = freeze([events[0], call('replacement'), ...appended.slice(2)])
  assert.deepEqual(cursor.read(replaced), { reset: true, events: replaced })
  const reordered = freeze([replaced[1], replaced[0], ...replaced.slice(2)])
  assert.deepEqual(cursor.read(reordered), { reset: true, events: reordered })
  assert.equal(cursor.read(reordered.slice(0, -1)).reset, true)
  const shallow = Object.freeze([Object.freeze(call('mutable-data'))])
  assert.equal(cursor.read(shallow).reset, true)
  shallow[0].data.name = 'subagent'
  assert.equal(cursor.read(shallow).reset, true)
  const accessor = Object.freeze({ get type() { return 'tool/call' } })
  assert.equal(cursor.read([accessor]).reset, true)
  assert.equal(cursor.read([accessor]).reset, true)
  const cycle = {}; cycle.self = cycle; Object.freeze(cycle)
  assert.equal(cursor.read([cycle]).reset, true)
  const date = Object.freeze({ data: Object.freeze(new Date()) })
  assert.equal(cursor.read([date]).reset, true)
})

test('every appended prefix matches replay with pending steps and causal native/PTC identities', () => {
  const source = freeze([
    event('turn/start', { turn: 1 }), event('step/start', { step: 1 }), reasoning(), reasoning(),
    event('step/start', { step: 2 }), reasoning(),
    call('a'), call('b'), result('b'), result('a'), result('a'),
    event('user/message', { source: { kind: guard.name, signal: 'echo' } }),
    call('wrapper', 'run_code'), result('wrapper', false), ptc('call', 'same'), ptc('result', 'same'),
    call('same'), result('same'), // same ID, distinct transport namespace
    ptc('result', 'late', 'subagent'), ptc('call', 'late', 'subagent'),
    call('child', 'subagent'), result('orphan', false), result('child', false),
    notice('n1'), notice('n1'), notice('n2'),
    event('step/end'), event('turn/end'), event('turn/start', { turn: 2 }),
    event('step/start', { step: 1 }), call('same'), result('same'),
    event('step/start', { step: 2 }), call('same'),
    event('tool/result', { callId: 'same', turn: 2, step: 1, isError: false,
      message: { source: { callId: 'same' } } }), result('same'),
  ])
  for (const settlement of ['settled-notice', 'tool-result']) {
    const g = projections.createGuardProjection(options)
    const f = projections.createFlowProjection(undefined, settlement)
    for (let i = 0; i <= source.length; i++) {
      const prefix = source.slice(0, i)
      assert.deepEqual(g.read(prefix), guard.foldGuardSignals(prefix, options), `guard prefix ${i}`)
      assert.deepEqual(g.read(prefix), guard.foldGuardSignals(prefix, options), `guard reread ${i}`)
      assert.deepEqual(f.read(prefix), context.foldSubagentFlow(prefix, undefined, settlement), `flow prefix ${i}`)
    }
    assert.equal(g.processedEvents, source.length)
    assert.equal(f.processedEvents, source.length)
  }
})

test('retrospective PTC wrapper removal preserves the earlier failure tail', () => {
  const g = projections.createGuardProjection({ echoFailures: 2 })
  const events = freeze([call('a'), result('a'), call('b'), result('b'), call('wrapper', 'run_code'), result('wrapper', false)])
  assert.equal(g.read(events).echo, undefined)
  const extended = freeze([...events, ptc('result', 'orphan')])
  assert.equal(g.read(extended).echo?.signal, 'echo')
  assert.deepEqual(g.read(extended), guard.foldGuardSignals(extended, { echoFailures: 2 }))
})

test('mutable restored histories, replacements, reorder and truncation match full replay', () => {
  for (const immutable of [false, true]) {
    const g = projections.createGuardProjection({ echoFailures: 2 })
    const f = projections.createFlowProjection()
    let events = [call('a', 'subagent'), result('a'), call('b', 'subagent'), result('b')]
    if (immutable) events = freeze(events)
    const read = () => {
      assert.deepEqual(g.read(events), guard.foldGuardSignals(events, { echoFailures: 2 }))
      assert.deepEqual(f.read(events), context.foldSubagentFlow(events))
    }
    read()
    if (!immutable) events[1].data.isError = false
    else events = freeze([events[0], result('a', false), ...events.slice(2)])
    read()
    events = [events[2], events[1], events[0], events[3]]
    read()
    events = events.slice(0, 2)
    read()
  }
})

test('option changes reprocess the immutable history and keep independent projections isolated', () => {
  const config = { echoFailures: 2, ...options }
  const g = projections.createGuardProjection(config)
  const events = freeze([call('a'), result('a'), call('b'), result('b')])
  assert.equal(g.read(events).echo?.signal, 'echo')
  config.echoFailures = 3
  assert.equal(g.read(events).echo, undefined)
  assert.equal(g.processedEvents, events.length * 2)
  const names = new Set(['subagent'])
  const flow = projections.createFlowProjection(names)
  const child = freeze([call('child', 'subagent')])
  assert.equal(flow.read(child).inFlight, 1)
  names.clear()
  assert.equal(flow.read(child).inFlight, 0)
  assert.equal(flow.processedEvents, 2)
  assert.equal(projections.createFlowProjection().read([]).dispatched, 0)
})

test('40000 immutable events are reduced once; rereads and one append reduce only the tail', () => {
  const events = freeze(Array.from({ length: 40000 }, (_, seq) => ({ seq, ...call(String(seq), 'subagent') })))
  const g = projections.createGuardProjection(options)
  const f = projections.createFlowProjection()
  for (const projection of [g, f]) {
    projection.read(events)
    assert.equal(projection.processedEvents, 40000)
    projection.read(events)
    assert.equal(projection.processedEvents, 40000)
  }
  const extended = freeze([...events, { seq: 40000, ...result('39999', false) }])
  assert.deepEqual(g.read(extended), guard.foldGuardSignals(extended, options))
  assert.deepEqual(f.read(extended), context.foldSubagentFlow(extended))
  assert.equal(g.processedEvents, 40001)
  assert.equal(f.processedEvents, 40001)
})

function runtime(plugin, config) {
  const hooks = new Map()
  const owner = {}
  plugin.apply({ on: (name, fn) => hooks.set(name, fn), get: name => name === 'agentPresets'
    ? { composedPreset: ctx => ctx?.preset ?? owner } : undefined }, config)
  return {
    owner, hooks,
    pre: agent => hooks.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] })),
  }
}

test('runtime flow remains isolated across agents, preset changes and same-ID session replacement', async () => {
  const h = runtime(context)
  const a = { ctx: { preset: h.owner }, session: { header: { id: 'root' }, events: freeze([call('a', 'subagent')]) } }
  const b = { ctx: { preset: h.owner }, session: { header: { id: 'root' }, events: freeze([call('a', 'subagent'), call('b', 'subagent')]) } }
  const text = decision => decision.messages[0]?.content[0].text
  assert.match(text(await h.pre(a)), /估计 1/)
  assert.match(text(await h.pre(b)), /估计 2/)
  a.ctx.preset = {}
  assert.deepEqual((await h.pre(a)).messages, [])
  a.ctx.preset = h.owner
  a.session = { header: { id: 'root' }, events: freeze([notice('completed')]) }
  assert.match(text(await h.pre(a)), /结算通知.*1/)
  assert.match(text(await h.pre(b)), /估计 2/)
})

test('runtime guard thresholds replay on effort changes, without downgrading requests', async () => {
  const h = runtime(guard, { stallAction: 'interrupt', stepDownRequests: 0, sensitivity: 'balanced' })
  const a = { session: { events: freeze([event('assistant/message', { message:
    { content: [{ type: 'reasoning', text: 'x'.repeat(9000) }] } })]) } }
  const request = value => h.hooks.get('agent/request')({ agent: a }, async () => value)
  const high = { reasoningEffort: 'high' }
  assert.equal(await request(high), high)
  assert.deepEqual((await h.pre(a)).messages, [])
  const max = { reasoningEffort: 'max' }
  assert.equal(await request(max), max)
  assert.equal((await h.pre(a)).messages[0]?.source.signal, 'stall')
})

// A Proxy over a frozen target can invent changing absent properties. Such
// histories must replay; ordinary JSON reducer reuse is covered above.
for (const plugin of [guard, context]) {
  test(`${plugin.name} runtime conservatively replays Proxy graphs across session/scope changes`, async () => {
    const h = runtime(plugin, { stallAction: 'observe', stepDownRequests: 0 })
    let dataReads = 0
    const counted = new Proxy(freeze(call('child', 'subagent')), {
      get(target, property, receiver) {
        if (property === 'data') dataReads++
        return Reflect.get(target, property, receiver)
      },
    })
    const a = { ctx: { preset: h.owner }, session: { header: { id: 'same' }, events: [counted] } }
    await h.pre(a)
    assert.ok(dataReads > 0)
    dataReads = 0
    await h.pre(a)
    assert.ok(dataReads > 0, 'Proxy graphs must replay even when their targets are frozen')
    const b = { ctx: a.ctx, session: a.session }
    dataReads = 0
    await h.pre(b)
    assert.ok(dataReads > 0, 'another agent must have an independent reducer')
    dataReads = 0
    await h.pre(a)
    assert.ok(dataReads > 0, 'a reused agent must still replay a Proxy graph')
    a.session = { header: { id: 'same' }, events: [counted] }
    dataReads = 0
    await h.pre(a)
    assert.ok(dataReads > 0, 'same-ID replacement session must replay')
    dataReads = 0
    a.ctx.preset = {}
    await h.pre(a)
    a.ctx.preset = h.owner
    await h.pre(a)
    assert.ok(dataReads > 0, 'leaving and rejoining the preset must replay')
    dataReads = 0
    h.hooks.get('agent/disposed')({ agent: a })
    await h.pre(a)
    assert.ok(dataReads > 0, 'disposal must drop the projection')
  })
}

test('non-JSON sparse arrays conservatively force replay', () => {
  const cursor = projections.createEventCursor()
  const sparse = Object.freeze([, 'value'])
  const nonJson = freeze(event('unknown', { sparse }))
  assert.equal(cursor.read([nonJson]).reset, true)
  assert.equal(cursor.read([nonJson]).reset, true)
})

test('sequence gaps conservatively force replay', () => {
  const cursor = projections.createEventCursor()
  const events = freeze([{ seq: 1, ...call('a') }, { seq: 2, ...result('a') }])
  assert.equal(cursor.read(events).reset, true)
  assert.equal(cursor.read(events).reset, false)
  const gap = freeze([...events, { seq: 4, ...call('b') }])
  assert.deepEqual(cursor.read(gap), { reset: true, events: gap })
  assert.equal(cursor.read(gap).reset, true)
})

test('cached flow preserves todo updates, context deduplication and compaction visibility', async () => {
  const h = runtime(context)
  const a = { session: { header: { id: 'root' }, surface: { nodes: [] }, events: freeze([
    { seq: 0, ...call('child', 'subagent') },
    { seq: 1, ...event('todo/write', { todos: [{ id: 't1', content: 'first task', status: 'in_progress' }] }) },
  ]) } }
  const first = await h.pre(a)
  const line = first.messages[0].content[0].text
  assert.match(line, /first task/)
  a.session.events = freeze([...a.session.events, { seq: 2, type: 'user/message', data: first.messages[0] }])
  a.session.surface.nodes = [2]
  assert.deepEqual((await h.pre(a)).messages, [])
  a.session.surface.nodes = []
  assert.equal((await h.pre(a)).messages[0].content[0].text, line)
  a.session.events = freeze([...a.session.events, { seq: 3, ...event('turn/start', { turn: 2 }) }])
  const changed = (await h.pre(a)).messages[0].content[0].text
  assert.doesNotMatch(changed, /first task/)
  assert.match(changed, /估计 1/)
})
