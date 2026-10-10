import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as guard from '../../lib/plugins/guard.mjs'

const call = (id, args = { path: 'a' }, tool = 'read') =>
  ({ type: 'tool/call', data: { name: tool, arguments: args, callId: id } })
const result = (id, failed = true) =>
  ({ type: 'tool/result', data: { callId: id, message: { isError: failed } } })
const failures = (prefix, count = 3, args) =>
  Array.from({ length: count }, (_, i) => [call(`${prefix}${i}`, args), result(`${prefix}${i}`)]).flat()
const signal = (events) => guard.foldGuardSignal(events, { echoFailures: 3, detectStall: false }).signal
const reasoning = (length = 20_000) => ({ type: 'assistant/message', data: {
  message: { content: [{ type: 'reasoning', text: 'x'.repeat(length) }] },
} })

function harness(config = {}) {
  const handlers = new Map()
  const logs = []
  guard.apply({ on: (event, fn) => handlers.set(event, fn), logger: { warn: (text) => logs.push(text) } }, {
    stallAction: 'observe', stepDownRequests: 0, sensitivity: 'balanced', echoFailures: 3,
    refireCooldownSteps: 2, ...config,
  })
  const agent = { session: { events: [] } }
  return {
    agent, logs,
    pre: () => handlers.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] })),
    request: (value) => handlers.get('agent/request')({ agent }, async () => value),
  }
}

// Removing key sorting or falling back to String(object) would break these contracts.
test('equivalent nested JSON objects and encoded JSON have one call signature', () => {
  const first = { z: 1, a: { right: 2, left: [{ b: 2, a: 1 }] } }
  const second = { a: { left: [{ a: 1, b: 2 }], right: 2 }, z: 1 }
  assert.equal(guard.callSignature(call('a', first)), guard.callSignature(call('b', second)))
  assert.equal(guard.callSignature(call('a', first)), guard.callSignature(call('c', JSON.stringify(second))))
})
test('argument key permutation cannot hide three consecutive failures', () => {
  const events = [{ x: 1, y: 2 }, { y: 2, x: 1 }, { x: 1, y: 2 }]
    .flatMap((args, i) => [call(String(i), args), result(String(i))])
  assert.equal(signal(events), 'echo')
})
test('array order, values, tool names, and raw non-JSON arguments remain distinct', () => {
  for (const [a, b] of [
    [call('a', [1, 2]), call('b', [2, 1])],
    [call('a', { x: 1 }), call('b', { x: '1' })],
    [call('a', { x: 1 }), call('b', { x: 1 }, 'write')],
    [call('a', 'invalid json'), call('b', 'other invalid json')],
  ]) assert.notEqual(guard.callSignature(a), guard.callSignature(b))
})
test('prototype-like JSON keys remain data during canonicalization', () => {
  assert.notEqual(guard.callSignature(call('a', JSON.parse('{"__proto__":{"x":1}}'))),
    guard.callSignature(call('b', {})))
})
test('cyclic or unserializable arguments are unknown, not one generic object signature', () => {
  const cycle = {}; cycle.self = cycle
  assert.equal(guard.callSignature(call('a', cycle)), undefined)
  assert.equal(guard.callSignature(call('b', { x: 1n })), undefined)
})

// A result must count once for its own invocation, never for the latest unrelated call.
test('one failure replayed three times is not three failed calls', () => {
  assert.equal(signal([call('a'), result('a'), result('a'), result('a')]), undefined)
})
test('replayed call-result pairs do not manufacture new attempts', () => {
  const pair = [call('a'), result('a')]
  assert.equal(signal([...pair, ...pair, ...pair]), undefined)
})
test('missing result correlation cannot be attributed to the latest call', () => {
  assert.equal(signal([call('a'), result(undefined), result(undefined), result(undefined)]), undefined)
})
test('calls with missing IDs cannot provide trusted failure evidence', () => {
  assert.equal(signal(Array.from({ length: 3 }, () => [call(undefined), result(undefined)]).flat()), undefined)
})
test('unknown results cannot create or clear a matched failure streak', () => {
  assert.equal(signal([...failures('a'), result('unknown', false)]), 'echo')
  assert.equal(signal([result('unknown'), result('unknown'), result('unknown')]), undefined)
})
test('nested source callId is accepted for matched results', () => {
  const events = Array.from({ length: 3 }, (_, i) => [call(String(i)), {
    type: 'tool/result', data: { message: { isError: true, source: { callId: String(i) } } },
  }]).flat()
  assert.equal(signal(events), 'echo')
})
test('parallel failures are evaluated in call order regardless of result arrival order', () => {
  assert.equal(signal([call('a'), call('b'), call('c'), result('c'), result('a'), result('b')]), 'echo')
})
test('an unresolved latest call blocks conclusions about a completed failure streak', () => {
  assert.equal(signal([...failures('a'), call('pending')]), undefined)
})
test('late success for an older call cannot erase three newer failures', () => {
  assert.equal(signal([call('older'), ...failures('new'), result('older', false)]), 'echo')
})
test('late failure for an older call cannot resurrect a streak after newer success', () => {
  assert.equal(signal([call('a'), call('b'), call('c'), result('c', false), result('b'), result('a')]), undefined)
})
test('a different invocation signature separates repeated-failure episodes', () => {
  assert.equal(signal([...failures('first', 2), call('different', { path: 'b' }), result('different'),
    ...failures('last', 2)]), undefined)
})
test('an unattributable latest invocation is an uncertainty barrier', () => {
  assert.equal(signal([...failures('a'), call(undefined), ...failures('b', 2)]), undefined)
})

// A persistent warning acknowledges prior evidence, not all future tool failures.
test('persisted ECHO notices prevent replay of the acknowledged evidence after resume', async () => {
  const first = harness()
  first.agent.session.events = failures('old')
  const warning = (await first.pre()).messages[0]
  assert.equal(warning.source.signal, 'echo')
  const resumed = harness()
  resumed.agent.session.events = [...first.agent.session.events, { type: 'user/message', data: warning }]
  assert.equal((await resumed.pre()).messages.length, 0)
  resumed.agent.session.events.push(...failures('new', 2))
  assert.equal((await resumed.pre()).messages.length, 0)
  resumed.agent.session.events.push(...failures('third', 1))
  assert.equal((await resumed.pre()).messages.length, 1)
})
test('unchanged ECHO evidence cannot rearm the same runtime warning after cooldown', async () => {
  const h = harness()
  h.agent.session.events = failures('a')
  assert.equal((await h.pre()).messages.length, 1)
  for (let i = 0; i < 10; i++) assert.equal((await h.pre()).messages.length, 0)
})
test('new failures after successful recovery remain observable', async () => {
  const h = harness()
  h.agent.session.events = failures('a')
  const warning = (await h.pre()).messages[0]
  h.agent.session.events.push({ type: 'user/message', data: warning }, call('ok'), result('ok', false))
  await h.pre(); await h.pre()
  h.agent.session.events.push(...failures('b'))
  assert.equal((await h.pre()).messages.length, 1)
})
for (const effort of [undefined, 42, 'toString', 'constructor']) {
  test(`route effort ${String(effort)} replaces rather than inherits the previous max threshold`, async () => {
    const h = harness()
    const before = { reasoningEffort: 'max' }
    assert.equal(await h.request(before), before)
    const after = { reasoningEffort: effort }
    assert.equal(await h.request(after), after)
    h.agent.session.events = [reasoning(10_000)]
    await h.pre()
    assert.equal(h.logs.length, 0)
  })
}
test('prototype property names cannot become numeric threshold values', () => {
  const defaults = guard.resolveThresholds({})
  for (const key of ['toString', 'constructor', '__proto__']) {
    assert.deepEqual(guard.resolveThresholds({ effort: key, sensitivity: key }), defaults)
  }
})
test('single folding pass exposes STALL and ECHO independently', () => {
  assert.equal(typeof guard.foldGuardSignals, 'function')
  const events = [...failures('a'), { type: 'step/start' }, reasoning()]
  const { stall, echo } = guard.foldGuardSignals(events, { echoFailures: 3 })
  assert.equal(stall.signal, 'stall')
  assert.equal(echo.signal, 'echo')
  assert.deepEqual(guard.foldGuardSignal(events, { echoFailures: 3 }), stall)
  assert.deepEqual(guard.foldGuardSignal(events, { echoFailures: 3, detectStall: false }), echo)
})
test('observing STALL and interrupting ECHO traverses session events only once per pre-step', async () => {
  const h = harness()
  let scans = 0
  const events = [...failures('a'), { type: 'step/start' }, reasoning()]
  const iterator = events[Symbol.iterator].bind(events)
  events[Symbol.iterator] = function () { scans++; return iterator() }
  h.agent.session.events = events
  assert.equal((await h.pre()).messages.length, 1)
  assert.equal(scans, 1)
})

test('reused callId with conflicting arguments is an uncertainty barrier, not a replay', () => {
  assert.equal(signal([...failures('a'), call('a2', { path: 'changed' }), result('a2')]), undefined)
})
test('conflicting result callId locations cannot manufacture matched failures', () => {
  const events = Array.from({ length: 3 }, (_, i) => [call(String(i)), {
    type: 'tool/result', data: { callId: String(i),
      message: { isError: true, source: { callId: 'unrelated' } } },
  }]).flat()
  assert.equal(signal(events), undefined)
})
test('error objects and immutable event snapshots remain supported without mutation', () => {
  const events = Object.freeze(Array.from({ length: 3 }, (_, i) => [call(String(i)), {
    type: 'tool/result', data: { callId: String(i), error: { message: 'boom' } },
  }]).flat().map(event => Object.freeze(event)))
  const before = JSON.stringify(events)
  assert.equal(signal(events), 'echo')
  assert.equal(JSON.stringify(events), before)
})
test('all 384 arrival permutations and success patterns match an invocation-order oracle', () => {
  function permutations(values) {
    return values.length === 0 ? [[]] : values.flatMap((value, i) =>
      permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest]))
  }
  let checked = 0
  for (let mask = 0; mask < 16; mask++) {
    const failed = Array.from({ length: 4 }, (_, i) => Boolean(mask & (1 << i)))
    let trailing = 0
    for (let i = 3; i >= 0 && failed[i]; i--) trailing++
    for (const order of permutations([0, 1, 2, 3])) {
      const events = [0, 1, 2, 3].map(i => call(String(i)))
      events.push(...order.map(i => result(String(i), failed[i])))
      assert.equal(signal(events), trailing >= 3 ? 'echo' : undefined, `mask=${mask} order=${order}`)
      checked++
    }
  }
  assert.equal(checked, 384)
})

const semanticFailure = JSON.stringify({ ok: false, error: 'target is not owned', code: 'E_CHILD_NOT_OWN', hint: 'check child identity' })
function textOutcome(id, text, extra = {}) {
  return { type: 'tool/result', data: { message: { isError: false,
    source: { callId: id }, content: [{ type: 'text', text }], ...extra } } }
}
function semanticEvents(tool = 'task_child_send', text = semanticFailure) {
  return Array.from({ length: 6 }, (_, i) => [
    call('semantic-' + i, { target_id: 'missing', message: 'continue' }, tool),
    textOutcome('semantic-' + i, text),
  ]).flat()
}
test('native task-tool JSON failures participate in echo detection even when transport succeeds', () => {
  for (const name of ['task_open', 'task_claim', 'task_fact', 'task_submit', 'task_verify',
    'task_accept', 'task_reject', 'task_close', 'task_board', 'task_child_send', 'task_child_stop']) {
    const events = semanticEvents(name)
    assert.equal(guard.foldGuardSignal(events, { echoFailures: 6, detectStall: false }).signal, 'echo', name)
  }
})
test('PTC task-tool JSON failures count inside successful run_code wrappers', () => {
  const events = Array.from({ length: 6 }, (_, i) => [
    { type: 'step/start', data: { turn: 1, step: i + 1 } },
    call('root-' + i, { code: 'different transport ' + i }, 'run_code'),
    { type: 'tool/ptc-dispatch-start', data: { rootCallId: 'root-' + i, subCallId: 'inner',
      name: 'task_child_send', arguments: { target_id: 'missing', message: 'continue' } } },
    { type: 'tool/ptc-dispatch', data: { rootCallId: 'root-' + i, subCallId: 'inner',
      isError: false, content: [{ type: 'text', text: semanticFailure }] } },
    result('root-' + i, false), { type: 'step/end', data: { turn: 1, step: i + 1 } },
  ]).flat()
  assert.equal(guard.foldGuardSignal(events, { echoFailures: 6, detectStall: false }).signal, 'echo')
})
test('semantic failure parsing excludes external tools, quoted errors and incomplete envelopes', () => {
  for (const name of ['read', 'bash', 'run_code', 'task_custom', 'task_child_spawn']) {
    assert.equal(guard.foldGuardSignal(semanticEvents(name), { echoFailures: 6, detectStall: false }).signal, undefined, name)
  }
  for (const text of [
    JSON.stringify({ ok: true, nested: JSON.parse(semanticFailure) }),
    JSON.stringify({ ok: true, text: semanticFailure }),
    JSON.stringify({ ok: false }), JSON.stringify({ ok: 'false', error: 'x', code: 'E_INPUT', hint: 'x' }),
    JSON.stringify([JSON.parse(semanticFailure)]), JSON.stringify(semanticFailure),
    'Error: ' + semanticFailure, semanticFailure + ' trailing text',
  ]) assert.equal(guard.foldGuardSignal(semanticEvents('task_child_send', text),
    { echoFailures: 6, detectStall: false }).signal, undefined, text)
  const successful = semanticEvents().slice(0, 10).concat([
    call('success', { target_id: 'missing', message: 'continue' }, 'task_child_send'),
    textOutcome('success', JSON.stringify({ ok: true })),
  ])
  assert.equal(guard.foldGuardSignal(successful, { echoFailures: 6, detectStall: false }).signal, undefined)
})

test('semantic failures need matched names and a single complete text envelope', () => {
  const wrongName = semanticEvents().map(event => event.type !== 'tool/result' ? event
    : { ...event, data: { message: { ...event.data.message,
      source: { ...event.data.message.source, toolName: 'read' } } } })
  assert.equal(guard.foldGuardSignal(wrongName, { echoFailures: 6, detectStall: false }).signal, undefined)
  const blocks = semanticEvents().map(event => event.type !== 'tool/result' ? event
    : { ...event, data: { message: { ...event.data.message,
      content: [...event.data.message.content, { type: 'text', text: 'extra' }] } } })
  assert.equal(guard.foldGuardSignal(blocks, { echoFailures: 6, detectStall: false }).signal, undefined)
  const noCode = JSON.stringify({ ok: false, error: 'unknown service error', code: null, hint: 'inspect service' })
  assert.equal(guard.foldGuardSignal(semanticEvents('task_child_send', noCode),
    { echoFailures: 6, detectStall: false }).signal, 'echo')
})
test('semantic ECHO warnings acknowledge durable evidence without changing request effort', async () => {
  const h = harness({ echoFailures: 6 })
  h.agent.session.events = semanticEvents()
  const request = { reasoningEffort: 'max' }
  assert.equal(await h.request(request), request)
  const warning = (await h.pre()).messages[0]
  assert.equal(warning?.source.signal, 'echo')
  assert.equal(await h.request(request), request)
  const resumed = harness({ echoFailures: 6 })
  resumed.agent.session.events = [...h.agent.session.events, { type: 'user/message', data: warning }]
  assert.equal((await resumed.pre()).messages.length, 0)
})

const unknownNativeResult = id => ({ type: 'tool/result', data: {
  message: { source: { callId: id }, isError: true, content: [{ type: 'text', text: 'uncommitted outcome' }] },
  error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
} })
const unknownControlText = (status = 'unknown', code = 'E_CONTROL_OUTCOME_UNKNOWN') => JSON.stringify({
  ok: false, error: 'external effect is unresolved', code,
  hint: 'keep the original retry key; do not repeat the effect under another key',
  operation: { status, retry_key: 'original-retry-key' },
})
const ambiguousNativeEvents = () => Array.from({ length: 3 }, (_, i) => [
  call('unknown-' + i, { command: 'one fixed effect' }, 'bash'), unknownNativeResult('unknown-' + i),
]).flat()

test('matched native unknown effects do not produce definite-failure ECHO', () => {
  assert.equal(signal(ambiguousNativeEvents()), undefined)
})

test('an ambiguous matched outcome breaks a definite failure tail and its replay cannot overwrite it', () => {
  const events = [...failures('before', 2), call('ambiguous'), unknownNativeResult('ambiguous')]
  assert.equal(signal(events), undefined)
  assert.equal(signal([...events, result('ambiguous')]), undefined, 'first observed outcome remains ambiguous')
  assert.equal(signal([...events, ...failures('after', 2)]), undefined)
  assert.equal(signal([...events, ...failures('after', 3)]), 'echo', 'later definite failures still protect the agent')
})

test('definite TOOL_NOT_STARTED outcomes still produce ECHO', () => {
  const events = Array.from({ length: 3 }, (_, i) => [
    call('not-started-' + i),
    { type: 'tool/result', data: { message: { source: { callId: 'not-started-' + i }, isError: true },
      error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } } },
  ]).flat()
  assert.equal(signal(events), 'echo')
})

for (const [status, code] of [
  ['pending', 'E_CONTROL_OUTCOME_UNKNOWN'], ['unknown', 'E_CONTROL_OUTCOME_UNKNOWN'],
  ['unknown', 'PERSISTENCE_UNAVAILABLE'], ['unknown', null],
]) {
  test('durable ' + status + '/' + code + ' control effects do not produce definite-failure ECHO', () => {
    assert.equal(guard.foldGuardSignal(semanticEvents('task_child_send', unknownControlText(status, code)),
      { echoFailures: 6, detectStall: false }).signal, undefined)
  })
}

test('PTC durable unknown control effects do not produce definite-failure ECHO', () => {
  const events = Array.from({ length: 3 }, (_, i) => [
    { type: 'step/start', data: { turn: 1, step: i + 1 } },
    call('unknown-root-' + i, { code: 'transport' }, 'run_code'),
    { type: 'tool/ptc-dispatch-start', data: { rootCallId: 'unknown-root-' + i, subCallId: 'inner',
      name: 'task_child_send', arguments: { target_id: 'child', message: 'continue' } } },
    { type: 'tool/ptc-dispatch', data: { rootCallId: 'unknown-root-' + i, subCallId: 'inner',
      isError: false, content: [{ type: 'text', text: unknownControlText() }] } },
    result('unknown-root-' + i, false), { type: 'step/end', data: { turn: 1, step: i + 1 } },
  ]).flat()
  assert.equal(signal(events), undefined)
})

test('unknown controls cannot inject change-arguments guidance or arm effort demotion', async () => {
  const h = harness({ stepDownRequests: 3 })
  h.agent.session.events = semanticEvents('task_child_send', unknownControlText())
  assert.deepEqual((await h.pre()).messages, [])
  const request = { reasoningEffort: 'max' }
  assert.equal(await h.request(request), request)
})

