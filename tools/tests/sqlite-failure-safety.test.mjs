import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withWriteTransaction } from '../../lib/store/sqlite.js'
import { tempStore } from './helpers.mjs'

for (const failure of [null, 'primitive failure', Object.freeze(new Error('frozen failure'))]) {
  test(`failed rollback always invalidates the handle for ${String(failure)}`, (t) => {
    const store = tempStore(t)
    const db = store.open()
    const execute = db.exec.bind(db)
    const rollback = new Error('rollback failed')
    db.exec = sql => { if (sql === 'ROLLBACK') throw rollback; return execute(sql) }
    let caught
    try { withWriteTransaction(db, () => { throw failure }) } catch (error) { caught = error }
    assert.equal(db.isOpen, false)
    assert.equal(store.handle, null)
    assert.equal(caught.transactionStateUnknown, true)
    assert.equal(caught.rollbackError, rollback)
    assert.equal(caught.cause, failure)
    assert.notEqual(store.open(), db)
  })
}
test('a poisoned diagnostic accessor cannot keep an uncertain transaction handle published', (t) => {
  const store = tempStore(t)
  const db = store.open()
  const execute = db.exec.bind(db)
  const failure = Object.defineProperty(new Error('original'), 'rollbackError', { get() { throw new Error('accessor') } })
  db.exec = sql => { if (sql === 'ROLLBACK') throw new Error('rollback'); return execute(sql) }
  let caught
  try { withWriteTransaction(db, () => { throw failure }) } catch (error) { caught = error }
  assert.equal(db.isOpen, false)
  assert.equal(store.handle, null)
  assert.equal(caught.cause, failure)
  assert.equal(caught.transactionStateUnknown, true)
})
for (const makeWork of [
  hit => async () => { hit(); await Promise.resolve(); hit() },
  hit => function* () { hit() },
  hit => async function* () { hit() },
]) {
  test(`rejects ${makeWork(() => {}).constructor.name} before invoking user work`, async (t) => {
    const db = tempStore(t).open()
    let hits = 0
    assert.throws(() => withWriteTransaction(db, makeWork(() => hits++)), { code: 'E_STORE_ASYNC_TRANSACTION' })
    await Promise.resolve()
    assert.equal(hits, 0)
    assert.equal(db.isTransaction, false)
    assert.equal(withWriteTransaction(db, () => 42), 42)
  })
}
test('non-callable work fails before acquiring a database transaction', (t) => {
  const db = tempStore(t).open()
  let begins = 0
  const execute = db.exec.bind(db)
  db.exec = sql => { if (sql === 'BEGIN IMMEDIATE') begins++; return execute(sql) }
  assert.throws(() => withWriteTransaction(db, null), TypeError)
  assert.equal(begins, 0)
})

test('a rejected native Promise result is consumed after synchronous refusal', async () => {
  const { execFileSync } = await import('node:child_process')
  const url = new URL('../../lib/store/sqlite.js', import.meta.url).href
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { withWriteTransaction } from ${JSON.stringify(url)};
    const db = { exec() {} };
    try { withWriteTransaction(db, () => Promise.reject(new Error('deferred rejection'))) }
    catch (error) { if (error.code !== 'E_STORE_ASYNC_TRANSACTION') throw error }
    await new Promise(resolve => setImmediate(resolve));
  `], { timeout: 5000, encoding: 'utf8', stdio: 'pipe' })
})

test('immutable native busy errors retain their classification after failed rollback', (t) => {
  const store = tempStore(t)
  const db = store.open()
  const execute = db.exec.bind(db)
  const failure = Object.freeze(Object.assign(new Error('locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }))
  db.exec = sql => { if (sql === 'ROLLBACK') throw new Error('rollback'); return execute(sql) }
  let caught
  try { withWriteTransaction(db, () => { throw failure }) } catch (error) { caught = error }
  assert.equal(store.handle, null)
  assert.equal(caught.code, 'E_STORE_BUSY')
  assert.equal(caught.transactionStateUnknown, true)
  assert.equal(caught.cause.cause, failure)
})
