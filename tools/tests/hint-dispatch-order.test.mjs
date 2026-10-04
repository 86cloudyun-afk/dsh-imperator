import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as applyTools } from '../../lib/tools/index.js'

/**
 * `wrap()` 的 code→hint 分派守卫（运行时）。
 *
 * 背景：失败分派曾把文本判定 `text.includes('服务不可用')` 和
 * `code === CHILD_ERROR_CODES.service` 并在 else-if 链**最顶端**。文本判定一旦
 * 置顶，就会**抢在所有 `code === 'E_*'` 分支之前**命中——只要某个带稳定错误码的
 * 拒绝（状态机 / 身份 / 阻塞类）报文里恰好出现「服务不可用」字样，就会被误分类成
 * 部署问题（HINT_SERVICE：不要重试、直接上报），把本可据状态机自愈的拒绝带偏。
 * 这与 #11「业务拒绝统一 refuse()、消除 code→hint 误分类」同一方向：**稳定错误码
 * 必须永远优先于文本判定**，文本判定只能作为无码错误（STORE_SERVICE 未挂载时抛的
 * 纯文本 Error）的最后兜底。本测试在运行时锁定这一优先级。
 */
function toolCaller(store) {
  const lead = { id: 'run-a', options: {}, session: { header: { id: 'run-a' } } }
  const definitions = []
  applyTools({ logger: { warn() {} }, get(name) {
    if (name === 'taskforceStore') return store
    if (name === 'agents') return { get: id => (id === 'run-a' ? lead : undefined) }
  }, tools: { register: definition => definitions.push(definition) } })
  return async (name, args) => JSON.parse(await definitions.find(tool => tool.name === name).execute(args, { agent: lead }))
}

test('带稳定错误码的拒绝即便报文含「服务不可用」也按码分类，不被文本兜底抢分类', async () => {
  const call = toolCaller({ openTask() {
    throw Object.assign(new Error('任务状态不允许该动作：事实库服务不可用那段文案'), { code: 'E_STATUS' })
  } })
  const result = await call('task_open', { title: 't' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_STATUS')
  assert.match(result.hint, /状态机边界/, 'E_STATUS 应分派到 HINT_STATUS（状态机边界）')
  assert.doesNotMatch(result.hint, /部署问题/, '不得被文本判定抢分类成 HINT_SERVICE（部署问题）')
})

test('无稳定错误码的「服务不可用」纯文本 Error 仍兜底为部署问题提示（HINT_SERVICE）', async () => {
  const call = toolCaller({ openTask() {
    throw new Error('taskforce-store 服务不可用：事实库（@local/dsh-taskforce/lib/store）未挂载或未激活')
  } })
  const result = await call('task_open', { title: 't' })
  assert.equal(result.ok, false)
  assert.equal(result.code, null)
  assert.match(result.hint, /部署问题/, '无码的 store-未挂载错误应落到 HINT_SERVICE（部署问题）')
})
