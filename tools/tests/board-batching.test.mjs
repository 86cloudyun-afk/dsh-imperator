import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempStore } from './helpers.mjs'
import { withWriteTransaction } from '../../lib/store/sqlite.js'

function seed(store, count, run = 'a', facts = 8) {
  store.open()
  return withWriteTransaction(store.handle, () => Array.from({ length: count }, (_, i) => {
    const id = store.openTask(`task-${i}`, run).task_id
    for (let f = 0; f < facts; f++) store.recordFact({ task_id: id, statement: `fact-${i}-${f}`, kind: 'artifact',
      confidence: 'PLAUSIBLE', evidence_path: 'result.txt', evidence_line: f }, run)
    return id
  }))
}
for (const count of [0, 1, 60]) {
  test(`default board uses bounded SQL calls with ${count} tasks and correct per-task latest facts`, t => {
    const store = tempStore(t)
    const ids = seed(store, count)
    const prepare = store.handle.prepare.bind(store.handle)
    let queries = 0
    store.handle.prepare = sql => { queries++; return prepare(sql) }
    const board = store.board({}, 'a')
    assert.equal(board.tasks.length, count)
    assert.ok(queries <= 4, `board used ${queries} SQL calls for ${count} tasks`)
    for (const row of board.tasks) {
      const index = ids.indexOf(row.id)
      assert.equal(row.fact_count, 8)
      assert.deepEqual(row.facts.map(f => f.statement), [7, 6, 5, 4, 3].map(f => `fact-${index}-${f}`))
      assert.equal(row.facts[0].evidence, 'result.txt:7')
    }
  })
}
test('batch summaries preserve task and fact run isolation including NULL legacy rows', t => {
  const store = tempStore(t)
  const [a] = seed(store, 1, 'a', 2)
  const [b] = seed(store, 1, 'b', 2)
  seed(store, 1, null, 2)
  store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
    .run(a, 'b', 'fact', 'foreign-secret', 'CONFIRMED', 'now')
  for (const run of ['a', 'b', undefined]) {
    const board = store.board({}, run)
    assert.equal(board.tasks.length, 1)
    assert.equal(board.tasks[0].facts.length, 2)
    assert.doesNotMatch(JSON.stringify(board.tasks), /foreign-secret/)
  }
  assert.equal(store.board({}, 'a').tasks[0].id, a)
  assert.equal(store.board({}, 'b').tasks[0].id, b)
})
test('batch summaries exclude terminal tasks but keep late blockers visible and clip statements', t => {
  const store = tempStore(t)
  const [id] = seed(store, 1)
  store.submitTask({ task_id: id }, 'a')
  store.acceptTask({ task_id: id }, 'a', 'lead')
  store.recordFact({ task_id: id, kind: 'blocker', statement: 'late' }, 'a')
  const [pending] = seed(store, 1)
  store.recordFact({ task_id: pending, statement: '文'.repeat(200) }, 'a')
  const board = store.board({}, 'a')
  assert.deepEqual(board.tasks.map(t => t.id), [pending])
  assert.equal(board.tasks[0].facts[0].statement, '文'.repeat(160) + '…')
  assert.equal(board.late_blockers[0].task_id, id)
  assert.equal(board.late_blockers[0].blockers[0].statement, 'late')
})
test('detail aggregates facts in SQL without materializing one JS row per fact', t => {
  const store = tempStore(t)
  const [id] = seed(store, 1, 'a', 240)
  const prepare = store.handle.prepare.bind(store.handle)
  const lengths = []
  store.handle.prepare = sql => {
    const statement = prepare(sql)
    const all = statement.all.bind(statement)
    statement.all = (...args) => { const rows = all(...args); lengths.push(rows.length); return rows }
    return statement
  }
  const board = store.board({ task_id: id }, 'a')
  assert.equal(board.task.fact_count, 240)
  assert.deepEqual(board.counts, { by_kind: { artifact: 240 }, by_confidence: { PLAUSIBLE: 240 } })
  assert.equal(board.facts.length, 50)
  assert.ok(Math.max(...lengths) <= 50, `materialized ${Math.max(...lengths)} rows`)
})

// Removing any selected TEXT recovery must fail through its public consumer.
for (const route of ['detail', 'ranked summary', 'late blockers', 'reopen', 'accept blockers']) {
  test(`SQLite TEXT ${route} preserves NUL before full output or clipping`, t => {
    const store = tempStore(t), run = 'text-run'
    const samples = ['ordinary', '"JSON"', 'back\\slash', '\0', '\0start', 'middle\0suffix', 'end\0', 'a\0\0b',
      '中\0文😀e\u0301\r\n\u0001', ...[159, 160, 161].map(n => '中\0' + '文'.repeat(n - 2))]
    for (const statement of samples) {
      const id = store.openTask('text', run).task_id
      if (['late blockers', 'reopen'].includes(route)) store.closeTask({ task_id: id, result: 'failed' }, run)
      store.recordFact({ task_id: id, statement, kind: route === 'detail' || route === 'ranked summary' ? 'fact' : 'blocker' }, run)
      const expected = statement.length > 160 ? statement.slice(0, 160) + '…' : statement
      if (route === 'detail') assert.equal(store.board({ task_id: id }, run).facts[0].statement, statement)
      if (route === 'ranked summary') assert.equal(store.board({}, run).tasks.find(row => row.id === id).facts[0].statement, expected)
      if (route === 'late blockers') assert.equal(store.board({ task_id: id }, run).late_blockers[0].blockers[0].statement, expected)
      if (route === 'reopen') assert.equal(store.rejectTask({ task_id: id, reason: 'reopen' }, run, 'lead').late_blockers[0].blockers[0].statement, expected)
      if (route === 'accept blockers') {
        store.submitTask({ task_id: id }, run)
        assert.throws(() => store.acceptTask({ task_id: id }, run, 'lead'), error => error.code === 'E_BLOCKERS' && error.message.includes(expected))
      }
    }
  })
}

for (const route of ['ranked summary', 'late blockers', 'accept blockers']) {
  test(`SQLite TEXT ${route} rejects corrupt evidence before its consumer`, t => {
    const store = tempStore(t), id = store.openTask('text', 'run').task_id
    if (route === 'late blockers') store.closeTask({ task_id: id, result: 'failed' }, 'run')
    store.recordFact({ task_id: id, kind: 'blocker', statement: 'private\0sentinel' }, 'run')
    if (route === 'accept blockers') store.submitTask({ task_id: id }, 'run')
    const db = store.open(), prepare = db.prepare.bind(db)
    const matches = sql => route === 'ranked summary' ? sql.startsWith('WITH ranked AS')
      : route === 'late blockers' ? sql.startsWith('SELECT t.id AS task_id, t.title, t.status, t.owner,')
        : sql.startsWith('SELECT b.id, b.statement, b.created_by, b.created_at')
    db.prepare = sql => {
      const statement = prepare(sql)
      if (matches(sql)) {
        const all = statement.all.bind(statement)
        statement.all = (...args) => all(...args).map(row => { row.__imperator_nul_statement = '"private sentinel"'; return row })
      }
      return statement
    }
    assert.throws(() => route === 'accept blockers' ? store.acceptTask({ task_id: id }, 'run', 'lead') : store.board({}, 'run'),
      { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
    assert.equal(db.isTransaction, false)
  })
}
