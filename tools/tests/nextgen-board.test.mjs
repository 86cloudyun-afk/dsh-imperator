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
