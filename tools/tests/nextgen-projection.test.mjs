import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEventCursor } from '../../lib/plugins/event-projection.mjs'
import * as context from '../../lib/plugins/working-context.mjs'

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

// A second full copy adds N indexed reads beyond the mandatory N comparisons.
test('unchanged cursor reread compares its full prefix without reading it again for a copy', () => {
  const source = freeze(Array.from({ length: 1024 }, (_, i) => call(String(i))))
  let indexedReads = 0
  const events = new Proxy(source, { get(target, key, receiver) {
    if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) indexedReads++
    return Reflect.get(target, key, receiver)
  }, getOwnPropertyDescriptor(target, key) {
    if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) indexedReads++
    return Reflect.getOwnPropertyDescriptor(target, key)
  } })
  const cursor = createEventCursor()
  cursor.read(events)
  indexedReads = 0
  assert.deepEqual(cursor.read(events), { reset: false, events: [] })
  assert.ok(indexedReads <= source.length + 2, 'unchanged reread performed ' + indexedReads + ' indexed reads')
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

test('runtime context does not reread historical TODO payloads after the first immutable projection', async () => {
  let todoReads = 0
  const counted = new Proxy(freeze(todo('current task')), { get(target, key, receiver) {
    if (key === 'data') todoReads++
    return Reflect.get(target, key, receiver)
  } })
  const h = runtime()
  const agent = { session: { header: { id: 'root' }, events: [counted, freeze(call('a'))] } }
  assert.match(text(await h.pre(agent)), /current task/)
  assert.ok(todoReads > 0)
  todoReads = 0
  assert.match(text(await h.pre(agent)), /current task/)
  assert.equal(todoReads, 0, 'immutable TODO payloads must be folded only once')
  agent.session.events.push(freeze(call('b')))
  assert.match(text(await h.pre(agent)), /current task/)
  assert.equal(todoReads, 0, 'appending a tool event must not rescan historical TODO payloads')
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

test('certified frozen data containers reuse their descriptors while still comparing every prefix slot', () => {
  let descriptors = 0, slots = 0
  const source = freeze(Array.from({ length: 256 }, (_, i) => call(String(i))))
  const events = new Proxy(source, {
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) descriptors++
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) slots++
      return Reflect.get(target, key, receiver)
    },
  })
  const cursor = createEventCursor()
  cursor.read(events)
  descriptors = 0; slots = 0
  assert.deepEqual(cursor.read(events), { reset: false, events: [] })
  assert.equal(descriptors, 0, 'certified frozen slots cannot acquire accessors')
  assert.equal(slots, source.length, 'the entire prefix must still be compared')
})
