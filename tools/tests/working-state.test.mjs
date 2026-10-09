import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempStore } from './helpers.mjs'
import { apply, foldSubagentFlow, readStoreState, renderWorkingContext } from '../../lib/plugins/working-context.mjs'

const call = id => ({ type: 'tool/call', data: { name: 'subagent', callId: id } })
const result = (id, fail = false) => ({ type: 'tool/result', data: { callId: id, message: { isError: fail } } })
const notice = id => ({ type: 'user/message', data: { id, source: { kind: 'subagent-settled', senderSessionId: 'same-child' } } })

test('failed spawn is not left permanently in the unsettled dispatch estimate', () => {
  const state = foldSubagentFlow([call('a'), result('a', true)])
  assert.equal(state.inFlight, 0)
  assert.equal(state.failedDispatches, 1)
  assert.equal(state.settledNotices, 0)
})
test('duplicate calls, results and notices cannot cancel unrelated pending dispatches', () => {
  const state = foldSubagentFlow([call('a'), call('a'), result('a'), result('a'), call('b'), notice('n'), notice('n')])
  assert.equal(state.dispatched, 2)
  assert.equal(state.delegatedResults, 1)
  assert.equal(state.settledNotices, 1)
  assert.equal(state.inFlight, 1)
})
test('one-shot error receipts settle their calls once, without becoming evidence facts', () => {
  const events = [call('a'), result('a', true), result('a', true)]
  const state = foldSubagentFlow(events, new Set(['subagent']), 'tool-result')
  assert.equal(state.inFlight, 0)
  assert.equal(state.settled, 1)
  assert.doesNotMatch(renderWorkingContext(events, { settlement: 'tool-result' }), /事实/)
})
test('native nested result identity is accepted; unrelated receipts do not settle a dispatch', () => {
  const state = foldSubagentFlow([call('a'), result('ghost', true),
    { type: 'tool/result', data: { message: { source: { callId: 'a' }, isError: true } } }])
  assert.equal(state.failedDispatches, 1)
  assert.equal(state.inFlight, 0)
})
test('distinct notice IDs are not collapsed merely because they share a sender', () => {
  const state = foldSubagentFlow([call('a'), call('b'), notice('one'), notice('two')])
  assert.equal(state.settledNotices, 2)
  assert.equal(state.settled, 2)
  assert.equal(state.inFlight, 1)
})
test('a missing current state supersedes rather than silently retaining a stale projection', async () => {
  const listeners = new Map()
  apply({ get() {}, on: (name, listener) => listeners.set(name, listener) })
  const old = { id: 'old', source: { kind: 'taskforce-working-context' }, content: [{ type: 'text', text: '[任务部队: 在飞 1]' }] }
  const agent = { session: { events: [{ type: 'user/message', seq: 1, data: old }], surface: { nodes: [1] } } }
  const decision = await listeners.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1)
  assert.match(decision.messages[0].content[0].text, /无可确认状态/)
  agent.session.events.push({ type: 'user/message', seq: 2, data: decision.messages[0] })
  agent.session.surface.nodes.push(2)
  const again = await listeners.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(again.messages.length, 0)
})
test('duplicate current-step context messages are reduced to a single fresh projection', async () => {
  const listeners = new Map()
  apply({ get() {}, on: (name, listener) => listeners.set(name, listener) })
  const stale = id => ({ id, source: { kind: 'taskforce-working-context' }, content: [{ type: 'text', text: 'old' }] })
  const user = { id: 'user', role: 'user', content: [{ type: 'text', text: 'keep me' }] }
  const agent = { session: { events: [call('a')] } }
  const decision = await listeners.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [stale('one'), user, stale('two')] }))
  assert.equal(decision.messages.filter(m => m.source?.kind === 'taskforce-working-context').length, 1)
  assert.equal(decision.messages.find(m => m.id === 'user'), user)
})
test('store working projection stays scoped and counts every pending task state', (t) => {
  const store = tempStore(t)
  assert.equal(typeof store.workingState, 'function')
  const claimed = store.openTask('claimed', 'a').task_id
  store.claimTask({ task_id: claimed, child_id: 'child' }, 'a')
  const submitted = store.openTask('submitted', 'a').task_id
  store.submitTask({ task_id: submitted }, 'a')
  const rejected = store.openTask('rejected', 'a').task_id
  store.submitTask({ task_id: rejected }, 'a')
  store.rejectTask({ task_id: rejected, reason: 'redo' }, 'a', 'lead')
  store.openTask('open', 'a')
  store.openTask('other run', 'b')
  store.openTask('legacy')
  const state = store.workingState('a')
  assert.equal(state.activeTasks, 4)
  assert.deepEqual(state.task, { id: claimed, title: 'claimed' })
  assert.equal(store.workingState('b').activeTasks, 1)
  assert.equal(store.workingState().activeTasks, 1)
  assert.deepEqual(store.workingState('missing'), { activeTasks: 0, factCount: 0 })
})
test('working-state read count does not grow with the number of tasks or fact summaries', (t) => {
  const store = tempStore(t)
  assert.equal(typeof store.workingState, 'function')
  for (let i = 0; i < 60; i++) store.openTask(`task-${i}`, 'a')
  const prepare = store.handle.prepare.bind(store.handle)
  let reads = 0
  store.handle.prepare = sql => { reads++; return prepare(sql) }
  const state = store.workingState('a')
  assert.equal(state.activeTasks, 60)
  assert.equal(state.task.title, 'task-59')
  assert.ok(reads <= 2, `expected bounded query count, got ${reads}`)
})
test('context projection uses the narrow store API rather than expanding the task board', () => {
  const store = { workingState(run) { assert.equal(run, 'a'); return { factCount: 3, activeTasks: 4, task: { id: 1, title: 'current' } } },
    stats() { throw new Error('must not read') }, board() { throw new Error('must not read') } }
  assert.deepEqual(readStoreState(store, 'a'), { factCount: 3, activeTasks: 4, task: { id: 1, title: 'current' } })
})
test('legacy store adapters include submitted/rejected tasks in active counts', () => {
  const store = { stats() { return { tasks: { open: 1, claimed: 2, submitted: 3, rejected: 4 } } } }
  assert.equal(readStoreState(store, 'a').activeTasks, 10)
})
