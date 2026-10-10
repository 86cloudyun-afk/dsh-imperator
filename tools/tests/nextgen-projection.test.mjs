import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEventCursor } from '../../lib/plugins/event-projection.mjs'
import * as context from '../../lib/plugins/working-context.mjs'
import * as guard from '../../lib/plugins/guard.mjs'

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const todo = title => ({ type: 'todo/write', data: { todos: [{ id: 't', content: title, status: 'in_progress' }] } })
const call = id => ({ type: 'tool/call', data: { callId: id, name: 'subagent', arguments: {} } })
function runtime() {
  const hooks = new Map(), owner = {}
  context.apply({ on: (name, fn) => hooks.set(name, fn),
    get: name => name === 'agentPresets' ? { composedPreset: ctx => ctx?.preset ?? owner } : undefined })
  return { hooks, owner, pre: agent => hooks.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] })) }
}
const text = result => result.messages[0]?.content[0]?.text

// Observe the former full-prefix slice without introducing a Proxy graph.
test('unchanged cursor reread retains its prefix without slicing the history', () => {
  const events = freeze(Array.from({ length: 1024 }, (_, i) => call(String(i))))
  const cursor = createEventCursor()
  cursor.read(events)
  const original = Array.prototype.slice
  let historySlices = 0
  try {
    Array.prototype.slice = function (...args) {
      if (this === events) historySlices++
      return Reflect.apply(original, this, args)
    }
    assert.deepEqual(cursor.read(events), { reset: false, events: [] })
    assert.equal(historySlices, 0, 'unchanged history must not be sliced for a replacement prefix')
  } finally { Array.prototype.slice = original }
})

test('outer accessor histories never establish a reusable immutable prefix', () => {
  const event = freeze(call('a'))
  for (const frozen of [false, true]) {
    const events = []
    Object.defineProperty(events, '0', { get: () => event, enumerable: true, configurable: true })
    if (frozen) Object.freeze(events)
    const cursor = createEventCursor()
    assert.equal(cursor.read(events).reset, true)
    assert.equal(cursor.read(events).reset, true, 'an accessor array must replay even when frozen')
  }
})

test('mutable outer arrays retain private prefixes through append, replacement, reorder and truncation', () => {
  const source = freeze([call('a'), call('b'), call('c')]), events = [...source]
  const cursor = createEventCursor()
  assert.equal(cursor.read(events).reset, true)
  events.push(freeze(call('d')))
  assert.deepEqual(cursor.read(events), { reset: false, events: [events[3]] })
  events[1] = freeze(call('replacement'))
  assert.deepEqual(cursor.read(events), { reset: true, events })
  ;[events[0], events[2]] = [events[2], events[0]]
  assert.equal(cursor.read(events).reset, true)
  events.length = 1
  assert.equal(cursor.read(events).reset, true)
})

test('runtime context does not reproject historical TODO payloads after the first immutable projection', async () => {
  const event = freeze(todo('current task')), todos = event.data.todos
  const original = Array.prototype.filter
  let todoReads = 0
  try {
    Array.prototype.filter = function (...args) {
      if (this === todos) todoReads++
      return Reflect.apply(original, this, args)
    }
    const h = runtime()
    const agent = { session: { header: { id: 'root' }, events: [event, freeze(call('a'))] } }
    assert.match(text(await h.pre(agent)), /current task/)
    assert.ok(todoReads > 0)
    todoReads = 0
    assert.match(text(await h.pre(agent)), /current task/)
    assert.equal(todoReads, 0, 'ordinary immutable TODO payloads must be projected only once')
    agent.session.events.push(freeze(call('b')))
    assert.match(text(await h.pre(agent)), /current task/)
    assert.equal(todoReads, 0, 'appending a tool event must not reproject historical TODO payloads')
  } finally { Array.prototype.filter = original }
})

test('runtime TODO output matches replay through every prefix and unsafe restored edit', async () => {
  const h = runtime(), agent = { session: { header: { id: 'root' }, events: [] } }
  const source = freeze([todo('first'), call('a'), todo('second'),
    { type: 'todo/write', data: { todos: [{ id: 'done', content: 'done', status: 'completed' }] } },
    todo('third'), { type: 'turn/start', data: { turn: 2 } }, todo('last')])
  for (let n = 0; n <= source.length; n++) {
    agent.session.events = source.slice(0, n)
    assert.equal(text(await h.pre(agent)), context.renderWorkingContext(agent.session.events), 'prefix ' + n)
  }
  agent.session.events = [todo('restored')]
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(agent.session.events))
  agent.session.events[0].data.todos[0].content = 'changed in place'
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(agent.session.events))
  assert.match(text(await h.pre(agent)), /changed in place/)
  agent.session.events = [...source]
  await h.pre(agent)
  agent.session.events[0] = freeze(todo('replacement'))
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(agent.session.events))
  agent.session.events.reverse()
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(agent.session.events))
  agent.session.events.length = 2
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(agent.session.events))
})

test('overwritten restored TODO payloads are not interpreted before the final replay state', async () => {
  const discarded = { type: 'todo/write', data: { todos: [{ status: 'in_progress',
    get content() { throw new Error('overwritten TODO content must remain unread') },
  }] } }
  const h = runtime(), agent = { session: { header: { id: 'root' }, events: [discarded, todo('current')] } }
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(agent.session.events))
  agent.session.events = [discarded, { type: 'turn/start', data: { turn: 2 } }]
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(agent.session.events))
})

test('certified frozen data containers reuse their slot metadata', () => {
  const events = freeze(Array.from({ length: 256 }, (_, i) => call(String(i))))
  const descriptor = Object.getOwnPropertyDescriptor, hasOwn = Object.hasOwn
  let metadataReads = 0
  const indexed = (target, key) => target === events && /^(0|[1-9][0-9]*)$/.test(String(key))
  try {
    Object.getOwnPropertyDescriptor = (target, key) => {
      if (indexed(target, key)) metadataReads++
      return descriptor(target, key)
    }
    Object.hasOwn = (target, key) => {
      if (indexed(target, key)) metadataReads++
      return hasOwn(target, key)
    }
    const cursor = createEventCursor()
    cursor.read(events)
    assert.ok(metadataReads > 0)
    metadataReads = 0
    assert.deepEqual(cursor.read(events), { reset: false, events: [] })
    assert.equal(metadataReads, 0, 'frozen data slots cannot acquire accessors')
  } finally { Object.getOwnPropertyDescriptor = descriptor; Object.hasOwn = hasOwn }
})

test('outer slot validation never invokes getters and rejects inherited or setter-only slots', () => {
  const event = freeze(call('a'))
  let reads = 0
  const accessor = []
  Object.defineProperty(accessor, '0', { get() { reads++; return event }, configurable: true })
  const inherited = new Array(1)
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: event }))
  const setterOnly = []
  Object.defineProperty(setterOnly, '0', { set() {}, configurable: true })
  for (const events of [accessor, inherited, setterOnly]) {
    const cursor = createEventCursor()
    assert.equal(cursor.read(events).reset, true)
    assert.equal(cursor.read(events).reset, true)
  }
  assert.equal(reads, 0)
})

test('mutable Proxy containers force replay without invoking indexed get traps during certification', () => {
  let reads = 0
  const event = freeze(call('a'))
  const events = new Proxy([event], { get(target, key, receiver) {
    if (key === '0') reads++
    return Reflect.get(target, key, receiver)
  } })
  const cursor = createEventCursor()
  assert.equal(cursor.read(events).reset, true)
  assert.deepEqual(cursor.read(events), { reset: true, events })
  assert.equal(reads, 0)
})

test('public guard and flow projections replay mutable Proxy values instead of descriptor identities', () => {
  const result = id => ({ type: 'tool/result', data: { callId: id, isError: true } })
  const source = freeze([call('a'), result('a'), call('b'), result('b')])
  let exposed = source[3]
  const events = new Proxy([...source], { get(target, key, receiver) {
    return key === '3' ? exposed : Reflect.get(target, key, receiver)
  } })
  const g = guard.createGuardProjection({ echoFailures: 2 }), f = context.createFlowProjection()
  assert.deepEqual(g.read(events), guard.foldGuardSignals(events, { echoFailures: 2 }))
  assert.deepEqual(f.read(events), context.foldSubagentFlow(events))
  exposed = freeze({ type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(g.read(events), guard.foldGuardSignals(events, { echoFailures: 2 }))
  assert.deepEqual(f.read(events), context.foldSubagentFlow(events))
})

test('runtime TODO follows changed mutable Proxy indexed values with unchanged descriptors', async () => {
  let exposed = freeze(todo('visible first'))
  const events = new Proxy([freeze(todo('descriptor'))], { get(target, key, receiver) {
    return key === '0' ? exposed : Reflect.get(target, key, receiver)
  } })
  const h = runtime(), agent = { session: { header: { id: 'proxy' }, events } }
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(events))
  exposed = freeze(todo('visible second'))
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(events))
  assert.match(text(await h.pre(agent)), /visible second/)
})

test('runtime TODO replays nested Proxy graphs that expose changing absent properties', async () => {
  let data = freeze(todo('first nested').data)
  const event = new Proxy(freeze({ type: 'todo/write' }), { get(target, key, receiver) {
    return key === 'data' ? data : Reflect.get(target, key, receiver)
  } })
  const events = freeze([event]), h = runtime()
  const agent = { session: { header: { id: 'nested-proxy' }, events } }
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(events))
  data = freeze(todo('second nested').data)
  assert.equal(text(await h.pre(agent)), context.renderWorkingContext(events))
  assert.match(text(await h.pre(agent)), /second nested/)
})

for (const kind of ['own', 'inherited', 'frozen-proxy']) {
  test('runtime preserves custom iterator replay semantics: ' + kind, async () => {
    let exposed = freeze(todo('iterator first'))
    const iterator = function* () { yield exposed }
    let events = [freeze(todo('descriptor'))]
    if (kind === 'own') Object.defineProperty(events, Symbol.iterator, { value: iterator })
    if (kind === 'inherited') Object.setPrototypeOf(events,
      Object.create(Array.prototype, { [Symbol.iterator]: { value: iterator } }))
    Object.freeze(events)
    if (kind === 'frozen-proxy') events = new Proxy(events, { get(target, key, receiver) {
      return key === Symbol.iterator ? iterator : Reflect.get(target, key, receiver)
    } })
    const h = runtime(), agent = { session: { header: { id: 'iterator' }, events } }
    assert.equal(text(await h.pre(agent)), context.renderWorkingContext(events))
    exposed = freeze(todo('iterator second'))
    assert.equal(text(await h.pre(agent)), context.renderWorkingContext(events))
    assert.match(text(await h.pre(agent)), /iterator second/)
  })
}

test('frozen ordinary containers recheck inherited iterator semantics after certification', () => {
  const events = freeze([call('a')]), extra = freeze(call('b'))
  const projection = context.createFlowProjection()
  assert.deepEqual(projection.read(events), context.foldSubagentFlow(events))
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, { ...descriptor, value: function* () {
      yield* descriptor.value.call(this)
      if (this === events) yield extra
    } })
    assert.deepEqual(projection.read(events), context.foldSubagentFlow(events))
  } finally { Object.defineProperty(Array.prototype, Symbol.iterator, descriptor) }
})
