import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as applyTools } from '../../lib/tools/index.js'
import { STORE_CODES } from '../../lib/store/index.js'
import { tempStore } from './helpers.mjs'

/**
 * `#39` 给 `closeTask(failed)` 加了 owner 取消闸门，但**提交路径**
 * （`submitTask`，含 `task_close(done|partial)` 别名）当时刻意未动 ——
 * `docs/STORE.md` §九 明记：「同 run 的竞争方仍可把别人的 `claimed` 任务推到
 * `submitted`（**不是**终态，可由主会话 `task_reject` 打回），破坏性远低于取消；
 * 本版刻意不动它以避免行为回退，留作后续单独立项。」
 *
 * 本测试就是那条"单独立项"：把提交路径的越权推进也关掉，同时**必须**保住三条
 * 既有契约（它们是刻意设计，不是漏洞）：
 *   ① `open`（无认领者）任务任何同 run 调用者都可提交 —— 既有语义明写"允许从
 *      `open`（未认领就交）提交"，并会给"没有认领者就直接提交"的 warning；
 *   ② `submitted` 上的重复提交幂等（`already:true`）—— 新闸门放在幂等分支之后，
 *      重试不受影响；
 *   ③ `rejected` 仍须先 `task_claim`（`E_STATUS`）。
 *
 * 与取消闸门（`requireCancelAuthority`）的差别：提交**不是**终态、破坏性更低，
 * 所以放行集合多一条"任务尚无认领者"。两条闸门共用同一身份来源与失败方向。
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

test('owner 本人与主会话仍可提交，且提交审计的署名反映真实调用者', async (t) => {
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

test('rejected 仍须先 task_claim（E_STATUS），不被新闸门改写语义', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '被打回' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  store.recordFact({ task_id: id, kind: 'fact', statement: '证据', confidence: 'CONFIRMED' }, RUN)
  store.submitTask({ task_id: id }, RUN)
  store.rejectTask({ task_id: id, reason: '缺行号' }, RUN, 'lead')

  const denied = await call('task_submit', { task_id: id }, childOf('worker-a'))
  assert.equal(denied.ok, false)
  assert.equal(denied.code, STORE_CODES.status, 'rejected 仍走 E_STATUS，而不是 owner 闸门的 E_TASK_CONFLICT')
})
