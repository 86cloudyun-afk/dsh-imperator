import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { apply as applyTools } from '../../lib/tools/index.js'
import { seedSubmitted, tempStore } from './helpers.mjs'

/**
 * #26 把 submit-on-rejected 改成 refuse(E_STATUS) 后，模型侧 HINT_STATUS 与
 * 状态机文档表仍写着「submit 在 rejected 可用」——与 submitTask 实现相反，
 * 会诱导模型在打回后跳过 task_claim 直接重提。#29 的「只在 open / claimed」
 * 又漏掉 submitted 幂等重试。检查真实 E_STATUS 返回的指路与状态表。
 */
const storeSrc = readFileSync(fileURLToPath(new URL('../../lib/store/index.js', import.meta.url)), 'utf8')
const docsSrc = readFileSync(fileURLToPath(new URL('../../docs/STORE.md', import.meta.url)), 'utf8')

function toolCaller(store) {
  const lead = { id: 'run-a', options: {}, session: { header: { id: 'run-a' } } }
  const other = { id: 'run-b', options: {}, session: { header: { id: 'run-b' } } }
  const child = { id: 'child-a', options: {}, session: { header: { id: 'child-a', origin: 'subagent',
    delegationDepth: 1, parentSession: 'run-a' } } }
  const definitions = []
  applyTools({ logger: { warn() {} }, get(name) {
    if (name === 'taskforceStore') return store
    if (name === 'agents') return { get: id => id === 'run-a' ? lead : undefined }
  }, tools: { register: definition => definitions.push(definition) } })
  return { lead, other, child, call: async (name, args, agent = lead) =>
    JSON.parse(await definitions.find(tool => tool.name === name).execute(args, { agent })) }
}

test('E_STATUS hint distinguishes claim/submit transitions and their measured retry contracts', async (t) => {
  const store = tempStore(t)
  const task_id = seedSubmitted(store, 'run-a')
  const { call } = toolCaller(store)
  const result = await call('task_claim', { task_id, child_id: 'child-a' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_STATUS')
  assert.doesNotMatch(result.hint, /claim 只在 open \/ rejected 可用/)
  assert.match(result.hint, /claim 将 open \/ rejected 转为 claimed/)
  assert.match(result.hint, /claimed 上同 owner 重复 claim 可用（already:true）/)
  assert.match(result.hint, /owner、状态、facts、handoffs 保持不变/)
  assert.match(result.hint, /库中 updated_at 刷新，返回的 claimed_at 同步刷新/)
  assert.match(result.hint, /claimed 上不同 owner 仍会冲突/)
  assert.doesNotMatch(result.hint, /submit (只在 open \/ claimed|在 open \/ claimed \/ rejected) 可用/)
  assert.match(result.hint, /submit 将 open \/ claimed 转为 submitted/)
  assert.match(result.hint, /submitted 上重复 submit 幂等成功（already:true/)
  assert.match(result.hint, /不改状态或记录新 note/)
  assert.match(result.hint, /rejected 须先 task_claim/)
  assert.match(result.hint, /close\(done\/partial\) 同 submit/)
  assert.match(result.hint, /close\(failed\) 单独取消为 cancelled/)
  // rejectTask is dual-use: submitted→打回 AND terminal→显式重新复核. Conflating
  // "accept / reject 只在 submitted" steers models away from task_reject on closed tasks.
  assert.doesNotMatch(result.hint, /accept \/ reject 只在 submitted 可用/)
  assert.match(result.hint, /accept 只在 submitted 可用/)
  assert.match(result.hint, /reject 在 submitted（打回）或终态（显式重新复核）可用/)
  assert.match(result.hint, /身份、当前 run 与参数检查/)
})

function claimedTask(store) {
  const task_id = store.openTask({ title: '重复认领', note: '原始任务说明' }, 'run-a').task_id
  const claimed = store.claimTask({ task_id, child_id: 'child-a' }, 'run-a')
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.already, false)
  store.recordFact({ task_id, kind: 'fact', statement: '已有证据', child_id: 'child-a' }, 'run-a')
  // Earlier deterministic time makes the existing refresh observable even in one millisecond.
  store.handle.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', task_id)
  return task_id
}

const claimSnapshot = (store, task_id) => ({
  task: store.taskOf(task_id, 'run-a').task,
  facts: store.handle.prepare('SELECT * FROM fact WHERE task_id = ? ORDER BY id').all(task_id),
  handoffs: store.handle.prepare('SELECT * FROM handoff WHERE task_id = ? ORDER BY id').all(task_id),
})

test('same-owner claimed retries preserve owner/state/audit and refresh updated_at/claimed_at', async (t) => {
  const store = tempStore(t)
  const { call, child } = toolCaller(store)
  for (const surface of ['store', 'tool']) {
    const task_id = claimedTask(store)
    const before = claimSnapshot(store, task_id)
    assert.equal(before.task.updated_at, '2026-01-01T00:00:00.000Z')
    const retry = surface === 'store'
      ? store.claimTask({ task_id, child_id: 'child-a' }, 'run-a')
      : await call('task_claim', { task_id, child_id: 'child-a' }, child)
    const after = claimSnapshot(store, task_id)
    assert.equal(retry.already, true)
    assert.equal(retry.owner, 'child-a')
    assert.equal(retry.status, 'claimed')
    const { updated_at: beforeTime, ...beforeTask } = before.task
    const { updated_at: afterTime, ...afterTask } = after.task
    assert.notEqual(afterTime, beforeTime)
    assert.equal(retry.claimed_at, afterTime)
    // Exactly the stored update timestamp may change; all other task/audit data must stay equal.
    assert.deepEqual(afterTask, beforeTask)
    assert.deepEqual(after.facts, before.facts)
    assert.deepEqual(after.handoffs, before.handoffs)
  }
})

test('claim retries retain ownership, identity/run guards and the submitted status boundary', async (t) => {
  const store = tempStore(t)
  const task_id = claimedTask(store)
  const { call, lead, other, child } = toolCaller(store)
  const before = claimSnapshot(store, task_id)
  assert.throws(() => store.claimTask({ task_id, child_id: 'child-b' }, 'run-a', 'lead'),
    { code: 'E_TASK_CONFLICT' })
  assert.throws(() => store.claimTask({ task_id, child_id: 'child-a' }, 'run-b'), { code: 'E_CROSS_RUN' })
  assert.deepEqual(claimSnapshot(store, task_id), before)
  for (const [args, agent, code] of [
    [{ task_id, child_id: 'child-b', actor: 'lead' }, lead, 'E_TASK_CONFLICT'],
    [{ task_id, child_id: 'child-a' }, other, 'E_CROSS_RUN'],
    [{ task_id, child_id: 'child-a' }, null, 'E_NO_AGENT'],
  ]) {
    const denied = await call('task_claim', args, agent)
    assert.equal(denied.ok, false)
    assert.equal(denied.code, code)
    assert.deepEqual(claimSnapshot(store, task_id), before)
  }
  const retry = await call('task_claim', { task_id, child_id: 'child-a' }, child)
  assert.equal(retry.ok, true)
  assert.equal(retry.already, true)
  assert.notEqual(store.taskOf(task_id, 'run-a').task.updated_at, before.task.updated_at)
  store.submitTask({ task_id }, 'run-a')
  const submitted = claimSnapshot(store, task_id)
  assert.throws(() => store.claimTask({ task_id, child_id: 'child-a' }, 'run-a'), { code: 'E_STATUS' })
  const denied = await call('task_claim', { task_id, child_id: 'child-a' }, child)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'E_STATUS')
  assert.deepEqual(claimSnapshot(store, task_id), submitted)
  store.rejectTask({ task_id, reason: '补证据' }, 'run-a', 'lead')
  const rework = await call('task_claim', { task_id, child_id: 'child-a' }, child)
  assert.equal(rework.status, 'claimed')
  assert.equal(rework.owner, 'child-a')
  assert.equal(rework.already, false)
})

test('submitted tool retries require valid identity, current run and parameters before success', async (t) => {
  const store = tempStore(t)
  const task_id = seedSubmitted(store, 'run-a')
  const { call, other, child } = toolCaller(store)
  const before = store.board({ task_id }, 'run-a')
  for (const [name, extra] of [
    ['task_submit', {}], ['task_close', { result: 'done' }], ['task_close', { result: 'partial' }],
  ]) {
    const args = { task_id, note: '重复调用不得新增说明', ...extra }
    for (const [agent, code] of [[other, 'E_CROSS_RUN'], [null, 'E_NO_AGENT']]) {
      const denied = await call(name, args, agent)
      assert.equal(denied.ok, false)
      assert.equal(denied.code, code)
      assert.deepEqual(store.board({ task_id }, 'run-a'), before)
    }
    const invalid = await call(name, { ...args, task_id: 0 }, child)
    assert.equal(invalid.ok, false)
    assert.match(invalid.error, /task_id/)
    assert.deepEqual(store.board({ task_id }, 'run-a'), before)
    const retry = await call(name, args, child)
    assert.equal(retry.ok, true)
    assert.equal(retry.status, 'submitted')
    assert.equal(retry.already, true)
    assert.deepEqual(store.board({ task_id }, 'run-a'), before)
  }
  const invalidResult = await call('task_close', { task_id, result: 'invalid' }, child)
  assert.equal(invalidResult.ok, false)
  assert.match(invalidResult.error, /result/)
  assert.deepEqual(store.board({ task_id }, 'run-a'), before)
})

test('store 头注释与 docs/STORE.md 的 rejected 行与 submitTask 实现一致（须先 claim）', () => {
  const stale = /\| `rejected` \| ✓ \| ✓ \| ✓ \| ✓ → submitted \|/
  assert.doesNotMatch(storeSrc, stale, 'lib/store/index.js 头表仍写 rejected → submit 直接可用')
  assert.doesNotMatch(docsSrc, stale, 'docs/STORE.md 状态表仍写 rejected → submit 直接可用')
  assert.match(storeSrc, /\| `rejected` \| ✓ \| ✓ \| ✓ \| ✗ `E_STATUS`（须先 claim） \|/)
  assert.match(docsSrc, /\| `rejected` \| ✓ \| ✓ \| ✓ \| ✗ `E_STATUS`（须先 claim） \|/)
})

const toolsSrc = readFileSync(fileURLToPath(new URL('../../lib/tools/index.js', import.meta.url)), 'utf8')

/** Extract a TOOL_SPECS description string for one tool (concatenated adjacent literals). */
function toolSpecDescription(src, name) {
  const start = src.indexOf(`  ${name}: {`)
  assert.ok(start >= 0, `TOOL_SPECS entry ${name} missing`)
  const params = src.indexOf('    parameters:', start)
  assert.ok(params > start, `${name}: parameters block missing`)
  const chunk = src.slice(start, params)
  const parts = [...chunk.matchAll(/'((?:\\'|[^'])*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
  assert.ok(parts.length > 0, `${name}: no description literals`)
  return parts.join('')
}

test('TOOL_SPECS.task_claim/task_submit descriptions match #30 measured retry contracts', () => {
  const claim = toolSpecDescription(toolsSrc, 'task_claim')
  const submit = toolSpecDescription(toolsSrc, 'task_submit')
  // Stale pre-#30 claim wording omitted same-owner claimed retry and would steer models away from idempotent reclaims.
  assert.doesNotMatch(claim, /只能认领\*\*当前工作实例\*\*内、状态为 open 或 rejected 的任务/)
  assert.match(claim, /open \/ rejected → claimed/)
  assert.match(claim, /同 owner.*already:true/)
  assert.match(claim, /不同 owner.*冲突/)
  assert.match(claim, /updated_at.*claimed_at/)
  assert.match(submit, /open \/ claimed → submitted/)
  assert.match(submit, /submitted 上重复提交幂等（already:true/)
  assert.match(submit, /rejected 不可直接提交/)
  assert.match(submit, /须先 task_claim/)
})

test('TOOL_SPECS.task_close description inherits submit retry contract for done/partial', () => {
  const close = toolSpecDescription(toolsSrc, 'task_close')
  // close(done/partial) delegates to submitTask; stale wording only said "等价于 task_submit"
  // without naming rejected→E_STATUS or submitted idempotency, which steers models the same way #31 fixed for task_submit.
  assert.match(close, /open \/ claimed → submitted/)
  assert.match(close, /submitted 上重复调用幂等（already:true/)
  assert.match(close, /rejected 上 close\(done\/partial\) 不可直提/)
  assert.match(close, /须先 task_claim/)
  assert.match(close, /failed.*cancelled/)
  assert.match(close, /E_TERMINAL/)
  assert.match(docsSrc, /`task_close`.*`rejected` 须先 claim/)
  assert.match(docsSrc, /`task_submit`.*`rejected` 不可直提/)
})

test('HINT_STATUS separates accept(submitted-only) from reject(submitted-or-terminal reopen)', () => {
  // Mirrors rejectTask: submitted → 打回; TERMINAL_STATUSES → 显式重新复核.
  assert.doesNotMatch(toolsSrc, /accept \/ reject 只在 submitted 可用/)
  assert.match(toolsSrc, /accept 只在 submitted 可用；reject 在 submitted（打回）或终态（显式重新复核）可用/)
})

