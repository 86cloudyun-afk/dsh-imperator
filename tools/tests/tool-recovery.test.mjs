import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply as applyTools } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'

const RUN = 'tool-recovery-run'
const CHILD = 'tool-recovery-child'
const COMMAND = 'node source.js'
const TABLES = ['task', 'fact', 'handoff', 'execution_receipt', 'execution_waiver']

// Actual SQLite; only the native subagent service is a boundary fixture.
function toolCaller(store, agent, subagents) {
  const definitions = []
  applyTools({
    logger: { warn() {} },
    get(name) {
      if (name === 'taskforceStore') return store
      if (name === 'agents') return { get: id => (id === agent.id ? agent : undefined) }
      if (name === 'subagents') return subagents
    },
    tools: { register: definition => { definitions.push(definition); return () => {} } },
  })
  return async (name, args, signal = new AbortController().signal) => {
    const definition = definitions.find(tool => tool.name === name)
    assert.ok(definition, 'tool ' + name + ' must be registered')
    return JSON.parse(await definition.execute(args, { agent, signal }))
  }
}
function workspace(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'taskforce-tool-recovery-')))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'source.js'), 'process.exitCode = 0\n')
  return cwd
}
function snapshot(store) {
  store.open()
  return Object.fromEntries(TABLES.map(table => [
    table, store.handle.prepare('SELECT * FROM ' + table + ' ORDER BY id').all(),
  ]))
}
function executionArgs(extra = {}) {
  return { title: 'fixed execution policy', evidence_policy: 'execution',
    verification_files: ['source.js'], verification_command: COMMAND, ...extra }
}
test('ID-only root can create legacy tasks, and only its own run sees them', async t => {
  const store = tempStore(t)
  store.openTask({ title: 'another run' }, 'other-run')
  const call = toolCaller(store, { id: RUN })
  const result = await call('task_open', { title: 'ID-only legacy' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.run_id, RUN)
  assert.equal(typeof result.task_id, 'number')
  assert.equal(store.stats(RUN).tasks.total, 1)
  assert.equal(store.boardPage({ task_id: result.task_id }, RUN).task.run_id, RUN)
  const board = await call('task_board', {})
  assert.equal(board.ok, true)
  assert.deepEqual(board.tasks.map(task => task.id), [result.task_id])
  assert.equal(board.can_accept, true)
  assert.equal(store.boardPage({}, 'other-run').tasks.length, 1)
  assert.throws(() => store.boardPage({ task_id: result.task_id }, 'other-run'), { code: 'E_CROSS_RUN' })
})
test('ID-only execution rejects with policy error and no persisted writes, even with model cwd', async t => {
  const store = tempStore(t)
  const modelCwd = workspace(t)
  const call = toolCaller(store, { id: RUN })
  const before = snapshot(store)
  const result = await call('task_open', executionArgs({
    cwd: modelCwd, verification_cwd: modelCwd, isRoot: true, run_id: 'model-run',
  }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_VERIFICATION_POLICY', JSON.stringify(result))
  assert.match(result.hint, /execution 任务须由主会话声明/)
  assert.doesNotMatch(result.error, /Cannot read propert/)
  assert.deepEqual(snapshot(store), before)
  assert.equal(store.stats(RUN).tasks.total, 0)
})
test('legacy creation also permits a host header that has no cwd', async t => {
  const store = tempStore(t)
  const agent = { id: RUN, session: { header: { id: RUN } } }
  const result = await toolCaller(store, agent)('task_open', { title: 'header without cwd' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(store.boardPage({ task_id: result.task_id }, RUN).task.evidence_policy, 'legacy')
})
test('execution uses the real host cwd and ignores a different valid model cwd', async t => {
  const store = tempStore(t)
  const cwd = workspace(t), modelCwd = workspace(t)
  assert.notEqual(cwd, modelCwd)
  const agent = { id: RUN, session: { header: { id: RUN, cwd } } }
  const call = toolCaller(store, agent)
  const result = await call('task_open', executionArgs({
    cwd: modelCwd, verification_cwd: modelCwd, run_id: 'model-run',
  }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.run_id, RUN)
  const detail = store.boardPage({ task_id: result.task_id }, RUN)
  assert.equal(detail.task.evidence_policy, 'execution')
  assert.equal(detail.task.verification_cwd, cwd)
  assert.equal(detail.task.verification_command, COMMAND)
  assert.deepEqual(detail.task.verification_files, ['source.js'])
  assert.equal(store.stats(RUN).tasks.total, 1)
  assert.equal(store.stats('model-run').tasks.total, 0)
})
// English diagnostics cannot accidentally supply the required Chinese hints.
function nativeFailure(code) {
  return Object.assign(new Error('native diagnostic ' + code + ' for ' + CHILD), {
    name: 'SubagentError', code,
  })
}
function childFixture(t, method, error) {
  const store = tempStore(t)
  store.openTask({ title: 'unrelated persisted task' }, RUN)
  const caller = { id: RUN, status: 'idle', options: {}, session: { header: { id: RUN } } }
  const signal = new AbortController().signal
  const calls = { listChildren: [], sendMessage: [], interrupt: [] }
  const service = {
    async listChildren(parentId) {
      calls.listChildren.push(parentId)
      return parentId === RUN ? [{ id: CHILD, mode: 'continuable', createdAt: 0 }] : []
    },
    async sendMessage(sender, targetId, content, options) {
      calls.sendMessage.push({ sender, targetId, content, options })
      assert.equal(sender, caller)
      assert.equal(targetId, CHILD)
      assert.deepEqual(content, [{ type: 'text', text: 'continue after recovery' }])
      assert.equal(options.signal, signal)
      if (method === 'send') throw error
      return 'accepted-message'
    },
    interrupt(targetId, authority) {
      calls.interrupt.push({ targetId, authority })
      assert.equal(targetId, CHILD)
      assert.equal(authority.kind, 'ancestor')
      assert.equal(authority.agent, caller)
      if (method === 'stop') throw error
    },
  }
  return { store, caller, signal, calls, call: toolCaller(store, caller, service) }
}
function assertNoReceipt(result) {
  assert.equal(result.ok, false)
  for (const field of ['sent', 'stopped', 'delivery', 'execution', 'accepted']) {
    assert.equal(Object.hasOwn(result, field), false, 'failed call must not return ' + field)
  }
}
function assertHint(result, kind) {
  assert.equal(typeof result.hint, 'string')
  assert.doesNotMatch(result.hint, /参数或对象标识有问题|核对 id 与取值后重试/)
  if (kind === 'authority') {
    assert.match(result.hint, /授权|归属|身份|自己派出|非直属|跨会话/)
    assert.match(result.hint, /不要(?:盲目|反复)?重试|停止(?:自动)?重试|拒绝服务/)
  } else if (kind === 'recovery') {
    assert.match(result.hint, /续作|恢复|持久|continuation/i)
    assert.match(result.hint, /不要(?:盲目|反复)?重试|停止(?:自动)?重试/)
    assert.match(result.hint, /核对|报告|上报|重新派|新(?:建|开|任务|子代理)/)
  } else if (kind === 'service') {
    assert.match(result.hint, /部署|宿主|依赖|持久化|查询/)
    assert.match(result.hint, /不要(?:盲目|反复)?重试|停止(?:自动)?重试/)
    assert.match(result.hint, /报告|上报/)
  } else {
    assert.match(result.hint, /宿主|运行时|生命周期|runtime/i)
    assert.match(result.hint, /报告|上报/)
    assert.match(result.hint, /task_board|看板|(?:核对|检查).*(?:状态|生命周期)/)
  }
}
for (const [code, kind] of [
  ['UNAUTHORIZED', 'authority'], ['NOT_RESUMABLE', 'recovery'],
  ['CONTINUATION_UNAVAILABLE', 'service'], ['PERSISTENCE_UNAVAILABLE', 'service'],
]) {
  test('child send ' + code + ' preserves native diagnostic and gives accurate remediation', async t => {
    const error = nativeFailure(code), f = childFixture(t, 'send', error)
    const before = snapshot(f.store)
    const result = await f.call('task_child_send', {
      target_id: CHILD, message: 'continue after recovery',
      sender: { id: 'model-forgery' }, parentSession: 'another-run',
    }, f.signal)
    assertNoReceipt(result)
    assert.equal(result.code, code, JSON.stringify(result))
    assert.ok(result.error.includes(error.message))
    assert.equal(f.calls.sendMessage.length, 1)
    assert.equal(f.calls.sendMessage[0].sender, f.caller)
    assert.deepEqual(f.calls.listChildren, [RUN])
    assert.equal(f.calls.interrupt.length, 0)
    assert.deepEqual(snapshot(f.store), before)
    assertHint(result, kind)
  })
}
test('child stop UNAUTHORIZED retains the existing ownership refusal', async t => {
  const error = nativeFailure('UNAUTHORIZED'), f = childFixture(t, 'stop', error)
  const before = snapshot(f.store)
  const result = await f.call('task_child_stop', { target_id: CHILD }, f.signal)
  assertNoReceipt(result)
  assert.equal(result.code, 'E_CHILD_NOT_OWN')
  assert.ok(result.error.includes(error.message))
  assert.match(result.error, /授权|归属/)
  assert.equal(f.calls.interrupt.length, 1)
  assert.equal(f.calls.interrupt[0].authority.agent, f.caller)
  assert.deepEqual(f.calls.listChildren, [RUN])
  assert.equal(f.calls.sendMessage.length, 0)
  assert.deepEqual(snapshot(f.store), before)
  assertHint(result, 'authority')
})
for (const [code, kind] of [['NOT_RESUMABLE', 'recovery'], ['PERSISTENCE_UNAVAILABLE', 'service']]) {
  test('child stop ' + code + ' must not fabricate ownership failure or accepted receipt', async t => {
    const error = nativeFailure(code), f = childFixture(t, 'stop', error)
    const before = snapshot(f.store)
    const result = await f.call('task_child_stop', {
      target_id: CHILD, authority: { kind: 'user', parentSessionId: 'model-forgery' },
    }, f.signal)
    assertNoReceipt(result)
    assert.equal(result.code, code, JSON.stringify(result))
    assert.ok(result.error.includes(error.message))
    assert.doesNotMatch(result.error, /父子授权.*对不上|归属已变|跨会话|非直属/)
    assert.equal(f.calls.interrupt.length, 1)
    assert.equal(f.calls.interrupt[0].authority.agent, f.caller)
    assert.deepEqual(f.calls.listChildren, [RUN])
    assert.equal(f.calls.sendMessage.length, 0)
    assert.deepEqual(snapshot(f.store), before)
    assertHint(result, kind)
  })
}
for (const [method, name, args, diagnostic] of [
  ['send', 'task_child_send', { target_id: CHILD, message: 'continue after recovery' }, 'opaque host runtime diagnostic'],
  ['stop', 'task_child_stop', { target_id: CHILD }, 'opaque host runtime diagnostic'],
  ['send', 'task_child_send', { target_id: CHILD, message: 'continue after recovery' }, '服务不可用：child bridge failed'],
  ['stop', 'task_child_stop', { target_id: CHILD }, '服务不可用：child bridge failed'],
]) {
  test('child ' + method + ' preserves unknown runtime failure: ' + diagnostic, async t => {
    const error = new Error(diagnostic), f = childFixture(t, method, error)
    const before = snapshot(f.store)
    const result = await f.call(name, args, f.signal)
    assertNoReceipt(result)
    assert.equal(result.code, null, JSON.stringify(result))
    assert.ok(result.error.includes(error.message))
    assert.doesNotMatch(result.error, /父子授权.*对不上|归属已变|跨会话|非直属/)
    assert.deepEqual(f.calls.listChildren, [RUN])
    assert.equal(f.calls.sendMessage.length, method === 'send' ? 1 : 0)
    assert.equal(f.calls.interrupt.length, method === 'stop' ? 1 : 0)
    if (method === 'send') assert.equal(f.calls.sendMessage[0].sender, f.caller)
    else assert.equal(f.calls.interrupt[0].authority.agent, f.caller)
    assert.deepEqual(snapshot(f.store), before)
    assertHint(result, 'runtime')
  })
}

// Real SQLite journal; only native service publication and child control are fixtures.
function controlJournalFixture(t, { detached = false, unreadableStore = false, malformedJournal = false,
  initialPublication, reflectedStore = false } = {}) {
  const store = tempStore(t)
  let published = detached ? undefined : malformedJournal ? { recovery: {} } : store
  if (initialPublication === 'null-store') published = null
  if (initialPublication === 'null-journal') published = { recovery: null }
  if (initialPublication === 'undefined-journal') published = { recovery: undefined }
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
  ]
  const agent = { id: RUN, session: { header: { id: RUN }, events } }
  const definitions = new Map()
  const effects = { send: 0, stop: 0 }
  const subagents = {
    async listChildren() { return [{ id: CHILD, mode: 'continuable', createdAt: 0 }] },
    async sendMessage() { effects.send++; return 'journal-message-' + effects.send },
    interrupt() { effects.stop++ },
  }
  applyTools({
    logger: { warn() {} },
    taskforceStore: reflectedStore ? store : undefined,
    get(name) {
      if (name === 'taskforceStore') {
        if (unreadableStore) throw new Error('PRIVATE_SERVICE_FAILURE')
        return published
      }
      if (name === 'subagents') return subagents
      if (name === 'agents') return { get: id => id === RUN ? agent : undefined }
    },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } },
  })
  return {
    store, effects, events, agent, subagents,
    publish(value) { published = value },
    async call(action, request_key) {
      const args = { target_id: CHILD, ...(action === 'send' ? { message: 'PRIVATE_CONTROL_MESSAGE' } : {}),
        ...(request_key === undefined ? {} : { request_key }) }
      return JSON.parse(await definitions.get('task_child_' + action).execute(args, {
        agent, callId: 'journal-call', rootCallId: 'journal-root-call', signal: new AbortController().signal,
      }))
    },
  }
}
function pendingControl(f) {
  f.store.open().exec("CREATE TRIGGER deny_control_outcome BEFORE UPDATE ON control_operation BEGIN SELECT RAISE(ABORT, 'PRIVATE_OUTCOME_FAILURE'); END")
}
function operationRows(store) {
  return store.open().prepare('SELECT * FROM control_operation ORDER BY id').all()
}
function assertJournalUnavailable(result) {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, 'E_CONTROL_JOURNAL_UNAVAILABLE', JSON.stringify(result))
  assert.match(result.hint, /原.*(?:键|retry_key)|retry_key/)
  assert.match(result.hint, /不得换键|禁止.*新.*键/)
  assert.match(result.hint, /日志|journal|恢复/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONTROL_MESSAGE|PRIVATE_OUTCOME_FAILURE|PRIVATE_SERVICE_FAILURE/)
  for (const field of ['sent', 'stopped', 'execution', 'delivery']) {
    assert.equal(Object.hasOwn(result, field), false, 'unavailable journal cannot return ' + field)
  }
}

for (const action of ['send', 'stop']) {
  for (const coordinate of ['explicit key', 'trusted coordinates']) {
    for (const degradation of ['missing', 'replacement']) {
      test('pending ' + action + ' with ' + coordinate + ' cannot repeat after journal ' + degradation, async t => {
        const f = controlJournalFixture(t)
        pendingControl(f)
        const key = coordinate === 'explicit key' ? 'journal-original-key' : undefined
        const first = await f.call(action, key)
        assert.equal(first.code, 'E_CONTROL_OUTCOME_UNKNOWN', JSON.stringify(first))
        assert.equal(first.operation.status, 'pending')
        assert.equal(typeof first.operation.retry_key, 'string')
        assert.equal(f.effects[action], 1)
        const before = operationRows(f.store)
        const replacement = degradation === 'replacement' ? tempStore(t) : undefined
        f.publish(replacement)
        const denied = await f.call(action, key)
        assert.equal(f.effects[action], 1, 'same operation must not reach the native effect twice: ' + JSON.stringify(denied))
        assertJournalUnavailable(denied)
        assert.deepEqual(operationRows(f.store), before)
        if (replacement) assert.equal(operationRows(replacement).length, 0)
        f.publish(f.store)
        const restored = await f.call(action, first.operation.retry_key)
        assert.equal(restored.operation.operation_id, first.operation.operation_id)
        assert.equal(restored.operation.replayed, true)
        assert.equal(restored.operation.status, 'pending')
        assert.equal(f.effects[action], 1)
        assert.deepEqual(operationRows(f.store), before)
      })
    }
  }

  test('explicit ' + action + ' retry key needs a journal even on a new detached activation', async t => {
    const f = controlJournalFixture(t, { detached: true })
    const denied = await f.call(action, 'persisted-elsewhere-key')
    assert.equal(f.effects[action], 0, 'an explicit retry key cannot fall back to a legacy effect')
    assertJournalUnavailable(denied)
  })

  test('journal observed at activation cannot disappear before the first ' + action, async t => {
    const f = controlJournalFixture(t)
    f.publish(undefined)
    const denied = await f.call(action)
    assert.equal(f.effects[action], 0)
    assertJournalUnavailable(denied)
  })

  test('closed journal denies ' + action + ' before a new native effect with safe diagnostics', async t => {
    const f = controlJournalFixture(t)
    pendingControl(f)
    const first = await f.call(action, 'closed-journal-original')
    assert.equal(first.operation.status, 'pending')
    f.store.close()
    const denied = await f.call(action, first.operation.retry_key)
    assert.equal(f.effects[action], 1)
    assertJournalUnavailable(denied)
    assert.equal(JSON.stringify(denied).includes(f.store.root), false, 'closed-store paths are not recovery diagnostics')
  })

  test('unreadable replacement recovery denies ' + action + ' without exposing its exception', async t => {
    const f = controlJournalFixture(t)
    pendingControl(f)
    const first = await f.call(action, 'unreadable-journal-original')
    assert.equal(first.operation.status, 'pending')
    const before = operationRows(f.store)
    f.publish({ get recovery() { throw new Error('PRIVATE_SERVICE_FAILURE') } })
    const denied = await f.call(action, first.operation.retry_key)
    assert.equal(f.effects[action], 1)
    assertJournalUnavailable(denied)
    assert.deepEqual(operationRows(f.store), before)
  })

  test('a fresh key cannot bypass a missing journal after durable ' + action, async t => {
    const f = controlJournalFixture(t)
    const first = await f.call(action)
    assert.equal(first.ok, true, JSON.stringify(first))
    f.publish(undefined)
    f.events.push({ type: 'step/start', data: { turn: 1, step: 2 } })
    const denied = await f.call(action)
    assert.equal(f.effects[action], 1)
    assertJournalUnavailable(denied)
  })

  test('genuinely detached ' + action + ' without a request key retains explicit legacy durability', async t => {
    const f = controlJournalFixture(t, { detached: true })
    const result = await f.call(action)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.operation.durable, false)
    assert.equal(result.operation.durability, 'unavailable')
    assert.equal(f.effects[action], 1)
  })
}

for (const action of ['send', 'stop']) {
  test('unreadable store resolution cannot authorize initial detached ' + action, async t => {
    const f = controlJournalFixture(t, { unreadableStore: true })
    const denied = await f.call(action)
    assert.equal(f.effects[action], 0, 'a failed service lookup is not a known journal-free adapter')
    assertJournalUnavailable(denied)
  })
  test('malformed initial journal cannot authorize ' + action + ' or leak method diagnostics', async t => {
    const f = controlJournalFixture(t, { malformedJournal: true })
    const denied = await f.call(action)
    assert.equal(f.effects[action], 0)
    assertJournalUnavailable(denied)
    assert.doesNotMatch(denied.error, /not a function|beginControl|finishControl/)
  })
}

for (const action of ['send', 'stop']) {
  for (const initialPublication of ['null-store', 'null-journal']) {
    test('explicit ' + initialPublication + ' cannot authorize keyless ' + action, async t => {
      const f = controlJournalFixture(t, { initialPublication })
      const before = operationRows(f.store)
      const result = await f.call(action)
      assert.equal(f.effects[action], 0, 'explicit null is not evidence of a never-journaled activation')
      assertJournalUnavailable(result)
      assert.deepEqual(operationRows(f.store), before)
    })
  }
  test('a failed primary store lookup cannot use reflected journal for ' + action, async t => {
    const f = controlJournalFixture(t, { unreadableStore: true, reflectedStore: true })
    const before = operationRows(f.store)
    const result = await f.call(action)
    assert.equal(f.effects[action], 0, 'a reflected journal cannot waive primary lookup failure')
    assertJournalUnavailable(result)
    assert.deepEqual(operationRows(f.store), before)
  })
  test('normal undefined primary lookup remains authoritative for detached ' + action, async t => {
    const f = controlJournalFixture(t, { detached: true, reflectedStore: true })
    const before = operationRows(f.store)
    const result = await f.call(action)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.operation.durable, false, 'a normal primary miss must not discover a shadow journal')
    assert.equal(result.operation.durability, 'unavailable')
    assert.equal(f.effects[action], 1)
    assert.deepEqual(operationRows(f.store), before)
  })
  test('undefined journal retains never-journaled keyless ' + action, async t => {
    const f = controlJournalFixture(t, { initialPublication: 'undefined-journal' })
    const result = await f.call(action)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.operation.durable, false)
    assert.equal(result.operation.durability, 'unavailable')
    assert.equal(f.effects[action], 1)
    assert.equal(operationRows(f.store).length, 0)
  })
}

function envelopeKey(f, mode) {
  if (mode === 'no coordinates') f.events.length = 0
  return mode === 'explicit key' ? 'envelope-original-key' : undefined
}
function envelopeInput(action, key) {
  return { request_key: key, action, target_id: CHILD,
    payload_hash: createHash('sha256').update(JSON.stringify([action, CHILD,
      action === 'send' ? 'PRIVATE_CONTROL_MESSAGE' : null])).digest('hex') }
}
const ENVELOPE_AUTHORITY = { sessionId: RUN, runId: RUN, isRoot: true }
const BEGIN_REPLY_FAULTS = [
  ['undefined', () => undefined],
  ['null', () => null],
  ['promise', value => Promise.resolve(value)],
  ['decorated promise', value => Object.assign(Promise.resolve(value), value)],
  ['thenable', value => ({ ...value, then() { throw new Error('PRIVATE_METHOD_REPLY') } })],
  ['empty', () => ({})],
  ['missing operation id', value => ({ ...value, operation_id: undefined })],
  ['empty operation id', value => ({ ...value, operation_id: '' })],
  ['missing invoke', value => ({ ...value, invoke: undefined })],
  ['null invoke', value => ({ ...value, invoke: null })],
  ['string invoke', value => ({ ...value, invoke: 'true' })],
  ['numeric invoke', value => ({ ...value, invoke: 1 })],
  ['missing status', value => ({ ...value, status: undefined })],
  ['not durable', value => ({ ...value, durable: false })],
  ['new accepted', value => ({ ...value, status: 'accepted' })],
  ['new replayed', value => ({ ...value, replayed: true })],
  ['short replay', value => ({ ...value, invoke: false, replayed: true })],
]
const REPLAY_REPLY_FAULTS = [
  ['wrong caller', value => ({ ...value, caller_session: 'PRIVATE_REPLAY_CALLER' })],
  ['wrong action', value => ({ ...value, action: value.action === 'send' ? 'stop' : 'send' })],
  ['wrong target', value => ({ ...value, target_id: 'PRIVATE_REPLAY_TARGET' })],
  ['wrong run', value => ({ ...value, run_id: 'PRIVATE_REPLAY_RUN' })],
  ['missing row id', value => ({ ...value, id: undefined })],
  ['missing process', value => ({ ...value, process_instance: undefined })],
]
const FINISH_REPLY_FAULTS = [
  ['undefined', () => undefined],
  ['null', () => null],
  ['promise', value => Promise.resolve(value)],
  ['decorated promise', value => Object.assign(Promise.resolve(value), value)],
  ['thenable', value => ({ ...value, then() { throw new Error('PRIVATE_METHOD_REPLY') } })],
  ['empty', () => ({})],
  ['short intent', value => ({ operation_id: value.operation_id, invoke: true, replayed: false, durable: true, status: 'pending' })],
  ['wrong operation', value => ({ ...value, operation_id: 'PRIVATE_OTHER_OPERATION' })],
  ['wrong status', value => ({ ...value, status: 'unknown' })],
  ['wrong message', value => ({ ...value, message_id: 'PRIVATE_OTHER_MESSAGE' })],
  ['not durable', value => ({ ...value, durable: false })],
  ['missing row identity', value => ({ ...value, id: undefined })],
  ['wrong caller', value => ({ ...value, caller_session: 'PRIVATE_FINISH_CALLER' })],
  ['wrong target', value => ({ ...value, target_id: 'PRIVATE_FINISH_TARGET' })],
]
function assertUnknownEnvelope(result, key) {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, 'E_CONTROL_OUTCOME_UNKNOWN', JSON.stringify(result))
  assert.equal(result.operation.retry_key, key)
  assert.equal(result.operation.status, 'pending')
  assert.equal(result.operation.durable, true)
  assert.equal(typeof result.operation.operation_id, 'string')
  assert.match(result.hint, /不得换键|禁止.*新.*键/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_METHOD_REPLY|PRIVATE_OTHER_|PRIVATE_FINISH_/)
  for (const field of ['sent', 'stopped', 'delivery', 'execution']) assert.equal(Object.hasOwn(result, field), false)
}
function unfinishedReply(f, input) {
  return { ...f.store.recovery.inspect({}, RUN).operations.at(-1), status: input.status,
    message_id: input.message_id ?? null, ended_at: new Date().toISOString(),
    replayed: false, durable: true }
}

for (const action of ['send', 'stop']) {
  for (const mode of ['explicit key', 'trusted coordinates', 'no coordinates']) {
    for (const [fault, corrupt] of BEGIN_REPLY_FAULTS) {
      test('invalid begin ' + fault + ' blocks ' + action + ' with ' + mode, async t => {
        const f = controlJournalFixture(t), key = envelopeKey(f, mode), journal = f.store.recovery
        const begin = journal.beginControl.bind(journal)
        let actualKey
        journal.beginControl = (input, authority) => {
          actualKey = input.request_key
          return corrupt(begin(input, authority))
        }
        const denied = await f.call(action, key)
        assert.equal(f.effects[action], 0, 'malformed intent must never dispatch: ' + JSON.stringify(denied))
        assertJournalUnavailable(denied)
        assert.equal(denied.operation.retry_key, actualKey, 'even generated keys remain recoverable after a bad reply')
        assert.equal(Object.hasOwn(denied.operation, 'durable'), false, 'invalid reply cannot assert durable intent')
        assert.equal(Object.hasOwn(denied.operation, 'status'), false)
        const before = operationRows(f.store)
        assert.equal(before.length, 1)
        assert.equal(before[0].status, 'pending')
        journal.beginControl = begin
        const replay = await f.call(action, denied.operation.retry_key)
        assert.equal(replay.operation.replayed, true)
        assert.equal(replay.operation.status, 'pending')
        assert.equal(f.effects[action], 0)
        assert.deepEqual(operationRows(f.store), before)
      })
    }

    for (const [fault, corrupt] of FINISH_REPLY_FAULTS) {
      test('invalid finish ' + fault + ' keeps ' + action + ' unknown with ' + mode, async t => {
        const f = controlJournalFixture(t), key = envelopeKey(f, mode), journal = f.store.recovery
        const finish = journal.finishControl.bind(journal)
        journal.finishControl = input => corrupt(unfinishedReply(f, input))
        const denied = await f.call(action, key)
        const before = operationRows(f.store)
        assert.equal(before.length, 1)
        assert.equal(before[0].status, 'pending')
        assert.equal(f.effects[action], 1)
        assertUnknownEnvelope(denied, before[0].request_key)
        journal.finishControl = finish
        const replay = await f.call(action, denied.operation.retry_key)
        assert.equal(replay.operation.replayed, true)
        assert.equal(replay.operation.status, 'pending')
        assert.equal(f.effects[action], 1)
        assert.deepEqual(operationRows(f.store), before)
      })
    }

    test('real short intent and accepted replay remain valid for ' + action + ' with ' + mode, async t => {
      const f = controlJournalFixture(t), key = envelopeKey(f, mode)
      const first = await f.call(action, key)
      assert.equal(first.ok, true, JSON.stringify(first))
      assert.equal(first.operation.durable, true)
      assert.equal(first.operation.status, 'accepted')
      const before = operationRows(f.store)
      const replay = await f.call(action, first.operation.retry_key)
      assert.equal(replay.ok, true, JSON.stringify(replay))
      assert.equal(replay.operation.replayed, true)
      assert.equal(replay.operation.invoke, false)
      assert.equal(replay.operation.operation_id, first.operation.operation_id)
      assert.equal(f.effects[action], 1)
      assert.deepEqual(operationRows(f.store), before)
    })

    test('real pending replay remains read-only for ' + action + ' with ' + mode, async t => {
      const f = controlJournalFixture(t), key = envelopeKey(f, mode)
      pendingControl(f)
      const first = await f.call(action, key)
      assert.equal(first.code, 'E_CONTROL_OUTCOME_UNKNOWN')
      const before = operationRows(f.store)
      const replay = await f.call(action, first.operation.retry_key)
      assert.equal(replay.operation.status, 'pending')
      assert.equal(replay.operation.replayed, true)
      assert.equal(replay.operation.invoke, false)
      assert.equal(f.effects[action], 1)
      assert.deepEqual(operationRows(f.store), before)
    })
  }

  for (const [fault, corrupt] of REPLAY_REPLY_FAULTS) {
    test('invalid replay ' + fault + ' is refused for ' + action, async t => {
      const f = controlJournalFixture(t), journal = f.store.recovery, key = 'replay-original-key'
      journal.beginControl(envelopeInput(action, key), ENVELOPE_AUTHORITY)
      const before = operationRows(f.store), begin = journal.beginControl.bind(journal)
      journal.beginControl = (input, authority) => corrupt(begin(input, authority))
      const denied = await f.call(action, key)
      assertJournalUnavailable(denied)
      assert.equal(denied.operation.retry_key, key)
      assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_REPLAY_/)
      assert.equal(f.effects[action], 0)
      assert.deepEqual(operationRows(f.store), before)
    })
  }

  for (const status of ['pending', 'accepted', 'rejected', 'unknown']) {
    test('real ' + status + ' full replay remains valid for ' + action, async t => {
      const f = controlJournalFixture(t), journal = f.store.recovery, key = 'real-replay-' + status
      const intent = journal.beginControl(envelopeInput(action, key), ENVELOPE_AUTHORITY)
      assert.deepEqual(Object.keys(intent).sort(), ['durable', 'invoke', 'operation_id', 'replayed', 'status'])
      if (status !== 'pending') {
        journal.finishControl({ operation_id: intent.operation_id, status }, ENVELOPE_AUTHORITY)
      }
      const before = operationRows(f.store)
      const replay = await f.call(action, key)
      assert.equal(replay.ok, status === 'accepted', JSON.stringify(replay))
      assert.equal(replay.operation.durable, true)
      assert.equal(replay.operation.status, status)
      assert.equal(replay.operation.replayed, true)
      assert.equal(replay.operation.invoke, false)
      assert.equal(replay.operation.caller_session, RUN)
      assert.equal(replay.operation.action, action)
      assert.equal(replay.operation.target_id, CHILD)
      assert.equal(f.effects[action], 0)
      assert.deepEqual(operationRows(f.store), before)
    })
  }

  for (const [fault, corrupt] of FINISH_REPLY_FAULTS.filter(([name]) => ['undefined', 'promise'].includes(name))) {
    test('committed outcome with invalid finish ' + fault + ' retains ' + action + ' original key', async t => {
      const f = controlJournalFixture(t), journal = f.store.recovery
      const finish = journal.finishControl.bind(journal)
      journal.finishControl = (input, authority) => corrupt(finish(input, authority))
      const result = await f.call(action)
      const before = operationRows(f.store)
      assert.equal(before[0].status, 'accepted', 'journal can commit before its malformed reply')
      assertUnknownEnvelope(result, before[0].request_key)
      assert.equal(f.effects[action], 1)
      journal.finishControl = finish
      const replay = await f.call(action, result.operation.retry_key)
      assert.equal(replay.ok, true, JSON.stringify(replay))
      assert.equal(replay.operation.replayed, true)
      assert.equal(replay.operation.status, 'accepted')
      assert.equal(f.effects[action], 1)
      assert.deepEqual(operationRows(f.store), before)
    })
    test('host exception and invalid finish ' + fault + ' preserve ' + action + ' unknown intent', async t => {
      const f = controlJournalFixture(t), journal = f.store.recovery
      const effect = () => { f.effects[action]++; throw Object.assign(new Error('host ambiguous effect'), { code: 'E_STORE_BUSY' }) }
      if (action === 'send') f.subagents.sendMessage = effect
      else f.subagents.interrupt = effect
      journal.finishControl = input => corrupt(unfinishedReply(f, input))
      const result = await f.call(action)
      const before = operationRows(f.store)
      assertUnknownEnvelope(result, before[0].request_key)
      assert.equal(f.effects[action], 1)
      const replay = await f.call(action, result.operation.retry_key)
      assert.equal(replay.operation.replayed, true)
      assert.equal(replay.operation.status, 'pending')
      assert.equal(f.effects[action], 1)
      assert.deepEqual(operationRows(f.store), before)
    })
  }

  test('real immutable finish replay is valid for ' + action, async t => {
    const f = controlJournalFixture(t), journal = f.store.recovery, finish = journal.finishControl.bind(journal)
    journal.finishControl = (input, authority) => {
      finish(input, authority)
      return finish(input, authority)
    }
    const result = await f.call(action, 'finish-replay-key')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.operation.durable, true)
    assert.equal(result.operation.replayed, true)
    assert.equal(f.effects[action], 1)
  })

  test('real unattributed direct-caller envelope remains valid for ' + action, async t => {
    const f = controlJournalFixture(t)
    Object.assign(f.agent.session.header, { origin: 'subagent', delegationDepth: 2, parentSession: 'missing-parent' })
    const first = await f.call(action, 'unattributed-key')
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.operation.run_id, null)
    const replay = await f.call(action, first.operation.retry_key)
    assert.equal(replay.operation.replayed, true)
    assert.equal(replay.operation.run_id, null)
    assert.equal(f.effects[action], 1)
  })
}

for (const action of ['send', 'stop']) {
  for (const phase of ['begin', 'finish']) {
    for (const realm of ['native', 'cross realm']) {
      test('rejected ' + realm + ' promise from ' + phase + ' does not crash ' + action, () => {
        const source = [
          'import { apply as applyTools } from ' + JSON.stringify(new URL('../../lib/tools/index.js', import.meta.url).href),
          'import { tempStore } from ' + JSON.stringify(new URL('./helpers.mjs', import.meta.url).href),
          "import { runInNewContext } from 'node:vm'",
          'const action = ' + JSON.stringify(action),
          'const phase = ' + JSON.stringify(phase),
          'const realm = ' + JSON.stringify(realm),
          'const cleanups = []; const store = tempStore({ after(fn) { cleanups.push(fn) } })',
          "const agent = { id: 'async-root', session: { header: { id: 'async-root' }, events: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } }] } }",
          'const definitions = new Map(); let effects = 0',
          "const subagents = { async listChildren() { return [{ id: 'async-child', mode: 'continuable', createdAt: 0 }] }, async sendMessage() { effects++; return 'async-message' }, interrupt() { effects++ } }",
          "applyTools({ logger: { warn() {} }, get(name) { if (name === 'taskforceStore') return store; if (name === 'agents') return { get: id => id === agent.id ? agent : undefined }; if (name === 'subagents') return subagents }, tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } })",
          "const rejected = () => realm === 'cross realm' ? runInNewContext(\"Promise.reject(new Error('PRIVATE_ASYNC_REPLY'))\") : Promise.reject(new Error('PRIVATE_ASYNC_REPLY'))",
          "if (phase === 'begin') { const begin = store.recovery.beginControl.bind(store.recovery); store.recovery.beginControl = (input, authority) => { begin(input, authority); return rejected() } } else { store.recovery.finishControl = () => rejected() }",
          "const result = JSON.parse(await definitions.get('task_child_' + action).execute({ target_id: 'async-child', ...(action === 'send' ? { message: 'async probe' } : {}) }, { agent, callId: 'async-call', rootCallId: 'async-root-call', signal: new AbortController().signal }))",
          'await new Promise(resolve => setImmediate(resolve))',
          "const row = store.open().prepare('SELECT * FROM control_operation').get()",
          "process.stdout.write(JSON.stringify({ result, effects, status: row.status, key: row.request_key }))",
          'for (const cleanup of cleanups.reverse()) await cleanup()',
        ].join('\n')
        const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', source],
          { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })
        assert.equal(child.status, 0, 'a rejected journal promise must be consumed without process failure: ' + child.stderr)
        assert.equal(child.signal, null)
        const { result, effects, status, key } = JSON.parse(child.stdout)
        assert.equal(effects, phase === 'begin' ? 0 : 1)
        assert.equal(status, 'pending')
        assert.equal(result.operation.retry_key, key)
        if (phase === 'begin') {
          assertJournalUnavailable(result)
          assert.equal(Object.hasOwn(result.operation, 'durable'), false)
        } else assertUnknownEnvelope(result, key)
        assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_ASYNC_REPLY/)
      })
    }
  }
}
