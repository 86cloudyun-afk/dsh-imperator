import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldSubagentFlow, createFlowProjection, renderWorkingContext } from '../../lib/plugins/working-context.mjs'

const freeze = value => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const event = (type, data) => ({ type, data })
const notice = (id, senderSessionId) => event('user/message', {
  id, source: { kind: 'subagent-settled', ...(senderSessionId === undefined ? {} : { senderSessionId }) },
})
const dispatch = (kind, step) => [
  event('step/start', { turn: 1, step }),
  kind === 'native'
    ? event('tool/call', { turn: 1, step, callId: 'shared', name: 'subagent', arguments: '{}' })
    : event('tool/ptc-dispatch-start', { rootCallId: 'wrapper', subCallId: 'shared', name: 'subagent', arguments: {} }),
  kind === 'native'
    ? event('tool/result', { turn: 1, step, callId: 'shared', isError: false })
    : event('tool/ptc-dispatch', { rootCallId: 'wrapper', subCallId: 'shared', name: 'subagent', isError: false }),
  event('step/end', { turn: 1, step }),
]
const history = kind => [
  event('turn/start', { turn: 1 }),
  ...dispatch(kind, 1), ...dispatch(kind, 2), notice('A1', 'A'),
  event('tool/call', { turn: 1, step: 3, callId: 'continue', name: 'task_child_send',
    arguments: '{"target_id":"A","message":"continue"}' }),
  event('tool/result', { turn: 1, step: 3, callId: 'continue', isError: false }),
  notice('A2', 'A'),
]

for (const kind of ['native', 'ptc']) {
  test(kind + ' continuation receipts cannot retire another initial child dispatch', () => {
    const events = history(kind)
    assert.deepEqual(foldSubagentFlow(events), {
      dispatched: 2, settledNotices: 2, delegatedResults: 2, settled: 2, failedDispatches: 0, inFlight: 1,
    })
    assert.match(renderWorkingContext(events), /未结算派发估计 1.*已收结算通知 2 条/)
    assert.equal(foldSubagentFlow([...events, notice('B1', 'B')]).inFlight, 0)
    assert.equal(foldSubagentFlow(events, undefined, 'tool-result').inFlight, 0)
  })
  test(kind + ' frozen continuation prefixes retain state and match restored replay', () => {
    const events = freeze([...history(kind), notice('B1', 'B')].map((item, seq) => ({ ...item, seq })))
    const projection = createFlowProjection()
    for (let length = 0; length <= events.length; length++) {
      const prefix = events.slice(0, length)
      assert.deepEqual(projection.read(prefix), foldSubagentFlow(JSON.parse(JSON.stringify(prefix))))
      assert.deepEqual(projection.read(prefix), foldSubagentFlow(prefix))
    }
    assert.equal(projection.processedEvents, events.length)
    assert.equal(projection.read(events.slice(0, -1)).inFlight, 1, 'truncation must rebuild settled senders')
    assert.equal(projection.read(events).inFlight, 0)
  })
}
test('notice IDs and seq deduplicate receipts independently of sender retirement', () => {
  const seqOnly = { type: 'user/message', seq: 40,
    data: { source: { kind: 'subagent-settled', senderSessionId: 'A' } } }
  const events = [...dispatch('native', 1), ...dispatch('native', 2),
    notice('A1', 'A'), notice('A1', 'A'), notice('A2', 'A'), seqOnly, structuredClone(seqOnly)]
  const flow = foldSubagentFlow(events)
  assert.equal(flow.settledNotices, 3)
  assert.equal(flow.settled, 3)
  assert.equal(flow.inFlight, 1)
})
test('missing and invalid sender notices remain receipts without retiring dispatches', () => {
  const events = [...dispatch('native', 1), ...dispatch('native', 2),
    ...[undefined, null, '', 42, {}].map((sender, index) => notice('unknown-' + index, sender))]
  const flow = foldSubagentFlow(events)
  assert.equal(flow.settledNotices, 5)
  assert.equal(flow.inFlight, 2)
})
test('sender identity remains exact rather than trimming legal native session IDs', () => {
  const flow = foldSubagentFlow([...dispatch('native', 1), ...dispatch('native', 2),
    notice('A1', 'A'), notice('padded-A1', ' A ')])
  assert.equal(flow.settledNotices, 2)
  assert.equal(flow.inFlight, 0)
})
for (const channel of ['settled-notice', 'tool-result']) {
  test(channel + ' unknown recovered tool outcome cannot prove a failed or settled dispatch', () => {
    const events = [
      event('tool/call', { callId: 'unknown', name: 'subagent', arguments: '{}' }),
      event('tool/result', { message: { source: { kind: 'tool', callId: 'unknown' }, isError: true },
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } }),
    ]
    const flow = foldSubagentFlow(events, undefined, channel)
    assert.equal(flow.dispatched, 1)
    assert.equal(flow.delegatedResults, 1, 'unknown durable receipt is still an observed receipt')
    assert.equal(flow.failedDispatches, 0)
    assert.equal(flow.inFlight, 1)
    assert.deepEqual(foldSubagentFlow([...events, events[1]], undefined, channel), flow)
    const notStarted = structuredClone(events)
    notStarted[1].data.error.code = 'TOOL_NOT_STARTED'
    assert.equal(foldSubagentFlow(notStarted, undefined, channel).failedDispatches, 1)
    assert.equal(foldSubagentFlow(notStarted, undefined, channel).inFlight, 0)
  })
}
