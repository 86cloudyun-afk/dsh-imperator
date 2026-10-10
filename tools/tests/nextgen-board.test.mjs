import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempStore } from './helpers.mjs'
import { withWriteTransaction } from '../../lib/store/sqlite.js'

for (const scoped of [true, false]) test(`${scoped ? 'scoped' : 'unscoped'} exhausted late continuation uses blocker access paths and retains uncapped resolver invalidation`, t => {
  const store = tempStore(t)
  store.open()
  for (const run of ['run-a', null]) {
    const id = store.openTask('long history', run).task_id
    const other = scoped ? store.openTask('same-run other task', run).task_id : undefined
    withWriteTransaction(store.handle, () => {
      const insert = store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
      for (let i = 0; i < 1000; i++) insert.run(id, run, 'fact', 'ordinary', 'PLAUSIBLE', 'now')
      store.handle.prepare("UPDATE task SET status='accepted' WHERE id=?").run(id)
      if (scoped) {
        store.handle.prepare("UPDATE task SET status='accepted' WHERE id=?").run(other)
        for (let i = 0; i < 1000; i++) insert.run(other, run, 'blocker', 'unrelated same-run blocker', 'PLAUSIBLE', 'now')
      }
      for (let i = 0; i < 3; i++) insert.run(id, run, 'blocker', 'late', 'PLAUSIBLE', 'now')
    })
    const scope = scoped ? { task_id: id } : {}
    const first = store.boardPage({ view: 'late_blockers', ...scope, limit: 1 }, run)
    const state = JSON.parse(Buffer.from(first.pagination.page_token, 'base64url').toString('utf8'))
    const oldest = Number(store.handle.prepare("SELECT MIN(id) AS n FROM fact WHERE task_id=? AND kind='blocker'").get(id).n)
    const args = { view: 'late_blockers', ...scope, limit: 1, cursor: oldest,
      page_token: Buffer.from(JSON.stringify({ ...state, c: oldest })).toString('base64url') }
    const original = store.handle.prepare, prepare = original.bind(store.handle), plans = []
    store.handle.prepare = sql => {
      const statement = prepare(sql)
      if (sql.startsWith('SELECT b.id AS fact_id,')) {
        const all = statement.all.bind(statement)
        statement.all = (...params) => {
          plans.push(prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail).join('\n'))
          return all(...params)
        }
      }
      return statement
    }
    let page
    try { page = store.boardPage(args, run) } finally { store.handle.prepare = original }
    assert.deepEqual(page.late_blockers, [])
    assert.equal(page.total, 3)
    assert.equal(page.pagination.next_cursor, null)
    assert.equal(plans.length, 1)
    const expectedIndex = scoped ? 'idx_fact_blocker_task_run_id' : 'idx_fact_blocker_run_id'
    assert.match(plans[0], new RegExp('SEARCH b USING (?:COVERING )?INDEX ' + expectedIndex),
      'exhausted selected-row reads must skip ordinary history and unrelated task blockers')
    const resolver = store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at,resolves_fact_id) VALUES(?,?,?,?,?,?,?)')
      .run(id, run, 'decision', 'resolved', 'CONFIRMED', 'now', first.late_blockers[0].fact_id)
    assert.ok(Number(resolver.lastInsertRowid) > state.u)
    assert.throws(() => store.boardPage(args, run), { code: 'E_PAGE_CHANGED' })
  }
})

test('opening an existing store recreates the task-first blocker index without changing facts', t => {
  const store = tempStore(t)
  store.open()
  const id = store.openTask('migration fixture', 'run').task_id
  store.handle.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,'blocker','preserved','PLAUSIBLE','now')").run(id, 'run')
  const before = store.handle.prepare('SELECT * FROM fact ORDER BY id').all()
  store.handle.exec('DROP INDEX IF EXISTS idx_fact_blocker_task_run_id')
  store.close(); store.open()
  const index = store.handle.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_fact_blocker_task_run_id'").get()
  assert.match(index?.sql ?? '', /ON fact\s*\(task_id,\s*run_id,\s*id\) WHERE kind='blocker'/)
  assert.deepEqual(store.handle.prepare('SELECT * FROM fact ORDER BY id').all(), before)
  assert.equal(Object.values(store.handle.prepare('PRAGMA integrity_check').get())[0], 'ok')
  store.close(); store.open()
  assert.equal(store.handle.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='idx_fact_blocker_task_run_id'").get().n, 1)
  assert.deepEqual(store.handle.prepare('SELECT * FROM fact ORDER BY id').all(), before)
})
