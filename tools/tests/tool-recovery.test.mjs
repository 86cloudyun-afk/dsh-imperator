import assert from 'node:assert/strict'
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
function controlJournalFixture(t, { detached = false, unreadableStore = false, malformedJournal = false } = {}) {
  const store = tempStore(t)
  let published = detached ? undefined : malformedJournal ? { recovery: {} } : store
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
    store, effects, events,
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
