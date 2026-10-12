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

const failures = (prefix, count = 6) => Array.from({ length: count }, (_, index) =>
  [call(`${prefix}-${index}`), result(`${prefix}-${index}`)]).flat()
const decisionText = decision => decision.messages.map(message => message.content[0].text).join('\n')

// Reusing the full fork prefix in either runtime must fail these assertions.
test('fork guard and dispatch estimates start empty and retain restored own activity', async () => {
  for (const plugin of [guard, context]) {
    const h = runtime(plugin, { stallAction: 'observe', stepDownRequests: 0 })
    const prefix = freeze([...failures('parent'), call('parent-dispatch', 'subagent'), notice('parent-notice')])
    const a = { session: { header: { id: 'child' }, events: prefix, inheritedEventCount: prefix.length } }
    assert.deepEqual((await h.pre(a)).messages, [], `${plugin.name}: inherited activity is not owned`)
    a.session.events = freeze([...prefix, ...failures('own'), call('own-dispatch', 'subagent')])
    // A dispatch following failures breaks ECHO, so guard gets its own tail.
    if (plugin === guard) a.session.events = freeze([...prefix, ...failures('own')])
    const own = await h.pre(a)
    if (plugin === guard) assert.equal(own.messages[0]?.source.signal, 'echo')
    else assert.match(decisionText(own), /未结算派发估计 1/)
    a.session = { ...a.session, firstLiveSeq: a.session.events.length }
    const restored = await h.pre(a)
    if (plugin === guard) assert.equal(restored.messages[0]?.source.signal, 'echo')
    else assert.match(decisionText(restored), /未结算派发估计 1/)
  }
})

test('root and unseeded child cuts retain own failures, ACK and unknown barriers', async () => {
  for (const inheritedEventCount of [undefined, 0]) {
    const h = runtime(guard, { stallAction: 'observe', stepDownRequests: 0 })
    const a = { session: { inheritedEventCount, firstLiveSeq: 99, events: freeze(failures('own')) } }
    const warning = (await h.pre(a)).messages[0]
    assert.equal(warning.source.signal, 'echo')
    a.session = { ...a.session, events: freeze([...a.session.events, event('user/message', warning)]) }
    assert.deepEqual((await h.pre(a)).messages, [], 'persisted own acknowledgment survives restore')
    const unknown = event('tool/result', { callId: 'barrier', isError: true, error: { code: 'TOOL_OUTCOME_UNKNOWN' } })
    a.session = { ...a.session, events: freeze([...failures('before'), call('barrier'), unknown, ...failures('after', 4)]) }
    assert.deepEqual((await h.pre(a)).messages, [], 'unknown effects break the definite failure tail')
  }
})

test('inherited STALL is excluded while own reasoning still triggers the configured signal', async () => {
  const h = runtime(guard, { stallReasoningChars: 200, sensitivity: 'balanced', stepDownRequests: 0 })
  const a = { session: { inheritedEventCount: 1, events: freeze([reasoning()]) } }
  assert.deepEqual((await h.pre(a)).messages, [])
  a.session.events = freeze([...a.session.events, reasoning()])
  assert.equal((await h.pre(a)).messages[0]?.source.signal, 'stall')
})

test('invalid and changing inherited cuts clear previously observed activity', async () => {
  const invalidCuts = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, 1000]
  for (const plugin of [guard, context]) {
    const h = runtime(plugin, { stallAction: 'observe', stepDownRequests: 0 })
    const events = freeze(plugin === guard ? failures('own') : [call('own', 'subagent')])
    const a = { session: { events, inheritedEventCount: 0 } }
    assert.equal((await h.pre(a)).messages.length, 1)
    for (const cut of invalidCuts) {
      a.session.inheritedEventCount = cut
      assert.deepEqual((await h.pre(a)).messages, [], `unavailable cut ${String(cut)}`)
    }
    Object.defineProperty(a.session, 'inheritedEventCount', { configurable: true, get() { throw new Error('unreadable cut') } })
    assert.deepEqual((await h.pre(a)).messages, [])
    Object.defineProperty(a.session, 'inheritedEventCount', { configurable: true, writable: true, value: events.length })
    assert.deepEqual((await h.pre(a)).messages, [])
    a.session.inheritedEventCount = 0
    assert.equal((await h.pre(a)).messages.length, 1, 'changed ownership resets runtime episode and projection')
  }
})

test('fork keeps full visible context for inherited TODO, dedup, compaction and unknown supersession', async () => {
  const h = runtime(context)
  const todo = event('todo/write', { todos: [{ id: 't', content: 'inherited task', status: 'in_progress' }] })
  const a = { session: { header: { id: 'child' }, inheritedEventCount: 1,
    surface: { nodes: [] }, events: freeze([{ seq: 0, ...todo }]) } }
  const first = (await h.pre(a)).messages[0]
  assert.match(first.content[0].text, /inherited task/)
  a.session.events = freeze([...a.session.events, { seq: 1, type: 'user/message', data: first }])
  a.session.inheritedEventCount = 2
  a.session.surface.nodes = [1]
  assert.deepEqual((await h.pre(a)).messages, [], 'visible inherited status deduplicates')
  a.session.surface.nodes = []
  assert.equal((await h.pre(a)).messages[0].content[0].text, first.content[0].text, 'compaction republishes')
  a.session.surface.nodes = [1]
  a.session.events = freeze([...a.session.events, { seq: 2, ...event('turn/start', { turn: 2 }) }])
  const superseded = (await h.pre(a)).messages[0]
  assert.match(superseded.content[0].text, /当前无可确认状态，勿沿用旧投影/)
  a.session.events = freeze([...a.session.events, { seq: 3, type: 'user/message', data: superseded }])
  a.session.surface.nodes = [1, 3]
  assert.deepEqual((await h.pre(a)).messages, [], 'unknown supersession itself deduplicates')
})

test('owned window preserves references and seq without reading a large inherited prefix', async () => {
  const module = await import('../../lib/plugins/session-observation.mjs').catch(() => ({}))
  assert.equal(typeof module.ownedSessionEvents, 'function', 'shared owned window is required')
  const { ownedSessionEvents } = module
  const events = new Array(40002)
  for (let index = 0; index < 40000; index++) Object.defineProperty(events, index, {
    get() { assert.fail('owned slicing must not inspect inherited events') },
  })
  events[40000] = freeze({ seq: 40000, ...call('own', 'subagent') })
  events[40001] = freeze({ seq: 40001, ...result('own', false) })
  Object.freeze(events)
  const session = { inheritedEventCount: 40000, firstLiveSeq: 40002 }
  const f = context.createFlowProjection()
  for (let read = 0; read < 2; read++) {
    const window = ownedSessionEvents(session, events)
    assert.equal(window.valid, true)
    assert.equal(window.events.length, 2)
    assert.equal(window.events[0], events[40000])
    assert.equal(window.events[0].seq, 40000)
    assert.equal(f.read(window.events).inFlight, 1)
  }
  assert.equal(f.processedEvents, 2, 'only the owned suffix reaches the reducer')
  const rootEvents = freeze([call('root', 'subagent')])
  assert.equal(ownedSessionEvents({}, rootEvents).events, rootEvents, 'legacy root retains original history semantics')
  assert.deepEqual(ownedSessionEvents({ inheritedEventCount: -1 }, events).events, [])
  assert.equal(ownedSessionEvents({ inheritedEventCount: -1 }, events).valid, false)
})

test('owned flow replays mutable, accessor, replacement and truncated history', async () => {
  const h = runtime(context)
  const inherited = freeze(call('parent', 'subagent'))
  const mutable = call('own', 'subagent')
  const a = { session: { inheritedEventCount: 1, events: [inherited, mutable] } }
  assert.match(decisionText(await h.pre(a)), /估计 1/)
  mutable.data.name = 'read'
  assert.deepEqual((await h.pre(a)).messages, [])
  let current = freeze(call('replacement', 'subagent'))
  const accessor = [inherited]
  Object.defineProperty(accessor, 1, { get: () => current })
  a.session.events = Object.freeze(accessor)
  assert.match(decisionText(await h.pre(a)), /估计 1/)
  current = freeze(call('replaced', 'read'))
  assert.deepEqual((await h.pre(a)).messages, [])
  a.session.events = freeze([inherited, call('new', 'subagent')])
  assert.match(decisionText(await h.pre(a)), /估计 1/)
  a.session.events = freeze([inherited])
  assert.deepEqual((await h.pre(a)).messages, [])
})

// Task20 preserves public behavior; every case is expected to pass before optimization.
test('certified frozen repeats return fresh isolated public tails, including empty histories', () => {
  for (const events of [freeze([{ seq: 0, ...call('repeat') }]), freeze([])]) {
    const originalLength = events.length
    const cursor = projections.createEventCursor()
    const first = cursor.read(events)
    assert.deepEqual(Object.keys(first), ['reset', 'events'])
    assert.equal(first.reset, true)
    assert.equal(first.events, events)
    const second = cursor.read(events)
    const third = cursor.read(events)
    for (const update of [second, third]) {
      assert.deepEqual(Object.keys(update), ['reset', 'events'])
      assert.equal(update.reset, false)
      assert.deepEqual(update.events, [])
      assert.notEqual(update.events, events)
    }
    assert.notEqual(second, third)
    assert.notEqual(second.events, third.events)
    second.events.push('caller-owned tail mutation')
    const fourth = cursor.read(events)
    assert.deepEqual(fourth, { reset: false, events: [] })
    assert.notEqual(fourth.events, second.events)
    assert.notEqual(fourth.events, third.events)
    assert.equal(events.length, originalLength)
    assert.equal(events.includes('caller-owned tail mutation'), false)
  }
})

test('historical frozen arrays are compared with the current prefix after replacement and truncation', () => {
  const a = freeze([
    { seq: 0, ...call('a', 'subagent') }, { seq: 1, ...result('a') },
    { seq: 2, ...call('b', 'subagent') }, { seq: 3, ...result('b') },
  ])
  const equal = Object.freeze([...a])
  const changed = freeze([a[0], { seq: 1, ...result('a', false) }, a[2], a[3]])
  const appended = freeze([...a, { seq: 4, ...call('tail', 'subagent') }])
  const shorter = Object.freeze(a.slice(0, 2))
  const cursor = projections.createEventCursor()
  const g = projections.createGuardProjection(options)
  const f = projections.createFlowProjection()
  let processed = 0
  for (const [input, reset, added] of [
    [a, true, 4], [equal, false, 0], [a, false, 0],
    [changed, true, 4], [a, true, 4], [a, false, 0],
    [appended, false, 1], [shorter, true, 2], [shorter, false, 0],
  ]) {
    const update = cursor.read(input)
    assert.equal(update.reset, reset)
    if (reset) assert.equal(update.events, input)
    else assert.deepEqual(update.events, added ? [appended[4]] : [])
    if (!reset && added) assert.equal(update.events[0], appended[4])
    assert.deepEqual(g.read(input), guard.foldGuardSignals(input, options))
    assert.deepEqual(f.read(input), context.foldSubagentFlow(input))
    processed += added
    assert.equal(g.processedEvents, processed)
    assert.equal(f.processedEvents, processed)
  }
})

test('unsafe intervening histories clear the accepted prefix without reading own getters', () => {
  const a = freeze([{ seq: 0, ...call('safe') }, { seq: 1, ...result('safe') }])
  let getterReads = 0
  const accessor = [a[0]]
  Object.defineProperty(accessor, 1, { get() { getterReads++; return a[1] } })
  Object.freeze(accessor)
  const unsafe = [
    ['mutable graph', Object.freeze([a[0], { seq: 1, ...result('mutable') }])],
    ['own accessor', accessor],
    ['sparse outer', Object.freeze([a[0], ,])],
    ['Proxy outer', new Proxy(a, {})],
    ['Proxy graph', Object.freeze([a[0], new Proxy(a[1], {})])],
    ['sequence gap', freeze([a[0], { seq: 3, ...result('safe') }])],
    ['unsafe sequence', freeze([a[0], { seq: Number.MAX_SAFE_INTEGER + 1, ...result('safe') }])],
  ]
  for (const [label, input] of unsafe) {
    const cursor = projections.createEventCursor()
    assert.equal(cursor.read(a).events, a)
    const rejected = cursor.read(input)
    assert.equal(rejected.reset, true, label)
    assert.equal(rejected.events, input, label)
    assert.equal(getterReads, 0, 'cursor rejection must not invoke an own slot getter')
    const rebuilt = cursor.read(a)
    assert.equal(rebuilt.reset, true, label)
    assert.equal(rebuilt.events, a, label)
    assert.deepEqual(cursor.read(a), { reset: false, events: [] }, label)
  }
})

test('revoked Proxy normalization throws without clearing the original accepted prefix', () => {
  const a = freeze([{ seq: 0, ...call('before-revocation') }])
  const cursor = projections.createEventCursor()
  assert.equal(cursor.read(a).events, a)
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  assert.throws(() => cursor.read(revoked.proxy), TypeError)
  const after = cursor.read(a)
  assert.deepEqual(after, { reset: false, events: [] })
  const repeated = cursor.read(a)
  assert.deepEqual(repeated, { reset: false, events: [] })
  assert.notEqual(after.events, repeated.events)
})

test('current global iterator descriptors still reject an already certified exact array', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)
  for (const mode of ['different value', 'accessor']) {
    const a = freeze([{ seq: 0, ...call('iterator-guard') }])
    const cursor = projections.createEventCursor()
    assert.equal(cursor.read(a).events, a)
    let iteratorCalls = 0
    let getterReads = 0
    const replacement = mode === 'accessor'
      ? { configurable: descriptor.configurable, enumerable: descriptor.enumerable,
        get() { getterReads++; return descriptor.value } }
      : { ...descriptor, value() { iteratorCalls++; throw new Error('unexpected iterator invocation') } }
    let update
    try {
      Object.defineProperty(Array.prototype, Symbol.iterator, replacement)
      update = cursor.read(a)
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, descriptor)
    }
    // Assertions and array-consuming helpers run only after exact restoration.
    assert.equal(update.reset, true, mode)
    assert.equal(update.events, a, mode)
    assert.equal(iteratorCalls, 0)
    assert.equal(getterReads, 0)
    assert.deepEqual(cursor.read(a), { reset: true, events: a })
    assert.deepEqual(cursor.read(a), { reset: false, events: [] })
  }
})

test('same mutable outer middle replacements and restored nested mutations match full replay', () => {
  const a = freeze([
    { seq: 0, ...call('a', 'subagent') }, { seq: 1, ...result('a') },
    { seq: 2, ...call('b', 'subagent') }, { seq: 3, ...result('b') },
  ])
  const mutable = [...a]
  const restored = Object.freeze([
    { seq: 0, ...call('restored-a', 'subagent') }, { seq: 1, ...result('restored-a') },
    { seq: 2, ...call('restored-b', 'subagent') }, { seq: 3, ...result('restored-b') },
  ])
  const cursor = projections.createEventCursor()
  const g = projections.createGuardProjection(options)
  const f = projections.createFlowProjection()
  let processed = 0
  const check = (input, reset, added) => {
    const update = cursor.read(input)
    assert.equal(update.reset, reset)
    if (reset) assert.equal(update.events, input)
    else assert.deepEqual(update.events, [])
    assert.deepEqual(g.read(input), guard.foldGuardSignals(input, options))
    const flow = f.read(input)
    assert.deepEqual(flow, context.foldSubagentFlow(input))
    processed += added
    assert.equal(g.processedEvents, processed)
    assert.equal(f.processedEvents, processed)
    return flow
  }
  check(a, true, 4)
  check(mutable, false, 0)
  mutable[1] = freeze({ seq: 1, ...result('a', false) })
  check(mutable, true, 4)
  check(a, true, 4)
  check(a, false, 0)
  assert.equal(check(restored, true, 4).dispatched, 2)
  restored[0].data.name = 'read'
  restored[1].data.isError = false
  assert.equal(check(restored, true, 4).dispatched, 1)
  check(a, true, 4)
  check(a, false, 0)
})

for (const fault of ['WeakRef unavailable', 'constructor throws', 'deref unavailable', 'deref throws', 'deref returns undefined']) {
  test(`optional weak capability fallback preserves cursor and projection behavior: ${fault}`, t => {
    const weakDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WeakRef')
    const hostWeakRef = weakDescriptor.value
    const derefDescriptor = Object.getOwnPropertyDescriptor(hostWeakRef.prototype, 'deref')
    const a = freeze([{ seq: 0, ...call('weak-a') }, { seq: 1, ...result('weak-a') }])
    const changed = freeze([a[0], { seq: 1, ...result('weak-a', false) }])
    const revoked = Proxy.revocable([], {})
    revoked.revoke()
    const cursor = projections.createEventCursor()
    assert.equal(cursor.read(a).events, a)
    const callbacks = []
    let projection
    projection = projections.createEventProjection(() => ({
      append(batch) { callbacks.push({ kind: 'append', batch, processed: projection.processedEvents }) },
      snapshot() {
        const snapshot = { processed: projection.processedEvents }
        callbacks.push({ kind: 'snapshot', processed: projection.processedEvents })
        return snapshot
      },
    }), () => { callbacks.push({ kind: 'policy', processed: projection.processedEvents }); return 'stable' })
    const initialSnapshot = projection.read(a)
    let faultObserved = false
    const faultError = new Error('optional weak facility unavailable')
    const target = fault.startsWith('deref') ? hostWeakRef.prototype : globalThis
    const key = fault.startsWith('deref') ? 'deref' : 'WeakRef'
    const original = fault.startsWith('deref') ? derefDescriptor : weakDescriptor
    const value = fault === 'WeakRef unavailable' || fault === 'deref unavailable' ? undefined
      : fault === 'deref returns undefined' ? function () { faultObserved = true; return undefined }
        : function () { faultObserved = true; throw faultError }
    let repeated, replaced, historical, afterThrow, thrown, firstSnapshot, secondSnapshot
    try {
      Object.defineProperty(target, key, { ...original, value })
      repeated = cursor.read(a)
      replaced = cursor.read(changed)
      historical = cursor.read(a)
      try { cursor.read(revoked.proxy) } catch (error) { thrown = error }
      afterThrow = cursor.read(a)
      firstSnapshot = projection.read(a)
      secondSnapshot = projection.read(a)
    } finally {
      Object.defineProperty(target, key, original)
    }
    assert.deepEqual(repeated, { reset: false, events: [] })
    assert.equal(replaced.reset, true)
    assert.equal(replaced.events, changed)
    assert.equal(historical.reset, true)
    assert.equal(historical.events, a)
    assert.ok(thrown instanceof TypeError, 'original revoked-Proxy failure still propagates')
    assert.notEqual(thrown, faultError)
    assert.deepEqual(afterThrow, { reset: false, events: [] })
    assert.notEqual(repeated.events, afterThrow.events)
    assert.notEqual(firstSnapshot, initialSnapshot)
    assert.notEqual(firstSnapshot, secondSnapshot)
    assert.deepEqual(firstSnapshot, { processed: a.length })
    assert.deepEqual(secondSnapshot, { processed: a.length })
    assert.equal(projection.processedEvents, a.length)
    assert.deepEqual(callbacks.map(entry => entry.kind), ['policy', 'append', 'snapshot', 'policy', 'append', 'snapshot', 'policy', 'append', 'snapshot'])
    assert.deepEqual(callbacks.map(entry => entry.processed), [0, 0, a.length, a.length, a.length, a.length, a.length, a.length, a.length])
    assert.equal(callbacks[1].batch, a)
    assert.deepEqual(callbacks[4].batch, [])
    assert.deepEqual(callbacks[7].batch, [])
    assert.notEqual(callbacks[4].batch, callbacks[7].batch)
    const resumed = cursor.read(a)
    assert.deepEqual(resumed, { reset: false, events: [] })
    assert.notEqual(resumed.events, afterThrow.events)
    // No assertion depends on optional internals being attempted by the baseline.
    t.diagnostic(JSON.stringify({ obligation: 'T6', fault, faultObserved,
      qualification: faultObserved ? 'optional fault observed; public fallback checked' : 'public fallback checked; optional fault invocation unobserved',
      noTargetIsDeterministicFault: fault === 'deref returns undefined', garbageCollectionClaim: false }))
  })
}

test('outer frozen certification failure remains optional while graph checks delegate normally', t => {
  const a = freeze([{ seq: 0, ...call('certification') }, { seq: 1, ...result('certification') }])
  const cursor = projections.createEventCursor()
  const descriptor = Object.getOwnPropertyDescriptor(Object, 'isFrozen')
  const original = descriptor.value
  let outerFaultObserved = false
  let graphDelegateObserved = false
  let first, second
  try {
    Object.defineProperty(Object, 'isFrozen', { ...descriptor, value(value) {
      if (value === a) { outerFaultObserved = true; throw new Error('optional outer certification fault') }
      graphDelegateObserved = true
      return original(value)
    } })
    first = cursor.read(a)
    second = cursor.read(a)
  } finally {
    Object.defineProperty(Object, 'isFrozen', descriptor)
  }
  assert.equal(first.reset, true)
  assert.equal(first.events, a)
  assert.deepEqual(second, { reset: false, events: [] })
  const third = cursor.read(a)
  const fourth = cursor.read(a)
  assert.deepEqual(third, { reset: false, events: [] })
  assert.deepEqual(fourth, { reset: false, events: [] })
  assert.notEqual(second.events, third.events)
  assert.notEqual(third.events, fourth.events)
  // A non-firing branch is a coverage qualification, never a manufactured RED.
  t.diagnostic(JSON.stringify({ obligation: 'T7', outerFaultObserved, graphDelegateObserved,
    qualification: outerFaultObserved ? 'outer certification fault observed; public fallback checked' : 'public preservation checked; outer fault unobserved' }))
})

test('projection repeats still append distinct empty tails and return fresh snapshots in policy order', () => {
  const a = freeze([{ seq: 0, ...call('callbacks') }, { seq: 1, ...result('callbacks') }])
  const callbacks = []
  let projection
  projection = projections.createEventProjection(() => {
    callbacks.push(['create', projection.processedEvents])
    return {
      append(batch) { callbacks.push(['append', batch, projection.processedEvents]) },
      snapshot() { callbacks.push(['snapshot', projection.processedEvents]); return { processed: projection.processedEvents } },
    }
  }, () => { callbacks.push(['policy', projection.processedEvents]); return 'stable' })
  const first = projection.read(a)
  const second = projection.read(a)
  const third = projection.read(a)
  assert.deepEqual(callbacks.map(entry => entry[0]), ['policy', 'create', 'append', 'snapshot', 'policy', 'append', 'snapshot', 'policy', 'append', 'snapshot'])
  assert.equal(callbacks[2][1], a)
  assert.equal(callbacks[2][2], 0)
  assert.deepEqual(callbacks[3], ['snapshot', 2])
  assert.deepEqual(callbacks[5], ['append', [], 2])
  assert.deepEqual(callbacks[8], ['append', [], 2])
  assert.notEqual(callbacks[5][1], callbacks[8][1])
  assert.deepEqual(first, { processed: 2 })
  assert.deepEqual(second, first)
  assert.deepEqual(third, first)
  assert.notEqual(first, second)
  assert.notEqual(second, third)
  assert.equal(projection.processedEvents, 2)
})

for (const failurePoint of ['append', 'snapshot']) {
  test(`nonempty ${failurePoint} failure retains callback counters and the committed cursor on retry`, () => {
    const a = freeze([{ seq: 0, ...call('fault-batch') }, { seq: 1, ...result('fault-batch') }])
    const appended = freeze([...a, { seq: 2, ...call('new-event') }])
    const failure = new Error('reducer ' + failurePoint + ' fault')
    const callbacks = []
    let failNext = false
    let projection
    projection = projections.createEventProjection(() => {
      const accepted = []
      callbacks.push(['create', projection.processedEvents])
      return {
        append(batch) {
          callbacks.push(['append', batch, projection.processedEvents])
          if (failNext && failurePoint === 'append') { failNext = false; throw failure }
          accepted.push(...batch)
        },
        snapshot() {
          callbacks.push(['snapshot', projection.processedEvents])
          if (failNext && failurePoint === 'snapshot') { failNext = false; throw failure }
          return { events: accepted.slice(), processed: projection.processedEvents }
        },
      }
    }, () => { callbacks.push(['policy', projection.processedEvents]); return 'stable' })
    assert.deepEqual(projection.read(a), { events: a, processed: 2 })
    failNext = true
    assert.throws(() => projection.read(appended), error => error === failure)
    const expectedProcessed = failurePoint === 'append' ? 2 : 3
    assert.equal(projection.processedEvents, expectedProcessed)
    assert.deepEqual(callbacks[4], ['policy', 2])
    assert.deepEqual(callbacks[5], ['append', [appended[2]], 2])
    assert.equal(callbacks.length, failurePoint === 'append' ? 6 : 7)
    if (failurePoint === 'snapshot') assert.deepEqual(callbacks[6], ['snapshot', 3])
    const beforeRetry = callbacks.length
    const retried = projection.read(appended)
    assert.deepEqual(callbacks.slice(beforeRetry), [
      ['policy', expectedProcessed], ['append', [], expectedProcessed], ['snapshot', expectedProcessed],
    ])
    assert.deepEqual(retried, { events: failurePoint === 'append' ? a : appended, processed: expectedProcessed })
    assert.equal(projection.processedEvents, expectedProcessed)
  })
}
