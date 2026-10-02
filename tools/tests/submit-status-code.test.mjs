import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STORE_CODES } from '../../lib/store/index.js'
import { tempStore } from './helpers.mjs'

/**
 * submitTask 在非终态但不可提交的状态（典型：rejected，须先 task_claim）
 * 必须 refuse(E_STATUS)，不能裸抛 Error —— 否则工具层 wrap() 落到 HINT_INPUT，
 * 把状态机边界误提示成「核对 id 后重试」。claim/accept 同形路径早已用 refuse(status)；
 * PR #11 统一 refuse 时漏了 submit 这一支，且 error-code-contract 原先只扫
 * `throw new Error(`，扫不到三元式 `: new Error(`（本轮已加强该扫描）。
 */
test('submitTask on rejected refuses with E_STATUS (not a bare Error)', (t) => {
  const store = tempStore(t)
  store.open()
  const run = 'run-a'
  const { task_id } = store.openTask({ title: '待重做' }, run)
  store.claimTask({ task_id, child_id: 'child-a' }, run)
  store.recordFact({
    task_id,
    kind: 'fact',
    statement: '初版证据',
    confidence: 'CONFIRMED',
    child_id: 'child-a',
  }, run)
  store.submitTask({ task_id }, run)
  store.rejectTask({ task_id, reason: '缺行号' }, run, 'lead')
  assert.equal(store.taskOf({ task_id }, run).task.status, 'rejected')

  assert.throws(
    () => store.submitTask({ task_id }, run),
    (error) => {
      assert.equal(error.code, STORE_CODES.status)
      assert.match(error.message, /status=rejected/)
      assert.match(error.message, /task_claim/)
      return true
    },
  )
})

test('submitTask on accepted still refuses with E_TERMINAL', (t) => {
  const store = tempStore(t)
  store.open()
  const run = 'run-a'
  const { task_id } = store.openTask({ title: '已收口' }, run)
  store.claimTask({ task_id, child_id: 'child-a' }, run)
  store.recordFact({
    task_id,
    kind: 'fact',
    statement: '可验收证据',
    confidence: 'CONFIRMED',
    child_id: 'child-a',
  }, run)
  store.submitTask({ task_id }, run)
  store.acceptTask({ task_id }, run, 'lead')

  assert.throws(
    () => store.submitTask({ task_id }, run),
    (error) => {
      assert.equal(error.code, STORE_CODES.terminal)
      return true
    },
  )
})
