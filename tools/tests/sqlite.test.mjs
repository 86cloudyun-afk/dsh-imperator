import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskforceStore } from '../../lib/store/index.js'
import { configureSqlite, normalizeSqliteError, normalizeSqliteOptions, withWriteTransaction } from '../../lib/store/sqlite.js'
import { tempStore, seedSubmitted } from './helpers.mjs'

test('validates SQLite options and preserves or explicitly selects WAL', (t) => {
  assert.deepEqual(normalizeSqliteOptions(), { busyTimeoutMs: 1000, journalMode: 'preserve' })
  for (const busyTimeoutMs of [-1, 5001, 1.5, '1000']) {
    assert.throws(() => normalizeSqliteOptions({ busyTimeoutMs }), { code: 'E_STORE_CONFIG' })
  }
  assert.throws(() => normalizeSqliteOptions({ journalMode: 'delete' }), { code: 'E_STORE_CONFIG' })
  assert.deepEqual(normalizeSqliteOptions({ busyTimeoutMs: 5000 }), { busyTimeoutMs: 5000, journalMode: 'preserve' })
  const memory = new DatabaseSync(':memory:')
  t.after(() => memory.close())
  assert.throws(() => configureSqlite(memory, { journalMode: 'wal' }), { code: 'E_STORE_JOURNAL_MODE' })
  const store = tempStore(t, { busyTimeoutMs: 0, journalMode: 'wal' })
  assert.equal(store.open().prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  store.handle.close()
  store.handle = null
  const preserved = new TaskforceStore(store.root)
  t.after(() => preserved.close())
  assert.equal(preserved.open().prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
})

test('rolls back outer work and only an inner failed savepoint', (t) => {
  const db = tempStore(t).open()
  db.exec('CREATE TABLE tx_test(value INTEGER)')
  assert.throws(() => withWriteTransaction(db, () => {
    db.exec('INSERT INTO tx_test VALUES (1)')
    throw new Error('abort')
  }), /abort/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_test').get().n, 0)
  withWriteTransaction(db, () => {
    db.exec('INSERT INTO tx_test VALUES (2)')
    assert.throws(() => withWriteTransaction(db, () => {
      db.exec('INSERT INTO tx_test VALUES (3)')
      throw new Error('inner')
    }), /inner/)
    db.exec('INSERT INTO tx_test VALUES (4)')
  })
  assert.deepEqual(db.prepare('SELECT value FROM tx_test ORDER BY value').all().map(x => x.value), [2, 4])
  assert.throws(() => withWriteTransaction(db, () => {
    withWriteTransaction(db, () => db.exec('INSERT INTO tx_test VALUES (5)'))
    throw new Error('outer')
  }), /outer/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_test').get().n, 2)
})

test('rejects asynchronous work and leaves no transaction', (t) => {
  const db = tempStore(t).open()
  assert.throws(() => withWriteTransaction(db, () => Promise.resolve()), { code: 'E_STORE_ASYNC_TRANSACTION' })
  assert.equal(db.isTransaction, false)
  assert.equal(withWriteTransaction(db, () => 42), 42)
})

test('maps only SQLite primary busy or locked errors', (t) => {
  const store = tempStore(t, { busyTimeoutMs: 0 })
  const db = store.open()
  db.exec('CREATE TABLE tx_test(value INTEGER)')
  const other = new DatabaseSync(store.dbPath)
  t.after(() => other.close())
  other.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(() => withWriteTransaction(db, () => db.exec('INSERT INTO tx_test VALUES (1)')), { code: 'E_STORE_BUSY' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_test').get().n, 0)
  } finally { other.exec('ROLLBACK') }
  withWriteTransaction(db, () => db.exec('INSERT INTO tx_test VALUES (2)'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_test').get().n, 1)
  const business = Object.assign(new Error('business'), { code: 'E_BUSINESS' })
  assert.equal(normalizeSqliteError(business), business)
  assert.equal(normalizeSqliteError(Object.assign(new Error('other SQLite'), { code: 'ERR_SQLITE_ERROR', errcode: 1 })).code, 'ERR_SQLITE_ERROR')
  const locked = Object.assign(new Error('locked'), { code: 'ERR_SQLITE_ERROR', errcode: 262, rollbackError: new Error('rollback'), transactionStateUnknown: true })
  const mapped = normalizeSqliteError(locked)
  assert.equal(mapped.code, 'E_STORE_BUSY')
  assert.equal(mapped.cause, locked)
  assert.equal(mapped.rollbackError, locked.rollbackError)
  assert.equal(mapped.transactionStateUnknown, true)
})

test('startup lock maps to busy and a failed connection is closed before retry', (t) => {
  for (const journalMode of ['preserve', 'wal']) {
    const store = tempStore(t, { busyTimeoutMs: 0, journalMode })
    const blocker = new DatabaseSync(store.dbPath)
    t.after(() => blocker.close())
    blocker.exec('BEGIN EXCLUSIVE')
    const originalClose = DatabaseSync.prototype.close
    const closed = []
    DatabaseSync.prototype.close = function () {
      closed.push(this)
      return originalClose.call(this)
    }
    try {
      let failure
      try { store.open() } catch (error) { failure = error }
      assert.equal(failure?.code, 'E_STORE_BUSY')
      assert.equal(failure.cause.code, 'E_STORE_BUSY')
      assert.equal(failure.cause.cause.code, 'ERR_SQLITE_ERROR')
      assert.equal(failure.cause.cause.errcode & 0xff, 5)
      assert.match(failure.message, /稍后.*重试/)
      assert.doesNotMatch(failure.message, /写权限|磁盘空间/)
      assert.equal(store.handle, null)
      assert.equal(closed.length, 1)
      assert.equal(closed[0].isOpen, false)
    } finally {
      DatabaseSync.prototype.close = originalClose
      blocker.exec('ROLLBACK')
    }
    assert.equal(store.open().isOpen, true)
  }
})

test('preserves commit error and annotates failed rollback', (t) => {
  const store = tempStore(t)
  const db = store.open()
  const execute = db.exec.bind(db)
  const commitFailure = new Error('commit failed')
  const rollbackFailure = new Error('rollback failed')
  db.exec = (sql) => {
    if (sql === 'COMMIT') throw commitFailure
    if (sql === 'ROLLBACK') throw rollbackFailure
    return execute(sql)
  }
  let error
  try { withWriteTransaction(db, () => 1) } catch (caught) { error = caught }
  assert.equal(error, commitFailure)
  assert.equal(error.rollbackError, rollbackFailure)
  assert.equal(error.transactionStateUnknown, true)
  assert.equal(db.isOpen, false)
  assert.equal(store.handle, null)
  assert.notEqual(store.open(), db)
})

test('preserves work error when its rollback also fails', (t) => {
  const store = tempStore(t)
  const db = store.open()
  const execute = db.exec.bind(db)
  const workError = Object.assign(new Error('business refused'), { code: 'E_BUSINESS' })
  const rollbackError = new Error('rollback failed')
  db.exec = (sql) => {
    if (sql === 'ROLLBACK') throw rollbackError
    return execute(sql)
  }
  let caught
  try { withWriteTransaction(db, () => { throw workError }) } catch (error) { caught = error }
  assert.equal(caught, workError)
  assert.equal(caught.code, 'E_BUSINESS')
  assert.equal(caught.rollbackError, rollbackError)
  assert.equal(caught.transactionStateUnknown, true)
  assert.equal(store.handle, null)
})

test('nested unwind preserves the first failed rollback diagnostic', (t) => {
  const store = tempStore(t)
  const db = store.open()
  const execute = db.exec.bind(db)
  const workError = new Error('inner work failed')
  const firstRollback = new Error('inner savepoint rollback failed')
  db.exec = (sql) => {
    if (sql.startsWith('ROLLBACK TO SAVEPOINT')) throw firstRollback
    return execute(sql)
  }
  let caught
  try {
    withWriteTransaction(db, () => withWriteTransaction(db, () => { throw workError }))
  } catch (error) { caught = error }
  assert.equal(caught, workError)
  assert.equal(caught.rollbackError, firstRollback)
  assert.equal(caught.transactionStateUnknown, true)
  assert.equal(db.isOpen, false)
  assert.equal(store.handle, null)
})

test('failed migration rolls back schema and same store retries cleanly', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'taskforce-legacy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'taskforce.db')
  const seed = new DatabaseSync(path)
  seed.exec(`CREATE TABLE task(id INTEGER PRIMARY KEY, title TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE fact(id INTEGER PRIMARY KEY, task_id INTEGER, kind TEXT, statement TEXT, confidence TEXT, created_at TEXT);
    CREATE TABLE handoff(id INTEGER PRIMARY KEY, task_id INTEGER, note TEXT, created_at TEXT);`)
  seed.close()
  const store = new TaskforceStore(root)
  t.after(() => store.close())
  const original = DatabaseSync.prototype.exec
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.startsWith('ALTER TABLE fact ADD COLUMN run_id')) throw new Error('injected migration failure')
    return original.call(this, sql)
  }
  try { assert.throws(() => store.open(), /injected migration failure/) }
  finally { DatabaseSync.prototype.exec = original }
  assert.equal(store.handle, null)
  assert.deepEqual(store.migration, { added_columns: [], unassigned: { task: 0, fact: 0, handoff: 0 } })
  const inspect = new DatabaseSync(path)
  assert.equal(inspect.prepare('PRAGMA table_info(task)').all().some(x => x.name === 'run_id'), false)
  assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='view'").get().n, 0)
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.startsWith('ALTER TABLE fact ADD COLUMN run_id')) throw new Error('injected direct migration failure')
    return original.call(this, sql)
  }
  try { assert.throws(() => store.migrate(inspect), /injected direct migration failure/) }
  finally { DatabaseSync.prototype.exec = original }
  assert.equal(inspect.prepare('PRAGMA table_info(task)').all().some(x => x.name === 'run_id'), false)
  inspect.close()
  assert.equal(store.open().prepare('PRAGMA table_info(task)').all().some(x => x.name === 'run_id'), true)
  assert.deepEqual(store.migration.added_columns.sort(),
    ['fact.actor_session', 'fact.resolves_fact_id', 'fact.run_id', 'handoff.run_id', 'task.owner_session', 'task.run_id'])
})

test('shared fixture creates a submitted task with a plausible artifact', (t) => {
  const store = tempStore(t)
  const id = seedSubmitted(store, 'fixture-run')
  const fact = store.open().prepare("SELECT confidence, kind, evidence_path FROM fact WHERE task_id=? AND kind='artifact'").get(id)
  assert.deepEqual({ ...fact }, { confidence: 'PLAUSIBLE', kind: 'artifact', evidence_path: 'artifact.txt' })
  assert.equal(store.open().prepare('SELECT status FROM task WHERE id=?').get(id).status, 'submitted')
})
