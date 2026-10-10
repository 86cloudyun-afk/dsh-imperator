import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { withWriteTransaction } from '../../lib/store/sqlite.js'
import { apply as applyStore, TaskforceStore } from '../../lib/store/index.js'
import { tempStore, seedSubmitted } from './helpers.mjs'

const run = 'scope-a'
function foreignFact(store, taskId, kind = 'artifact', foreignRun = 'scope-b') {
  return store.open().prepare('INSERT INTO fact(task_id,kind,statement,evidence_path,confidence,created_by,run_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(taskId, kind, 'FOREIGN_SECRET', 'FOREIGN_PATH', 'CONFIRMED', 'FOREIGN_ACTOR', foreignRun, '9999-01-01').lastInsertRowid
}
function foreignHandoff(store, taskId) {
  store.open().prepare('INSERT INTO handoff(task_id,from_child,to_child,note,run_id,created_at) VALUES(?,?,?,?,?,?)')
    .run(taskId, 'FOREIGN_FROM', 'FOREIGN_TO', 'FOREIGN_HANDOFF', 'scope-b', '9999-01-01')
}
for (const foreignRun of ['scope-b', null]) {
  test(`task readers exclude misattributed facts (${foreignRun}) and report integrity counts`, (t) => {
    const store = tempStore(t)
    const id = seedSubmitted(store, run)
    const before = store.board(id, run)
    foreignFact(store, id, 'artifact', foreignRun)
    foreignFact(store, id, 'blocker', foreignRun)
    foreignHandoff(store, id)
    const detail = store.board(id, run)
    const board = store.board({}, run)
    assert.doesNotMatch(JSON.stringify(detail), /FOREIGN_/)
    assert.doesNotMatch(JSON.stringify(board), /FOREIGN_/)
    assert.equal(detail.task.fact_count, before.task.fact_count)
    assert.equal(detail.task.last_fact_at, before.task.last_fact_at)
    assert.equal(store.taskOf(id, run).blockers, 0)
    assert.deepEqual(detail.counts, before.counts)
    assert.equal(detail.handoffs.length, 0)
    assert.equal(board.tasks[0].fact_count, before.task.fact_count)
    assert.equal(board.tasks[0].blockers, 0)
    assert.deepEqual(board.scope_integrity, [{ task_id: id, mismatched_facts: 2, mismatched_handoffs: 1 }])
    assert.deepEqual(detail.scope_integrity, board.scope_integrity)
    assert.equal(store.stats(run).blockers_open, 0)
    const view = store.handle.prepare('SELECT fact_count, blockers_open FROM v_run_board WHERE id=?').get(id)
    assert.equal(view.fact_count, before.task.fact_count)
    assert.equal(view.blockers_open, 0)
    assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact WHERE task_id=?').get(id).n, before.task.fact_count + 2)
  })
}
for (const corruption of ['artifact', 'blocker', 'handoff']) {
  for (const waiver of [false, true]) {
    test(`acceptance refuses ${corruption} scope corruption (waiver=${waiver}) atomically`, (t) => {
      const store = tempStore(t)
      const id = seedSubmitted(store, run)
      if (corruption === 'handoff') foreignHandoff(store, id)
      else foreignFact(store, id, corruption)
      const before = store.handle.prepare('SELECT status,updated_at FROM task WHERE id=?').get(id)
      const count = store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n
      assert.throws(() => store.acceptTask({ task_id: id, ...(waiver ? { waiver_reason: 'manual' } : {}) }, run, 'lead'), (error) => {
        assert.equal(error.code, 'E_STORE_INTEGRITY')
        assert.match(error.hint, /重试|修复/)
        assert.doesNotMatch(error.message + error.hint, /FOREIGN_/)
        return true
      })
      assert.deepEqual(store.handle.prepare('SELECT status,updated_at FROM task WHERE id=?').get(id), before)
      assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n, count)
    })
  }
}
test('an accepted task keeps its decision but reports a foreign late blocker without leaking it', (t) => {
  const store = tempStore(t)
  const id = seedSubmitted(store, run)
  store.acceptTask({ task_id: id }, run, 'lead')
  foreignFact(store, id, 'blocker')
  const board = store.board({}, run)
  assert.equal(board.tasks.length, 0)
  assert.equal(board.late_blockers.length, 0)
  assert.equal(board.scope_integrity[0].task_id, id)
  assert.doesNotMatch(JSON.stringify(board), /FOREIGN_/)
  assert.equal(store.stats(run).blockers_late, 0)
  assert.equal(store.board(id, run).task.status, 'accepted')
})
test('unassigned tasks reject attached assigned facts without absorbing another domain', (t) => {
  const store = tempStore(t)
  const id = seedSubmitted(store)
  foreignFact(store, id)
  assert.doesNotMatch(JSON.stringify(store.board(id)), /FOREIGN_/)
  assert.throws(() => store.acceptTask({ task_id: id }, undefined, 'lead'), { code: 'E_STORE_INTEGRITY' })
})
test('healthy tasks and foreign-run refusal retain existing semantics', (t) => {
  const store = tempStore(t)
  const id = seedSubmitted(store, run)
  assert.deepEqual(store.board(id, run).scope_integrity, [])
  assert.throws(() => store.acceptTask({ task_id: id }, 'scope-b', 'lead'), { code: 'E_CROSS_RUN' })
  assert.equal(store.acceptTask({ task_id: id }, run, 'lead').status, 'accepted')
})


function quarantinedExecutionAudit(store) {
  const id = seedSubmitted(store, run)
  store.handle.prepare('INSERT INTO execution_receipt(receipt_id,task_id,run_id,evidence_generation,owner_session,actor_session,command,cwd,verification_files,status,started_at,call_id,root_call_id,parent_call_id,timeout_ms,snapshot) VALUES(?,?,NULL,0,?,?,?,?,?,?,?,?,?,NULL,?,?)')
    .run('null-receipt', id, 'worker', 'worker', 'true', '/tmp', '[]', 'completed', 'now', 'call', 'call', 1000, '{}')
  store.handle.prepare('INSERT INTO execution_waiver(task_id,run_id,evidence_generation,actor_session,reason,created_at) VALUES(?,NULL,0,?,?,?)')
    .run(id, 'lead', 'legacy quarantine', 'now')
  return id
}

test('migration diagnostics include only-NULL execution audit and preserve quarantine', t => {
  const store = tempStore(t), id = quarantinedExecutionAudit(store)
  const summary = store.unassignedSummary()
  assert.equal(summary.execution_receipts, 1)
  assert.equal(summary.execution_waivers, 1)
  const adopted = store.adoptUnassigned('scope-b')
  assert.equal(adopted.execution_receipts, 0)
  assert.equal(adopted.execution_waivers, 0)
  assert.throws(() => store.acceptTask({ task_id: id, waiver_reason: 'manual' }, run, 'lead'), { code: 'E_STORE_INTEGRITY' })
  const migration = store.migrate(store.handle, false)
  for (const key of ['task', 'fact', 'handoff', 'execution_receipts', 'execution_waivers']) {
    assert.equal(migration.unassigned[key], summary[key], key)
  }
})

test('boot warns when only quarantined NULL execution receipts and waivers exist', t => {
  const store = tempStore(t)
  quarantinedExecutionAudit(store)
  store.close()
  const warnings = [], disposers = []
  let published
  applyStore({
    logger: { info() {}, warn(message) { warnings.push(message) } },
    effect(callback) { disposers.push(callback()) },
    provide(name, value) { if (name === 'taskforceStore') published = value },
  }, { root: store.root })
  t.after(() => { for (const dispose of disposers) dispose?.() })
  assert.ok(published)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /execution_receipts=1/)
  assert.match(warnings[0], /execution_waivers=1/)
  assert.match(warnings[0], /管理员|人工核对/)
})

for (const table of ['task_event', 'task_checkpoint', 'control_operation']) {
  for (const [scope, foreignScope] of [[run, 'scope-b'], [run, null], [null, 'scope-b']]) {
    test('board integrity totals report ' + table + ' corruption ' + scope + '/' + foreignScope, t => {
      const store = tempStore(t), id = seedSubmitted(store, scope)
      if (table === 'task_event') {
        store.handle.prepare('INSERT INTO task_event(task_id,run_id,kind,source,actor_session,status,evidence_generation,history_complete,observed_at) VALUES(?,?,?,?,?,?,0,1,?)')
          .run(id, foreignScope, 'transition', 'database_change', 'FOREIGN_SECRET', 'submitted', 'now')
      } else if (table === 'task_checkpoint') {
        store.handle.prepare('INSERT INTO task_checkpoint(task_id,run_id,actor_session,evidence_generation,summary,created_at) VALUES(?,?,?,0,?,?)')
          .run(id, foreignScope, 'FOREIGN_SECRET', 'FOREIGN_SECRET', 'now')
      } else {
        store.handle.prepare('INSERT INTO control_operation(operation_id,caller_session,request_key,run_id,task_id,evidence_generation,action,target_id,payload_hash,process_instance,status,created_at) VALUES(?,?,?,?,?,0,?,?,?,?,?,?)')
          .run('operation', 'FOREIGN_SECRET', 'request', foreignScope, id, 'send', 'FOREIGN_SECRET', '0'.repeat(64), 'process', 'unknown', 'now')
      }
      const key = { task_event: 'mismatched_events', task_checkpoint: 'mismatched_checkpoints', control_operation: 'mismatched_controls' }[table]
      const detail = store.board({ task_id: id }, scope)
      assert.equal(detail.scope_integrity[0][key], 1)
      const before = store.taskOf(id, scope).task
      assert.throws(() => store.acceptTask({ task_id: id, waiver_reason: 'manual' }, scope, 'lead'), { code: 'E_STORE_INTEGRITY' })
      assert.deepEqual(store.taskOf(id, scope).task, before)
      for (const view of ['tasks', 'summary']) {
        const page = store.boardPage({ view }, scope)
        assert.equal(page.scope_integrity_totals[key], 1)
        assert.doesNotMatch(JSON.stringify({ detail, page }), /FOREIGN_SECRET/)
      }
    })
  }
}

test('healthy recovery integrity keeps the existing compact total shape', t => {
  const store = tempStore(t)
  seedSubmitted(store, run)
  assert.deepEqual({ ...store.boardPage({}, run).scope_integrity_totals }, { mismatched_facts: 0, mismatched_handoffs: 0 })
})


test('reopening a legacy control journal preserves every row and column while restoring task lookup', t => {
  const store = tempStore(t), id = seedSubmitted(store, run)
  const insert = store.handle.prepare('INSERT INTO control_operation(operation_id,caller_session,request_key,run_id,task_id,evidence_generation,action,target_id,payload_hash,process_instance,status,created_at) VALUES(?,?,?,?,?,0,?,?,?,?,?,?)')
  for (const [key, scope, task] of [['matched', run, id], ['foreign', null, id], ['detached', null, null]]) {
    insert.run(key, ' 真实 caller ', key, scope, task, 'send', ' child ', '0'.repeat(64), 'test', 'unknown', '2025-01-01')
  }
  // Simulate an existing supported journal created before task lookup was indexed.
  for (const index of store.handle.prepare("PRAGMA index_list('control_operation')").all()) {
    const escaped = index.name.replaceAll('"', '""')
    const columns = store.handle.prepare('PRAGMA index_info("' + escaped + '")').all()
    if (columns[0]?.name === 'task_id') store.handle.exec('DROP INDEX "' + escaped + '"')
  }
  const tables = ['task', 'fact', 'handoff', 'control_operation', 'task_event', 'task_checkpoint']
  const rows = db => tables.map(table => JSON.stringify(db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()))
  const columns = db => tables.map(table => db.prepare('PRAGMA table_info(' + table + ')').all())
  const beforeRows = rows(store.handle), beforeColumns = columns(store.handle)
  const oldPlan = store.handle.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM control_operation o WHERE o.task_id=? AND o.run_id IS NOT ?')
    .all(id, run).map(row => row.detail).join('\n')
  assert.match(oldPlan, /\bSCAN o\b/, 'fixture must have the former unindexed access path')
  store.close()
  const reopened = new TaskforceStore(store.root)
  t.after(() => reopened.close())
  reopened.open()
  assert.deepEqual(rows(reopened.handle), beforeRows, 'migration preserves all serialized row bytes')
  assert.deepEqual(columns(reopened.handle), beforeColumns, 'adding an access path changes no physical columns')
  assert.deepEqual(reopened.migration.added_columns, [])
  const plan = reopened.handle.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM control_operation o WHERE o.task_id=? AND o.run_id IS NOT ?')
    .all(id, run).map(row => row.detail).join('\n')
  t.diagnostic('CONTROL_JOURNAL_MIGRATION ' + JSON.stringify({ before: oldPlan, after: plan }))
  assert.match(plan, /SEARCH o USING .*\(task_id=\?/, 'reopening must restore a task-key lookup')
  assert.equal(reopened.board({ task_id: id }, run).scope_integrity[0].mismatched_controls, 1)
})


test('measure boot audit counts at 100k assigned rows without changing NULL quarantine', t => {
  const store = tempStore(t)
  const scoped = seedSubmitted(store, run), unassigned = seedSubmitted(store), other = seedSubmitted(store, 'scope-b')
  const insertReceipt = store.handle.prepare('INSERT INTO execution_receipt(receipt_id,task_id,run_id,evidence_generation,owner_session,actor_session,command,cwd,verification_files,status,started_at,call_id,root_call_id,timeout_ms,snapshot,logs) VALUES(?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insertWaiver = store.handle.prepare('INSERT INTO execution_waiver(task_id,run_id,evidence_generation,actor_session,reason,created_at) VALUES(?,?,0,?,?,?)')
  const add = (key, task, scope) => {
    insertReceipt.run(key, task, scope, 'worker', 'worker', 'true', '/tmp', '[]', 'completed', 'now', 'call', 'root', 1000, '{}', null)
    insertWaiver.run(task, scope, 'lead', 'historical waiver', 'now')
  }
  const bulk = (start, end) => withWriteTransaction(store.handle, () => {
    for (let i = start; i < end; i++) add('assigned-' + i, i % 2 ? scoped : other, i % 2 ? run : 'scope-b')
  })
  const auditTables = ['execution_receipt', 'execution_waiver']
  const fingerprint = db => auditTables.map(table => {
    const hash = createHash('sha256')
    let rows = 0
    for (const row of db.prepare('SELECT * FROM ' + table + ' ORDER BY id').iterate()) {
      hash.update(JSON.stringify(row) + '\n')
      rows++
    }
    return { table, rows, sha256: hash.digest('hex') }
  })
  const columns = db => auditTables.map(table => db.prepare('PRAGMA table_info(' + table + ')').all())
  const original = DatabaseSync.prototype.prepare, queries = [], totals = []
  let stage = '', reopened, published
  const disposers = []
  const measure = (name, work) => {
    stage = name
    const start = performance.now(), result = work()
    totals.push({ stage, milliseconds: +(performance.now() - start).toFixed(3) })
    return result
  }
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = original.call(this, sql)
    if (sql.startsWith('SELECT ') && sql.includes(') AS execution_receipts') && sql.includes(') AS execution_waivers')) {
      const get = statement.get.bind(statement), db = this
      statement.get = (...params) => {
        const start = performance.now(), row = get(...params)
        const milliseconds = +(performance.now() - start).toFixed(3)
        const plan = original.call(db, 'EXPLAIN QUERY PLAN ' + sql).all(...params).map(item => item.detail)
        queries.push({ stage, milliseconds, counts: { ...row }, plan })
        return row
      }
    }
    return statement
  }
  try {
    bulk(0, 1000)
    assert.equal(measure('summary-1k-healthy', () => store.unassignedSummary()).execution_receipts, 0)
    bulk(1000, 100000)
    const healthy = measure('summary-100k-healthy', () => store.unassignedSummary())
    assert.equal(healthy.execution_receipts, 0)
    assert.equal(healthy.execution_waivers, 0)
    for (const [i, task] of [scoped, unassigned, 999999].entries()) add('null-' + i, task, null)
    store.handle.prepare("UPDATE execution_receipt SET verification_files='{broken', snapshot='{broken', logs='{broken', status='HISTORICAL_UNKNOWN' WHERE receipt_id='null-2'").run()
    const expected = { task: 1, fact: 2, handoff: 0, execution_receipts: 3, execution_waivers: 3 }
    const before = fingerprint(store.handle), beforeColumns = columns(store.handle)
    assert.deepEqual(before.map(item => item.rows), [100003, 100003])
    const migration = measure('migrate-100k', () => store.migrate(store.handle, false))
    assert.deepEqual(migration.unassigned, expected)
    assert.deepEqual(migration.added_columns, [])
    assert.deepEqual(fingerprint(store.handle), before)
    store.close()
    reopened = new TaskforceStore(store.root)
    measure('open-100k', () => reopened.open())
    assert.deepEqual(reopened.migration.unassigned, expected)
    assert.deepEqual(reopened.migration.added_columns, [])
    assert.deepEqual(columns(reopened.handle), beforeColumns)
    assert.deepEqual(fingerprint(reopened.handle), before, 'open preserves all serialized audit row bytes')
    assert.deepEqual(reopened.handle.prepare("PRAGMA index_info('idx_control_task')").all().map(row => row.name), ['task_id', 'run_id'])
    reopened.close()
    const warnings = []
    measure('apply-boot-100k', () => applyStore({
      logger: { info() {}, warn(message) { warnings.push(message) } },
      effect(callback) { disposers.push(callback()) },
      provide(name, value) { if (name === 'taskforceStore') published = value },
    }, { root: store.root }))
    assert.ok(published)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /execution_receipts=3/)
    assert.match(warnings[0], /execution_waivers=3/)
    assert.deepEqual(fingerprint(published.handle), before)
    assert.throws(() => published.acceptTask({ task_id: scoped, waiver_reason: 'manual' }, run, 'lead'), { code: 'E_STORE_INTEGRITY' })
    const adopted = measure('adopt-100k', () => published.adoptUnassigned('adopted'))
    assert.equal(adopted.execution_receipts, 1)
    assert.equal(adopted.execution_waivers, 1)
    assert.equal(published.unassignedSummary().execution_receipts, 2)
    assert.equal(published.unassignedSummary().execution_waivers, 2)
    assert.equal(published.handle.prepare("SELECT run_id FROM execution_receipt WHERE receipt_id='null-0'").get().run_id, null)
    assert.equal(published.handle.prepare("SELECT snapshot FROM execution_receipt WHERE receipt_id='null-2'").get().snapshot, '{broken')
  } finally {
    DatabaseSync.prototype.prepare = original
    for (const dispose of disposers) dispose?.()
    reopened?.close()
  }
  t.diagnostic('UNASSIGNED_AUDIT_SCALE ' + JSON.stringify({ assignedRowsPerTable: 100000, nullRowsPerTable: 3, totals, queries }))
})
