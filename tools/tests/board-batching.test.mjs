import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempStore } from './helpers.mjs'
import { DatabaseSync } from 'node:sqlite'
import { TaskforceStore } from '../../lib/store/index.js'
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
    let injections = 0
    db.prepare = sql => {
      const statement = prepare(sql)
      if (matches(sql)) {
        const all = statement.all.bind(statement)
        statement.all = (...args) => all(...args).map(row => { injections++; row.__imperator_nul_statement = '"private sentinel"'; return row })
      }
      return statement
    }
    assert.throws(() => route === 'accept blockers' ? store.acceptTask({ task_id: id }, 'run', 'lead') : store.board({}, 'run'),
      { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
    assert.equal(injections, 1)
    assert.equal(db.isTransaction, false)
  })
}

// Task19 prospective public output regressions. No fixture is an archived seed.
for (const sample of ['\0field', 'field\0suffix', 'field\0', 'Tordinary', 'J"literal"', '{"text":true}', 'literal\\u0000', '普通🙂']) {
  test(`Task19 accepted task prose survives detail and every task projection: ${JSON.stringify(sample)}`, t => {
    const store = tempStore(t), run = 'task19-prose'
    const expected = Object.fromEntries(['title', 'note', 'owner', 'owner_session'].map(field => [field, sample.replace('field', field)]))
    const id = store.openTask({ title: `  ${expected.title}  `, note: `  ${expected.note}  ` }, run).task_id
    store.claimTask({ task_id: id, child_id: expected.owner }, run, 'lead', expected.owner_session)
    const lateId = store.openTask({ title: expected.title, note: expected.note }, run).task_id
    store.claimTask({ task_id: lateId, child_id: expected.owner }, run, 'lead', expected.owner_session)
    // This full-owner transition is a post-Task16 closure, not a frozen706 output RED.
    assert.equal(store.closeTask({ task_id: lateId, result: 'failed' }, run, 'lead').status, 'cancelled')
    const blocker = store.recordFact({ task_id: lateId, kind: 'blocker', statement: 'late blocker' }, run)
    const creationHandle = store.open()
    function check(reader, phase) {
      const oracle = new DatabaseSync(store.dbPath, { readOnly: true })
      try {
        const rows = oracle.prepare('SELECT id, typeof(title) AS title_type, json_quote(title) AS title_json,'
          + ' typeof(note) AS note_type, json_quote(note) AS note_json, typeof(owner) AS owner_type, json_quote(owner) AS owner_json,'
          + ' typeof(owner_session) AS owner_session_type, json_quote(owner_session) AS owner_session_json'
          + ' FROM task WHERE run_id IS ? ORDER BY id').all(run)
        assert.deepEqual(rows.map(row => row.id), [id, lateId])
        for (const row of rows) for (const [field, value] of Object.entries(expected)) {
          assert.equal(row[field + '_type'], 'text', `${phase}:${field}:storage-type`)
          assert.equal(JSON.parse(row[field + '_json']), value, `${phase}:${field}:stored-cell`)
        }
        assert.equal(oracle.prepare('SELECT total_changes() AS n').get().n, 0)
      } finally { oracle.close() }
      const db = reader.open(), before = db.prepare('SELECT total_changes() AS n').get().n
      for (const result of [reader.taskOf(id, run), reader.board({ task_id: id }, run), reader.boardPage({ task_id: id }, run)]) {
        assert.equal(result.task.id, id); assert.equal(result.task.status, 'claimed')
        for (const [field, value] of Object.entries(expected)) assert.equal(result.task[field], value, `${phase}:${field}:detail`)
        assert.equal(result.task.truncated, undefined)
      }
      const board = reader.board({}, run), page = reader.boardPage({}, run)
      for (const result of [board, page]) {
        assert.equal(result.open_tasks, 1); assert.deepEqual(result.tasks.map(row => row.id), [id])
        for (const field of ['title', 'owner', 'owner_session']) assert.equal(result.tasks[0][field], expected[field], `${phase}:${field}:task`)
        assert.equal(result.tasks[0].truncated, undefined); assert.equal(result.tasks[0].fact_count, 0)
      }
      const legacyLate = board.late_blockers[0]
      assert.equal(legacyLate.task_id, lateId); assert.equal(legacyLate.status, 'cancelled')
      assert.equal(legacyLate.title, expected.title); assert.equal(legacyLate.owner, expected.owner)
      assert.equal(legacyLate.blockers[0].fact_id, blocker.fact_id)
      for (const result of [page, reader.boardPage({ view: 'summary' }, run),
        reader.boardPage({ view: 'late_blockers', task_id: lateId }, run), reader.boardPage({ task_id: lateId }, run)]) {
        assert.equal(result.late_blockers.length, 1)
        const late = result.late_blockers[0]
        assert.equal(late.task_id, lateId); assert.equal(late.fact_id, blocker.fact_id)
        assert.equal(late.title, expected.title); assert.equal(late.owner, expected.owner)
        assert.equal(late.status, 'cancelled'); assert.equal(late.truncated, undefined)
      }
      assert.equal(page.pagination.has_more, false); assert.equal(page.pagination.next_cursor, null)
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
    }
    assert.equal(store.open(), creationHandle); check(store, 'creation')
    store.close()
    const reopened = new TaskforceStore(store.root)
    try { assert.notEqual(reopened.open(), creationHandle); check(reopened, 'reopened') } finally { reopened.close() }
  })
}
