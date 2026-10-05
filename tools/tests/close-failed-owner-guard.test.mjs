import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as applyTools } from '../../lib/tools/index.js'
import { STORE_CODES } from '../../lib/store/index.js'
import { tempStore } from './helpers.mjs'

/**
 * `#36` 以原始 head 合并后，`claimed` 冲突指引把 `task_close(failed)` 写成了
 * **竞争子代理可执行**的动作（"或 task_close(failed) 放弃后开新任务"）。而
 * `closeTask` 的 `failed` 分支只校验 run，没有 owner 校验，写审计时又无条件用
 * `created_by: row.owner` —— 组合结果是：同一 run 内任意调用者都能把**别人**
 * `claimed` 的任务改成终态 `cancelled`，审计还会归咎于原 owner。
 *
 * 本测试锁定两层修复：
 *   ① 指引不再向竞争方推荐取消动作（文案层，去掉诱导）；
 *   ② `closeTask(failed)` 增加 owner 闸门（行为层，治本）——主会话或 owner 本人
 *      才可取消，其余一律 `E_TASK_CONFLICT` 拒绝且不产生任何写入；
 *   ③ `E_TASK_CONFLICT` 的内联 `hint` 必须按状态分流透出（`#36` 的 P2）。
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

const cancelFact = (store, id, note) => store.handle
  .prepare("SELECT * FROM fact WHERE task_id = ? AND statement = ?").get(id, `取消任务：${note}`)

test('竞争子代理不能取消他人 claimed 任务：被拒且状态与审计零变化', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '被 worker-a 认领' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  const before = snapshot(store, id)

  const denied = await call('task_close', { task_id: id, result: 'failed', note: '抢着取消' }, childOf('worker-b'))
  assert.equal(denied.ok, false)
  assert.equal(denied.code, STORE_CODES.conflict)
  assert.match(denied.error, /worker-a/, '错误里要指名当前 owner')
  assert.deepEqual(snapshot(store, id), before, '被拒后任务状态、事实与交接都必须一字未改')
  assert.equal(store.taskOf({ task_id: id }, RUN).task.status, 'claimed')
})

test('claimed 冲突指引不再向竞争方推荐 task_close(failed)', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '冲突文案' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)

  const conflict = await call('task_claim', { task_id: id, child_id: 'worker-b' }, childOf('worker-b'))
  assert.equal(conflict.code, STORE_CODES.conflict)
  assert.doesNotMatch(conflict.error, /task_close\(failed\)/, '错误正文不得再推荐取消他人任务')
  assert.doesNotMatch(conflict.hint, /task_close\(failed\)/, 'hint 同样不得推荐')
  assert.match(conflict.hint, /task_submit/, 'claimed 的正确出路是等认领者提交后由主会话驳回')
})

test('E_TASK_CONFLICT 的 hint 按状态分流透出，不再落通用兜底文案', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: 'hint 分流' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)

  const conflict = await call('task_claim', { task_id: id, child_id: 'worker-b' }, childOf('worker-b'))
  assert.match(conflict.hint, /claimed/)
  assert.doesNotMatch(conflict.hint, /不要盲目重试认领/, '通用 HINT_TASK_CONFLICT 说明内联 hint 没透出')
  assert.match(conflict.hint, /task_board/, '既有契约：hint 必须仍指向读板')
})

test('owner 本人与主会话仍可取消，且审计 created_by 反映真实调用者', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)

  const ownId = store.openTask({ title: '自己取消' }, RUN).task_id
  store.claimTask({ task_id: ownId, child_id: 'worker-a' }, RUN)
  const okOwn = await call('task_close', { task_id: ownId, result: 'failed', note: '自己放弃' }, childOf('worker-a'))
  assert.equal(okOwn.ok, true)
  assert.equal(okOwn.status, 'cancelled')
  assert.equal(cancelFact(store, ownId, '自己放弃').created_by, 'worker-a')

  const leadId = store.openTask({ title: '主会话叫停' }, RUN).task_id
  store.claimTask({ task_id: leadId, child_id: 'worker-c' }, RUN)
  const okLead = await call('task_close', { task_id: leadId, result: 'failed', note: '主会话叫停' }, lead)
  assert.equal(okLead.ok, true)
  assert.equal(okLead.status, 'cancelled')
  assert.equal(cancelFact(store, leadId, '主会话叫停').created_by, 'lead',
    '主会话取消他人任务时必须记 lead，不得误标成原 owner')
})

test('未认领任务的常规取消与 done/partial 别名语义不回退', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)

  const openId = store.openTask({ title: '未认领' }, RUN).task_id
  const openCancelled = await call('task_close', { task_id: openId, result: 'failed' }, lead)
  assert.equal(openCancelled.ok, true)
  assert.equal(openCancelled.status, 'cancelled')
  assert.equal(openCancelled.alias_of, null)

  const doneId = store.openTask({ title: '走 done 别名' }, RUN).task_id
  store.claimTask({ task_id: doneId, child_id: 'worker-d' }, RUN)
  const done = await call('task_close', { task_id: doneId, result: 'done' }, childOf('worker-d'))
  assert.equal(done.ok, true)
  assert.equal(done.status, 'submitted')
  assert.equal(done.alias_of, 'submitTask')

  const direct = store.closeTask({ task_id: store.openTask({ title: '宿主直连' }, RUN).task_id, result: 'failed' }, RUN)
  assert.equal(direct.status, 'cancelled')
})
