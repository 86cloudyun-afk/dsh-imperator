/** Synchronous SQLite configuration and transaction primitives. */

const transactionDepth = new WeakMap()
const invalidationHandlers = new WeakMap()
let savepointId = 0

/** Store-owned connections can clear their published handle after failed rollback. */
export function onSqliteConnectionInvalidated(db, handler) {
  invalidationHandlers.set(db, handler)
}

function codedError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

export function normalizeSqliteOptions(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw codedError('E_STORE_CONFIG', 'SQLite 配置必须是对象')
  }
  const busyTimeoutMs = input.busyTimeoutMs === undefined ? 1000 : input.busyTimeoutMs
  const journalMode = input.journalMode === undefined ? 'preserve' : input.journalMode
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000
    || !['preserve', 'wal'].includes(journalMode)) {
    throw codedError('E_STORE_CONFIG', 'SQLite 配置无效：busyTimeoutMs 应为 0–5000 整数，journalMode 应为 preserve 或 wal')
  }
  return { busyTimeoutMs, journalMode }
}

export function configureSqlite(db, options = {}) {
  const { busyTimeoutMs, journalMode } = normalizeSqliteOptions(options)
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  if (journalMode === 'wal') {
    const result = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode
    if (String(result).toLowerCase() !== 'wal') {
      throw codedError('E_STORE_JOURNAL_MODE', `SQLite 无法启用 WAL（当前模式：${result}）`)
    }
  }
  return { busyTimeoutMs, journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode }
}

export function normalizeSqliteError(error) {
  // errcode is the native node:sqlite field; mask extended codes to their primary code.
  if (error?.code !== 'ERR_SQLITE_ERROR' || typeof error.errcode !== 'number'
    || ![5, 6].includes(error.errcode & 0xff)) return error
  const normalized = codedError('E_STORE_BUSY', `SQLite 写入繁忙：${error.message}`, error)
  if (error.rollbackError !== undefined) normalized.rollbackError = error.rollbackError
  if (error.transactionStateUnknown === true) normalized.transactionStateUnknown = true
  return normalized
}

export function withWriteTransaction(db, work) {
  const depth = transactionDepth.get(db) ?? 0
  const savepoint = depth ? `taskforce_sp_${++savepointId}` : null
  const begin = savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE'
  try {
    db.exec(begin)
  } catch (error) {
    throw normalizeSqliteError(error)
  }
  transactionDepth.set(db, depth + 1)
  try {
    const result = work()
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
      throw codedError('E_STORE_ASYNC_TRANSACTION', 'SQLite 写事务仅支持同步工作')
    }
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
    return result
  } catch (error) {
    try {
      db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK')
      if (savepoint) db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    } catch (rollbackError) {
      if (error.rollbackError === undefined) error.rollbackError = rollbackError
      error.transactionStateUnknown = true
      // The caller must never reuse a connection whose transaction state is unknown.
      try { db.close() } catch { /* retain the primary failure */ }
      try { invalidationHandlers.get(db)?.() } catch { /* retain the primary failure */ }
    }
    throw normalizeSqliteError(error)
  } finally {
    if (depth) transactionDepth.set(db, depth)
    else transactionDepth.delete(db)
  }
}
