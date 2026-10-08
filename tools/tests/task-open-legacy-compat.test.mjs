import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply as applyTools } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'

/**
 * `task_open` 对 **ID-only agent** 的兼容性守卫（#49 合并后 Codex P2 行内意见，lib/tools/index.js:1185）。
 *
 * 缺陷形态：身份推导接受的最小调用者形态是「合法 `agent.id` + **无** `session.header`」
 * （`readHeader` 见 lib/tools/index.js:400-406，`deriveIdentity` 对 ID-only agent 明确给出
 * self-root 身份），但 `task_open` 把 `exec.agent.session.header.cwd` 写成**无条件解引用** ⇒
 * 在进 `openTask` **之前**就抛 TypeError，被 `wrap()` 分类成 `code:null` + HINT_INPUT
 * （"参数或对象标识有问题"），连**默认的 `legacy` 策略**都开不出任务。
 * 而 cwd 只有 `execution` 策略需要（lib/store/execution.js:78 对 legacy 直接 early-return）。
 *
 * 判据是**分层**的：容缺读取既不能崩（测试 1/2/4），也不能把 cwd 整条丢掉让 execution 失效
 * （测试 3 —— 反向锁，专治"改成恒 undefined"这种假修复）。
 */

/** 挂载工具并返回一个最小调用器：`(工具名, 参数, agent) → 解析后的返回体`。 */
function callerOf(store) {
  const defs = []
  applyTools({
    logger: { warn() {} },
    get: name => (name === 'taskforceStore' ? store : undefined),
    tools: { register: definition => defs.push(definition) },
  })
  return async (name, args, agent) => JSON.parse(
    await defs.find(definition => definition.name === name).execute(args, { agent }),
  )
}

/** 宿主给的**最小**调用者形态：合法 id，无 session.header（与 deriveIdentity 的接受面一致）。 */
const idOnlyAgent = { id: 'run-a' }

test('ID-only agent（无 session.header）在 legacy 策略下必须能开任务，不得抛 TypeError', async t => {
  const store = tempStore(t)
  const call = callerOf(store)
  const result = await call('task_open', { title: 'legacy 兼容' }, idOnlyAgent)
  assert.equal(result.ok, true, `ID-only legacy task_open 应成功，实得：${JSON.stringify(result)}`)
  assert.equal(typeof result.task_id, 'number')
  assert.equal(result.run_id, 'run-a')
  // 不只信返回体：任务必须真的落在该 run 的视图里（回显不是验收）。
  assert.equal(store.boardPage({}, 'run-a').tasks.length, 1)
})

test('ID-only agent 走 execution 策略时落在结构化 E_VERIFICATION_POLICY 拒绝，而不是无码 TypeError', async t => {
  const store = tempStore(t)
  const call = callerOf(store)
  const result = await call('task_open', {
    title: '严格任务', evidence_policy: 'execution',
    verification_files: ['source.js'], verification_command: 'node -e "process.exit(0)"',
  }, idOnlyAgent)
  assert.equal(result.ok, false, `缺 cwd 的 execution 应被拒绝，实得：${JSON.stringify(result)}`)
  assert.equal(result.code, 'E_VERIFICATION_POLICY', '必须是稳定错误码，不能是散装 TypeError')
  assert.match(result.hint, /execution 任务须由主会话声明/, 'E_VERIFICATION_POLICY 应分派到验收策略提示')
  assert.doesNotMatch(result.error, /Cannot read propert|undefined/, '不得暴露解引用崩溃的报文')
  assert.equal(store.stats('run-a').tasks.total, 0, '被拒绝的任务不得落库')
})

test('会话头里 cwd 存在但缺失/非字符串时 legacy 仍可开（容缺不止覆盖 header 缺失）', async t => {
  const store = tempStore(t)
  const call = callerOf(store)
  const agent = { id: 'run-a', session: { header: { id: 'run-a' } } } // header 在，cwd 不在
  const result = await call('task_open', { title: 'header 无 cwd' }, agent)
  assert.equal(result.ok, true, `实得：${JSON.stringify(result)}`)
  assert.equal(store.boardPage({}, 'run-a').tasks.length, 1)
})

test('反向锁：带真实绝对 cwd 的主会话仍能开 execution 任务（容缺不得退化成恒 undefined）', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'taskforce-taskopen-')))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'source.js'), 'export const answer = 42\n')
  const store = tempStore(t)
  const call = callerOf(store)
  const agent = { id: 'run-a', session: { header: { id: 'run-a', cwd } } }
  const result = await call('task_open', {
    title: '严格任务', evidence_policy: 'execution',
    verification_files: ['source.js'], verification_command: 'node -e "process.exit(0)"',
  }, agent)
  assert.equal(result.ok, true, `带 cwd 的 execution 必须仍可创建，实得：${JSON.stringify(result)}`)
  // ok:true 本身就是判别点：cwd 若被容缺逻辑丢掉，executionPolicy 会直接给 E_VERIFICATION_POLICY。
  // 再读一次库确认落的是 execution 策略与真实 cwd，而不是退化成 legacy。
  const detail = store.boardPage({ task_id: result.task_id }, 'run-a')
  assert.equal(detail.task.evidence_policy, 'execution')
  assert.equal(detail.task.verification_cwd, cwd, '落库的 verification_cwd 必须是调用者会话头里的绝对 cwd')
})
