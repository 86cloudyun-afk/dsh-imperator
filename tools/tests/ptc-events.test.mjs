import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldSubagentFlow } from '../../lib/plugins/working-context.mjs'
import { foldGuardSignal, callSignature } from '../../lib/plugins/guard.mjs'

const start = (id, name = 'subagent', args = { prompt: 'work' }) => ({ type: 'tool/ptc-dispatch-start',
  data: { rootCallId: id.split(':')[0], parentCallId: id.split(':')[0], subCallId: id, name, arguments: args } })
const result = (id, isError = false, name = 'subagent', args = { prompt: 'work' }) => ({ type: 'tool/ptc-dispatch',
  data: { ...start(id, name, args).data, isError, content: [], ...(isError ? { error: { name: 'Error', code: 'ENOENT' } } : {}) } })
const notice = { type: 'user/message', data: { source: { kind: 'subagent-settled' } } }
const nativeCall = (id, name = 'subagent', args = { prompt: 'work' }) => ({ type: 'tool/call',
  data: { callId: id, name, arguments: JSON.stringify(args) } })
const nativeResult = (id, isError = false) => ({ type: 'tool/result',
  data: { message: { source: { callId: id }, isError, content: [] } } })
const step = (turn, number, events) => [
  { type: 'step/start', data: { turn, step: number } },
  ...events.map(event => ['tool/call', 'tool/result'].includes(event.type)
    ? { ...event, data: { turn, step: number, ...event.data } } : event),
  { type: 'step/end', data: { turn, step: number } },
]
const turn = (number, steps) => [{ type: 'turn/start', data: { turn: number } }, ...steps.flat(),
  { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } }]

test('failed or cancelled native delegation retires its in-flight placeholder', () => {
  const cancelled = nativeResult('cancelled', true)
  cancelled.data.error = { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' }
  const events = [nativeCall('failed'), nativeResult('failed', true),
    nativeCall('cancelled', 'subagent_fork'), cancelled]
  for (const settlement of ['settled-notice', 'tool-result']) {
    assert.deepEqual(foldSubagentFlow(events, undefined, settlement), {
      dispatched: 0, delegatedResults: 0, settledNotices: 0, settled: 0, inFlight: 0,
    })
  }
})

test('native replay counts each call and settlement once, including late starts', () => {
  const call = nativeCall('ok')
  const settled = nativeResult('ok')
  assert.deepEqual(foldSubagentFlow([call, call, settled, settled, call, notice]), {
    dispatched: 1, delegatedResults: 1, settledNotices: 1, settled: 1, inFlight: 0,
  })
  const failedCall = nativeCall('failed')
  const failure = nativeResult('failed', true)
  assert.equal(foldSubagentFlow([failedCall, failure, failure, failedCall]).dispatched, 0)
})

test('mixed successful and failed dispatches keep both settlement channels accurate', () => {
  const events = [nativeCall('bad'), nativeResult('bad', true), nativeCall('good'), nativeResult('good'),
    start('ptc:1'), result('ptc:1'), start('ptc:2'), result('ptc:2', true), notice]
  assert.deepEqual(foldSubagentFlow(events), {
    dispatched: 2, delegatedResults: 2, settledNotices: 1, settled: 1, inFlight: 1,
  })
  assert.equal(foldSubagentFlow(events, undefined, 'tool-result').inFlight, 0)
})

test('unmatched native results cannot settle another pending child', () => {
  assert.deepEqual(foldSubagentFlow([nativeCall('pending'), nativeResult('unknown'), nativeResult('unknown', true)]), {
    dispatched: 1, delegatedResults: 0, settledNotices: 0, settled: 0, inFlight: 1,
  })
})

test('PTC successful delegation, unresolved start and settlement notices survive replay', () => {
  const events = [start('a:ptc:1'), result('a:ptc:1'), start('b:ptc:1'), notice]
  assert.deepEqual(foldSubagentFlow(events), { dispatched: 2, delegatedResults: 1,
    settledNotices: 1, settled: 1, inFlight: 1 })
  assert.equal(foldSubagentFlow(events, undefined, 'tool-result').inFlight, 1)
  assert.deepEqual(foldSubagentFlow(events), foldSubagentFlow(JSON.parse(JSON.stringify(events))))
})

test('failed or aborted PTC dispatch does not claim a child was created', () => {
  const failure = result('a:ptc:1', true)
  const abort = result('b:ptc:1', true)
  abort.data.error = { name: 'AbortError', code: 'ABORT_ERR' }
  const flow = foldSubagentFlow([start('a:ptc:1'), failure, start('b:ptc:1'), abort])
  assert.equal(flow.dispatched, 0)
  assert.equal(flow.delegatedResults, 0)
  assert.equal(flow.inFlight, 0)
})

test('PTC settlement-only histories count success once and ignore duplicate dispatch records', () => {
  const events = [result('a:ptc:1'), result('a:ptc:1'), start('a:ptc:1'), start('b:ptc:1'), start('b:ptc:1')]
  assert.equal(foldSubagentFlow(events).dispatched, 2)
  assert.equal(foldSubagentFlow(events).delegatedResults, 1)
})

test('native and PTC delegations share the same settlement channel without counting run_code', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'native', name: 'subagent_fork' } },
    { type: 'tool/result', data: { message: { source: { callId: 'native' } } } },
    { type: 'tool/call', data: { callId: 'a', name: 'run_code' } },
    start('a:ptc:1'), result('a:ptc:1'), notice,
  ]
  assert.deepEqual(foldSubagentFlow(events), { dispatched: 2, delegatedResults: 2,
    settledNotices: 1, settled: 1, inFlight: 1 })
})

function attempts(count, innerResult = true) {
  return Array.from({ length: count }, (_, i) => [
    { type: 'tool/call', data: { callId: `r${i}`, name: 'run_code', arguments: { code: `// different wrapper ${i}` } } },
    start(`r${i}:ptc:1`, 'read', { path: 'missing' }),
    result(`r${i}:ptc:1`, innerResult, 'read', { path: 'missing' }),
    { type: 'tool/result', data: { message: { source: { callId: `r${i}`, toolName: 'run_code' }, isError: false } } },
  ]).flat()
}

test('successful outer run_code does not erase repeated inner PTC failures', () => {
  assert.equal(foldGuardSignal(attempts(3), { echoFailures: 3 }).signal, 'echo')
  assert.equal(foldGuardSignal(attempts(2), { echoFailures: 3 }).signal, undefined)
})

test('inner success or a genuinely different call resets the failure chain', () => {
  assert.equal(foldGuardSignal([...attempts(3), start('ok:ptc:1', 'read', { path: 'missing' }),
    result('ok:ptc:1', false, 'read', { path: 'missing' })], { echoFailures: 3 }).signal, undefined)
  assert.equal(foldGuardSignal([...attempts(3), start('other:ptc:1', 'read', { path: 'exists' })],
    { echoFailures: 3 }).signal, undefined)
})

test('standalone transport failures still count; mismatched results cannot increment a PTC chain', () => {
  const events = Array.from({ length: 3 }, (_, i) => [
    { type: 'tool/call', data: { name: 'run_code', callId: `c${i}`, arguments: { code: 'bad syntax' } } },
    { type: 'tool/result', data: { callId: `c${i}`, error: 'SyntaxError' } },
  ]).flat()
  assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, 'echo')
  assert.equal(foldGuardSignal([...attempts(2), result('unmatched:ptc:1', true, 'read', { path: 'missing' })],
    { echoFailures: 3 }).signal, undefined)
})

test('echo signatures treat reordered nested JSON object keys as the same arguments', () => {
  const args = [
    { file_path: 'missing', options: { offset: 0, limit: 20 } },
    { options: { limit: 20, offset: 0 }, file_path: 'missing' },
    { file_path: 'missing', options: { offset: 0, limit: 20 } },
  ]
  const events = args.flatMap((value, i) => [nativeCall(`n${i}`, 'read', value), nativeResult(`n${i}`, true)])
  assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, 'echo')
  const ptc = start('p:1', 'read', args[1])
  assert.equal(callSignature(events[0]), callSignature(ptc))
  assert.deepEqual(args[1], { options: { limit: 20, offset: 0 }, file_path: 'missing' })
})

test('signature normalization preserves array order, value types and malformed raw arguments', () => {
  const signature = (args) => callSignature(nativeCall('call', 'read', args))
  assert.notEqual(signature({ paths: ['a', 'b'] }), signature({ paths: ['b', 'a'] }))
  assert.notEqual(signature({ offset: 1 }), signature({ offset: '1' }))
  assert.notEqual(signature({ path: 'a' }), signature({ path: 'b' }))
  assert.notEqual(callSignature({ data: { name: 'read', arguments: '{bad a' } }),
    callSignature({ data: { name: 'read', arguments: '{bad b' } }))
})

for (const kind of ['native', 'ptc']) {
  const call = kind === 'native' ? nativeCall : start
  const settle = kind === 'native' ? nativeResult : (id, isError, args = { path: 'missing' }) => result(id, isError, 'read', args)
  test(`${kind} duplicate failure results count one attempt rather than triggering echo`, () => {
    const failed = settle('call', true)
    const rewrite = kind === 'native' ? { ...failed,
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] } : structuredClone(failed)
    assert.equal(foldGuardSignal([call('call', 'read', { path: 'missing' }), failed, failed, rewrite],
      { echoFailures: 3 }).signal, undefined)
  })

  test(`${kind} same-argument parallel failures count despite out-of-order results`, () => {
    const events = ['a', 'b', 'c'].map(id => call(id, 'read', { path: 'missing' }))
    events.push(settle('b', true), settle('c', true), settle('a', true))
    assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, 'echo')
  })

  test(`${kind} old failure results cannot revive a chain after a different call`, () => {
    const events = [call('old', 'read', { path: 'missing' }), call('different', 'read', { path: 'exists' }),
      call('new', 'read', { path: 'missing' }), settle('old', true), settle('new', true)]
    assert.equal(foldGuardSignal(events, { echoFailures: 2 }).signal, undefined)
  })

  test(`${kind} real success clears failures and ignores older pending failures`, () => {
    const events = ['a', 'b', 'c'].map(id => call(id, 'read', { path: 'missing' }))
    events.push(settle('b', true), settle('c', false), settle('a', true),
      call('new', 'read', { path: 'missing' }), settle('new', true))
    assert.equal(foldGuardSignal(events, { echoFailures: 2 }).signal, undefined)
  })

  test(`${kind} a late success from an older call clears the current failure chain`, () => {
    const events = [call('old-success', 'read', { path: 'exists' })]
    for (const id of ['a', 'b', 'c']) events.push(call(id, 'read', { path: 'missing' }), settle(id, true))
    assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, 'echo')
    events.push(settle('old-success', false, { path: 'exists' }))
    assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, undefined)
  })

  test(`${kind} reused IDs in separate steps identify distinct delegation attempts`, () => {
    const settled = kind === 'native' ? nativeResult : result
    const events = turn(1, [step(1, 1, [call('same', 'subagent'), settled('same', true)]),
      step(1, 2, [call('same', 'subagent'), settled('same', false)])])
    assert.deepEqual(foldSubagentFlow(events), {
      dispatched: 1, delegatedResults: 1, settledNotices: 0, settled: 0, inFlight: 1,
    })
  })

  test(`${kind} same-argument failures with reused IDs across steps still trigger echo`, () => {
    const events = turn(1, [1, 2, 3].map(number => step(1, number,
      [call('same', 'read', { path: 'missing' }), settle('same', true)])))
    assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, 'echo')
  })

  test(`${kind} same-argument failures with reused IDs across turns still trigger echo`, () => {
    const events = [1, 2, 3].flatMap(number => turn(number, [step(number, 1,
      [call('same', 'read', { path: 'missing' }), settle('same', true)])]))
    assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, 'echo')
  })
}

test('late native surface replacements stay attached to the original attempt', () => {
  const first = step(1, 1, [nativeCall('same'), nativeResult('same', true)])
  const rewrite = { ...first[2], surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }
  const events = turn(1, [first, step(1, 2, [nativeCall('same'), rewrite, nativeResult('same')])])
  assert.deepEqual(foldSubagentFlow(events), {
    dispatched: 1, delegatedResults: 1, settledNotices: 0, settled: 0, inFlight: 1,
  })
  assert.equal(foldGuardSignal(events, { echoFailures: 2 }).signal, undefined)
})

test('an older PTC wrapper ID does not hide standalone run_code failures in later steps', () => {
  const events = turn(1, [step(1, 1, [nativeCall('r', 'run_code', { code: 'wrapped tool' }),
    start('r:ptc:1', 'read', { path: 'missing' }), result('r:ptc:1', true, 'read', { path: 'missing' }), nativeResult('r')]),
  ...[2, 3, 4].map(number => step(1, number,
    [nativeCall('r', 'run_code', { code: 'bad syntax' }), nativeResult('r', true)]))])
  assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, 'echo')
})
