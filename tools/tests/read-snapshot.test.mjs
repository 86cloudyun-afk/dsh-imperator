import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { tempStore } from './helpers.mjs'
import * as sqlite from '../../lib/store/sqlite.js'

function writerFor(t, store) {
  const writer = new DatabaseSync(store.dbPath)
  t.after(() => writer.close())
  return writer
}
function afterFirstRead(db, pattern, change) {
  const prepare = db.prepare.bind(db)
  let fired = false
  db.prepare = sql => {
    const statement = prepare(sql)
    if (pattern.test(sql)) {
      for (const method of ['get', 'all']) {
        const read = statement[method].bind(statement)
        statement[method] = (...args) => {
          const result = read(...args)
          if (!fired) { fired = true; change() }
          return result
        }
      }
    }
    return statement
  }
  return () => fired
}
function seed(store) {
  const id = store.openTask('original', 'a').task_id
  store.recordFact({ task_id: id, statement: 'original-fact' }, 'a')
  return id
}
for (const method of ['board', 'taskOf']) {
  test(`${method} retains the authorized read snapshot across a concurrent reassignment`, t => {
    const store = tempStore(t, { journalMode: 'wal' })
    const id = seed(store)
    const writer = writerFor(t, store)
    const fired = afterFirstRead(store.handle, /SELECT id, title, note, status, owner, owner_session, run_id/, () => {
      writer.exec('BEGIN IMMEDIATE')
      writer.prepare('UPDATE task SET run_id = ? WHERE id = ?').run('b', id)
      writer.prepare('UPDATE fact SET run_id = ?, statement = ? WHERE task_id = ?').run('b', 'FOREIGN_SECRET', id)
      writer.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?, 'b', 'fact', 'NEW_SECRET', 'PLAUSIBLE', 'now')").run(id)
      writer.exec('COMMIT')
    })
    const result = store[method]({ task_id: id }, 'a')
    assert.equal(fired(), true, 'second real connection committed during this read')
    assert.doesNotMatch(JSON.stringify(result), /FOREIGN_SECRET|NEW_SECRET/)
    assert.equal(method === 'taskOf' ? result.fact_count : result.task.fact_count, 1)
    assert.equal(store.handle.isTransaction, false)
    assert.throws(() => store.taskOf({ task_id: id }, 'a'), { code: 'E_CROSS_RUN' })
    assert.equal(store.board({ task_id: id }, 'b').task.fact_count, 2)
  })
}
test('default board facts and counts refer to one snapshot while WAL writer remains live', t => {
  const store = tempStore(t, { journalMode: 'wal' })
  const id = seed(store)
  const writer = writerFor(t, store)
  const fired = afterFirstRead(store.handle, /ORDER BY t.updated_at DESC, t.id DESC/, () => {
    writer.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?, 'a', 'fact', 'later', 'PLAUSIBLE', 'now')").run(id)
  })
  const board = store.board({}, 'a')
  assert.equal(fired(), true)
  assert.equal(board.tasks[0].fact_count, 1)
  assert.deepEqual(board.tasks[0].facts.map(f => f.statement), ['original-fact'])
  assert.equal(store.board({}, 'a').tasks[0].fact_count, 2)
})
test('scoped stats retain consistent totals across concurrent inserts', t => {
  const store = tempStore(t, { journalMode: 'wal' })
  seed(store)
  const writer = writerFor(t, store)
  const fired = afterFirstRead(store.handle, /SELECT status, COUNT\(\*\) AS n FROM task WHERE/, () => {
    writer.exec("BEGIN IMMEDIATE; INSERT INTO task(title,run_id,status,created_at,updated_at) VALUES('later','a','open','now','now');"
      + "INSERT INTO fact(run_id,kind,statement,confidence,created_at) VALUES('a','fact','later','PLAUSIBLE','now'); COMMIT")
  })
  const stats = store.stats('a')
  assert.equal(fired(), true)
  assert.equal(stats.tasks.total, 1)
  assert.equal(stats.facts.total, 1)
  assert.equal(store.stats('a').facts.total, 2)
})
test('read transaction permits nesting in a write transaction and releases only its own scope', t => {
  assert.equal(typeof sqlite.withReadTransaction, 'function')
  const store = tempStore(t)
  seed(store)
  sqlite.withWriteTransaction(store.handle, () => {
    assert.equal(sqlite.withReadTransaction(store.handle, () => store.board({}, 'a').tasks.length), 1)
    assert.equal(store.handle.isTransaction, true)
    store.openTask('second', 'a')
  })
  assert.equal(store.handle.isTransaction, false)
  assert.equal(store.stats('a').tasks.total, 2)
})
test('failed scoped reads close their read transaction and later reads can proceed', t => {
  const store = tempStore(t)
  const id = seed(store)
  assert.throws(() => store.board({ task_id: id }, 'b'), { code: 'E_CROSS_RUN' })
  assert.equal(store.handle.isTransaction, false)
  assert.equal(store.board({ task_id: id }, 'a').task.id, id)
})
