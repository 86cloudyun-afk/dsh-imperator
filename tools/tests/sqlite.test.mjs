import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskforceStore } from '../../lib/store/index.js'
import { configureSqlite, normalizeSqliteError, normalizeSqliteOptions, withWriteTransaction,
  sqliteTextCompanion, restoreSqliteText, prepareSqliteTextProjection } from '../../lib/store/sqlite.js'
import { tempStore, seedSubmitted } from './helpers.mjs'

test('SQLite TEXT primitives preserve native values, row shape, and integer conversion settings', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE text_read(value, __companion TEXT, "__proto__" TEXT, constructor INTEGER, "12" TEXT, "2" TEXT, extra BLOB, empty, integer_value INTEGER, "", "odd""列😀")')
  const samples = ['', 'plain', 'T', 'J', 'J"pretend"', 'Tordinary', '"json"', '\\u0000', '\0', 'left\0right', '中\0文😀e\u0301\r\n\u0001', null, 1.25, 42n, new Uint8Array([0,255])]
  for (const value of samples) {
    db.exec('DELETE FROM text_read')
    db.prepare('INSERT INTO text_read VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(value, 'legacy companion', 'prototype data', 27, 'twelve', 'two', new Uint8Array([0,255]), null, 42, 'empty name', 'quoted Unicode name')
    const nativeStatement = db.prepare('SELECT * FROM text_read'), native = nativeStatement.get()
    const projected = db.prepare('SELECT value, ' + sqliteTextCompanion('value', '__text') + ' FROM text_read')
    const explicit = restoreSqliteText(projected.get(), 'value', '__text')
    const expected = typeof value === 'bigint' ? Number(value) : value
    assert.deepEqual(explicit.value, expected)
    assert.deepEqual(Object.keys(explicit), ['value']); assert.equal(Object.getPrototypeOf(explicit), null)
    const { statement: wildcard, restore } = prepareSqliteTextProjection(db, 'value', 'text_read', (projection = '*') => 'SELECT ' + projection + ' FROM text_read')
    const encoded = wildcard.get(), row = restore(encoded)
    assert.equal(row, encoded)
    const descriptors = Object.getOwnPropertyDescriptors(native); descriptors.value.value = expected
    assert.deepEqual(Object.getOwnPropertyDescriptors(row), descriptors)
    assert.deepEqual(Object.keys(row), Object.keys(native)); assert.equal(Object.getPrototypeOf(row), null)
    assert.deepEqual(wildcard.all().map(restore), [row])
    db.prepare('UPDATE text_read SET integer_value=?').run(9007199254740993n)
    assert.throws(() => wildcard.get(), { code: 'ERR_OUT_OF_RANGE' })
    wildcard.setReadBigInts(true)
    assert.equal(restore(wildcard.get()).integer_value, 9007199254740993n)
    assert.equal(restore(wildcard.get()).constructor, 27n)
    db.prepare('UPDATE text_read SET integer_value=?').run(42)
    db.prepare('UPDATE text_read SET value=?').run(9007199254740993n)
    const integers = prepareSqliteTextProjection(db, 'value', 'text_read', (projection = '*') => 'SELECT ' + projection + ' FROM text_read')
    assert.throws(() => nativeStatement.get(), { code: 'ERR_OUT_OF_RANGE' })
    assert.throws(() => integers.statement.get(), { code: 'ERR_OUT_OF_RANGE' })
    integers.statement.setReadBigInts(true)
    assert.equal(integers.restore(integers.statement.get()).value, 9007199254740993n)
    db.exec('DELETE FROM text_read')
    assert.equal(restore(wildcard.get()), undefined)
    assert.deepEqual(wildcard.all().map(restore), [])
    assert.equal(restoreSqliteText(projected.get(), 'value', '__text'), undefined)
  }
})

test('Task16 target lists reject holes before factory or native calls and keep empty identifiers valid', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE source(value, other, ""); INSERT INTO source VALUES(1,2,3)')
  const inherited = new Array(1), proto = Object.create(Array.prototype)
  proto[0] = 'value'; Object.setPrototypeOf(inherited, proto)
  for (const fields of [new Array(1), ['value', ,], [, 'value'], inherited, ['value', undefined], [], ['value', 'value'], null, 1]) {
    let factories = 0, prepares = 0, metadata = 0
    const calls = { get: 0, all: 0, iterate: 0, run: 0 }
    const tracked = { prepare(sql) {
      prepares++; const statement = db.prepare(sql), columns = statement.columns.bind(statement)
      statement.columns = () => { metadata++; return columns() }
      for (const method of Object.keys(calls)) { const read = statement[method].bind(statement); statement[method] = (...args) => { calls[method]++; return read(...args) } }
      return statement
    } }
    for (const suffix of ['', ' WHERE 0']) {
      assert.throws(() => prepareSqliteTextProjection(tracked, fields, 'source', (projection = '*') => {
        factories++; return 'SELECT ' + projection + ' FROM source' + suffix
      }), { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
      assert.equal(factories, 0); assert.equal(prepares, 0); assert.equal(metadata, 0)
      assert.deepEqual(calls, { get: 0, all: 0, iterate: 0, run: 0 })
    }
  }
  for (const fields of ['value', ['value'], ['value', 'other'], '', ['']]) {
    const { statement, restore } = prepareSqliteTextProjection(db, fields, 'source', (projection = '*') => 'SELECT ' + projection + ' FROM source')
    assert.deepEqual({ ...restore(statement.get()) }, { value: 1, other: 2, '': 3 })
  }
})

test('Task16 multi-target projection keeps maximum native width and per-call empty result accounting', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const names = ['value', 'other', '', '__proto__', '12', '2', 'odd"列', ...Array.from({ length: 1993 }, (_, i) => 'extra_' + i)]
  const quote = name => '"' + name.replaceAll('"', '""') + '"'
  db.exec('CREATE TABLE source(' + names.map(quote).join(',') + ')')
  db.prepare('INSERT INTO source(value,other,"","__proto__","12","2","odd""列") VALUES(?,?,?,?,?,?,?)')
    .run('left\0right', 'Jordinary', 'empty', 'prototype', 'twelve', 'two', 'quoted')
  const original = db.prepare('SELECT * FROM source'), native = original.get()
  assert.equal(original.columns().length, 2000); assert.equal(Object.keys(native).length, 2000)
  for (const [method, suffix] of [['get', ''], ['all', ''], ['iterate', ''], ['get', ' WHERE 0'], ['all', ' WHERE 0']]) {
    const observations = []
    const tracked = { prepare(sql) {
      const statement = db.prepare(sql), calls = { get: 0, all: 0, iterate: 0, run: 0 }; observations.push(calls)
      for (const name of Object.keys(calls)) { const read = statement[name].bind(statement); statement[name] = (...args) => { calls[name]++; return read(...args) } }
      return statement
    } }
    const { statement, restore } = prepareSqliteTextProjection(tracked, ['value', 'other'], 'source', (projection = '*') => 'SELECT ' + projection + ' FROM source' + suffix)
    assert.equal(statement.columns().length, 2000)
    const result = statement[method](), rows = method === 'get' ? [result] : [...result]
    if (suffix) assert.deepEqual(rows.map(restore), method === 'get' ? [undefined] : [])
    else for (const encoded of rows) {
      assert.equal(restore(encoded), encoded); assert.equal(encoded.value, 'left\0right'); assert.equal(encoded.other, 'Jordinary')
      const descriptors = Object.getOwnPropertyDescriptors(native); descriptors.value.value = 'left\0right'
      assert.deepEqual(Object.getOwnPropertyDescriptors(encoded), descriptors)
      assert.deepEqual(Object.keys(encoded), Object.keys(native)); assert.equal(Object.getPrototypeOf(encoded), null)
    }
    assert.deepEqual(observations, [{ get: 0, all: 0, iterate: 0, run: 0 }, { get: 0, all: 0, iterate: 0, run: 0, [method]: 1 }])
  }
})

test('Task16 multi-target faults reject each transported field with exact native call and injection counts', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE source(value, other); INSERT INTO source VALUES(1,2)')
  for (const field of ['value', 'other']) for (const fault of ['metadata', 'missing', 'tag', 'descriptor']) {
    const calls = [{ get: 0, all: 0, iterate: 0, run: 0 }, { get: 0, all: 0, iterate: 0, run: 0 }]
    let prepares = 0, injections = 0
    const tracked = { prepare(sql) {
      const index = prepares++, statement = db.prepare(sql), columns = statement.columns.bind(statement)
      statement.columns = () => { const result = columns(); if (index === 1 && fault === 'metadata') { result.find(c => c.name === field).name = 'wrong'; injections++ } return result }
      for (const method of Object.keys(calls[index])) {
        const read = statement[method].bind(statement)
        statement[method] = (...args) => {
          calls[index][method]++; const row = read(...args)
          if (index === 1 && method === 'get') {
            injections++
            if (fault === 'missing') delete row[field]
            if (fault === 'tag') row[field] = 'J"no NUL"'
            if (fault === 'descriptor') Object.defineProperty(row, field, { writable: false })
          }
          return row
        }
      }
      return statement
    } }
    assert.throws(() => {
      const { statement, restore } = prepareSqliteTextProjection(tracked, ['value', 'other'], 'source', (projection = '*') => 'SELECT ' + projection + ' FROM source')
      restore(statement.get())
    }, { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
    assert.equal(injections, 1)
    assert.deepEqual(calls, [{ get: 0, all: 0, iterate: 0, run: 0 }, { get: fault === 'metadata' ? 0 : 1, all: 0, iterate: 0, run: 0 }])
  }
})

test('SQLite TEXT projection rejects malformed metadata, transports and native object descriptors', () => {
  const metadata = [{ name: 'value' }, { name: 'other' }]
  const prepare = (...args) => {
    const first = args.length > 0 ? args[0] : metadata, second = args.length > 1 ? args[1] : metadata
    let prepares = 0
    return prepareSqliteTextProjection({ prepare() { const columns = prepares++ === 0 ? first : second; return { columns: () => columns } } },
      'value', 'static_alias', projection => projection ?? 'original')
  }
  const invalid = work => assert.throws(work, { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
  for (const columns of [undefined, null, [], new Array(2), [null], [{ name: 1 }], [{ name: 'other' }],
    [{ name: 'value' }, { name: 'value' }], [...metadata, { name: 'other' }]]) invalid(() => prepare(columns))
  for (const columns of [undefined, null, [], [{ name: 'value' }], metadata.toReversed(), [...metadata, { name: 'extra' }],
    [{ name: 'value' }, { name: 'changed' }]]) invalid(() => prepare(metadata, columns))
  const { restore } = prepare(), row = value => Object.assign(Object.create(null), { value, other: 42 })
  for (const value of ['', 'unmarked private sentinel', 'Xprivate sentinel', 'Tprivate\0sentinel', 'Jbad JSON',
    'Jnull', 'J7', 'Jtrue', 'J[]', 'J{}', 'J"no NUL"', undefined, true, {}, [], new Uint16Array([1])]) invalid(() => restore(row(value)))
  for (const value of [null, [], 7, 'Tvalue', {}, { value: 'Tvalue', other: 42 },
    Object.assign(Object.create(null), { other: 42 }), Object.assign(row('Tvalue'), { extra: 1 }),
    Object.assign(row('Tvalue'), { [Symbol('extra')]: 1 })]) invalid(() => restore(value))
  for (const flag of ['writable', 'enumerable', 'configurable']) {
    const value = row('Tvalue'); Object.defineProperty(value, 'value', { [flag]: false }); invalid(() => restore(value))
  }
  let getters = 0
  for (const field of ['value', 'other']) {
    const value = row('Tvalue'); Object.defineProperty(value, field, { get() { getters++; return 'private sentinel' } }); invalid(() => restore(value))
  }
  assert.equal(getters, 0)
  const parse = JSON.parse
  try {
    JSON.parse = () => assert.fail('ordinary TEXT must not be parsed')
    for (const text of ['', 'T', 'J', 'J"pretend"', '"JSON\\u0000literal"']) {
      assert.equal(restore(row('T' + text)).value, text)
      assert.equal(restoreSqliteText({ value: text, companion: null }, 'value', 'companion').value, text)
    }
  } finally { JSON.parse = parse }
  assert.equal(restore(row('J"prefix\\u0000suffix"')).value, 'prefix\0suffix')
  const native = Object.assign(new Error('native failure'), { code: 'ERR_SQLITE_ERROR' })
  for (const db of [{ prepare() { throw native } }, { prepare() { return { columns() { throw native } } } }]) {
    assert.throws(() => prepareSqliteTextProjection(db, 'value', 'f', () => 'query'), error => error === native)
  }
})

test('SQLite TEXT projection executes only its replacement and refreshes columns after DDL', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec("CREATE TABLE source(value); INSERT INTO source VALUES('ordinary')")
  const observations = []
  const tracked = { prepare(sql) {
    const statement = db.prepare(sql), record = { sql, get: 0, all: 0, iterate: 0, run: 0 }
    observations.push(record)
    for (const method of ['get', 'all', 'iterate', 'run']) {
      const read = statement[method].bind(statement)
      statement[method] = (...args) => { record[method]++; return read(...args) }
    }
    statement.setReturnArrays = () => assert.fail('native object rows are required')
    statement.setReadBigInts = () => assert.fail('helper must preserve integer mode')
    return statement
  } }
  const query = (projection = '*') => 'SELECT ' + projection + ' FROM source AS caller_alias'
  for (const added of [false, true]) {
    if (added) db.exec('ALTER TABLE source ADD COLUMN "new""列"; UPDATE source SET "new""列"=42')
    const { statement, restore } = prepareSqliteTextProjection(tracked, 'value', 'caller_alias', query)
    const row = statement.get(); assert.equal(restore(row), row); assert.equal(row.value, 'ordinary')
    if (added) assert.equal(row['new"列'], 42)
    assert.deepEqual(Object.keys(row), added ? ['value', 'new"列'] : ['value'])
  }
  assert.equal(observations.length, 4)
  assert.deepEqual(observations.map(({ sql, ...calls }) => calls), [
    { get: 0, all: 0, iterate: 0, run: 0 }, { get: 1, all: 0, iterate: 0, run: 0 },
    { get: 0, all: 0, iterate: 0, run: 0 }, { get: 1, all: 0, iterate: 0, run: 0 },
  ])
})

for (const companion of [undefined, 7, false, {}, 'bad JSON', 'null', '[]', '"plain"']) {
  test(`SQLite TEXT invalid object evidence fails closed through detail: ${JSON.stringify(companion)}`, t => {
    const store = tempStore(t), id = store.openTask('text', 'run').task_id
    store.recordFact({ task_id: id, statement: 'private\0sentinel' }, 'run')
    const db = store.open(), prepare = db.prepare.bind(db)
    let injections = 0
    db.prepare = sql => {
      const statement = prepare(sql)
      if (sql.startsWith('SELECT id, task_id, kind, statement,')) {
        const all = statement.all.bind(statement)
        statement.all = (...args) => all(...args).map(row => {
          injections++
          if (companion === undefined) delete row.__imperator_nul_statement
          else row.__imperator_nul_statement = companion
          return row
        })
      }
      return statement
    }
    assert.throws(() => store.board({ task_id: id }, 'run'), { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
    assert.equal(injections, 1)
    assert.equal(db.isTransaction, false)
  })
}

for (const fault of ['missing column', 'extra column', 'array row', 'wrong name', 'wrong order', 'wrong count', 'missing target', 'duplicate target', 'duplicate name']) {
  test(`SQLite TEXT wildcard layout fails closed through facts page: ${fault}`, t => {
    const store = tempStore(t), id = store.openTask('text', 'run').task_id
    store.recordFact({ task_id: id, statement: 'private\0sentinel' }, 'run')
    const db = store.open(), prepare = db.prepare.bind(db)
    let injections = 0
    const calls = { original: { get: 0, all: 0, iterate: 0, run: 0 }, generated: { get: 0, all: 0, iterate: 0, run: 0 } }
    db.prepare = sql => {
      const statement = prepare(sql)
      const original = sql.startsWith('SELECT f.*'), replacement = sql.includes("THEN 'J'||json_quote(")
      if ((original || replacement) && sql.includes('ORDER BY f.id DESC LIMIT')) {
        for (const method of ['get', 'all', 'iterate', 'run']) {
          const read = statement[method].bind(statement)
          statement[method] = (...args) => { calls[original ? 'original' : 'generated'][method]++; return read(...args) }
        }
        const all = statement.all.bind(statement), columns = statement.columns.bind(statement)
        statement.columns = () => {
          const metadata = columns()
          if (replacement && fault === 'wrong name') { metadata.at(-1).name = 'wrong'; injections++ }
          if (replacement && fault === 'wrong order') { [metadata[0], metadata[1]] = [metadata[1], metadata[0]]; injections++ }
          if (replacement && fault === 'wrong count') { metadata.pop(); injections++ }
          if (original && fault === 'missing target') { metadata.find(c => c.name === 'statement').name = 'missing'; injections++ }
          if (original && fault === 'duplicate target') { metadata[0].name = 'statement'; injections++ }
          if (original && fault === 'duplicate name') { metadata[0].name = metadata[1].name; injections++ }
          return metadata
        }
        statement.all = (...args) => all(...args).map(row => {
          if (replacement && ['missing column', 'extra column', 'array row'].includes(fault)) injections++
          if (replacement && fault === 'missing column') delete row.statement
          if (replacement && fault === 'extra column') row.extra = null
          return replacement && fault === 'array row' ? Object.values(row) : row
        })
      }
      return statement
    }
    assert.throws(() => store.boardPage({ view: 'facts', task_id: id }, 'run'), { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
    assert.equal(injections, 1)
    assert.deepEqual(calls, { original: { get: 0, all: 0, iterate: 0, run: 0 },
      generated: { get: 0, all: ['missing column', 'extra column', 'array row'].includes(fault) ? 1 : 0, iterate: 0, run: 0 } })
    assert.equal(db.isTransaction, false)
  })
}

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
  assert.deepEqual(store.migration, { added_columns: [], unassigned: { task: 0, fact: 0, handoff: 0, execution_receipts: 0, execution_waivers: 0 } })
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
    ['fact.actor_session', 'fact.resolves_fact_id', 'fact.run_id', 'handoff.run_id', 'task.evidence_generation', 'task.evidence_policy', 'task.owner_session', 'task.run_id', 'task.submitted_at', 'task.verification_command', 'task.verification_cwd', 'task.verification_files'])
})

test('shared fixture creates a submitted task with a plausible artifact', (t) => {
  const store = tempStore(t)
  const id = seedSubmitted(store, 'fixture-run')
  const fact = store.open().prepare("SELECT confidence, kind, evidence_path FROM fact WHERE task_id=? AND kind='artifact'").get(id)
  assert.deepEqual({ ...fact }, { confidence: 'PLAUSIBLE', kind: 'artifact', evidence_path: 'artifact.txt' })
  assert.equal(store.open().prepare('SELECT status FROM task WHERE id=?').get(id).status, 'submitted')
})
