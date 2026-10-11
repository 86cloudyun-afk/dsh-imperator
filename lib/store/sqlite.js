/** Synchronous SQLite configuration and transaction primitives. */

import { types } from 'node:util'

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

/** Companion for an explicitly selected, static SQL column and alias. */
export function sqliteTextCompanion(column, alias) {
  return `CASE WHEN typeof(${column})='text' THEN CASE WHEN instr(${column},char(0))>0`
    + ` THEN json_quote(${column}) ELSE NULL END ELSE NULL END AS ${alias}`
}

function invalidTextEvidence() {
  throw codedError('E_STORE_INTEGRITY', 'SQLite 文本读取证据无效')
}

function decodeText(value, companion) {
  if (companion === null) return value
  if (typeof companion !== 'string') invalidTextEvidence()
  let decoded
  try { decoded = JSON.parse(companion) } catch { invalidTextEvidence() }
  if (typeof decoded !== 'string' || !decoded.includes('\0')) invalidTextEvidence()
  return decoded
}

/** Explicit projections reserve their companion alias; native row shape stays intact. */
export function restoreSqliteText(row, field, companion) {
  if (row === undefined) return row
  if (row === null || typeof row !== 'object' || Array.isArray(row)
    || !Object.hasOwn(row, field) || !Object.hasOwn(row, companion)) invalidTextEvidence()
  row[field] = decodeText(row[field], row[companion])
  delete row[companion]
  return row
}

function sqliteColumnNames(columns) {
  if (!Array.isArray(columns) || columns.length === 0) invalidTextEvidence()
  const names = []
  for (const column of columns) {
    if (typeof column?.name !== 'string') invalidTextEvidence()
    names.push(column.name)
  }
  if (new Set(names).size !== names.length) invalidTextEvidence()
  return names
}

function decodeTaggedText(value) {
  if (typeof value !== 'string') {
    if (value === null || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value
    invalidTextEvidence()
  }
  if (value[0] === 'T') {
    const text = value.slice(1)
    if (text.includes('\0')) invalidTextEvidence()
    return text
  }
  if (value[0] !== 'J') invalidTextEvidence()
  return decodeText(undefined, value.slice(1))
}

/** Restore only native object values. Callers validate their fixed metadata
 * layout; this utility does not prepare SQL or resolve duplicate columns.
 */
export function sqliteTaggedRestorer(names, fields) {
  const nameSet = new Set(names)
  return row => {
    if (row === undefined) return row
    if (row === null || typeof row !== 'object' || Object.getPrototypeOf(row) !== null) invalidTextEvidence()
    const keys = Reflect.ownKeys(row)
    if (keys.length !== nameSet.size) invalidTextEvidence()
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key)
      if (typeof key !== 'string' || !nameSet.has(key) || !Object.hasOwn(descriptor, 'value')
        || !descriptor.writable || !descriptor.enumerable || !descriptor.configurable) invalidTextEvidence()
    }
    for (const field of fields) row[field] = decodeTaggedText(Object.getOwnPropertyDescriptor(row, field).value)
    return row
  }
}

/** Selected star readers supply a fixed factory and qualifier. Prepare the
 * original only for metadata, then replace selected TEXT fields in one
 * equal-width projection. Native objects retain every original column/value.
 */
export function prepareSqliteTextProjection(db, fieldOrFields, qualifier, queryFactory) {
  const fields = typeof fieldOrFields === 'string' ? [fieldOrFields] : fieldOrFields
  if (!Array.isArray(fields) || fields.length === 0) invalidTextEvidence()
  for (let index = 0; index < fields.length; index++) {
    if (!Object.hasOwn(fields, index) || typeof fields[index] !== 'string') invalidTextEvidence()
  }
  const selected = new Set(fields)
  if (selected.size !== fields.length) invalidTextEvidence()
  const original = db.prepare(queryFactory())
  const names = sqliteColumnNames(original.columns())
  if (fields.some(field => !names.includes(field))) invalidTextEvidence()
  const quote = name => '"' + name.replaceAll('"', '""') + '"'
  const projection = names.map(name => {
    const ref = quote(qualifier) + '.' + quote(name)
    return selected.has(name)
      ? `CASE WHEN typeof(${ref})='text' THEN CASE WHEN instr(${ref},char(0))>0 THEN 'J'||json_quote(${ref}) ELSE 'T'||${ref} END ELSE ${ref} END AS ${quote(name)}`
      : ref
  }).join(',')
  const statement = db.prepare(queryFactory(projection))
  const actual = sqliteColumnNames(statement.columns())
  if (actual.length !== names.length || names.some((name, index) => name !== actual[index])) invalidTextEvidence()
  return { statement, restore: sqliteTaggedRestorer(names, fields) }
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

/** Multi-query reads share one deferred snapshot without reserving a write lock.
 * The callback must only read; this is snapshot coordination, not a SQL sandbox.
 */
export function withReadTransaction(db, work) {
  return withTransaction(db, work, 'BEGIN DEFERRED')
}

export function withWriteTransaction(db, work) {
  return withTransaction(db, work, 'BEGIN IMMEDIATE')
}

function withTransaction(db, work, beginSql) {
  if (typeof work !== 'function') throw new TypeError('SQLite transaction work must be a function')
  // Do not invoke known asynchronous/lazy callbacks: their effects could escape
  // a rollback after the first await/yield. Arbitrary scheduled work is still
  // the caller's responsibility; a synchronous transaction cannot cancel it.
  if (types.isAsyncFunction(work) || types.isGeneratorFunction(work)) {
    throw codedError('E_STORE_ASYNC_TRANSACTION', 'SQLite 写事务仅支持同步工作')
  }
  const depth = transactionDepth.get(db) ?? 0
  const savepoint = depth ? `taskforce_sp_${++savepointId}` : null
  const begin = savepoint ? `SAVEPOINT ${savepoint}` : beginSql
  try {
    db.exec(begin)
  } catch (error) {
    throw normalizeSqliteError(error)
  }
  transactionDepth.set(db, depth + 1)
  try {
    const result = work()
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
      // Consume native Promise rejections without invoking arbitrary thenables.
      if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {})
      throw codedError('E_STORE_ASYNC_TRANSACTION', 'SQLite 写事务仅支持同步工作')
    }
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
    return result
  } catch (error) {
    try {
      db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK')
      if (savepoint) db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    } catch (rollbackError) {
      // Invalidate before touching the thrown value: it may be a primitive,
      // frozen Error, or have throwing accessors. Diagnostics must not retain
      // a connection whose transaction state is unknown.
      try { db.close() } catch { /* retain the primary failure */ }
      try { invalidationHandlers.get(db)?.() } catch { /* retain the primary failure */ }
      let firstRollback = rollbackError
      try {
        if (error.rollbackError !== undefined) firstRollback = error.rollbackError
        else error.rollbackError = rollbackError
        error.transactionStateUnknown = true
      } catch {
        const primary = error
        error = codedError('E_STORE_TRANSACTION', 'SQLite 回滚失败，连接状态未知', primary)
        try { if (typeof primary?.code === 'string') error.code = primary.code } catch { /* optional metadata */ }
        try { if (typeof primary?.errcode === 'number') error.errcode = primary.errcode } catch { /* optional metadata */ }
        error.rollbackError = firstRollback
        error.transactionStateUnknown = true
      }
    }
    throw normalizeSqliteError(error)
  } finally {
    if (depth) transactionDepth.set(db, depth)
    else transactionDepth.delete(db)
  }
}
