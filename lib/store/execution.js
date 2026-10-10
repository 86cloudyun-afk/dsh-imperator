/** Host-observed execution evidence. This is an API boundary, not isolation
 * against processes with the same UID that can write the database or logs. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MAX_LOG_BYTES = 2 * 1024 * 1024
export const EXECUTION_DDL = `
CREATE TABLE IF NOT EXISTS execution_receipt (
  id INTEGER PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL,
  run_id TEXT,
  evidence_generation INTEGER NOT NULL,
  owner_session TEXT NOT NULL,
  actor_session TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  verification_files TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  call_id TEXT NOT NULL,
  root_call_id TEXT NOT NULL,
  parent_call_id TEXT,
  timeout_ms INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  outcome TEXT,
  logs TEXT
);
CREATE INDEX IF NOT EXISTS idx_execution_task_run ON execution_receipt(task_id, run_id, id);
CREATE TABLE IF NOT EXISTS execution_waiver (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  run_id TEXT,
  evidence_generation INTEGER NOT NULL,
  actor_session TEXT,
  reason TEXT NOT NULL,
  receipt_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_waiver_task_run ON execution_waiver(task_id, run_id, id);
`

export function executionError(code, message) {
  return Object.assign(new Error(message), { code })
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** Reads bytes, resolved identity and metadata; every subsequent read rechecks containment. */
export function sourceSnapshot(cwd, files) {
  try {
    if (realpathSync(cwd) !== cwd || !statSync(cwd).isDirectory()) throw new Error('工作区身份变化')
    return files.map(path => {
      if (typeof path !== 'string' || !path.trim() || isAbsolute(path)) throw new Error('清单须为非空相对文件路径')
      const lexical = resolve(cwd, path)
      const physical = realpathSync(lexical)
      if (!inside(cwd, lexical) || !inside(cwd, physical)) throw new Error('清单越界或 symlink 指向工作区外')
      const before = statSync(physical)
      if (!before.isFile()) throw new Error('清单条目不是文件')
      const bytes = readFileSync(physical)
      const after = statSync(physical)
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || realpathSync(lexical) !== physical) throw new Error('快照读取期间文件变化')
      return { path, realpath: physical, sha256: sha256(bytes), size: after.size,
        mtime_ms: after.mtimeMs, ctime_ms: after.ctimeMs, ino: after.ino, dev: after.dev }
    })
  } catch (error) {
    throw executionError('E_VERIFICATION_POLICY', `验收清单/工作区无效：${error.message}；请主会话核对任务工作区与 verification_files`)
  }
}

export function executionPolicy(args, trustedContext) {
  const policy = args.evidence_policy ?? 'legacy'
  if (policy === 'legacy') return { evidence_policy: policy, verification_files: null, verification_command: null, verification_cwd: null }
  if (policy !== 'execution' || trustedContext?.isRoot !== true
    || typeof trustedContext?.sessionId !== 'string' || !trustedContext.sessionId.trim()
    || typeof trustedContext?.cwd !== 'string' || !isAbsolute(trustedContext.cwd)
    || !Array.isArray(args.verification_files) || args.verification_files.length === 0
    || typeof args.verification_command !== 'string' || !args.verification_command.trim()) {
    throw executionError('E_VERIFICATION_POLICY', 'execution 任务只允许可信主会话创建，须有真实 sessionId、绝对 cwd、非空 verification_files 与固定 verification_command')
  }
  let cwd
  try { cwd = realpathSync(trustedContext.cwd) } catch {
    throw executionError('E_VERIFICATION_POLICY', '可信工作区不存在：请核对主会话 cwd')
  }
  const files = [...args.verification_files]
  sourceSnapshot(cwd, files)
  return { evidence_policy: policy, verification_files: JSON.stringify(files),
    verification_command: args.verification_command, verification_cwd: cwd }
}

/** Canonical native union only; rendered text and model-authored fields are never evidence. */
export function executionOutcome(result, signalAborted = false) {
  const value = result?.isError === false ? result.value : undefined
  const streamValid = stream => typeof stream?.text === 'string' && typeof stream.truncated === 'boolean'
  const canonical = value?.kind === 'foreground'
    && (Number.isInteger(value.exitCode) || value.exitCode === null)
    && (typeof value.signal === 'string' || value.signal === null)
    && typeof value.timedOut === 'boolean' && typeof value.aborted === 'boolean'
    && typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)
    && streamValid(value.stdout) && streamValid(value.stderr)
  const stdout = typeof value?.stdout?.text === 'string' ? value.stdout.text : ''
  const stderr = typeof value?.stderr?.text === 'string' ? value.stderr.text : ''
  const oversized = Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_LOG_BYTES
  const complete = canonical && value.stdout.truncated === false && value.stderr.truncated === false && !oversized
  return { status: canonical ? 'completed' : 'unknown', kind: value?.kind ?? null,
    exit_code: canonical ? value.exitCode : null, signal: canonical ? value.signal : null,
    actual_timeout_ms: canonical ? value.timeoutMs : null,
    timed_out: canonical ? value.timedOut : null, aborted: signalAborted || (canonical ? value.aborted : false),
    runner_failed: value?.sandbox?.runnerFailed === true, sandbox: value?.sandbox ?? null,
    stopped: value?.stopped ?? null, output_complete: complete, oversized,
    stdout_truncated: value?.stdout?.truncated ?? null, stderr_truncated: value?.stderr?.truncated ?? null,
    native_error_code: result?.isError === true ? (result.error?.info?.code ?? null) : null,
    native_error: result?.isError === true ? String(result.error?.message ?? 'native 执行拒绝/失败').slice(0, 2000)
      : (!canonical ? 'native 结果未提供完整 foreground 结构' : null),
    stdout, stderr }
}

/** Persist at most 2 MiB of observed output; oversized output is always incomplete.
 * Native spill paths are never followed or called complete evidence. */
export function persistExecutionLogs(root, receiptId, outcome) {
  try {
    const directory = join(root, 'receipts')
    mkdirSync(directory, { recursive: true })
    let remaining = MAX_LOG_BYTES
    const logs = {}
    for (const stream of ['stdout', 'stderr']) {
      const all = Buffer.from(outcome[stream])
      const bytes = all.subarray(0, remaining)
      remaining -= bytes.length
      const path = join(directory, `${receiptId}.${stream}.log`)
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
      logs[stream] = { path, sha256: sha256(bytes), bytes: bytes.length, observed_bytes: all.length }
    }
    return logs
  } catch (error) {
    throw executionError('E_VERIFICATION_RECEIPT', `宿主日志持久化失败：${error.message}；最新 pending intent 保持未验证，修复日志目录后由当前 owner 重新 task_verify`)
  }
}

export function receiptRow(row) {
  if (!row) return null
  const { verification_files, snapshot, outcome, logs, ...base } = row
  return { ...base, verification_files: JSON.parse(verification_files), snapshot: JSON.parse(snapshot),
    ...(outcome ? JSON.parse(outcome) : {}), logs: logs ? JSON.parse(logs) : null }
}

export function latestExecution(db, task) {
  return receiptRow(db.prepare('SELECT * FROM execution_receipt WHERE task_id = ? AND run_id IS ? ORDER BY id DESC LIMIT 1').get(task.id, task.run_id))
}

/** Every strict acceptance repeats all checks, including current source and actual log bytes. */
export function strictExecutionEvidence(db, root, task) {
  try {
    const receipt = latestExecution(db, task)
    if (!receipt || receipt.status !== 'completed' || receipt.kind !== 'foreground'
      || receipt.evidence_generation !== task.evidence_generation
      || !task.owner_session || receipt.owner_session !== task.owner_session || receipt.actor_session !== task.owner_session
      || receipt.run_id !== task.run_id || receipt.command !== task.verification_command
      || receipt.cwd !== task.verification_cwd || JSON.stringify(receipt.verification_files) !== task.verification_files
      || receipt.exit_code !== 0 || receipt.signal !== null || receipt.timed_out !== false || receipt.aborted !== false
      || receipt.runner_failed || receipt.sandbox?.denied === true || receipt.stopped !== null || receipt.output_complete !== true || receipt.source_changed !== false) {
      throw new Error('最新回执缺失、待定、失效或执行未完整成功')
    }
    if (JSON.stringify(sourceSnapshot(task.verification_cwd, JSON.parse(task.verification_files))) !== JSON.stringify(receipt.snapshot)) {
      throw new Error('当前源码清单与运行快照不一致')
    }
    // Only the configured root may be an alias. Keep exact stored path text,
    // and bind each regular log to receipts beneath the physical store root.
    const physicalRoot = realpathSync(root)
    let total = 0
    for (const stream of ['stdout', 'stderr']) {
      const log = receipt.logs?.[stream]
      const filename = `${receipt.receipt_id}.${stream}.log`
      const expected = join(root, 'receipts', filename)
      const physicalExpected = join(physicalRoot, 'receipts', filename)
      if (!log || log.path !== expected || lstatSync(log.path).isSymbolicLink()
        || realpathSync(log.path) !== physicalExpected) throw new Error('日志路径或身份不符')
      const stat = statSync(log.path)
      if (!stat.isFile() || stat.size !== log.bytes || stat.size > MAX_LOG_BYTES) throw new Error('日志大小不符')
      const bytes = readFileSync(log.path)
      total += bytes.length
      if (sha256(bytes) !== log.sha256 || bytes.length !== log.observed_bytes) throw new Error('日志内容/摘要不符')
    }
    if (total > MAX_LOG_BYTES) throw new Error('日志超限')
    return receipt
  } catch (error) {
    throw executionError('E_VERIFICATION_RECEIPT', `严格验收拒绝：${error.message}；请当前真实 owner 在本代重新 task_verify，或主会话明确给出 waiver_reason 人工豁免（非验证通过）`)
  }
}

export const newReceiptId = () => randomUUID()
