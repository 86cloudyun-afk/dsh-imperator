/** Trusted local operators. No service boot, model invocation or production replacement. */
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TaskforceStore } from '../store/index.js'
import { MAX_LOG_BYTES } from '../store/execution.js'

export const MAX_REPORT_BYTES = 8192
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_FILES = 20001
const PROVENANCE_FILE = 'receipt-provenance.json'
const HASH = /^[a-f0-9]{64}$/
const RECEIPT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const CODES = new Set(['E_OPERATIONS_INPUT', 'E_OPERATIONS_PATH', 'E_OPERATIONS_EXISTS',
  'E_OPERATIONS_DATABASE', 'E_OPERATIONS_LOG', 'E_OPERATIONS_INTEGRITY', 'E_OPERATIONS_MANIFEST',
  'E_OPERATIONS_SCHEMA', 'E_OPERATIONS_IO', 'E_OPERATIONS_LIMIT'])
const fail = code => { throw Object.assign(new Error(code), { code }) }
export function operationErrorCode(error) {
  return CODES.has(error?.code) ? error.code : 'E_OPERATIONS_IO'
}
function boundary(error) { fail(operationErrorCode(error)) }
function report(command, extra) {
  const value = { command, ...extra }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REPORT_BYTES) fail('E_OPERATIONS_LIMIT')
  return value
}
function lexical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096
    || path.includes('\0') || path.split(/[\\/]/).includes('..')) fail('E_OPERATIONS_PATH')
  return resolve(path)
}
/** Check every existing ancestor, including aliases above the supplied root. */
function canonical(path, type) {
  path = lexical(path)
  let part = path
  while (true) {
    const stat = lstatSync(part)
    if (stat.isSymbolicLink()) fail('E_OPERATIONS_PATH')
    const parent = dirname(part)
    if (parent === part) break
    part = parent
  }
  if (realpathSync(path) !== path) fail('E_OPERATIONS_PATH')
  const stat = lstatSync(path)
  if (type === 'directory' ? !stat.isDirectory() : !stat.isFile()) fail('E_OPERATIONS_PATH')
  return path
}
function within(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
function source(root) {
  root = canonical(root, 'directory')
  const path = canonical(join(root, 'taskforce.db'), 'file')
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(path + suffix)) canonical(path + suffix, 'file')
  }
  // SQLite may need to create shared-memory coordination for an orphaned WAL.
  // Refuse rather than make a read-only diagnostic create a sidecar.
  if (existsSync(path + '-wal') && !existsSync(path + '-shm')) fail('E_OPERATIONS_DATABASE')
  return { root, path }
}
function readDatabase(path) {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000')
    return db
  } catch { fail('E_OPERATIONS_DATABASE') }
}
function integrity(db) {
  try {
    for (const row of db.prepare('PRAGMA quick_check').iterate()) {
      if (Object.values(row)[0] !== 'ok') fail('E_OPERATIONS_INTEGRITY')
    }
  } catch { fail('E_OPERATIONS_INTEGRITY') }
}
const identifier = value => '"' + value.replaceAll('"', '""') + '"'
function schema(db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const schemaHash = db => digest(JSON.stringify(schema(db)))
function columns(db, table) {
  return db.prepare('PRAGMA table_info(' + identifier(table) + ')').all().map(row => row.name)
}
function hasTable(db, table) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) !== undefined
}
function currentSchema(db) {
  const required = {
    task: ['id', 'title', 'status', 'owner', 'owner_session', 'run_id', 'evidence_generation', 'evidence_policy',
      'verification_files', 'verification_command', 'verification_cwd', 'created_at', 'updated_at'],
    fact: ['id', 'task_id', 'run_id', 'actor_session', 'kind', 'confidence', 'resolves_fact_id'],
    handoff: ['id', 'task_id', 'run_id'],
    execution_receipt: ['id', 'receipt_id', 'task_id', 'run_id', 'status', 'logs'],
    execution_waiver: ['id', 'task_id', 'run_id'],
  }
  return Object.entries(required).every(([table, fields]) => {
    const actual = columns(db, table)
    return fields.every(field => actual.includes(field))
  })
}
function fileDigest(path, expectedBytes) {
  canonical(path, 'file')
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = fstatSync(fd)
    if (!before.isFile() || (expectedBytes !== undefined && before.size !== expectedBytes)) fail('E_OPERATIONS_INTEGRITY')
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let bytes = 0, count
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count)); bytes += count
    }
    const after = fstatSync(fd)
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== after.size) fail('E_OPERATIONS_INTEGRITY')
    return { bytes, sha256: hash.digest('hex') }
  } finally { if (fd !== undefined) closeSync(fd) }
}
function readLog(root, path, expected) {
  try {
    const absolute = canonical(join(root, path), 'file')
    if (!within(root, absolute) || !Number.isSafeInteger(expected.bytes)
      || expected.bytes < 0 || expected.bytes > MAX_LOG_BYTES || !HASH.test(expected.sha256)) fail('E_OPERATIONS_LOG')
    const fingerprint = fileDigest(absolute, expected.bytes)
    if (fingerprint.sha256 !== expected.sha256) fail('E_OPERATIONS_LOG')
    return { path, ...fingerprint }
  } catch { fail('E_OPERATIONS_LOG') }
}
/** Archived paths are exact historical identities, never paths to read.
 * The receipt filename and digest remain bound to each original log path. */
function archivedFile(entry) {
  const match = typeof entry?.path === 'string' && entry.path.match(/^receipts\/(.+)\.(stdout|stderr)\.log$/)
  if (!match || !RECEIPT.test(match[1]) || !Number.isSafeInteger(entry.bytes)
    || entry.bytes < 0 || entry.bytes > MAX_LOG_BYTES || !HASH.test(entry.sha256)
    || typeof entry.original_path !== 'string') fail('E_OPERATIONS_LOG')
  try {
    if (lexical(entry.original_path) !== entry.original_path
      || join(dirname(dirname(entry.original_path)), entry.path) !== entry.original_path) fail('E_OPERATIONS_LOG')
  } catch { fail('E_OPERATIONS_LOG') }
  return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256, original_path: entry.original_path }
}
function readProvenance(root) {
  const path = join(root, PROVENANCE_FILE)
  if (!lstatSync(path, { throwIfNoEntry: false })) return new Map()
  try {
    canonical(path, 'file')
    if (lstatSync(path).size > MAX_MANIFEST_BYTES) fail('E_OPERATIONS_LOG')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (data?.format !== 'imperator-receipt-provenance' || data.version !== 1
      || !Array.isArray(data.files) || data.files.length >= MAX_FILES) fail('E_OPERATIONS_LOG')
    const records = new Map()
    for (const value of data.files) {
      const entry = archivedFile(value)
      if (records.has(entry.path)) fail('E_OPERATIONS_LOG')
      records.set(entry.path, entry)
    }
    return records
  } catch (error) {
    if (error?.code === 'E_OPERATIONS_PATH') throw error
    fail('E_OPERATIONS_LOG')
  }
}
function writeProvenance(root, files) {
  if (!files.length) return
  const text = JSON.stringify({ format: 'imperator-receipt-provenance', version: 1, files }, null, 2) + '\n'
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) fail('E_OPERATIONS_LIMIT')
  writeFileSync(join(root, PROVENANCE_FILE), text, { flag: 'wx', mode: 0o600 })
}
/** References come from the snapshot. Stored paths are provenance, never arbitrary file selectors. */
function receiptFiles(db, originalRoot, provenance = new Map()) {
  if (!hasTable(db, 'execution_receipt')) return []
  const files = []
  for (const row of db.prepare('SELECT receipt_id,status,logs FROM execution_receipt ORDER BY id').iterate()) {
    if (!RECEIPT.test(row.receipt_id)) fail('E_OPERATIONS_LOG')
    if (row.logs === null && row.status === 'pending') continue
    let logs
    try { logs = JSON.parse(row.logs) } catch { fail('E_OPERATIONS_LOG') }
    let total = 0
    for (const stream of ['stdout', 'stderr']) {
      const path = 'receipts/' + row.receipt_id + '.' + stream + '.log', log = logs?.[stream]
      if (!log || !Number.isSafeInteger(log.bytes)
        || log.bytes < 0 || log.bytes > MAX_LOG_BYTES || !HASH.test(log.sha256)) fail('E_OPERATIONS_LOG')
      const file = archivedFile({ path, bytes: log.bytes, sha256: log.sha256, original_path: log.path })
      const archived = provenance.get(path)
      if (archived) {
        // An existing archival identity cannot be rewritten to the local path.
        if (archived.original_path !== log.path || archived.bytes !== log.bytes
          || archived.sha256 !== log.sha256) fail('E_OPERATIONS_LOG')
      } else if (log.path !== join(originalRoot, path)) fail('E_OPERATIONS_LOG')
      total += log.bytes
      files.push(file)
      if (files.length >= MAX_FILES) fail('E_OPERATIONS_LIMIT')
    }
    if (total > MAX_LOG_BYTES) fail('E_OPERATIONS_LOG')
  }
  return files
}
function copyVerified(sourceRoot, destinationRoot, entry) {
  try {
    const from = canonical(join(sourceRoot, entry.path), 'file'), to = join(destinationRoot, entry.path)
    if (entry.path.startsWith('receipts/')) mkdirSync(join(destinationRoot, 'receipts'), { recursive: true, mode: 0o700 })
    const before = fileDigest(from, entry.bytes)
    if (before.sha256 !== entry.sha256) fail('E_OPERATIONS_INTEGRITY')
    copyFileSync(from, to, constants.COPYFILE_EXCL)
    chmodSync(to, 0o600)
    const after = fileDigest(to, entry.bytes)
    if (after.sha256 !== entry.sha256) fail('E_OPERATIONS_INTEGRITY')
  } catch (error) {
    if (error?.code === 'E_OPERATIONS_PATH') throw error
    fail('E_OPERATIONS_INTEGRITY')
  }
}
function syncFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
/** Reserve a fresh destination exclusively; publish the validated sibling by one rename.
 * A crash may leave the empty reservation/staging, never a success manifest. */
async function staged(out, sourceRoot, work) {
  out = lexical(out)
  const parent = canonical(dirname(out), 'directory')
  if (within(sourceRoot, out) || within(out, sourceRoot)) fail('E_OPERATIONS_PATH')
  let reserved, staging, published = false
  try {
    try { mkdirSync(out, { mode: 0o700 }) } catch (error) {
      if (error.code === 'EEXIST') fail('E_OPERATIONS_EXISTS')
      throw error
    }
    reserved = lstatSync(out)
    staging = mkdtempSync(join(parent, '.imperator-stage-'))
    chmodSync(staging, 0o700)
    const result = await work(staging)
    for (const name of readdirSync(staging)) {
      if (lstatSync(join(staging, name)).isFile()) syncFile(join(staging, name))
    }
    if (existsSync(join(staging, 'receipts'))) {
      for (const name of readdirSync(join(staging, 'receipts'))) syncFile(join(staging, 'receipts', name))
      syncFile(join(staging, 'receipts'))
    }
    syncFile(staging)
    const now = lstatSync(out)
    if (now.ino !== reserved.ino || now.dev !== reserved.dev || readdirSync(out).length !== 0) fail('E_OPERATIONS_EXISTS')
    renameSync(staging, out)
    published = true
    syncFile(parent)
    return result
  } finally {
    if (!published) {
      if (staging) rmSync(staging, { recursive: true, force: true })
      if (reserved) {
        try {
          const now = lstatSync(out)
          if (now.ino === reserved.ino && now.dev === reserved.dev) rmdirSync(out)
        } catch { /* never remove someone else's destination or its contents */ }
      }
    }
  }
}
async function snapshot(path, destination) {
  const db = readDatabase(path)
  try { integrity(db); await sqliteBackup(db, destination) }
  catch { fail('E_OPERATIONS_DATABASE') }
  finally { db.close() }
  let copied
  try {
    copied = new DatabaseSync(destination)
    copied.exec('PRAGMA journal_mode=DELETE')
    integrity(copied)
  } finally { copied?.close() }
  chmodSync(destination, 0o600)
}

/** Reports only codes/counts; does not create the root or call TaskforceStore.open. */
export async function doctor({ root } = {}) {
  let db
  const checks = [], counts = {}
  const add = (code, severity = 'error') => checks.push({ code, severity })
  try {
    lexical(root)
    if (!existsSync(root) || !existsSync(join(root, 'taskforce.db'))) {
      add('DATABASE_MISSING')
      return report('doctor', { ok: false, checks, counts, host: 'unverified' })
    }
    const input = source(root)
    db = readDatabase(input.path)
    db.exec('BEGIN DEFERRED')
    integrity(db)
    if (!currentSchema(db)) add('SCHEMA_UPGRADE_REQUIRED')
    else {
      for (const [field, table] of [['tasks', 'task'], ['facts', 'fact'], ['receipts', 'execution_receipt'], ['waivers', 'execution_waiver']]) {
        counts[field] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
      }
      counts.pending_receipts = Number(db.prepare("SELECT COUNT(*) AS n FROM execution_receipt WHERE status IN ('pending','unknown')").get().n)
      counts.scope_anomalies = 0
      for (const table of ['fact', 'handoff', 'execution_receipt', 'execution_waiver']) {
        counts.scope_anomalies += Number(db.prepare('SELECT COUNT(*) AS n FROM ' + table
          + ' f LEFT JOIN task t ON t.id=f.task_id WHERE f.task_id IS NOT NULL AND (t.id IS NULL OR f.run_id IS NOT t.run_id)').get().n)
      }
      counts.invalid_logs = 0
      try {
        const files = receiptFiles(db, input.root, readProvenance(input.root))
        counts.archived_logs = files.filter(file => file.original_path !== join(input.root, file.path)).length
        for (const file of files) {
          try { readLog(input.root, file.path, file) } catch { counts.invalid_logs++ }
        }
      } catch { counts.invalid_logs++ }
      if (counts.archived_logs) add('ARCHIVED_RECEIPT_LOGS', 'info')
      if (counts.invalid_logs) add('RECEIPT_LOG_INVALID')
      if (counts.scope_anomalies) add('SCOPE_INTEGRITY')
      if (counts.pending_receipts) add('EXECUTION_UNRESOLVED', 'warning')
    }
    const journal = db.prepare('PRAGMA journal_mode').get().journal_mode
    db.exec('COMMIT')
    if (!checks.length) add('DATABASE_OK', 'info')
    return report('doctor', { ok: !checks.some(check => check.severity === 'error'), checks, counts,
      journal_mode: ['delete', 'truncate', 'persist', 'memory', 'wal', 'off'].includes(journal) ? journal : 'unknown',
      host: 'unverified' })
  } catch (error) {
    add(error?.code === 'E_OPERATIONS_PATH' ? 'PATH_UNSAFE' : 'DATABASE_INVALID')
    return report('doctor', { ok: false, checks, counts, host: 'unverified' })
  } finally { db?.close() }
}

export async function backup({ root, out } = {}) {
  try {
    const input = source(root)
    return await staged(out, input.root, async staging => {
      const path = join(staging, 'taskforce.db')
      await snapshot(input.path, path)
      const db = readDatabase(path)
      let files, fingerprint
      try {
        integrity(db)
        if (!hasTable(db, 'task')) fail('E_OPERATIONS_SCHEMA')
        fingerprint = schemaHash(db)
        files = receiptFiles(db, input.root, readProvenance(input.root))
      } finally { db.close() }
      for (const entry of files) {
        readLog(input.root, entry.path, entry)
        try { copyVerified(input.root, staging, entry) } catch { fail('E_OPERATIONS_LOG') }
      }
      files.unshift({ path: 'taskforce.db', ...fileDigest(path) })
      const manifest = { format: 'imperator-backup', version: 1, source_root: input.root,
        schema_sha256: fingerprint, files }
      const json = JSON.stringify(manifest, null, 2) + '\n'
      if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) fail('E_OPERATIONS_LIMIT')
      writeFileSync(join(staging, 'manifest.json'), json, { flag: 'wx', mode: 0o600 })
      return report('backup', { ok: true, files: files.length, bytes: files.reduce((n, file) => n + file.bytes, 0),
        database_sha256: files[0].sha256, manifest_sha256: digest(json) })
    })
  } catch (error) { boundary(error) }
}

/** Hash every original row/column, including identities and BLOB/integer values. */
function retained(db, definitions) {
  definitions ??= db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => ({ name, columns: columns(db, name) }))
  return definitions.map(definition => {
    const fields = definition.columns.map(identifier).join(',')
    const statement = db.prepare('SELECT ' + fields + ' FROM ' + identifier(definition.name) + ' ORDER BY ' + fields)
    statement.setReadBigInts(true)
    const hash = createHash('sha256')
    let rows = 0
    for (const row of statement.iterate()) {
      hash.update(JSON.stringify(definition.columns.map(column => row[column]),
        (_key, value) => typeof value === 'bigint' ? { integer: value.toString() } : value) + '\n')
      rows++
    }
    return { ...definition, rows, sha256: hash.digest('hex') }
  })
}
export async function preflight({ root } = {}) {
  let temporary, migrated
  try {
    const input = source(root)
    temporary = mkdtempSync(join(realpathSync(tmpdir()), 'imperator-preflight-'))
    chmodSync(temporary, 0o700)
    const path = join(temporary, 'taskforce.db')
    await snapshot(input.path, path)
    const beforeDb = readDatabase(path)
    let before, beforeSchema
    try { before = retained(beforeDb); beforeSchema = schemaHash(beforeDb) }
    finally { beforeDb.close() }
    try {
      migrated = new TaskforceStore(temporary)
      const db = migrated.open()
      integrity(db)
      const after = retained(db, before)
      if (JSON.stringify(after) !== JSON.stringify(before)) fail('E_OPERATIONS_SCHEMA')
      if (!currentSchema(db)) fail('E_OPERATIONS_SCHEMA')
      return report('preflight', { ok: true, rows_preserved: true,
        migration_required: schemaHash(db) !== beforeSchema,
        tables_checked: before.length, rows_checked: before.reduce((n, table) => n + table.rows, 0) })
    } catch { fail('E_OPERATIONS_SCHEMA') }
  } catch (error) { boundary(error) }
  finally {
    migrated?.close()
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}
function readManifest(root) {
  try {
    const path = canonical(join(root, 'manifest.json'), 'file')
    if (lstatSync(path).size > MAX_MANIFEST_BYTES) fail('E_OPERATIONS_MANIFEST')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    if (manifest?.format !== 'imperator-backup' || manifest.version !== 1
      || !HASH.test(manifest.schema_sha256) || !Array.isArray(manifest.files)
      || manifest.files.length < 1 || manifest.files.length > MAX_FILES) fail('E_OPERATIONS_MANIFEST')
    lexical(manifest.source_root)
    const paths = new Set()
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== 'string'
        || !(entry.path === 'taskforce.db' || /^receipts\/[a-f0-9-]{36}\.(stdout|stderr)\.log$/.test(entry.path))
        || paths.has(entry.path) || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.bytes)
        || entry.bytes < 0 || (entry.path !== 'taskforce.db' && entry.bytes > MAX_LOG_BYTES)) fail('E_OPERATIONS_MANIFEST')
      if (entry.path !== 'taskforce.db') {
        // Version-1 backups without an explicit path used one source root.
        entry.original_path ??= join(manifest.source_root, entry.path)
        archivedFile(entry)
      } else if (entry.original_path !== undefined) fail('E_OPERATIONS_MANIFEST')
      paths.add(entry.path)
    }
    if (!paths.has('taskforce.db')) fail('E_OPERATIONS_MANIFEST')
    const actual = new Set(['manifest.json', ...paths])
    for (const name of readdirSync(root)) {
      if (name === 'receipts') {
        canonical(join(root, name), 'directory')
        for (const log of readdirSync(join(root, name))) {
          if (!actual.has('receipts/' + log)) fail('E_OPERATIONS_MANIFEST')
        }
      } else if (!actual.has(name)) fail('E_OPERATIONS_MANIFEST')
    }
    return manifest
  } catch (error) {
    if (error?.code === 'E_OPERATIONS_PATH') throw error
    fail('E_OPERATIONS_MANIFEST')
  }
}
export async function restore({ backup: backupRoot, out } = {}) {
  try {
    backupRoot = canonical(backupRoot, 'directory')
    const manifest = readManifest(backupRoot)
    const sourceRoot = lexical(manifest.source_root), target = lexical(out)
    if (within(sourceRoot, target) || within(target, sourceRoot)) fail('E_OPERATIONS_PATH')
    return await staged(out, backupRoot, async staging => {
      for (const file of manifest.files) copyVerified(backupRoot, staging, file)
      const db = readDatabase(join(staging, 'taskforce.db'))
      let receipts
      try {
        integrity(db)
        if (!hasTable(db, 'task') || schemaHash(db) !== manifest.schema_sha256) fail('E_OPERATIONS_SCHEMA')
        receipts = receiptFiles(db, sourceRoot, new Map(manifest.files.filter(file => file.path !== 'taskforce.db').map(file => [file.path, file])))
        const expected = receipts.map(file => JSON.stringify(file)).sort()
        const actual = manifest.files.filter(file => file.path !== 'taskforce.db')
          .map(file => JSON.stringify(archivedFile(file))).sort()
        if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('E_OPERATIONS_MANIFEST')
        for (const file of receipts) readLog(staging, file.path, file)
      } finally { db.close() }
      writeProvenance(staging, receipts)
      return report('restore', { ok: true, files: manifest.files.length, audit_preserved: true,
        reverification_required: receipts.length > 0, production_replaced: false })
    })
  } catch (error) { boundary(error) }
}
