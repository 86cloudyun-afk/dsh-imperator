import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as applyTools } from '../../lib/tools/index.js'
import { STORE_CODES } from '../../lib/store/index.js'
import { tempStore } from './helpers.mjs'

/**
 * **提交/结任务的审计署名改用真实调用者（audit attribution only）**。
 *
 * 本文件**不测试任何权限闸门** —— 提交路径（`submitTask`，含 `task_close(done|partial)`
 * 别名）**没有** owner 权限判定：`caller` 只用于把「提交验收」事实的 `created_by`
 * 写成真实调用者。同 run 的竞争方仍可提交他人 `claimed` 任务（非终态，可由主会话
 * `task_reject` 打回）。
 *
 * **为什么闸门不可实现**（负结果，记于 `docs/STORE.md` §九）：按 `#39` 取消闸门的同款
 * 设计实现后，`verify-store-v2.mjs` 的 **C09 / C10 / C12 三条核心用例 FAIL** ——
 * `task_claim` 的 `child_id` 是自由标签（C09 用代号 `'child-1'` 认领、却以真实 sessionId
 * 调用 `task_submit`），数据层无法把「调用者 sessionId」与「owner 标签」对应 ⇒
 * 闸门会误杀合法提交。可靠实现需要给 `task` 表加 `owner_session` 列（表迁移），留作后续立项。
 *
 * 本文件锁定的只是**署名**，外加三条**既有契约不许回退**（它们是刻意设计，不是漏洞）：
 *   ① `open`（无认领者）任务任何同 run 调用者都可提交 —— 既有语义明写"允许从
 *      `open`（未认领就交）提交"，并会给"没有认领者就直接提交"的 warning；
 *   ② `submitted` 上的重复提交幂等（`already:true`），横跨 owner / lead / 非 owner 三种 caller；
 *   ③ `rejected` 仍须先 `task_claim`（`E_STATUS`）。
 */
const RUN = 'run-a'
const lead = { id: RUN, options: {}, session: { header: { id: RUN } } }
const childOf = (id) => ({
  id,
  options: {},
  session: { header: { id, origin: 'subagent', delegationDepth: 1, parentSession: RUN } },
})

function toolCaller(store) {
  const definitions = []
  applyTools({
    logger: { warn() {} },
    get(name) {
      if (name === 'taskforceStore') return store
      if (name === 'agents') return { get: (id) => (id === RUN ? lead : undefined) }
    },
    tools: { register: (definition) => definitions.push(definition) },
  })
  return async (name, args, agent = lead) =>
    JSON.parse(await definitions.find((definition) => definition.name === name).execute(args, { agent }))
}

const snapshot = (store, id) => ({
  task: store.taskOf({ task_id: id }, RUN).task,
  facts: store.handle.prepare('SELECT * FROM fact WHERE task_id = ? ORDER BY id').all(id),
  handoffs: store.handle.prepare('SELECT * FROM handoff WHERE task_id = ? ORDER BY id').all(id),
})

test('提交审计的署名反映真实调用者（owner 自己 / 主会话代交）', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)

  const ownId = store.openTask({ title: '自己交' }, RUN).task_id
  store.claimTask({ task_id: ownId, child_id: 'worker-a' }, RUN)
  const okOwn = await call('task_submit', { task_id: ownId, note: '自己交' }, childOf('worker-a'))
  assert.equal(okOwn.ok, true)
  assert.equal(okOwn.status, 'submitted')
  const ownFact = store.handle
    .prepare("SELECT * FROM fact WHERE task_id = ? AND statement = ?").get(ownId, '提交验收：自己交')
  assert.equal(ownFact.created_by, 'worker-a')

  const leadId = store.openTask({ title: '主会话代交' }, RUN).task_id
  store.claimTask({ task_id: leadId, child_id: 'worker-c' }, RUN)
  const okLead = await call('task_submit', { task_id: leadId, note: '主会话代交' }, lead)
  assert.equal(okLead.ok, true)
  assert.equal(okLead.status, 'submitted')
  const leadFact = store.handle
    .prepare("SELECT * FROM fact WHERE task_id = ? AND statement = ?").get(leadId, '提交验收：主会话代交')
  assert.equal(leadFact.created_by, 'lead', '主会话代交不得被记成原 owner 自己提交')
})

test('submitted 上的幂等重试不回退（横跨 owner / 主会话 / 非 owner 三种 caller）', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '幂等' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  assert.equal((await call('task_submit', { task_id: id }, childOf('worker-a'))).status, 'submitted')

  const before = snapshot(store, id)
  for (const [agent, label] of [[childOf('worker-a'), 'owner'], [lead, 'lead'], [childOf('worker-b'), '非 owner']]) {
    const retry = await call('task_submit', { task_id: id, note: '重复说明不得落库' }, agent)
    assert.equal(retry.ok, true, `${label} 的幂等重试仍须成功`)
    assert.equal(retry.status, 'submitted')
    assert.equal(retry.already, true)
  }
  assert.deepEqual(snapshot(store, id), before, '幂等重试不得产生任何写入')
})

test('open（尚无认领者）任务仍可被任何同 run 调用者提交 —— 刻意的宽路径不回退', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '未认领就交' }, RUN).task_id
  const submitted = await call('task_submit', { task_id: id }, childOf('worker-z'))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.status, 'submitted')
  assert.ok(
    submitted.warnings.some((w) => w.includes('没有认领者')),
    '既有契约：无认领者直接提交仍须给出 warning',
  )
})

test('rejected 仍须先 task_claim（E_STATUS）—— 既有语义不回退', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '被打回' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  store.recordFact({ task_id: id, kind: 'fact', statement: '证据', confidence: 'CONFIRMED' }, RUN)
  store.submitTask({ task_id: id }, RUN)
  store.rejectTask({ task_id: id, reason: '缺行号' }, RUN, 'lead')

  const denied = await call('task_submit', { task_id: id }, childOf('worker-a'))
  assert.equal(denied.ok, false)
  assert.equal(denied.code, STORE_CODES.status, 'rejected 仍走 E_STATUS（提交路径本就没有 owner 闸门，不该冒出 E_TASK_CONFLICT）')
})

// ── 以下三条补齐 #40 复审（6001031129）指出的署名覆盖盲区 ──
// 复审原文：「新增测试仅覆盖直接 task_submit 的 owner 和主会话场景，未覆盖
// 「非 owner 带备注提交」及 task_close(done|partial) 两条署名路径」。

test('非 owner 带备注提交他人 claimed 任务：允许提交，署名记真实调用者（不是原 owner）', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '他人代交' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)

  // 提交路径没有 owner 闸门（负结果见文件头与 docs/STORE.md §九）：非 owner 的提交被接受。
  // 本测试锁的是**署名** —— 必须写成真实调用者，而不是被误记成任务原 owner。
  const submitted = await call('task_submit', { task_id: id, note: '替他人提交' }, childOf('worker-b'))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.status, 'submitted')

  const fact = store.handle
    .prepare('SELECT * FROM fact WHERE task_id = ? AND statement = ?').get(id, '提交验收：替他人提交')
  assert.ok(fact !== undefined, '带备注的提交必须写「提交验收」审计事实')
  assert.equal(fact.created_by, 'worker-b', '署名必须是真实调用者 worker-b')
  assert.notEqual(fact.created_by, 'worker-a', '不得被误记成任务原 owner')
  assert.equal(fact.kind, 'decision')
  assert.equal(store.taskOf({ task_id: id }, RUN).task.owner, 'worker-a', 'owner 不因他人提交而改变')
})

test('task_close(done|partial) 别名路径的署名同样反映真实调用者', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)

  // 三条组合：owner 自己走 done、非 owner 走 partial、主会话走 done。
  for (const [result, agent, expected] of [
    ['done', childOf('worker-a'), 'worker-a'],
    ['partial', childOf('worker-b'), 'worker-b'],
    ['done', lead, 'lead'],
  ]) {
    const id = store.openTask({ title: `别名 ${result} ${expected}` }, RUN).task_id
    store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
    const note = `别名提交-${result}-${expected}`

    const closed = await call('task_close', { task_id: id, result, note }, agent)
    assert.equal(closed.ok, true)
    assert.equal(closed.status, 'submitted')
    assert.equal(closed.alias_of, 'submitTask', 'done/partial 必须自称 submit 别名')

    const fact = store.handle
      .prepare('SELECT * FROM fact WHERE task_id = ? AND statement = ?').get(id, `提交验收：${note}`)
    assert.ok(fact !== undefined, '别名路径同样必须写「提交验收」审计事实')
    assert.equal(fact.created_by, expected, `${result} 由 ${expected} 调用时署名应为 ${expected}`)
  }
})

test('note 为空（含空串与纯空白）时不写「提交验收」审计事实', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const submitFacts = (id) => store.handle
    .prepare("SELECT COUNT(*) AS n FROM fact WHERE task_id = ? AND statement LIKE '提交验收：%'").get(id).n

  // 依据 lib/store/index.js 的 `if (note !== null)` + optionalText：空串/纯空白归一为 null ⇒ 不落审计。
  for (const note of [undefined, '', '   ']) {
    const id = store.openTask({ title: `无备注 ${JSON.stringify(note)}` }, RUN).task_id
    store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
    const args = note === undefined ? { task_id: id } : { task_id: id, note }

    const submitted = await call('task_submit', args, childOf('worker-a'))
    assert.equal(submitted.ok, true)
    assert.equal(submitted.status, 'submitted')
    assert.equal(submitFacts(id), 0, `note=${JSON.stringify(note)} 时不得写「提交验收」事实`)
  }
})
