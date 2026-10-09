import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TASKFORCE_DEFINITION } from '../../lib/preset.js'
import { foldGuardSignals, foldGuardSignal, apply } from '../../lib/plugins/guard.mjs'
import { foldSubagentFlow } from '../../lib/plugins/working-context.mjs'

const call = (id, step, name = 'read', args = { path: 'missing' }) => ({ type: 'tool/call', data: { turn: 1, step, callId: id, name, arguments: args } })
const result = (id, step, isError = true) => ({ type: 'tool/result', data: { turn: 1, step, callId: id, message: { isError } } })
const ptc = (type, id, root = 'r', name = 'read', isError = true) => ({ type: `tool/ptc-dispatch${type === 'call' ? '-start' : ''}`, data: {
  rootCallId: root, subCallId: id, name, arguments: { path: 'missing' }, isError,
} })
const fail = (step) => [call('same', step), result('same', step)]

test('integration retains deliberate root policy, native presentation, depth two and worker persona', () => {
  const rows = TASKFORCE_DEFINITION.plugins
  const guard = rows.find(row => row.id === 'taskforce-guard') ?? rows.find(row => row.name?.endsWith('/guard.mjs'))
  assert.equal(guard.config.stallAction, 'observe')
  assert.equal(guard.config.stepDownRequests, 0)
  assert.equal(rows.find(row => row.id === 'tool-presentation')?.config.mode, 'native')
  const persona = rows.find(row => row.id === 'persona').config.prefix
  assert.match(persona, /研究|调查/)
  assert.doesNotMatch(persona, /send_message \/ interrupt_agent 属于 Agent Teams/)
  assert.match(persona, /DSH 0\.2.*send_message.*也支持子代理/)
  assert.doesNotMatch(persona, /不读写文件、不执行命令、不检索/)
  for (const row of rows.find(row => row.id === 'delegation').config.filter(row => row.name === '@deepseek-ai/dsh-tool-subagent')) {
    assert.equal(row.config.maxDepth, 2)
    assert.match(row.config.persona, /执行者/)
  }
})
test('the same provider ID can trigger fresh runtime warnings in different steps', async () => {
  const handlers = new Map()
  apply({ on: (event, fn) => handlers.set(event, fn) }, { stallAction: 'observe', stepDownRequests: 0,
    echoFailures: 2, refireCooldownSteps: 1 })
  const agent = { session: { events: [...fail(1), ...fail(2)] } }
  const pre = () => handlers.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal((await pre()).messages.length, 1)
  await pre()
  agent.session.events.push(...fail(3), ...fail(4))
  assert.equal((await pre()).messages.length, 1)
})
test('native and PTC IDs occupy separate namespaces within one step', () => {
  const events = [call('same', 1, 'read'), result('same', 1), ptc('call', 'same'), ptc('result', 'same')]
  assert.equal(foldGuardSignal(events, { echoFailures: 2 }).signal, 'echo')
})
test('PTC wrappers cannot erase invocation-ordered newer failures or rescan history', () => {
  let scans = 0
  const events = [call('old', 0), ...[1,2,3].flatMap(step => [call('r', step, 'run_code'), ptc('call','inner'),
    ptc('result','inner'), result('r', step, false)]), result('old', 0, false)]
  const iterate = events[Symbol.iterator].bind(events)
  events[Symbol.iterator] = () => { scans++; return iterate() }
  assert.equal(foldGuardSignal(events, { echoFailures: 3 }).signal, 'echo')
  assert.equal(scans, 1)
})
test('a PTC root ID cannot turn an unrelated native read into a transparent wrapper', () => {
  const events = [call('r', 1), result('r', 1), ptc('call','inner'), ptc('result','inner')]
  assert.equal(foldGuardSignal(events, { echoFailures: 2 }).signal, 'echo')
})
test('pending PTC invocations remain an uncertainty barrier after repeated failures', () => {
  const events = [...fail(1), ...fail(2), call('r', 3, 'run_code'), ptc('call','pending')]
  assert.equal(foldGuardSignal(events, { echoFailures: 2 }).signal, undefined)
})
test('persistent acknowledgements suppress old PTC failures but not new scoped attempts', () => {
  const attempts = step => [call('r', step, 'run_code'), ptc('call','inner'), ptc('result','inner'), result('r',step,false)]
  const events = [...attempts(1), ...attempts(2), { type: 'user/message', data: { source: { kind: 'taskforce-guard', signal: 'echo' } } }]
  assert.equal(foldGuardSignals(events, { echoFailures: 2 }).echo, undefined)
  events.push(...attempts(3), ...attempts(4))
  assert.equal(foldGuardSignals(events, { echoFailures: 2 }).echo.signal, 'echo')
})
test('PTC failed receipts and repeated notices preserve main flow counters and pending work', () => {
  const events = [call('r', 1,'run_code'), ptc('call','a','r','subagent'), ptc('result','a','r','subagent'),
    ptc('call','b','r','subagent'), ptc('result','b','r','subagent',false), ptc('call','c','r','subagent')]
  const notice = { type:'user/message', data:{id:'one', source:{kind:'subagent-settled',senderSessionId:'settled-child'}} }
  events.push(notice, structuredClone(notice))
  assert.deepEqual(foldSubagentFlow(events), { dispatched:3, delegatedResults:2, failedDispatches:1,
    settledNotices:1, settled:1, inFlight:1 })
})
