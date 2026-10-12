import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { tempStore } from './helpers.mjs'
import { TaskforceStore } from '../../lib/store/index.js'
import { withWriteTransaction } from '../../lib/store/sqlite.js'
import { apply as applyTools } from '../../lib/tools/index.js'

function seed(store, count, facts = 8, run = 'run-a') {
  store.open()
  return withWriteTransaction(store.handle, () => Array.from({ length: count }, (_, i) => {
    const id = store.openTask(`task-${i}`, run).task_id
    for (let j = 0; j < facts; j++) store.recordFact({ task_id: id, statement: `fact-${i}-${j}` }, run)
    return id
  }))
}
function collect(store, args, key, run = 'run-a') {
  const result = []
  let cursor = args.cursor, pageToken = args.page_token
  do {
    const page = store.boardPage({ ...args, cursor, page_token: pageToken }, run)
    result.push(...page[key])
    assert.equal(page.pagination.has_more, page.pagination.next_cursor !== null)
    cursor = page.pagination.next_cursor ?? undefined
    pageToken = page.pagination.page_token ?? undefined
  } while (cursor !== undefined)
  return result
}
function tools(store, id = 'run-a') {
  const defs = []
  applyTools({ logger: { warn() {} }, get: name => name === 'taskforceStore' ? store : undefined,
    tools: { register: d => defs.push(d) } })
  return args => defs.find(d => d.name === 'task_board').execute(args, { agent: { options: {}, session: { header: { id } } } })
}

test('SQLite TEXT width-neutral facts and latest remain readable at the native column limit', async t => {
  const store = tempStore(t), id = store.openTask('maximum width', 'run-a').task_id, db = store.open()
  const capacity = Number(db.prepare('PRAGMA compile_options').all().map(row => row.compile_options)
    .find(option => option.startsWith('MAX_COLUMN=')).split('=')[1])
  const existing = db.prepare('PRAGMA table_info(fact)').all().length
  for (let index = existing; index < capacity; index++) db.exec(`ALTER TABLE fact ADD COLUMN extension_${index}`)
  assert.equal(db.prepare('SELECT * FROM fact').columns().length, capacity)
  for (const statement of ['ordinary', 'left\0中文😀right']) {
    store.recordFact({ task_id: id, statement }, 'run-a')
    assert.equal(db.prepare('SELECT hex(CAST(statement AS BLOB)) AS bytes FROM fact WHERE task_id=? ORDER BY id DESC LIMIT 1').get(id).bytes,
      Buffer.from(statement).toString('hex').toUpperCase())
    for (const view of ['facts', 'latest']) await t.test(`${view}: ${JSON.stringify(statement)}`, () => {
      const page = store.boardPage(view === 'facts' ? { view: 'facts', task_id: id } : {}, 'run-a')
      const row = view === 'facts' ? page.facts[0] : page.tasks[0].facts[0]
      assert.equal(row.statement, statement)
      if (view === 'facts') {
        assert.equal(row[`extension_${capacity - 1}`], null)
        assert.ok(Object.keys(row).length >= capacity)
      }
    })
  }
})

test('SQLite TEXT board factories add metadata prepares without additional data execution', t => {
  const store = tempStore(t), id = store.openTask('counts', 'run-a').task_id
  store.recordFact({ task_id: id, statement: 'prefix\0suffix' }, 'run-a')
  const db = store.open(), prepare = db.prepare.bind(db), records = []
  db.prepare = sql => {
    const statement = prepare(sql)
    if ((sql.startsWith('SELECT f.*') || sql.includes("THEN 'J'||json_quote(")) && / FROM (fact|handoff) f JOIN task/.test(sql)) {
      const record = { original: sql.startsWith('SELECT f.*'), handoff: sql.includes(' FROM handoff '), get: 0, all: 0, iterate: 0, run: 0 }
      records.push(record)
      for (const method of ['get', 'all', 'iterate', 'run']) {
        const execute = statement[method].bind(statement)
        statement[method] = (...args) => { record[method]++; return execute(...args) }
      }
    }
    return statement
  }
  for (const route of ['facts', 'handoffs', 'latest', 'empty']) {
    records.length = 0
    if (route === 'empty') store.closeTask({ task_id: id, result: 'failed' }, 'run-a')
    store.boardPage(['facts', 'handoffs'].includes(route) ? { view: route, task_id: id } : {}, 'run-a')
    const metadata = { original: true, handoff: false, get: 0, all: 0, iterate: 0, run: 0 }
    const execution = { original: false, handoff: false, get: 0, all: 1, iterate: 0, run: 0 }
    assert.deepEqual(records, route === 'empty' ? [] : route === 'handoffs'
      ? [{ ...metadata, handoff: true }, { ...execution, handoff: true }] : [metadata, execution])
    t.diagnostic(route + ' SQL lifecycle=' + JSON.stringify(records))
  }
})

for (const route of ['facts', 'detail', 'latest', 'late full', 'late display']) {
  test(`SQLite TEXT page ${route} restores text before pagination and clipping`, t => {
    const store = tempStore(t), run = 'run-a'
    const samples = ['plain', 'T', 'J', 'J"pretend"', 'Tordinary', '"json"', '\\u0000', '\0', '\0start', 'middle\0suffix', 'end\0', 'a\0\0b',
      '中\0文😀e\u0301\r\n\u0001', ...[159, 160, 161].map(n => '中\0' + '文'.repeat(n - 2))]
    const id = store.openTask('text', run).task_id
    if (route.startsWith('late ')) store.closeTask({ task_id: id, result: 'failed' }, run)
    for (const statement of samples) {
      store.recordFact({ task_id: id, statement, kind: route.startsWith('late ') ? 'blocker' : 'fact' }, run)
      const display = statement.length > 160 ? statement.slice(0, 160) + '…' : statement
      if (route === 'facts') assert.equal(store.boardPage({ view: 'facts', task_id: id, limit: 1 }, run).facts[0].statement, statement)
      if (route === 'detail') assert.equal(store.boardPage({ task_id: id }, run).facts[0].statement, statement)
      if (route === 'latest') assert.equal(store.boardPage({}, run).tasks[0].facts[0].statement, display)
      if (route === 'late full') assert.equal(store.boardPage({ view: 'late_blockers', task_id: id, limit: 1 }, run).late_blockers[0].statement, statement)
      if (route === 'late display') assert.equal(store.boardPage({}, run).late_blockers[0].statement, display)
    }
    if (route === 'facts') assert.deepEqual(collect(store, { view: 'facts', task_id: id, limit: 3 }, 'facts').map(r => r.statement), samples.toReversed())
    store.handle.close(); store.handle = null; store.open()
    if (route === 'facts') assert.equal(store.boardPage({ view: 'facts', task_id: id }, run).facts[0].statement, samples.at(-1))
  })
}

test('SQLite TEXT fact history preserves real companion names and unusual legacy column types', t => {
  const store = tempStore(t), id = store.openTask('legacy columns', 'run-a').task_id
  store.recordFact({ task_id: id, statement: 'prefix\0suffix' }, 'run-a')
  const db = store.open()
  db.exec('ALTER TABLE fact ADD COLUMN __imperator_nul_statement TEXT; ALTER TABLE fact ADD COLUMN "__proto__" TEXT;'
    + ' ALTER TABLE fact ADD COLUMN constructor INTEGER; ALTER TABLE fact ADD COLUMN "12" TEXT; ALTER TABLE fact ADD COLUMN "2" TEXT;'
    + ' ALTER TABLE fact ADD COLUMN extra_blob BLOB; ALTER TABLE fact ADD COLUMN extra_null; ALTER TABLE fact ADD COLUMN extra_integer INTEGER')
  db.exec('ALTER TABLE fact ADD COLUMN "" TEXT; ALTER TABLE fact ADD COLUMN "quoted""列😀" TEXT')
  db.prepare('UPDATE fact SET ""=?,"quoted""列😀"=? WHERE task_id=?').run('empty name', 'quoted name', id)
  db.prepare('UPDATE fact SET __imperator_nul_statement=?,"__proto__"=?,constructor=27,"12"=?,"2"=?,extra_blob=?,extra_integer=42 WHERE task_id=?')
    .run('legacy companion', 'prototype data', 'twelve', 'two', new Uint8Array([0,255]), id)
  const row = store.boardPage({ view: 'facts', task_id: id }, 'run-a').facts[0]
  assert.equal(row.statement, 'prefix\0suffix')
  assert.equal(row.__imperator_nul_statement, 'legacy companion')
  assert.equal(row.__proto__, 'prototype data'); assert.equal(row.constructor, 27)
  assert.equal(row['12'], 'twelve'); assert.equal(row['2'], 'two')
  assert.deepEqual(row.extra_blob, new Uint8Array([0,255])); assert.equal(row.extra_null, null)
  assert.equal(row.extra_integer, 42)
  assert.equal(row[''], 'empty name'); assert.equal(row['quoted"列😀'], 'quoted name')
  assert.equal(Object.getPrototypeOf(row), Object.prototype, 'public history keeps its existing spread shape')
  assert.deepEqual(Object.getOwnPropertyDescriptor(row, '__proto__'), { value: 'prototype data', writable: true, enumerable: true, configurable: true })
  assert.equal(store.boardPage({}, 'run-a').tasks[0].facts[0].statement, 'prefix\0suffix')
  db.prepare('UPDATE fact SET extra_integer=? WHERE task_id=?').run(9007199254740993n, id)
  for (const args of [{ view: 'facts', task_id: id }, {}]) assert.throws(() => store.boardPage(args, 'run-a'), { code: 'ERR_OUT_OF_RANGE' })
})

for (const route of ['late', 'latest']) {
  test(`SQLite TEXT page ${route} rejects corrupt evidence before clipping`, t => {
    const store = tempStore(t), id = store.openTask('text', 'run-a').task_id
    if (route === 'late') store.closeTask({ task_id: id, result: 'failed' }, 'run-a')
    store.recordFact({ task_id: id, kind: 'blocker', statement: 'private\0sentinel' }, 'run-a')
    const db = store.open(), prepare = db.prepare.bind(db)
    let injections = 0
    db.prepare = sql => {
      const statement = prepare(sql)
      if (route === 'late' ? sql.startsWith('SELECT b.id AS fact_id,') : sql.includes("THEN 'J'||json_quote(") && sql.includes('FROM fact f')) {
        const all = statement.all.bind(statement)
        statement.all = (...args) => all(...args).map(row => {
          injections++
          if (route === 'latest') row.statement = 'J"private sentinel"'
          else row.__imperator_nul_statement = '"private sentinel"'
          return row
        })
      }
      return statement
    }
    assert.throws(() => store.boardPage({}, 'run-a'), { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
    assert.equal(injections, 1)
    assert.equal(db.isTransaction, false)
  })
}

test('1000 pending tasks have bounded defaults, full totals and complete descending keyset traversal', t => {
  const store = tempStore(t), ids = seed(store, 1000)
  assert.equal(typeof store.boardPage, 'function', 'paged store API is missing')
  const first = store.boardPage({}, 'run-a')
  assert.equal(first.tasks.length, 25)
  assert.equal(first.pagination.limit, 25)
  assert.equal(first.open_tasks, 1000)
  assert.equal(first.totals.tasks, 1000)
  assert.equal(first.totals.facts, 8000)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 65536)
  for (const row of first.tasks) { assert.equal(row.facts.length, 1); assert.equal(row.fact_count, 8) }
  assert.deepEqual(collect(store, { limit: 100 }, 'tasks').map(r => r.id), ids.reverse())
  assert.equal(store.board({}, 'run-a').tasks.length, 1000, 'host compatibility stays unpaged')
})

test('invalid page inputs are rejected rather than silently coerced or ignored', t => {
  const store = tempStore(t), [id] = seed(store, 1)
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '25' }, { limit: null },
    { cursor: 0 }, { cursor: -1 }, { cursor: '2' }, { cursor: Number.MAX_SAFE_INTEGER + 1 },
    { late_cursor: 0 }, { view: 'invalid' }, { view: 'facts' }, { view: 'handoffs' }]) {
    assert.throws(() => store.boardPage(args, 'run-a'), { code: 'E_INPUT' }, JSON.stringify(args))
  }
  assert.equal(store.boardPage({ limit: 100 }, 'run-a').pagination.limit, 100)
  assert.throws(() => store.boardPage({ view: 'tasks', task_id: id }, 'foreign'), { code: 'E_CROSS_RUN' })
})

test('full facts and handoffs are reachable from compatible detail continuations and match raw SQL', t => {
  const store = tempStore(t), [id] = seed(store, 1, 73)
  const long = '原文😀'.repeat(2000)
  store.recordFact({ task_id: id, statement: long }, 'run-a')
  for (let i = 0; i < 23; i++) store.handle.prepare('INSERT INTO handoff(task_id,run_id,from_child,to_child,note,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'run-a', 'old', 'new', `handoff-${i}`, 'now')
  const detail = store.boardPage({ task_id: id }, 'run-a')
  assert.equal(detail.facts.length, 50)
  assert.equal(detail.facts[0].statement, long)
  assert.equal(detail.handoffs.length, 10)
  assert.equal(detail.facts_pagination.has_more, true)
  assert.equal(detail.handoffs_pagination.has_more, true)
  assert.ok(Array.isArray(detail.receipts))
  for (const view of ['facts', 'handoffs']) {
    const rows = collect(store, { view, task_id: id, limit: 25 }, view)
    assert.deepEqual(rows.map(r => r.id), store.handle.prepare(`SELECT id FROM ${view === 'facts' ? 'fact' : 'handoff'} WHERE task_id=? ORDER BY id DESC`).all(id).map(r => r.id))
    const continuation = store.boardPage({ view, task_id: id, cursor: detail[`${view}_pagination`].next_cursor }, 'run-a')
    assert.equal(continuation[view][0].id, rows[detail[view].length].id)
    assert.throws(() => store.boardPage({ view, task_id: id }, 'foreign'), { code: 'E_CROSS_RUN' })
  }
})

test('late blockers paginate by fact ID with full counts, even when the pending page is empty', t => {
  const store = tempStore(t), ids = seed(store, 31, 0)
  for (const id of ids) {
    store.closeTask({ task_id: id, result: 'failed' }, 'run-a')
    for (let j = 0; j < 2; j++) store.recordFact({ task_id: id, kind: 'blocker', statement: `late-${id}-${j}` }, 'run-a')
  }
  const first = store.boardPage({}, 'run-a')
  assert.deepEqual(first.tasks, [])
  assert.equal(first.late_blocked_tasks, 31)
  assert.equal(first.totals.late_blockers, 62)
  assert.equal(first.late_blockers.length, 25)
  assert.equal(first.late_pagination.has_more, true)
  const next = store.boardPage({ late_cursor: first.late_pagination.next_cursor, late_page_token: first.late_pagination.page_token }, 'run-a')
  assert.ok(next.late_blockers[0].fact_id < first.late_blockers.at(-1).fact_id)
  assert.equal(collect(store, { view: 'late_blockers' }, 'late_blockers').length, 62)
})

test('foreign attached rows cannot consume any scoped page or summary allowance including NULL run', t => {
  const store = tempStore(t)
  for (const run of ['run-a', null]) {
    const [id] = seed(store, 1, 30, run)
    for (let i = 0; i < 40; i++) store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, 'foreign', 'blocker', 'FOREIGN_SECRET', 'CONFIRMED', 'now')
    const page = store.boardPage({}, run)
    assert.equal(page.tasks[0].fact_count, 30)
    assert.equal(page.tasks[0].facts[0].statement, 'fact-0-29')
    assert.equal(page.totals.facts, 30)
    assert.equal(page.scope_integrity_totals.mismatched_facts, 40)
    const facts = store.boardPage({ view: 'facts', task_id: id }, run)
    assert.equal(facts.facts.length, 25)
    assert.doesNotMatch(JSON.stringify({ page, facts }), /FOREIGN_SECRET/)
  }
})

test('large display fields and many alerts stay within the complete tool wire budget with honest continuations', async t => {
  const store = tempStore(t), ids = seed(store, 110, 1), huge = '文😀\\\"\n'.repeat(10000)
  for (const id of ids) {
    store.handle.prepare('UPDATE task SET title=?, owner=?, owner_session=? WHERE id=?').run(huge, huge, huge, id)
    store.recordFact({ task_id: id, statement: huge, child_id: huge }, 'run-a')
  }
  const done = seed(store, 1, 0)[0]
  store.closeTask({ task_id: done, result: 'failed' }, 'run-a')
  for (let i = 0; i < 110; i++) store.recordFact({ task_id: done, kind: 'blocker', statement: huge, child_id: huge }, 'run-a')
  for (const view of ['tasks', 'summary']) {
    const wire = await tools(store)({ view, limit: 100 })
    assert.ok(Buffer.byteLength(wire) <= 65536, `${view}: ${Buffer.byteLength(wire)} bytes`)
    const page = JSON.parse(wire)
    assert.equal(page.ok, true)
    assert.equal(page.truncated, true)
    assert.equal(page.totals.late_blockers, 110)
    assert.equal(page.late_pagination.has_more, true)
    if (view === 'tasks') {
      assert.ok(page.tasks.length > 0)
      assert.equal(page.tasks[0].owner_session, null, 'actionable identity is omitted, never shortened into a fake ID')
      assert.equal(page.tasks[0].detail.task_id, page.tasks[0].id)
    }
  }
  const all = collect(store, { limit: 100 }, 'tasks')
  assert.equal(new Set(all.map(r => r.id)).size, 110)
  const lateIds = []
  let lateCursor, lateToken
  do {
    const page = store.boardPage({ view: 'summary', limit: 100, late_cursor: lateCursor, late_page_token: lateToken }, 'run-a')
    lateIds.push(...page.late_blockers.map(row => row.fact_id))
    lateCursor = page.late_pagination.next_cursor ?? undefined
    lateToken = page.late_pagination.page_token ?? undefined
  } while (lateCursor !== undefined)
  assert.deepEqual(lateIds, store.handle.prepare("SELECT id FROM fact WHERE task_id=? AND kind='blocker' ORDER BY id DESC").all(done).map(row => row.id))
  assert.equal(store.boardPage({ view: 'late_blockers', limit: 1 }, 'run-a').late_blockers[0].statement, huge.trim())
})

test('keyset continuation ignores later inserts and reads only selected task summaries', t => {
  const store = tempStore(t), ids = seed(store, 70)
  const prepare = store.handle.prepare.bind(store.handle), lengths = []
  store.handle.prepare = sql => {
    const s = prepare(sql), all = s.all.bind(s)
    s.all = (...args) => { const rows = all(...args); lengths.push(rows.length); return rows }
    return s
  }
  const first = store.boardPage({ limit: 25 }, 'run-a')
  const added = store.openTask('later insertion', 'run-a').task_id
  const rest = collect(store, { cursor: first.pagination.next_cursor, page_token: first.pagination.page_token, limit: 25 }, 'tasks')
  assert.deepEqual([...first.tasks, ...rest].map(r => r.id), ids.reverse())
  assert.ok(!rest.some(r => r.id === added))
  assert.ok(Math.max(...lengths) <= 26, `materialized ${Math.max(...lengths)} rows`)
})


test('tool envelope remains bounded for a long real child session ID without inventing another ID', async t => {
  const store = tempStore(t)
  seed(store, 1)
  const root = { options: {}, session: { header: { id: 'run-a' } } }
  const id = '真实😀'.repeat(30000)
  const agent = { options: {}, session: { header: { id, parentSession: 'run-a', origin: 'subagent', delegationDepth: 1 } } }
  const defs = []
  applyTools({ logger: { warn() {} }, get(name) {
    if (name === 'taskforceStore') return store
    if (name === 'agents') return { get: value => value === 'run-a' ? root : undefined }
  }, tools: { register: d => defs.push(d) } })
  const wire = await defs.find(d => d.name === 'task_board').execute({}, { agent })
  assert.ok(Buffer.byteLength(wire) <= 65536)
  const result = JSON.parse(wire)
  assert.equal(result.ok, true)
  assert.equal(result.viewer, null)
  assert.deepEqual(result.viewer_metadata, { role: 'child', omitted: true })
})


test('fact history retains every stored content and provenance field and excludes foreign handoffs', t => {
  const store = tempStore(t), [id] = seed(store, 1, 3)
  const raw = store.handle.prepare('SELECT * FROM fact WHERE task_id=? ORDER BY id DESC').all(id)
  const facts = store.boardPage({ view: 'facts', task_id: id }, 'run-a').facts
  for (let i = 0; i < raw.length; i++) {
    assert.deepEqual(Object.fromEntries(Object.keys(raw[i]).map(key => [key, facts[i][key]])), { ...raw[i] })
  }
  const put = store.handle.prepare('INSERT INTO handoff(task_id,run_id,from_child,to_child,note,created_at) VALUES(?,?,?,?,?,?)')
  put.run(id, 'run-a', 'old', 'new', 'own', 'now')
  for (let i = 0; i < 30; i++) put.run(id, 'foreign', 'old', 'new', 'FOREIGN_HANDOFF', 'now')
  const handoffs = store.boardPage({ view: 'handoffs', task_id: id, limit: 1 }, 'run-a')
  assert.equal(handoffs.total, 1)
  assert.equal(handoffs.handoffs[0].note, 'own')
  assert.equal(handoffs.pagination.has_more, false)
})

test('global submitted totals and scope corruption alarms remain visible outside the current task page', t => {
  const store = tempStore(t), ids = seed(store, 30, 1)
  store.submitTask({ task_id: ids[0] }, 'run-a')
  store.closeTask({ task_id: ids[1], result: 'failed' }, 'run-a')
  store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
    .run(ids[1], 'foreign', 'blocker', 'FOREIGN_LATE', 'CONFIRMED', 'now')
  for (const view of ['tasks', 'summary']) {
    const page = store.boardPage({ view, limit: 1 }, 'run-a')
    assert.equal(page.open_tasks, 29)
    assert.equal(page.submitted_tasks, 1)
    assert.equal(page.scope_integrity_totals.mismatched_facts, 1)
    assert.equal(page.late_blocked_tasks, 0)
    assert.equal(page.late_pagination.has_more, false)
    assert.doesNotMatch(JSON.stringify(page), /FOREIGN_LATE/)
  }
})

test('SQL count work is restricted to selected task IDs before sorting a mixed-status run', t => {
  const store = tempStore(t), ids = seed(store, 120, 1)
  for (let i = 0; i < ids.length; i++) store.handle.prepare('UPDATE task SET status=? WHERE id=?').run(['open', 'claimed', 'submitted', 'rejected'][i % 4], ids[i])
  const counted = new Set()
  store.handle.function('board_count_probe', taskId => { counted.add(taskId); return 1 })
  const prepare = store.handle.prepare.bind(store.handle)
  store.handle.prepare = sql => prepare(sql.includes(' AS fact_count,')
    ? sql.replace('WHERE f.task_id=t.id AND', 'WHERE f.task_id=t.id AND board_count_probe(t.id) AND') : sql)
  const page = store.boardPage({ limit: 1 }, 'run-a')
  assert.equal(page.tasks[0].id, ids.at(-1))
  assert.ok(counted.size <= 2, `computed task counts for ${counted.size} tasks while selecting 1+lookahead`)
})

test('task-filtered pending views keep global totals and the independent full-run late alarm entry', t => {
  const store = tempStore(t), [pending, terminal] = seed(store, 2, 0)
  store.closeTask({ task_id: terminal, result: 'failed' }, 'run-a')
  store.recordFact({ task_id: terminal, kind: 'blocker', statement: 'late elsewhere' }, 'run-a')
  for (const view of ['tasks', 'summary']) {
    const result = store.boardPage({ view, task_id: pending }, 'run-a')
    assert.equal(result.totals.tasks, 2)
    assert.equal(result.totals.late_blockers, 1)
    assert.equal(result.late_blocked_tasks, 1)
    assert.equal(result.late_blockers[0].task_id, terminal)
  }
})


test('board page totals, summaries and late alarms share one snapshot during a real concurrent insert', t => {
  const store = tempStore(t, { journalMode: 'wal' }), [id] = seed(store, 1, 1)
  const writer = new DatabaseSync(store.dbPath)
  t.after(() => writer.close())
  const prepare = store.handle.prepare.bind(store.handle)
  let inserted = false
  store.handle.prepare = sql => {
    const statement = prepare(sql)
    if (sql.startsWith('SELECT COUNT(*) AS tasks,')) {
      const get = statement.get.bind(statement)
      statement.get = (...args) => {
        const result = get(...args)
        if (!inserted) {
          inserted = true
          writer.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
            .run(id, 'run-a', 'fact', 'concurrent-new', 'PLAUSIBLE', 'now')
        }
        return result
      }
    }
    return statement
  }
  const first = store.boardPage({}, 'run-a')
  assert.equal(inserted, true)
  assert.equal(first.totals.facts, 1)
  assert.equal(first.tasks[0].fact_count, 1)
  assert.equal(first.tasks[0].facts[0].statement, 'fact-0-0')
  assert.equal(store.boardPage({}, 'run-a').totals.facts, 2)
  assert.equal(store.handle.isTransaction, false)
})

test('compatible accepted detail checks evidence presence without materializing the full fact history', t => {
  const store = tempStore(t), [id] = seed(store, 1, 80)
  store.submitTask({ task_id: id }, 'run-a')
  store.acceptTask({ task_id: id }, 'run-a', 'lead')
  const prepare = store.handle.prepare.bind(store.handle), lengths = []
  store.handle.prepare = sql => {
    const statement = prepare(sql), all = statement.all.bind(statement)
    statement.all = (...args) => { const rows = all(...args); lengths.push(rows.length); return rows }
    return statement
  }
  const detail = store.boardPage({ task_id: id }, 'run-a')
  assert.equal(detail.facts.length, 50)
  assert.equal(detail.facts_pagination.has_more, true)
  assert.deepEqual(detail.validation_warnings, [])
  assert.ok(Math.max(...lengths) <= 51, `materialized ${Math.max(...lengths)} fact rows for a detail page plus lookahead`)
})

test('pending continuation detects a previously skipped terminal task reopening above the cursor', t => {
  const store = tempStore(t), ids = seed(store, 4, 0)
  store.closeTask({ task_id: ids.at(-1), result: 'failed' }, 'run-a')
  const first = store.boardPage({ limit: 1 }, 'run-a')
  assert.equal(first.tasks[0].id, ids.at(-2))
  store.rejectTask({ task_id: ids.at(-1), reason: 'new evidence requires review' }, 'run-a', 'lead')
  assert.throws(() => store.boardPage({ limit: 1, cursor: first.pagination.next_cursor,
    page_token: first.pagination.page_token }, 'run-a'), { code: 'E_PAGE_CHANGED' })
  assert.equal(store.handle.isTransaction, false)
  assert.equal(store.boardPage({ limit: 1 }, 'run-a').tasks[0].id, ids.at(-1))
})

test('late continuation detects a previously pending high-ID blocker entering the alarm collection', t => {
  const store = tempStore(t), ids = seed(store, 3, 0)
  for (const id of ids.slice(0, 2)) {
    store.closeTask({ task_id: id, result: 'failed' }, 'run-a')
    store.recordFact({ task_id: id, kind: 'blocker', statement: 'late blocker' }, 'run-a')
  }
  store.recordFact({ task_id: ids[2], kind: 'blocker', statement: 'still pending' }, 'run-a')
  const first = store.boardPage({ view: 'late_blockers', limit: 1 }, 'run-a')
  store.closeTask({ task_id: ids[2], result: 'failed' }, 'run-a')
  assert.throws(() => store.boardPage({ view: 'late_blockers', limit: 1,
    cursor: first.pagination.next_cursor, page_token: first.pagination.page_token }, 'run-a'),
  { code: 'E_PAGE_CHANGED' })
})

test('board, stats and working state count the same visible facts including unattached facts and NULL scope', t => {
  const store = tempStore(t)
  for (const run of ['run-a', null]) {
    const [id] = seed(store, 1, 1, run), [foreign] = seed(store, 1, 0, 'foreign')
    store.recordFact({ statement: 'unattached', confidence: 'CONFIRMED' }, run)
    const put = store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
    put.run(foreign, run, 'blocker', 'wrong parent scope', 'REFUTED', 'now')
    store.handle.exec('PRAGMA foreign_keys=OFF')
    put.run(999999, run, 'blocker', 'missing parent', 'REFUTED', 'now')
    store.handle.exec('PRAGMA foreign_keys=ON')
    assert.equal(store.boardPage({}, run).totals.facts, 2)
    const stats = store.stats(run)
    assert.equal(stats.facts.total, 2)
    assert.deepEqual(stats.facts.by_kind, { fact: 2 })
    assert.deepEqual(stats.facts.by_confidence, { CONFIRMED: 1, PLAUSIBLE: 1 })
    assert.equal(store.workingState(run).factCount, 2)
    assert.equal(store.boardPage({ view: 'facts', task_id: id }, run).total, 1)
  }
  assert.equal(store.statsAllRuns().facts.total, 8, 'explicit raw global statistics retain their contract')
})

test('mutable cursors require a bounded token bound to the collection, run, filter and emitted cursor', t => {
  const store = tempStore(t), ids = seed(store, 4, 0)
  seed(store, 4, 0, 'other')
  const first = store.boardPage({ limit: 1 }, 'run-a'), cursor = first.pagination.next_cursor
  const token = first.pagination.page_token
  for (const args of [
    { cursor }, { page_token: token }, { cursor, page_token: '' }, { cursor, page_token: 'bad' },
    { cursor, page_token: 'a'.repeat(2049) }, { cursor: cursor - 1, page_token: token },
    { cursor, page_token: token, task_id: ids[0] }, { cursor, page_token: token, view: 'tasks', task_id: ids[0] },
    { cursor, page_token: token, view: 'late_blockers' },
  ]) assert.throws(() => store.boardPage(args, 'run-a'), { code: 'E_INPUT' }, JSON.stringify(args))
  assert.throws(() => store.boardPage({ cursor, page_token: token }, 'other'), { code: 'E_INPUT' })
  assert.ok(typeof token === 'string' && token.length <= 1024)
  const second = store.boardPage({ limit: 2, cursor, page_token: token }, 'run-a')
  assert.deepEqual(second.tasks.map(row => row.id), ids.slice(1, 3).reverse())
})

test('successful task_board tool continuation forwards the page token and exposes restart guidance', async t => {
  const store = tempStore(t), ids = seed(store, 3, 0), board = tools(store)
  const first = JSON.parse(await board({ limit: 1 }))
  const second = JSON.parse(await board({ limit: 1, cursor: first.pagination.next_cursor,
    page_token: first.pagination.page_token }))
  assert.equal(second.ok, true)
  assert.equal(second.tasks[0].id, ids[1])
  store.closeTask({ task_id: ids[1], result: 'failed' }, 'run-a')
  const stale = JSON.parse(await board({ limit: 1, cursor: first.pagination.next_cursor,
    page_token: first.pagination.page_token }))
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'E_PAGE_CHANGED')
  assert.match(stale.hint, /第一页/)
})

test('workingState excludes wrong-parent facts independently of board rendering', t => {
  const store = tempStore(t), [id] = seed(store, 1, 1), [foreign] = seed(store, 1, 0, 'foreign')
  store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
    .run(foreign, 'run-a', 'fact', 'wrong parent', 'CONFIRMED', 'now')
  assert.equal(store.workingState('run-a').factCount, 1)
  assert.equal(store.workingState('run-a').task.id, id)
})
test('new resolver above the initial blocker ceiling invalidates a late continuation', t => {
  const store = tempStore(t), [id] = seed(store, 1, 0)
  store.closeTask({ task_id: id, result: 'failed' }, 'run-a')
  for (let i = 0; i < 3; i++) store.recordFact({ task_id: id, kind: 'blocker', statement: 'late-' + i }, 'run-a')
  const first = store.boardPage({ view: 'late_blockers', limit: 1 }, 'run-a')
  const blocker = first.late_blockers[0].fact_id
  store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at,resolves_fact_id) VALUES(?,?,?,?,?,?,?)')
    .run(id, 'run-a', 'decision', 'resolved by migrated evidence', 'CONFIRMED', 'now', blocker)
  assert.throws(() => store.boardPage({ view: 'late_blockers', limit: 1,
    cursor: first.pagination.next_cursor, page_token: first.pagination.page_token }, 'run-a'),
  { code: 'E_PAGE_CHANGED' })
})
test('pending status changes and later inserted tasks preserve an existing cohort including NULL scope', t => {
  const store = tempStore(t)
  for (const run of ['run-a', null]) {
    const ids = seed(store, 4, 0, run), first = store.boardPage({ limit: 1 }, run)
    store.claimTask({ task_id: ids[2], child_id: 'worker' }, run)
    store.openTask('new above the ceiling', run)
    const second = store.boardPage({ cursor: first.pagination.next_cursor,
      page_token: first.pagination.page_token, limit: 3 }, run)
    assert.deepEqual(second.tasks.map(row => row.id), ids.slice(0, 3).reverse())
  }
})
test('late tokens continue across display containers while task and late cursors stay independent', t => {
  const store = tempStore(t), ids = seed(store, 4, 0)
  store.closeTask({ task_id: ids[0], result: 'failed' }, 'run-a')
  for (let i = 0; i < 4; i++) store.recordFact({ task_id: ids[0], kind: 'blocker', statement: 'late-' + i }, 'run-a')
  const first = store.boardPage({ limit: 1 }, 'run-a')
  const summary = store.boardPage({ view: 'summary', limit: 1,
    late_cursor: first.late_pagination.next_cursor, late_page_token: first.late_pagination.page_token }, 'run-a')
  const late = store.boardPage({ view: 'late_blockers', limit: 1,
    cursor: summary.late_pagination.next_cursor, page_token: summary.late_pagination.page_token }, 'run-a')
  assert.equal(late.late_blockers[0].fact_id, first.late_blockers[0].fact_id - 2)
  const tasks = store.boardPage({ limit: 1, cursor: first.pagination.next_cursor,
    page_token: first.pagination.page_token }, 'run-a')
  assert.equal(tasks.tasks[0].id, ids[2])
  assert.equal(tasks.late_blockers[0].fact_id, first.late_blockers[0].fact_id)
})

test('fresh terminal-only board avoids redundant task cohort scans and selection', t => {
  const store = tempStore(t), ids = seed(store, 20, 0)
  for (const id of ids) store.closeTask({ task_id: id, result: 'failed' }, 'run-a')
  const prepare = store.handle.prepare.bind(store.handle)
  let queries = 0
  store.handle.prepare = sql => { queries++; return prepare(sql) }
  const page = store.boardPage({}, 'run-a')
  assert.deepEqual(page.tasks, [])
  assert.equal(page.open_tasks, 0)
  assert.equal(page.totals.tasks, 20)
  assert.equal(page.pagination.next_cursor, null)
  assert.equal(page.pagination.page_token, null)
  assert.ok(queries <= 7, 'empty fresh board used ' + queries + ' SQL queries')
})
test('empty current membership still invalidates a previously issued task continuation', t => {
  const store = tempStore(t), ids = seed(store, 3, 0)
  const first = store.boardPage({ limit: 1 }, 'run-a')
  for (const id of ids) store.closeTask({ task_id: id, result: 'failed' }, 'run-a')
  assert.throws(() => store.boardPage({ cursor: first.pagination.next_cursor,
    page_token: first.pagination.page_token }, 'run-a'), { code: 'E_PAGE_CHANGED' })
  assert.throws(() => store.boardPage({ cursor: first.pagination.next_cursor }, 'run-a'), { code: 'E_INPUT' })
  assert.equal(store.handle.isTransaction, false)
})

test('late cohort queries filter blocker history through an index without sorting IDs', t => {
  const store = tempStore(t), ids = seed(store, 80)
  store.handle.prepare("UPDATE task SET status='accepted' WHERE run_id=?").run('run-a')
  for (const id of ids) store.recordFact({ task_id: id, kind: 'blocker', statement: 'late' }, 'run-a')
  const original = store.handle.prepare, prepare = original.bind(store.handle), reads = []
  store.handle.prepare = sql => {
    const statement = prepare(sql)
    if (/^SELECT (?:COALESCE\(MAX\(b\.id\)|b\.id AS id|COUNT\(\*\) AS n, COUNT\(DISTINCT t\.id\))/.test(sql)) {
      for (const method of ['get', 'all', 'iterate']) {
        const execute = statement[method].bind(statement)
        statement[method] = (...params) => { reads.push({ sql, params }); return execute(...params) }
      }
    }
    return statement
  }
  try {
    const first = store.boardPage({ view: 'late_blockers' }, 'run-a')
    assert.equal(first.total, 80)
    const next = store.boardPage({ view: 'late_blockers', cursor: first.pagination.next_cursor,
      page_token: first.pagination.page_token }, 'run-a')
    assert.equal(next.total, 80)
    assert.equal(next.late_blockers.length, 25)
  } finally { store.handle.prepare = original }
  assert.equal(reads.length, 5, 'first ceiling/members/counts and continuation members/counts must execute')
  for (const { sql, params } of reads) {
    const plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail).join('\n')
    assert.match(plan, /SEARCH b USING (?:COVERING )?INDEX idx_fact_blocker_run_id \(run_id=\?/,
      'cohort/count queries must skip ordinary fact history')
    assert.doesNotMatch(plan, /TEMP B-TREE FOR ORDER BY/, 'membership IDs stream in index order')
  }
})


test('all-runs statistics share one snapshot across a concurrent WAL insert', t => {
  const store = tempStore(t, { journalMode: 'wal' })
  const id = store.openTask({ title: 'initial task' }, 'run-a').task_id
  store.recordFact({ task_id: id, kind: 'blocker', statement: 'initial blocker' }, 'run-a')
  const writer = new DatabaseSync(store.dbPath)
  t.after(() => writer.close())
  const original = store.handle.prepare, prepare = original.bind(store.handle)
  let inserted = false
  store.handle.prepare = sql => {
    const statement = prepare(sql)
    if (sql === 'SELECT status, COUNT(*) AS n FROM task GROUP BY status') {
      const all = statement.all.bind(statement)
      statement.all = (...params) => {
        const result = all(...params)
        if (!inserted) {
          inserted = true
          writer.exec('BEGIN IMMEDIATE')
          try {
            const task = writer.prepare("INSERT INTO task(title,status,run_id,created_at,updated_at) VALUES('concurrent task','open','run-b','now','now')").run().lastInsertRowid
            writer.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,'run-b','blocker','concurrent blocker','PLAUSIBLE','now')").run(task)
            writer.exec('COMMIT')
          } catch (error) { writer.exec('ROLLBACK'); throw error }
        }
        return result
      }
    }
    return statement
  }
  let first
  try { first = store.statsAllRuns() } finally { store.handle.prepare = original }
  assert.equal(inserted, true)
  assert.equal(first.tasks.total, 1)
  assert.equal(first.facts.total, 1)
  assert.equal(first.runs, 1)
  assert.equal(first.blockers_open, 1)
  assert.equal(store.handle.isTransaction, false)
  const next = store.statsAllRuns()
  assert.equal(next.tasks.total, 2)
  assert.equal(next.facts.total, 2)
  assert.equal(next.runs, 2)
  assert.equal(next.blockers_open, 2)
})


test('control integrity uses task-key searches on a large journal for paged and legacy boards', t => {
  const store = tempStore(t)
  const scopes = [['run-a', 160], ['run-b', 40], [null, 80]]
  const groups = scopes.map(([scope, count]) => [scope, seed(store, count, 0, scope)])
  let operations = 0
  withWriteTransaction(store.handle, () => {
    const insert = store.handle.prepare('INSERT INTO control_operation(operation_id,caller_session,request_key,run_id,task_id,evidence_generation,action,target_id,payload_hash,process_instance,status,created_at) VALUES(?,?,?,?,?,0,?,?,?,?,?,?)')
    const add = (task, scope, foreign = false) => {
      const key = 'scale-' + operations++
      insert.run(key, 'caller-' + key, key, scope, task, 'send',
        foreign ? 'FOREIGN_CONTROL_SECRET' : 'child', '0'.repeat(64), 'test', 'unknown', 'now')
    }
    for (const [scope, ids] of groups) for (const id of ids) {
      for (let i = 0; i < 24; i++) add(id, scope)
      if (scope === 'run-a') { add(id, 'run-b', true); add(id, null, true) }
      if (scope === null) add(id, 'run-b', true)
    }
    for (let i = 0; i < 1000; i++) add(null, i % 2 ? 'run-a' : null)
  })
  assert.equal(operations, 8120)
  const original = store.handle.prepare, prepare = original.bind(store.handle), plans = []
  store.handle.prepare = sql => {
    const statement = prepare(sql)
    if (sql.includes('control_operation o') && sql.includes('AS mismatched_controls')) {
      for (const method of ['get', 'all']) {
        const execute = statement[method].bind(statement)
        statement[method] = (...params) => {
          plans.push({ sql, plan: prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail) })
          return execute(...params)
        }
      }
    }
    return statement
  }
  try {
    for (const [scope, count, mismatches] of [['run-a', 160, 320], [null, 80, 80]]) {
      for (const view of ['tasks', 'summary']) {
        const page = store.boardPage({ view, limit: 1 }, scope)
        assert.equal(page.totals.tasks, count)
        assert.equal(page.tasks.length, view === 'tasks' ? 1 : 0)
        assert.equal(page.scope_integrity_totals.mismatched_controls, mismatches)
        assert.doesNotMatch(JSON.stringify(page), /FOREIGN_CONTROL_SECRET/)
      }
      const legacy = store.board({}, scope)
      assert.equal(legacy.scope_integrity.length, count)
      assert.equal(legacy.scope_integrity.reduce((sum, row) => sum + row.mismatched_controls, 0), mismatches)
      assert.doesNotMatch(JSON.stringify(legacy), /FOREIGN_CONTROL_SECRET/)
    }
    assert.deepEqual({ ...store.boardPage({ limit: 1 }, 'run-b').scope_integrity_totals },
      { mismatched_facts: 0, mismatched_handoffs: 0 }, 'detached controls are not attached anomalies')
  } finally { store.handle.prepare = original }
  assert.equal(plans.length, 7, 'five compact totals and two legacy full-run integrity reads must execute')
  const accesses = plans.map(({ sql, plan }) => ({
    path: sql.startsWith('SELECT t.id AS task_id') ? 'legacy' : 'paged',
    access: plan.filter(detail => /\b(?:SCAN|SEARCH) o\b/.test(detail)),
  }))
  t.diagnostic('CONTROL_INTEGRITY_SCALE ' + JSON.stringify({ tasks: 280, operations, accesses }))
  for (const { plan } of plans) {
    assert.match(plan.join('\n'), /SEARCH o USING .*\(task_id=\?/,
      'each correlated control count must seek by parent task, never scan the complete journal')
    assert.doesNotMatch(plan.join('\n'), /\bSCAN o\b/)
  }
})

const task19HandoffFields = ['from_child', 'to_child', 'note']
const task19HandoffCases = []
for (const field of task19HandoffFields) for (const position of ['leading', 'middle', 'trailing']) {
  const values = { from_child: 'old', to_child: 'new', note: 'handoff' }
  values[field] = position === 'leading' ? '\0' + field : position === 'middle' ? field + '\0suffix' : field + '\0'
  task19HandoffCases.push(values)
}
for (const position of ['leading', 'middle', 'trailing']) task19HandoffCases.push(Object.fromEntries(task19HandoffFields.map(field =>
  [field, position === 'leading' ? '\0' + field : position === 'middle' ? field + '\0suffix' : field + '\0'])))
for (const value of ['Tordinary', 'J"literal"', '{"text":true}', 'literal\\u0000', '中文🙂']) {
  task19HandoffCases.push(Object.fromEntries(task19HandoffFields.map(field => [field, value])))
}
// Full-run variants are post-Task16 closure; each batch fits H1's unchanged limit10.
for (const run of ['task19-handoffs', 'task19-handoffs\0full']) for (const offset of [0, 10]) {
  test(`Task19 handoff content survives both history readers and pagination: ${JSON.stringify(run)} batch ${offset / 10}`, t => {
    const store = tempStore(t), id = store.openTask('handoffs', run).task_id
    const expected = task19HandoffCases.slice(offset, offset + 10).map(values => ({
      ...values, id: store.recordHandoff({ task_id: id, ...values }, run).handoff_id,
    })).reverse()
    assert.ok(expected.length > 3 && expected.length <= 10)
    const creationHandle = store.open()
    function check(reader) {
      const oracle = new DatabaseSync(store.dbPath, { readOnly: true })
      try {
        const rows = oracle.prepare('SELECT id, json_quote(from_child) AS from_child_json, typeof(from_child) AS from_child_type,'
          + ' json_quote(to_child) AS to_child_json, typeof(to_child) AS to_child_type, json_quote(note) AS note_json, typeof(note) AS note_type,'
          + ' json_quote(run_id) AS run_id_json, typeof(run_id) AS run_id_type FROM handoff WHERE task_id=? ORDER BY id DESC').all(id)
        assert.deepEqual(rows.map(row => row.id), expected.map(row => row.id))
        rows.forEach((row, index) => {
          for (const field of [...task19HandoffFields, 'run_id']) {
            assert.equal(row[field + '_type'], 'text')
            assert.equal(JSON.parse(row[field + '_json']), field === 'run_id' ? run : expected[index][field])
          }
        })
        assert.equal(oracle.prepare('SELECT total_changes() AS n').get().n, 0)
      } finally { oracle.close() }
      const db = reader.open(), before = db.prepare('SELECT total_changes() AS n').get().n
      const legacy = reader.board({ task_id: id }, run).handoffs
      const detail = reader.boardPage({ task_id: id }, run)
      const history = collect(reader, { view: 'handoffs', task_id: id, limit: 3 }, 'handoffs', run)
      assert.equal(detail.handoffs_pagination.has_more, false)
      for (const rows of [legacy, detail.handoffs, history]) {
        assert.deepEqual(rows.map(row => row.id), expected.map(row => row.id))
        assert.equal(new Set(rows.map(row => row.id)).size, expected.length)
        rows.forEach((row, index) => {
          assert.equal(row.task_id, id)
          for (const field of task19HandoffFields) assert.equal(row[field], expected[index][field])
        })
      }
      for (const row of legacy) assert.equal(Object.hasOwn(row, 'run_id'), false, 'H1 retains its existing projection')
      for (const row of [...detail.handoffs, ...history]) assert.equal(row.run_id, run)
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
    }
    assert.equal(store.open(), creationHandle); check(store)
    store.close()
    const reopened = new TaskforceStore(store.root)
    try { assert.notEqual(reopened.open(), creationHandle); check(reopened) } finally { reopened.close() }
  })
}

for (const [index, sample] of ['\0field', 'field\0suffix', 'field\0', 'Tordinary', 'J"literal"', '{"text":true}', 'literal\\u0000', '中文🙂', 'structured\0actor'].entries()) {
  test(`Task19 fact attribution remains exact in every public projection: ${JSON.stringify(sample)}`, t => {
    const store = tempStore(t), run = index === 7 ? 'task19-facts\0full' : 'task19-facts'
    const structured = index === 8
    const by = sample.replace('field', 'display'), actorSession = structured ? by : sample.replace('field', 'audit')
    const actor = structured ? { sessionId: by, isRoot: false } : by
    const statement = 'statement\0kept', evidencePath = [null, 'result.txt', '报告/结果.txt'][index % 3]
    const evidenceLine = evidencePath === null ? null : 7
    const id = store.openTask('active attribution', run).task_id
    const lateId = store.openTask('late attribution', run).task_id
    store.closeTask({ task_id: lateId, result: 'failed' }, run)
    const record = taskId => store.recordFact({ task_id: taskId, kind: 'blocker', statement,
      evidence_path: evidencePath, evidence_line: evidenceLine }, run, actor, structured ? undefined : actorSession)
    const fact = record(id), lateFact = record(lateId)
    assert.equal(fact.late, false); assert.equal(lateFact.late, true)
    const creationHandle = store.open()
    function check(reader) {
      const oracle = new DatabaseSync(store.dbPath, { readOnly: true })
      try {
        const rows = oracle.prepare('SELECT id, json_quote(created_by) AS by_json, typeof(created_by) AS by_type,'
          + ' json_quote(actor_session) AS actor_json, typeof(actor_session) AS actor_type,'
          + ' json_quote(statement) AS statement_json, typeof(statement) AS statement_type,'
          + ' json_quote(evidence_path) AS evidence_json, typeof(evidence_path) AS evidence_type, json_quote(run_id) AS run_json'
          + ' FROM fact WHERE id IN (?,?) ORDER BY id').all(fact.fact_id, lateFact.fact_id)
        assert.deepEqual(rows.map(row => row.id), [fact.fact_id, lateFact.fact_id])
        for (const row of rows) {
          assert.equal(row.by_type, 'text'); assert.equal(JSON.parse(row.by_json), by)
          assert.equal(row.actor_type, 'text'); assert.equal(JSON.parse(row.actor_json), actorSession)
          assert.equal(row.statement_type, 'text'); assert.equal(JSON.parse(row.statement_json), statement)
          assert.equal(row.evidence_type, evidencePath === null ? 'null' : 'text')
          assert.equal(JSON.parse(row.evidence_json), evidencePath); assert.equal(JSON.parse(row.run_json), run)
        }
        assert.equal(oracle.prepare('SELECT total_changes() AS n').get().n, 0)
      } finally { oracle.close() }
      const db = reader.open(), before = db.prepare('SELECT total_changes() AS n').get().n
      const detail = reader.board({ task_id: id }, run).facts[0]
      const ranked = reader.board({}, run).tasks.find(row => row.id === id).facts[0]
      const raw = reader.boardPage({ view: 'facts', task_id: id }, run).facts[0]
      const latest = reader.boardPage({}, run).tasks.find(row => row.id === id).facts[0]
      for (const row of [detail, ranked, raw, latest]) {
        assert.equal(row.id, fact.fact_id); assert.equal(row.by, by); assert.equal(row.actor_session, actorSession)
        assert.equal(row.statement, statement); assert.equal(row.truncated, undefined)
        assert.equal(row.evidence, evidencePath === null ? null : `${evidencePath}:${evidenceLine}`)
      }
      assert.equal(raw.created_by, by); assert.equal(raw.evidence_path, evidencePath); assert.equal(raw.run_id, run)
      const legacyLate = reader.board({}, run).late_blockers.find(row => row.task_id === lateId).blockers[0]
      const fullLate = reader.boardPage({ view: 'late_blockers', task_id: lateId }, run).late_blockers[0]
      const displayLate = reader.boardPage({ view: 'summary' }, run).late_blockers[0]
      for (const row of [legacyLate, fullLate, displayLate]) {
        assert.equal(row.fact_id, lateFact.fact_id); assert.equal(row.by, by)
        assert.equal(row.actor_session, actorSession); assert.equal(row.statement, statement)
      }
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
    }
    assert.equal(store.open(), creationHandle); check(store)
    store.close()
    const reopened = new TaskforceStore(store.root)
    try { assert.notEqual(reopened.open(), creationHandle); check(reopened) } finally { reopened.close() }
  })
}

for (const delta of [-1, 0, 1]) {
  test(`Task19 restored board values obey existing clip boundaries: ${delta}`, t => {
    const store = tempStore(t), run = 'task19-boundaries'
    const text = length => 'x\0' + '"'.repeat(length - 2)
    const values = { title: text(80 + delta), owner: text(64 + delta), owner_session: text(256 + delta),
      statement: text(160 + delta), by: text(64 + delta), actor_session: text(256 + delta) }
    const id = store.openTask({ title: values.title, note: values.statement }, run).task_id
    store.claimTask({ task_id: id, child_id: values.owner }, run, 'lead', values.owner_session)
    const fact = store.recordFact({ task_id: id, statement: values.statement }, run, values.by, values.actor_session)
    const creationHandle = store.open()
    function check(reader) {
      const page = reader.boardPage({}, run), row = page.tasks[0], visibleFact = row.facts[0]
      const clipped = delta > 0
      assert.equal(row.title, clipped ? values.title.slice(0, 80) + '…' : values.title)
      assert.equal(row.owner, clipped ? values.owner.slice(0, 64) + '…' : values.owner)
      assert.equal(row.owner_session, clipped ? null : values.owner_session)
      assert.equal(visibleFact.statement, clipped ? values.statement.slice(0, 160) + '…' : values.statement)
      assert.equal(visibleFact.by, clipped ? values.by.slice(0, 64) + '…' : values.by)
      assert.equal(visibleFact.actor_session, clipped ? null : values.actor_session)
      assert.deepEqual(row.truncated_fields, clipped ? ['title', 'owner', 'owner_session'] : undefined)
      assert.deepEqual(visibleFact.truncated_fields, clipped ? ['statement', 'by', 'actor_session'] : undefined)
      assert.equal(page.truncated, clipped); assert.equal(page.pagination.has_more, false)
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 60000)
      const detail = reader.board({ task_id: id }, run)
      for (const field of ['title', 'owner', 'owner_session']) assert.equal(detail.task[field], values[field])
      assert.equal(detail.task.note, values.statement)
      const history = reader.boardPage({ view: 'facts', task_id: id }, run).facts[0]
      assert.equal(history.id, fact.fact_id)
      for (const field of ['statement', 'by', 'actor_session']) assert.equal(history[field], values[field])
    }
    assert.equal(store.open(), creationHandle); check(store)
    store.close()
    const reopened = new TaskforceStore(store.root)
    try { assert.notEqual(reopened.open(), creationHandle); check(reopened) } finally { reopened.close() }
  })
}

// Count the real public reader pair; oracle/setup reads occur outside this hook.
function task19BoardLifecycle(t, db, originalSql, match, args, rowCount, work, mutate) {
  const originalPrepare = db.prepare, prepare = originalPrepare.bind(db), records = []
  db.prepare = sql => {
    const statement = prepare(sql)
    if (!match(sql)) return statement
    const record = { kind: sql === originalSql ? 'original' : 'generated', columns: 0,
      get: 0, all: 0, iterate: 0, run: 0, bindings: [], rows: [] }
    records.push(record)
    const columns = statement.columns.bind(statement)
    statement.columns = (...values) => { record.columns++; return columns(...values) }
    for (const method of ['get', 'all', 'iterate', 'run']) {
      const read = statement[method].bind(statement)
      statement[method] = (...values) => {
        record[method]++; record.bindings.push(values)
        const result = read(...values)
        if (method === 'all') {
          assert.equal(Array.isArray(result), true); record.rows.push(result.length)
          if (record.kind === 'generated' && mutate) mutate(result)
        }
        return result
      }
    }
    return statement
  }
  let result
  try { result = work() } finally { db.prepare = originalPrepare }
  t.diagnostic('public SQL lifecycle ' + JSON.stringify({ originalSql, records }))
  assert.deepEqual(records, rowCount === null ? [] : [
    { kind: 'original', columns: 1, get: 0, all: 0, iterate: 0, run: 0, bindings: [], rows: [] },
    { kind: 'generated', columns: 1, get: 0, all: 1, iterate: 0, run: 0, bindings: [args], rows: [rowCount] },
  ])
  return result
}

for (const [view, scope] of [['facts', 'lifecycle\0run'], ['handoffs', 'lifecycle\0run'], ['latest', 'lifecycle\0run'], ['handoffs', null]]) {
  test(`Task19 ${view} public lifecycle counts empty and multi-field rows without extra reads: ${JSON.stringify(scope)}`, t => {
    const store = tempStore(t), db = store.open()
    const statement = 'statement\0full', by = 'display\0full', actor = 'actor\0full'
    const ids = [], expected = []
    if (view !== 'latest') ids.push(store.openTask('history', scope).task_id)
    const check = count => {
      const history = view !== 'latest'
      const suffix = history
        ? ' FROM ' + (view === 'facts' ? 'fact' : 'handoff')
          + ' f JOIN task t ON t.id=f.task_id AND f.run_id IS t.run_id WHERE t.run_id IS ? AND t.id=? ORDER BY f.id DESC LIMIT ?'
        : ' FROM fact f JOIN task t ON t.id=f.task_id AND f.run_id IS t.run_id WHERE t.run_id IS ? AND t.id IN ('
          + [...ids].reverse().map(() => '?').join(',') + ') AND f.id=(SELECT MAX(b.id) FROM fact b WHERE b.task_id=t.id AND b.run_id IS t.run_id)'
      const match = sql => sql.startsWith('SELECT ') && (history ? sql.endsWith(suffix)
        : sql.includes(' FROM fact f JOIN task t ON t.id=f.task_id AND f.run_id IS t.run_id WHERE t.run_id IS ? AND t.id IN (')
          && sql.endsWith(' AND f.id=(SELECT MAX(b.id) FROM fact b WHERE b.task_id=t.id AND b.run_id IS t.run_id)'))
      const before = db.prepare('SELECT total_changes() AS n').get().n
      const page = task19BoardLifecycle(t, db, 'SELECT f.*' + suffix, match,
        history ? [scope, ids[0], 4] : [scope, ...[...ids].reverse()], count,
        () => store.boardPage(history ? { view, task_id: ids[0], limit: 3 } : { limit: 3 }, scope))
      const rows = history ? page[view] : page.tasks.flatMap(task => task.facts)
      assert.equal(rows.length, expected.length)
      assert.deepEqual(rows.map(row => row.id), [...expected].reverse().map(row => row.id))
      rows.forEach((row, index) => {
        const wanted = expected.at(-1 - index)
        if (view === 'handoffs') {
          for (const field of ['from_child', 'to_child', 'note', 'run_id']) assert.equal(row[field], wanted[field])
        } else {
          assert.equal(row.statement, statement); assert.equal(row.by, by); assert.equal(row.actor_session, actor)
          assert.equal(row.evidence, null)
          if (view === 'facts') {
            assert.equal(row.created_by, by); assert.equal(row.evidence_path, null); assert.equal(row.run_id, scope)
          }
        }
      })
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
      assert.equal(db.isTransaction, false)
    }
    check(view === 'latest' ? null : 0) // A4 alone skips preparation when no task is selected.
    if (view === 'latest') { ids.push(store.openTask('latest one', scope).task_id); check(0) }
    for (let index = 0; index < 2; index++) {
      if (view === 'latest' && index === 1) ids.push(store.openTask('latest two', scope).task_id)
      if (view === 'handoffs') {
        const values = { from_child: 'from\0full', to_child: 'to\0full', note: 'note\0full', run_id: scope }
        const created = store.recordHandoff({ task_id: ids[0], ...values }, scope)
        expected.push({ ...values, id: created.handoff_id })
      } else {
        const created = store.recordFact({ task_id: view === 'latest' ? ids.at(-1) : ids[0], statement }, scope, by, actor)
        expected.push({ id: created.fact_id })
      }
      check(index + 1)
    }
  })
}
