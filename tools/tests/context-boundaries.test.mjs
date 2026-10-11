import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as context from '../../lib/plugins/working-context.mjs'
import * as guard from '../../lib/plugins/guard.mjs'
import { deriveIdentity } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'

function host(store, agents) {
  const hooks = new Map()
  context.apply({ on: (name, fn) => hooks.set(name, fn),
    get: name => name === 'taskforceStore' ? store : name === 'agents' ? agents : undefined })
  return (agent, messages = [], beforeEnter) => hooks.get('agent/pre-step')({ agent }, async () => {
    await beforeEnter?.()
    return { kind: 'enter', messages }
  })
}
const text = result => result.messages.flatMap(m => m.content ?? []).map(b => b.text ?? '').join('\n')

for (const method of ['snapshot', 'status', 'state']) {
  test(`scoped reads never invoke unscoped ${method} fallback`, () => {
    let called = 0
    const store = { [method]() { called++; return { task: 'OTHER_RUN_SECRET', factCount: 99 } } }
    assert.equal(context.readStoreState(store, 'run-a'), undefined)
    assert.equal(called, 0)
  })
}
test('scoped reads never copy global fields even if scoped methods failed', () => {
  const store = { task: 'OTHER_RUN_SECRET', factCount: 99,
    workingState() { throw new Error('unavailable') }, stats() { throw new Error('unavailable') } }
  assert.equal(context.readStoreState(store, 'run-a'), undefined)
})
test('unscoped standalone compatibility and scoped stats/board adapters remain usable', () => {
  assert.deepEqual(context.readStoreState({ snapshot: () => ({ task: 'legacy', factCount: 2 }) }),
    { task: { title: 'legacy' }, factCount: 2 })
  const seen = []
  const store = { stats(run) { seen.push(run); return { facts: { total: 2 }, tasks: { open: 1 } } },
    board(args, run) { seen.push(run); return { tasks: [{ id: 2, title: 'current', status: 'open' }] } } }
  assert.deepEqual(context.readStoreState(store, 'a'), { factCount: 2, activeTasks: 1, task: { id: 2, title: 'current' } })
  assert.deepEqual(seen, ['a', 'a'])
})
for (const id of ['', ' ', null, 7, 'wrong-root']) {
  test(`inconsistent parent identity ${JSON.stringify(id)} never queries a store`, async () => {
    let calls = 0
    const step = host({ workingState() { calls++; return { task: { title: 'SECRET' } } } },
      { get: () => ({ session: { header: { id } } }) })
    const result = await step({ session: { header: { id: 'child', origin: 'subagent', delegationDepth: 1, parentSession: 'root' }, events: [] } })
    assert.equal(calls, 0)
    assert.doesNotMatch(text(result), /SECRET/)
  })
}
test('valid root and unloaded depth-one parent retain scoped lookup', async () => {
  for (const agents of [undefined, { get: () => ({ session: { header: { id: 'root' } } }) }]) {
    const runs = []
    const step = host({ workingState(run) { runs.push(run); return { factCount: 1 } } }, agents)
    await step({ session: { header: { id: 'child', origin: 'subagent', delegationDepth: 1, parentSession: 'root' }, events: [] } })
    assert.deepEqual(runs, ['root'])
  }
})
test('root ID containing only whitespace cannot select unassigned historical data', async () => {
  let calls = 0
  const step = host({ workingState() { calls++; return { factCount: 100 } } })
  await step({ session: { header: { id: '  ' }, events: [] } })
  assert.equal(calls, 0)
})
for (const [label, module] of [['projection', context], ['guard', guard]]) {
  test(`${label} handles unreadable history as no evidence`, () => {
    assert.deepEqual(module.sessionEvents({ snapshotEvents() { throw new Error('unavailable') } }), [])
    assert.deepEqual(module.sessionEvents({ get events() { throw new Error('unavailable') } }), [])
    for (const value of [null, {}, 'invalid', 5]) {
      assert.deepEqual(module.sessionEvents({ snapshotEvents: () => value }), [])
    }
    const events = []
    const session = { saved: events, snapshotEvents() { return this.saved } }
    assert.equal(module.sessionEvents(session), events)
  })
}
test('one pre-step reads a single history snapshot for projection and deduplication', async () => {
  let reads = 0
  const step = host()
  const result = await step({ session: { snapshotEvents() { reads++; return [{ type: 'tool/call', data: { name: 'subagent', callId: 'a' } }] } } })
  assert.match(text(result), /未结算派发估计 1/)
  assert.equal(reads, 1)
})
test('an unavailable snapshot never aborts a valid pre-step', async () => {
  const step = host()
  const user = { role: 'user', content: [{ type: 'text', text: 'keep' }] }
  const result = await step({ session: { snapshotEvents() { throw new Error('unavailable') } } }, [user])
  assert.equal(result.messages[0], user)
})
test('explicitly empty authoritative store does not resurrect an obsolete todo', () => {
  const line = context.renderWorkingContext([{ type: 'todo/write', data: { todos: [{ status: 'in_progress', content: 'obsolete' }] } }],
    { runId: 'a', store: { workingState: () => ({ activeTasks: 0, factCount: 1 }) } })
  assert.doesNotMatch(line, /obsolete/)
  assert.match(line, /事实 1 条/)
})
test('malformed assistant blocks cannot manufacture signals or abort guard folding', () => {
  for (const content of [{}, 4, 'bad', [null, { type: 'reasoning', text: {} }]]) {
    const events = [{ type: 'assistant/message', data: { message: { content } } }]
    assert.deepEqual(guard.foldGuardSignals(events), { stall: undefined, echo: undefined, echoKey: undefined })
  }
})

test('legacy directory assembly requires confirmed ownership after downstream assembly', async () => {
  for (const mode of ['unknown', 'switched']) {
    const hooks = new Map()
    const owner = { preset: 'taskforce' }, agent = { ctx: { preset: 'taskforce' } }
    const registry = { composedPreset(target) {
      if (mode === 'unknown') throw new Error('scope unavailable')
      return target.preset
    } }
    context.apply({ ...owner, on: (name, fn) => hooks.set(name, fn),
      get: name => name === 'agentPresets' ? registry : undefined })
    const assembly = { sections: [], contexts: [], tools: [], variables: { cwd: '/outside-native-directory' } }
    const result = await hooks.get('system-prompt/assemble')(assembly, { agent }, async () => {
      if (mode === 'switched') agent.ctx.preset = 'standard'
      return assembly
    })
    assert.equal(result, assembly, mode + ' scope must preserve the downstream assembly')
    assert.deepEqual(result.sections, [])
  }
})

const observedAgent = (id, header = {}, options = {}) => ({
  session: { header: { id, ...header }, events: [] }, options, ctx: {},
})

// Reverting runtime-depth observation, exact ID preservation, or the defensive
// cache read breaks the projections below. Store reads execute real SQLite;
// only registration/next and the Agent records in these unit tests are fixtures.
function identityProjection(t, runIds = ['root', 'parent', 'child']) {
  const store = tempStore(t), runs = [], domains = new Map()
  for (const run of [undefined, ...new Set(runIds)]) {
    const title = 'IDENTITY_SCOPE_' + domains.size + '_TASK'
    const task = store.openTask({ title }, run)
    const count = domains.size + 1
    for (let index = 0; index < count; index++) {
      store.recordFact({ task_id: task.task_id, statement: 'private fact ' + index }, run)
    }
    domains.set(run, { title, count })
  }
  const db = store.open(), changes = () => db.prepare('SELECT total_changes() AS n').get().n
  const read = store.workingState.bind(store)
  store.workingState = run => { runs.push(run); return read(run) }
  const agents = new Map(), step = host(store, agents)
  const check = async (agent, run, { parity = false, next } = {}) => {
    runs.length = 0
    const before = changes()
    const result = await step(agent, [], next)
    assert.equal(changes(), before, 'projection must not write SQLite')
    assert.deepEqual(runs, run === undefined ? [] : [run], 'exact scoped store read; never legacy')
    const output = text(result)
    for (const [domain, expected] of domains) {
      if (domain === run && run !== undefined) {
        assert.ok(output.includes(expected.title), 'missing task for exact run ' + JSON.stringify(run))
        assert.ok(output.includes('事实 ' + expected.count + ' 条'), 'wrong scoped fact count')
      } else assert.ok(!output.includes(expected.title), 'foreign or legacy task leaked')
    }
    if (parity) assert.equal(deriveIdentity(agent, agents).runId, run, 'uncached tool identity parity')
    return result
  }
  return { store, agents, check }
}

for (const shape of ['root', 'ordinary-fork', 'durable-child', 'runtime-caller', 'runtime-ancestor', 'offline-durable-one', 'offline-runtime-one']) {
  test('real SQLite context identity: ' + shape, async t => {
    const f = identityProjection(t), root = observedAgent('root')
    const parent = observedAgent('parent', { parentSession: 'root' }, { subagentDepth: 1 })
    f.agents.set('root', root); f.agents.set('parent', parent)
    let agent, expected = 'root'
    if (shape === 'root') agent = root
    if (shape === 'ordinary-fork') {
      agent = observedAgent('child', { parentSession: 'root', isSeeded: true }, { subagentDepth: 0 }); expected = 'child'
    }
    if (shape === 'durable-child' || shape === 'offline-durable-one') {
      agent = observedAgent('child', { parentSession: 'root', origin: 'subagent', delegationDepth: 1 })
    }
    if (shape === 'runtime-caller' || shape === 'offline-runtime-one') {
      agent = observedAgent('child', { parentSession: 'root' }, { subagentDepth: 1 })
    }
    if (shape === 'runtime-ancestor') {
      agent = observedAgent('child', { parentSession: 'parent', origin: 'subagent', delegationDepth: 2 })
    }
    if (shape.startsWith('offline-')) f.agents.delete('root')
    await f.check(agent, expected, { parity: true })
  })
}

for (const shape of ['root', 'child', 'ancestor', 'offline-parent']) {
  test('padded ' + shape + ' preserves exact SQLite domain and tool identity', async t => {
    const f = identityProjection(t, [' root ', 'root', ' parent ', 'parent', ' child ', 'child'])
    const root = observedAgent(' root ')
    f.agents.set(' root ', root)
    let agent = root
    if (shape === 'child') agent = observedAgent(' child ', { parentSession: ' root ' }, { subagentDepth: 1 })
    if (shape === 'ancestor') {
      f.agents.set(' parent ', observedAgent(' parent ', { parentSession: ' root ' }, { subagentDepth: 1 }))
      agent = observedAgent(' child ', { parentSession: ' parent ', origin: 'subagent', delegationDepth: 2 })
    }
    if (shape === 'offline-parent') {
      f.agents.clear()
      agent = observedAgent(' child ', { parentSession: ' root ' }, { subagentDepth: 1 })
    }
    await f.check(agent, ' root ', { parity: true })
  })
}

for (const id of [' ' + 'x'.repeat(198) + ' ', ' ' + '界'.repeat(198) + ' ', ' ' + '😀'.repeat(99) + ' ']) {
  test('200 JavaScript characters remain valid exact IDs: ' + id.slice(1, 3), async t => {
    assert.equal(id.length, 200)
    const f = identityProjection(t, [id, id.trim(), 'child'])
    await f.check(observedAgent(id), id, { parity: true })
    await f.check(observedAgent('child', { parentSession: id }, { subagentDepth: 1 }), id, { parity: true })
  })
}
for (const id of ['', ' \t\n', null, undefined, 7, {}, 'x'.repeat(201), '界'.repeat(201), '😀'.repeat(100) + 'x']) {
  test('invalid root and parent IDs never query legacy: ' + String(id).slice(0, 16), async t => {
    const f = identityProjection(t)
    // A top-level Agent ID must not replace the actual session header ID.
    await f.check({ ...observedAgent(id), id: 'root' }, undefined)
    await f.check(observedAgent('child', { parentSession: id }, { subagentDepth: 1 }), undefined)
  })
}

const invalidDepths = [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]
const depthCases = [
  ['zero/one', 0, 1, 1], ['one/zero', 1, 0, 1], ['one/two', 1, 2, 2], ['two/one', 2, 1, 2],
  ['negative-zero/absent', -0, undefined, 0], ['absent/negative-zero', undefined, -0, 0],
  ['negative-zero/zero', -0, 0, 0], ['negative-zero/one', -0, 1, 1], ['one/negative-zero', 1, -0, 1],
  ['safe-upper-bound', Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER],
  ...invalidDepths.flatMap((invalid, index) => [
    ['valid/invalid-' + index, 1, invalid, 1], ['invalid/valid-' + index, invalid, 1, 1],
    ['both-invalid-' + index, invalid, invalid, 0],
  ]),
]
for (const location of ['caller', 'ancestor']) {
  for (const [label, headerDepth, runtimeDepth, depth] of depthCases) {
    test('effective depth at ' + location + ': ' + label, async t => {
      const f = identityProjection(t)
      const target = observedAgent('parent', { parentSession: 'root', delegationDepth: headerDepth }, { subagentDepth: runtimeDepth })
      f.agents.set('parent', target)
      const agent = location === 'caller' ? target
        : observedAgent('child', { parentSession: 'parent', origin: 'subagent', delegationDepth: 2 })
      const expected = depth === 0 ? 'parent' : depth === 1 ? 'root' : undefined
      await f.check(agent, expected, { parity: expected !== undefined })
    })
  }
  test('origin-only ' + location + ' cannot invent an offline root from invalid depths', async t => {
    const f = identityProjection(t)
    const target = observedAgent('parent', { parentSession: 'root', origin: 'subagent', delegationDepth: 0.5 }, { subagentDepth: NaN })
    f.agents.set('parent', target)
    const agent = location === 'caller' ? target : observedAgent('child', { parentSession: 'parent' }, { subagentDepth: 1 })
    await f.check(agent, undefined)
    f.agents.set('root', observedAgent('root'))
    await f.check(agent, 'root', { parity: true })
  })
}

test('offline fallback uses the visited ancestor depth, not the original caller depth', async t => {
  const f = identityProjection(t)
  const parent = observedAgent('parent', { parentSession: 'root' }, { subagentDepth: 1 })
  const child = observedAgent('child', { parentSession: 'parent', delegationDepth: 2 })
  f.agents.set('parent', parent)
  await f.check(child, 'root', { parity: true })
  child.session.header.delegationDepth = 1
  parent.options.subagentDepth = 2
  await f.check(child, undefined)
})

for (const absent of [undefined, null, {}, { session: {} }, { session: { header: null } }]) {
  test('only absent or null parent headers permit the depth-one observation fallback: ' + JSON.stringify(absent), async t => {
    const f = identityProjection(t)
    f.agents.set('root', absent)
    await f.check(observedAgent('child', { parentSession: 'root' }, { subagentDepth: 1 }), 'root')
  })
}
for (const header of [{}, { id: '' }, { id: ' ' }, { id: 'x'.repeat(201) }, { id: 'wrong-root' }, { id: 'root' }]) {
  test('a present malformed or mismatched parent cannot become an offline root: ' + JSON.stringify(header).slice(0, 48), async t => {
    const f = identityProjection(t, [' root ', 'root', 'child'])
    f.agents.set(' root ', { id: ' root ', session: { header } })
    await f.check(observedAgent('child', { parentSession: ' root ' }, { subagentDepth: 1 }), undefined)
  })
}

for (const edges of [32, 33]) {
  test('context ancestry retains the ' + edges + '-parent-lookup boundary', async t => {
    const f = identityProjection(t), lookups = [], registryGet = f.agents.get.bind(f.agents)
    f.agents.get = id => { lookups.push(id); return registryGet(id) }
    let child
    for (let index = edges; index >= 0; index--) {
      const id = index === edges ? 'root' : 'node-' + index
      const agent = index === edges ? observedAgent(id)
        : observedAgent(id, { parentSession: index + 1 === edges ? 'root' : 'node-' + (index + 1), origin: 'subagent' })
      f.agents.set(id, agent)
      if (index === 0) child = agent
    }
    await f.check(child, edges === 32 ? 'root' : undefined)
    assert.equal(lookups.length, 32, '32 lookups, not 32 nodes or 64 nodes')
  })
}
for (const cycle of ['self', 'pair']) {
  test('depth-one ' + cycle + ' cycle never reaches offline fallback', async t => {
    const f = identityProjection(t)
    const child = observedAgent('child', { parentSession: cycle === 'self' ? 'child' : 'parent' }, { subagentDepth: 1 })
    f.agents.set('parent', observedAgent('parent', { parentSession: 'child' }, { subagentDepth: 1 }))
    await f.check(child, undefined)
  })
}

for (const location of ['caller', 'ancestor']) {
  test('same Agent ' + location + ' runtime changes are reread after controlled next', async t => {
    const f = identityProjection(t), target = observedAgent('parent', { parentSession: 'root' }, { subagentDepth: 0 })
    f.agents.set('root', observedAgent('root')); f.agents.set('parent', target)
    const agent = location === 'caller' ? target : observedAgent('child', { parentSession: 'parent', delegationDepth: 2 })
    const session = agent.session, header = session.header, events = session.events, scope = agent.ctx
    await f.check(agent, 'parent', { parity: true })
    await f.check(agent, 'root', { parity: true, next: () => { target.options.subagentDepth = 1 } })
    target.options.subagentDepth = 0
    await f.check(agent, 'parent', { parity: true })
    target.session.header.origin = 'subagent'
    await f.check(agent, 'root', { parity: true })
    assert.equal(agent.session, session); assert.equal(agent.session.header, header)
    assert.equal(agent.session.events, events); assert.equal(agent.ctx, scope)
  })
}

for (const location of ['caller', 'ancestor']) {
  for (const field of ['header', 'id', 'options', 'subagentDepth', 'delegationDepth']) {
    test('whole hook degrades throwing ' + location + ' ' + field + ' without legacy reads', async t => {
      const f = identityProjection(t), parent = observedAgent('parent')
      const child = observedAgent('child', { parentSession: 'parent', delegationDepth: 1 })
      f.agents.set('parent', parent)
      const previous = context.createContextMessage('[任务部队: 旧投影]')
      child.session.events.push({ type: 'user/message', seq: 1, data: previous })
      await f.check(child, 'parent') // populate the existing projection cache
      const target = location === 'caller' ? child : parent
      const owner = field === 'header' ? target.session : field === 'options' ? target
        : field === 'subagentDepth' ? target.options : target.session.header
      Object.defineProperty(owner, field, { get() { throw new Error('identity getter unavailable') }, configurable: true })
      const result = await f.check(child, undefined)
      assert.match(text(result), /当前无可确认状态，勿沿用旧投影/)
    })
  }
}

test('throwing live registry lookup cannot become offline depth-one evidence', async t => {
  const f = identityProjection(t)
  f.agents.get = () => { throw new Error('registry unavailable') }
  await f.check(observedAgent('child', { parentSession: 'root' }, { subagentDepth: 1 }), undefined)
})
