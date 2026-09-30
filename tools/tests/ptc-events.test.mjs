import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldSubagentFlow } from '../../lib/plugins/working-context.mjs'
import { foldGuardSignal } from '../../lib/plugins/guard.mjs'

const start = (id, name = 'subagent', args = { prompt: 'work' }) => ({ type: 'tool/ptc-dispatch-start',
  data: { rootCallId: id.split(':')[0], parentCallId: id.split(':')[0], subCallId: id, name, arguments: args } })
const result = (id, isError = false, name = 'subagent', args = { prompt: 'work' }) => ({ type: 'tool/ptc-dispatch',
  data: { ...start(id, name, args).data, isError, content: [], ...(isError ? { error: { name: 'Error', code: 'ENOENT' } } : {}) } })
const notice = { type: 'user/message', data: { source: { kind: 'subagent-settled' } } }

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
