import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TASKFORCE_DEFINITION } from '../../lib/preset.js'
import { apply, foldGuardSignal, name } from '../../lib/plugins/guard.mjs'
import { runVerification } from '../verify-all.mjs'

const rows = TASKFORCE_DEFINITION.plugins
const presetGuard = rows.find((row) => row.id === 'taskforce-guard')
const persona = rows.find((row) => row.id === 'persona').config.prefix
const deliberate = { stallAction: 'observe', stepDownRequests: 0 }

// This is a hook fixture, not a real DSH host or a model-behaviour benchmark.
function harness(config, loggerOverride) {
  const handlers = new Map()
  const logs = []
  const ctx = {
    on(event, handler) { handlers.set(event, handler) },
    logger: loggerOverride ?? { warn(message) { logs.push(message) } },
  }
  apply(ctx, config)
  return {
    handlers, logs,
    step: (agent, decision = { kind: 'enter', messages: [] }) =>
      handlers.get('agent/pre-step')({ agent }, async () => decision),
    request: (agent, request) => handlers.get('agent/request')({ agent }, async () => request),
  }
}

const stepStart = () => ({ type: 'step/start' })
const reasoning = (count = 24000) => ({ type: 'assistant/message', data: {
  message: { content: [{ type: 'reasoning', text: 'private-reasoning-marker'.repeat(count).slice(0, count) }] },
} })
const output = () => ({ type: 'assistant/message', data: {
  message: { content: [{ type: 'text', text: 'New evidence found.' }] },
} })
const stalled = () => [stepStart(), reasoning()]
function echoing(count = 5) {
  return Array.from({ length: count }, (_, i) => [
    stepStart(),
    { type: 'tool/call', data: { name: 'read', callId: `call-${i}`, arguments: { path: '/missing' } } },
    { type: 'tool/result', data: { callId: `call-${i}`, error: 'missing' } },
  ]).flat()
}

test('persona assigns evidence gathering and decision-making to the main session', () => {
  assert.match(persona, /主会话.*研究.*决策/)
  for (const tool of ['read', 'glob', 'grep']) assert(persona.includes(tool))
  assert.match(persona, /备选方案/)
  assert.match(persona, /反例/)
  assert.doesNotMatch(persona, /不读写文件|缺事实就立刻派子代理|同一假设最多推理两次|思考只用于确定/)
})

test('persona groups work and separates reuse, scoped review, and budget dimensions', () => {
  for (const term of ['派发前', 'task_child_send', '独立复核', '累计新建', '嵌套', '返工', '软预算']) {
    assert(persona.includes(term), `Missing discipline: ${term}`)
  }
  assert.match(persona, /主会话.*验收/)
  assert.match(persona, /子代理.*执行/)
  assert.doesNotMatch(persona, /复核是重做，不是重读/)
})

test('preset selects observation and no step-down without removing execution boundaries', () => {
  assert.deepEqual(presetGuard.config, deliberate)
  assert(rows.some((row) => row.id === 'taskforce-orchestrator-scope'))
  const delegation = rows.find((row) => row.id === 'delegation').config
  assert.equal(delegation.find((row) => row.id === 'tool-subagent').config.maxDepth, 2)
  for (const id of ['tool-subagent', 'tool-subagent-fork']) {
    assert.equal(delegation.find((row) => row.id === id).config.backgroundMode, 'continuable')
  }
  assert.match(persona, /不执行命令/)
  assert.match(persona, /不.*写.*文件/)
})

test('observe mode never injects a STALL message or arms the legacy step-down window', async () => {
  // Nonzero legacy budget isolates stallAction from the separate zero-budget switch.
  const h = harness({ stallAction: 'observe', stepDownRequests: 3 })
  const agent = { session: { events: stalled() } }
  const request = Object.freeze({ model: 'fixture', reasoningEffort: 'high' })
  await h.request(agent, request)
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [] }] }
  assert.strictEqual(await h.step(agent, decision), decision)
  for (let i = 0; i < 5; i++) assert.strictEqual(await h.request(agent, request), request)
  assert.equal(h.logs.length, 1)
  assert.match(h.logs[0], /观察/)
  assert.doesNotMatch(h.logs[0], /private-reasoning-marker|已经打断|断路器触发/)
})

for (const effort of ['max', 'high', 'low', 'off', undefined, 42]) {
  test(`shipped guard preserves request identity with reasoningEffort=${effort}`, async () => {
    // Assert shipped config separately so an absent config cannot silently use a fixture default.
    assert.deepEqual(presetGuard.config, deliberate)
    const h = harness(presetGuard.config)
    const agent = { session: { events: stalled() } }
    const request = Object.freeze({ model: 'fixture', reasoningEffort: effort })
    await h.request(agent, request)
    assert.equal((await h.step(agent)).messages.length, 0)
    assert.strictEqual(await h.request(agent, request), request)
  })
}

test('observation is once per uninterrupted STALL episode, including beyond cooldown', async () => {
  const h = harness({ stallAction: 'observe', refireCooldownSteps: 2 })
  const agent = { session: { events: stalled() } }
  for (let i = 0; i < 12; i++) await h.step(agent)
  assert.equal(h.logs.length, 1)
  agent.session.events.push(output())
  await h.step(agent)
  agent.session.events.push(stepStart(), reasoning())
  await h.step(agent)
  assert.equal(h.logs.length, 2)
})

test('observation never consumes ECHO cooldown or suppresses duplicate-failure protection', async () => {
  const h = harness(deliberate)
  const agent = { session: { events: stalled() } }
  await h.step(agent)
  agent.session.events.push(...echoing())
  const decision = await h.step(agent)
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].source.kind, name)
  const request = Object.freeze({ reasoningEffort: 'high' })
  assert.strictEqual(await h.request(agent, request), request)
})

test('an observed STALL cannot mask an ECHO signal already present in the same event tail', async () => {
  const h = harness(deliberate)
  const agent = { session: { events: [...echoing(), stepStart(), reasoning()] } }
  assert.equal(foldGuardSignal(agent.session.events).signal, 'stall')
  const decision = await h.step(agent)
  assert.equal(decision.messages.length, 1)
  assert.match(decision.messages[0].content[0].text, /工具调用.*反复失败/)
  const request = Object.freeze({ reasoningEffort: 'max' })
  assert.strictEqual(await h.request(agent, request), request)
})

test('a successful tool result clears ECHO even while STALL observation remains enabled', async () => {
  const h = harness(deliberate)
  const events = echoing()
  events.push({ type: 'tool/call', data: { name: 'read', callId: 'ok', arguments: { path: '/found' } } },
    { type: 'tool/result', data: { callId: 'ok', message: { isError: false } } })
  assert.equal((await h.step({ session: { events } })).messages.length, 0)
})

test('zero step-down budget still permits explicit STALL interruption without changing requests', async () => {
  const h = harness({ stallAction: 'interrupt', stepDownRequests: 0 })
  const agent = { session: { events: stalled() } }
  assert.equal((await h.step(agent)).messages.length, 1)
  const request = Object.freeze({ reasoningEffort: 'high' })
  for (let i = 0; i < 5; i++) assert.strictEqual(await h.request(agent, request), request)
})

test('legacy interrupt configuration retains bounded downgrade and restoration', async () => {
  const h = harness({ stallAction: 'interrupt', stepDownRequests: 2 })
  const agent = { session: { events: stalled() } }
  assert.equal((await h.step(agent)).messages.length, 1)
  const request = Object.freeze({ model: 'fixture', reasoningEffort: 'max' })
  assert.deepEqual(await h.request(agent, request), { model: 'fixture', reasoningEffort: 'high' })
  assert.equal((await h.request(agent, request)).reasoningEffort, 'high')
  assert.strictEqual(await h.request(agent, request), request)
})

test('real output prevents STALL observation; a stopped pre-step is not modified', async () => {
  const h = harness(deliberate)
  assert.equal((await h.step({ session: { events: [...stalled(), output()] } })).messages.length, 0)
  assert.equal(h.logs.length, 0)
  const decision = { kind: 'stop' }
  assert.strictEqual(await h.step({ session: { events: stalled() } }, decision), decision)
  assert.equal(h.logs.length, 0)
})

test('snapshot events and per-agent disposal work without shared observation state', async () => {
  const h = harness(deliberate)
  const first = { session: { snapshotEvents: stalled } }
  const second = { session: { events: stalled() } }
  await h.step(first)
  await h.step(second)
  assert.equal(h.logs.length, 2)
  await h.step(first)
  assert.equal(h.logs.length, 2)
  h.handlers.get('agent/disposed')({ agent: first })
  await h.step(first)
  assert.equal(h.logs.length, 3)
})

test('unavailable logging cannot turn an observation into a session failure', async () => {
  const h = harness(deliberate, { warn() { throw new Error('logger unavailable') } })
  assert.equal((await h.step({ session: { events: stalled() } })).messages.length, 0)
})

test('invalid stall actions and invalid step-down budgets are rejected at activation', () => {
  for (const value of ['silent', '', null, true, 0]) {
    assert.throws(() => harness({ stallAction: value }), /stallAction/)
  }
  for (const value of [-1, 0.5, '0', NaN, Infinity]) {
    assert.throws(() => harness({ stepDownRequests: value }), /stepDownRequests/)
  }
  assert.doesNotThrow(() => harness({ stepDownRequests: 0 }))
  assert.equal(harness({ enabled: false }).handlers.size, 0)
})

test('the standard offline runner includes this regression suite', async () => {
  const calls = []
  await runVerification({ runProcess: async (_file, args) => {
    calls.push(args)
    return { exitCode: 0 }
  } })
  assert(calls.some((args) => args[0] === '--test'
    && args.some((path) => path.endsWith('/deliberate-orchestration.test.mjs'))))
})
