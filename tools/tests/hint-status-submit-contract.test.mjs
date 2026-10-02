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

test('E_STATUS hint distinguishes submit transitions, submitted retries and rejected rework', async (t) => {
  const store = tempStore(t)
  const task_id = seedSubmitted(store, 'run-a')
  const { call } = toolCaller(store)
  const result = await call('task_claim', { task_id, child_id: 'child-a' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_STATUS')
  assert.doesNotMatch(result.hint, /submit (只在 open \/ claimed|在 open \/ claimed \/ rejected) 可用/)
  assert.match(result.hint, /submit 将 open \/ claimed 转为 submitted/)
  assert.match(result.hint, /submitted 上重复 submit 幂等成功/)
  assert.match(result.hint, /already:true/)
  assert.match(result.hint, /不改状态或记录新 note/)
  assert.match(result.hint, /rejected 须先 task_claim/)
  assert.match(result.hint, /close\(done\/partial\) 同 submit/)
  assert.match(result.hint, /close\(failed\) 单独取消为 cancelled/)
  assert.match(result.hint, /身份、当前 run 与参数检查/)
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
