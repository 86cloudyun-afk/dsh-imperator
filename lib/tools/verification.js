/** Awaited native execution only: retain approval, sandbox, guards and caller identity. */
import { randomUUID } from 'node:crypto'
import { executionError } from '../store/execution.js'

export async function runTaskVerification({ store, identity, agent, task_id, command,
  timeout_ms = 60000, signal, execute, exec }) {
  if (identity?.isRoot !== false) {
    throw executionError('E_VERIFICATION_ROLE', 'task_verify 只能由真实子会话 owner 调用；主会话只读取回执并验收')
  }
  const target = store.verificationTarget(task_id, identity.runId, identity)
  if (command !== target.verification_command) {
    throw executionError('E_VERIFICATION_COMMAND', 'command 必须逐字匹配 task_open 固定的 verification_command；请读板核对，不可替换验收命令')
  }
  if (!Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 120000) {
    throw executionError('E_VERIFICATION_POLICY', 'timeout_ms 必须是 1–120000 的整数，默认 60000')
  }
  const nativeSignal = signal ?? exec?.signal
  if (typeof execute !== 'function' || !agent || exec?.agent !== agent
    || agent.session?.header?.id !== identity.sessionId || exec?.token == null
    || typeof exec?.rootCallId !== 'string' || !exec.rootCallId
    || nativeSignal !== exec?.signal || typeof nativeSignal?.addEventListener !== 'function') {
    throw executionError('E_VERIFICATION_CAPABILITY', '缺少可信 native tools.execute 或完整外层执行 context（agent/token/rootCallId/signal）；宿主接线不足，拒绝降级执行')
  }
  const callId = `task-verify-${randomUUID()}`
  // Durable intent is synchronous before the first await. A crash or a failed
  // completion write leaves this newest row pending and blocks an old success.
  const pending = store.recordExecution({ task_id, status: 'pending', command, timeout_ms,
    call_id: callId, root_call_id: exec.rootCallId, parent_call_id: exec.callId ?? null }, identity.runId, identity)
  let nativeResult
  try {
    nativeResult = await execute({ callId, rootCallId: exec.rootCallId, parent: exec.token,
      name: 'bash', arguments: { command: target.verification_command,
        description: `验证任务 ${task_id} 的固定验收命令`,
        workdir: target.verification_cwd, timeoutMs: timeout_ms, run_in_background: false },
      agent, signal: nativeSignal })
  } catch (error) {
    nativeResult = { isError: true, error: { message: String(error?.message ?? error) }, content: [] }
  }
  // Deliberately outside the execute catch: persistence errors must propagate,
  // and must not overwrite the pending intent or report a verified outcome.
  const completed = store.recordExecution({ task_id, receipt_id: pending.receipt_id,
    native_result: nativeResult, signal_aborted: nativeSignal.aborted }, identity.runId, identity)
  return completed.native_error_code === 'UNKNOWN_TOOL'
    ? { ...completed, ok: false, code: 'E_VERIFICATION_CAPABILITY', error: '宿主 native bash 不可用或当前执行域不可达，回执已记为 unknown' }
    : completed
}
