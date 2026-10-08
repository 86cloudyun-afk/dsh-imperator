import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { strictExecutionEvidence } from '../../lib/store/execution.js'
import { tempStore } from './helpers.mjs'

const RUN = 'adopt-run'
const OTHER_RUN = 'other-run'
const command = "printf 'verified\\n'"
const worker = { isRoot: false, sessionId: 'worker-session' }

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'taskforce-adopt-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'source.js'), 'export const answer = 42\n')
  const store = tempStore(t)
  const context = { sessionId: 'lead-session', cwd, isRoot: true }
  /** 在指定域创建并完整"验证"一个 execution 任务，返回 { id, receiptId }。 */
  const seedVerified = (run) => {
    const id = store.openTask({
      title: '执行验证任务', evidence_policy: 'execution',
      verification_files: ['source.js'], verification_command: command,
    }, run, context).task_id
    store.claimTask({ task_id: id, child_id: 'worker' }, run, worker, worker.sessionId)
    const pending = store.recordExecution({ task_id: id, status: 'pending', command,
      call_id: 'call-1', root_call_id: 'call-1', timeout_ms: 60000 }, run, worker)
    const completed = store.recordExecution({ task_id: id, status: 'completed', receipt_id: pending.receipt_id,
      native_result: { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null,
        timedOut: false, aborted: false, timeoutMs: 60000,
        stdout: { text: 'verified\n', truncated: false }, stderr: { text: '', truncated: false } } } }, run, worker)
    return { id, receiptId: pending.receipt_id, completed }
  }
  return { cwd, store, context, seedVerified }
}

const receiptRow = (store, id) => store.handle.prepare('SELECT run_id, status FROM execution_receipt WHERE task_id = ?').get(id)
const taskRun = (store, id) => store.handle.prepare('SELECT run_id FROM task WHERE id = ?').get(id).run_id
const taskRow = (store, id) => store.handle.prepare('SELECT * FROM task WHERE id = ?').get(id)

// 未接管时审计行留在未归属域、run 域不可达；接管后必须随任务一起迁走，否则 run 域
// 视图（看板 receipts、latestExecution、strictExecutionEvidence）按 run_id 精确匹配，
// 旧回执会"消失"而未归属域又已看不到任务。
test('接管把未归属 execution 回执与豁免随任务一起迁移到目标 run', t => {
  const f = fixture(t)
  const { id, receiptId, completed } = f.seedVerified(null)
  assert.equal(completed.verified, true)
  f.store.handle.prepare('INSERT INTO execution_waiver (task_id, run_id, evidence_generation, actor_session, reason, receipt_id, created_at) VALUES (?, NULL, 0, ?, ?, ?, ?)')
    .run(id, 'worker-session', '人工豁免示例', receiptId, '2026-01-01T00:00:00.000Z')

  // 反向锁：接管前审计行在未归属域，run 域连任务本身都读不到（跨域拒绝）。
  assert.equal(receiptRow(f.store, id).run_id, null)
  assert.equal(f.store.unassignedSummary().receipt, 1)
  assert.equal(f.store.unassignedSummary().waiver, 1)
  assert.throws(() => f.store.board({ task_id: id }, RUN), { code: 'E_CROSS_RUN' })

  const adopted = f.store.adoptUnassigned(RUN)
  assert.equal(adopted.tasks, 1)
  assert.equal(adopted.receipts, 1)
  assert.equal(adopted.waivers, 1)

  const detail = f.store.board({ task_id: id }, RUN)
  assert.equal(detail.receipts.length, 1)
  assert.equal(detail.receipts[0].receipt_id, receiptId)
  assert.equal(detail.receipts[0].run_id, RUN)
  assert.equal(detail.execution_waivers.length, 1)
  assert.equal(detail.execution_waivers[0].run_id, RUN)
  assert.equal(f.store.unassignedSummary().receipt, 0)
  assert.equal(f.store.unassignedSummary().waiver, 0)
})

// 修复的价值面：接管前已验证成功的执行证据，接管后仍能通过严格验收（而不是被判"回执缺失"）。
test('接管后严格验收仍可复用接管前有效的执行回执', t => {
  const f = fixture(t)
  const { id, receiptId } = f.seedVerified(null)
  assert.equal(strictExecutionEvidence(f.store.handle, f.store.root, taskRow(f.store, id)).receipt_id, receiptId)
  f.store.submitTask({ task_id: id }, null, worker, worker.sessionId)

  assert.equal(f.store.adoptUnassigned(RUN).receipts, 1)
  assert.equal(strictExecutionEvidence(f.store.handle, f.store.root, taskRow(f.store, id)).receipt_id, receiptId)
  const accepted = f.store.acceptTask({ task_id: id, note: '接管后验收' }, RUN, 'lead', RUN)
  assert.equal(accepted.execution_verified, true)
  assert.equal(accepted.execution_receipt, receiptId)
})

// 反向锁：幂等 —— 第二次接管（此时已无未归属行）不重复迁移、不改写已有归属。
test('重复接管不重复迁移审计行', t => {
  const f = fixture(t)
  const { id } = f.seedVerified(null)
  assert.equal(f.store.adoptUnassigned(RUN).receipts, 1)
  const second = f.store.adoptUnassigned(RUN)
  assert.equal(second.tasks, 0)
  assert.equal(second.receipts, 0)
  assert.equal(second.waivers, 0)
  assert.equal(receiptRow(f.store, id).run_id, RUN)
  assert.equal(f.store.board({ task_id: id }, RUN).receipts.length, 1)
})

// 反向锁：谓词只碰未归属且挂在已归位任务下的行，别的 run 的审计记录不被波及。
test('接管不误伤其它 run 的审计行', t => {
  const f = fixture(t)
  const other = f.seedVerified(OTHER_RUN)
  const orphan = f.seedVerified(null)
  assert.equal(f.store.adoptUnassigned(RUN).receipts, 1)
  assert.equal(receiptRow(f.store, other.id).run_id, OTHER_RUN)
  assert.equal(f.store.board({ task_id: other.id }, OTHER_RUN).receipts.length, 1)
  assert.equal(receiptRow(f.store, orphan.id).run_id, RUN)
})

// 接管是一个组合写动作：审计行迁移失败必须让整个事务（含任务归属）回滚，不能只搬一半。
test('接管中途失败时审计行随任务整体回滚', t => {
  const f = fixture(t)
  const { id } = f.seedVerified(null)
  f.store.handle.exec("CREATE TEMP TRIGGER fail_receipt_adopt BEFORE UPDATE OF run_id ON execution_receipt BEGIN SELECT RAISE(ABORT,'receipt adopt failure'); END")
  assert.throws(() => f.store.adoptUnassigned(RUN), /receipt adopt failure/)
  f.store.handle.exec('DROP TRIGGER fail_receipt_adopt')
  assert.equal(taskRun(f.store, id), null)
  assert.equal(receiptRow(f.store, id).run_id, null)
  assert.equal(f.store.unassignedSummary().task, 1)
  assert.equal(f.store.unassignedSummary().receipt, 1)
})
