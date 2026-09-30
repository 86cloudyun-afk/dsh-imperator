import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as context from '../../lib/plugins/working-context.mjs'
import * as guard from '../../lib/plugins/guard.mjs'

function host(store, agents) {
  const hooks = new Map()
  context.apply({ on: (name, fn) => hooks.set(name, fn),
    get: name => name === 'taskforceStore' ? store : name === 'agents' ? agents : undefined })
  return (agent, messages = []) => hooks.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages }))
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
