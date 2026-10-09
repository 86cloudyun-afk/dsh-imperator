#!/usr/bin/env node
/** Temporary same-process SQLite experiment; timing is informational, no provider calls. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { TaskforceStore } from '../lib/store/index.js'
import { withWriteTransaction } from '../lib/store/sqlite.js'

const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [1000, 5000]
if (sizes.some(n => !Number.isSafeInteger(n) || n < 104 || n > 100000)) {
  throw new TypeError('sizes must be integers between 104 and 100000')
}
const INDEX = 'idx_probe_late_blocker_run_id'
const VARIANTS = [
  { name: 'baseline', index: false, rewrite: false },
  { name: 'index_only', index: true, rewrite: false },
  { name: 'query_only', index: false, rewrite: true },
  { name: 'both', index: true, rewrite: true },
]
const ANCHOR = ' FROM fact b JOIN task t ON t.id=b.task_id AND b.run_id IS t.run_id WHERE t.run_id IS ?'
const REWRITTEN = ' FROM fact b JOIN task t ON t.id=b.task_id AND b.run_id IS t.run_id WHERE b.run_id IS ?'
const emit = value => console.log(JSON.stringify(value))
const nearestRank = (sorted, probability) => sorted[Math.ceil(sorted.length * probability) - 1]

// Recognize only the four late-page statements, including optimized production SQL.
function lateRole(sql) {
  if (!(sql.includes(ANCHOR) || sql.includes(REWRITTEN)) || !sql.includes(" AND b.kind='blocker'")) return null
  if (sql.startsWith('SELECT COALESCE(MAX(b.id),0) AS n')) return 'ceiling'
  if (sql.startsWith('SELECT b.id AS id')) return 'members'
  if (sql.startsWith('SELECT COUNT(*) AS n, COUNT(DISTINCT t.id) AS tasks')) return 'counts'
  if (sql.startsWith('SELECT b.id AS fact_id,')) return 'rows'
  return null
}
function installVariant(db, variant) {
  // These are fresh synthetic stores; normalize production and experimental indexes.
  db.exec('DROP INDEX IF EXISTS idx_fact_blocker_run_id')
  db.exec('DROP INDEX IF EXISTS ' + INDEX)
  if (!variant.index) return 0
  const at = performance.now()
  db.exec('CREATE INDEX ' + INDEX + " ON fact(run_id,id,task_id) WHERE kind='blocker'")
  return performance.now() - at
}
function withVariant(db, variant, work, capture = null) {
  const original = db.prepare, prepare = original.bind(db)
  db.prepare = sql => {
    const role = lateRole(sql)
    const normalized = role === null ? sql : sql.replace(REWRITTEN, ANCHOR)
    const actual = variant.rewrite && role !== null ? normalized.replace(ANCHOR, REWRITTEN) : normalized
    const statement = prepare(actual)
    if (capture !== null) {
      for (const method of ['all', 'get', 'iterate']) {
        const execute = statement[method].bind(statement)
        const record = params => capture.statements.push({ sql: actual, params, role, rewritten: variant.rewrite && role !== null })
        if (method === 'iterate') {
          statement[method] = function* (...params) {
            record(params)
            for (const row of execute(...params)) { capture.streamed_rows++; yield row }
          }
        } else {
          statement[method] = (...params) => {
            record(params)
            const value = execute(...params)
            capture.materialized_rows += method === 'all' ? value.length : Number(value !== undefined)
            return value
          }
        }
      }
    }
    return statement
  }
  try { return work() } finally { db.prepare = original }
}
function profile(store, variant, read) {
  const capture = { statements: [], materialized_rows: 0, streamed_rows: 0 }
  const board = withVariant(store.handle, variant, read, capture)
  const late = capture.statements.filter(statement => statement.role !== null)
  assert.ok(late.length >= 3, 'probe did not recognize executed late queries')
  assert.equal(late.filter(statement => statement.rewritten).length, variant.rewrite ? late.length : 0)
  const prepare = store.handle.prepare.bind(store.handle)
  const late_plans = late.map(({ sql, params, role }) => ({
    role, details: prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail),
  }))
  return { board, queries: capture.statements.length,
    materialized_rows: capture.materialized_rows, streamed_rows: capture.streamed_rows,
    late_queries: late.length, rewritten_queries: late.filter(statement => statement.rewritten).length, late_plans }
}
function counters(result) {
  return { queries: result.queries, materialized_rows: result.materialized_rows, streamed_rows: result.streamed_rows }
}
// Exact JSON includes independent mutable page tokens; profiling is outside timing.
function compareScenario(store, scenario, args, run, context = {}, timed = true) {
  const read = () => store.boardPage(args, run), raw = store.handle.prepare.bind(store.handle)
  const beforeChanges = Number(raw('SELECT total_changes() AS n').get().n)
  let reference, referenceJson, referenceCounters, baselineTiming
  for (const variant of VARIANTS) {
    const index_create_ms = installVariant(store.handle, variant), durations = []
    if (timed) {
      withVariant(store.handle, variant, () => {
        for (let i = 0; i < 5; i++) read()
        for (let i = 0; i < 30; i++) {
          const at = performance.now(); read(); durations.push(performance.now() - at)
        }
      })
      durations.sort((a, b) => a - b)
    }
    const result = profile(store, variant, read), json = JSON.stringify(result.board), counts = counters(result)
    if (reference === undefined) {
      reference = result.board; referenceJson = json; referenceCounters = counts
    } else {
      assert.equal(json, referenceJson, scenario + ': output/token mismatch for ' + variant.name)
      assert.deepEqual(counts, referenceCounters, scenario + ': returned-row/query counter mismatch for ' + variant.name)
    }
    const timing = timed ? { samples: durations.length, warmups: 5,
      p50_ms: nearestRank(durations, 0.50), p95_ms: nearestRank(durations, 0.95) } : {}
    if (variant.name === 'baseline') baselineTiming = timing
    emit({ kind: timed ? 'late_index_measurement' : 'late_index_equivalence',
      scenario, run, ...context, variant: variant.name, output_equal: true, counters_equal: true, ...counts,
      late_queries: result.late_queries, rewritten_queries: result.rewritten_queries,
      selected_tasks: result.board.tasks?.length ?? 0, selected_late: result.board.late_blockers?.length ?? 0,
      board_json_bytes: Buffer.byteLength(json),
      tool_json_bytes: Buffer.byteLength(JSON.stringify({ ok: true, ...result.board, viewer: 'lead:bench', can_accept: true })),
      index_create_ms, ...timing,
      ...(timed ? { p50_ratio_to_baseline: timing.p50_ms / baselineTiming.p50_ms,
        p95_ratio_to_baseline: timing.p95_ms / baselineTiming.p95_ms } : {}),
      late_plans: result.late_plans })
  }
  assert.equal(Number(raw('SELECT total_changes() AS n').get().n), beforeChanges, 'board reads wrote data')
  assert.equal(store.handle.isTransaction, false)
  return reference
}
function continuationArgs(first, extra = {}) {
  assert.notEqual(first.pagination.next_cursor, null, 'fixture needs a continuation')
  assert.ok(first.pagination.page_token)
  return { ...extra, cursor: first.pagination.next_cursor, page_token: first.pagination.page_token }
}
function temporaryStore(work) {
  const root = mkdtempSync(join(tmpdir(), 'taskforce-late-index-probe-')), store = new TaskforceStore(root)
  try { store.open(); return work(store) }
  finally { store.close(); rmSync(root, { recursive: true, force: true }) }
}
function putters(db) {
  const task = db.prepare('INSERT INTO task(title,status,run_id,created_at,updated_at) VALUES(?,?,?,?,?)')
  const fact = db.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at,resolves_fact_id) VALUES(?,?,?,?,?,?,?)')
  return { task: (title, status, run) => Number(task.run(title, status, run, 'now', 'now').lastInsertRowid),
    fact: (taskId, run, kind, statement, confidence = 'PLAUSIBLE', resolves = null) =>
      Number(fact.run(taskId, run, kind, statement, confidence, 'now', resolves).lastInsertRowid) }
}
function runBench(tasks) {
  temporaryStore(store => {
    const run = 'bench', context = { tasks, node: process.version }, seedAt = performance.now()
    withWriteTransaction(store.handle, () => {
      const put = putters(store.handle)
      for (let i = 0; i < tasks; i++) {
        const id = put.task('task-' + i, 'open', run)
        for (let j = 0; j < 8; j++) put.fact(id, run, 'fact', 'fact-' + i + '-' + j)
      }
    })
    emit({ kind: 'late_index_seed', ...context, ordinary_facts: tasks * 8, seed_ms: performance.now() - seedAt })
    const first = compareScenario(store, 'pending_first_25', {}, run, context)
    compareScenario(store, 'pending_continue_25', continuationArgs(first, { view: 'tasks' }), run, context)
    compareScenario(store, 'pending_first_100', { limit: 100 }, run, context)
    store.handle.prepare("UPDATE task SET status=CASE WHEN id%4=0 THEN 'accepted' ELSE 'open' END WHERE run_id IS ?").run(run)
    compareScenario(store, 'mixed_tasks', {}, run, context)
    store.handle.prepare("UPDATE task SET status='accepted' WHERE run_id IS ?").run(run)
    compareScenario(store, 'terminal_tasks', {}, run, context)
    compareScenario(store, 'terminal_summary', { view: 'summary' }, run, context)
    withWriteTransaction(store.handle, () => {
      store.handle.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) SELECT id,run_id,'blocker','late blocker','PLAUSIBLE','now' FROM task WHERE run_id IS ? AND id%2=0").run(run)
      store.handle.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at,resolves_fact_id) SELECT task_id,run_id,'decision','resolved','CONFIRMED','now',id FROM fact WHERE run_id IS ? AND kind='blocker' AND task_id%4=0").run(run)
    })
    const late = compareScenario(store, 'unresolved_and_resolved_late', { view: 'late_blockers' }, run, context)
    compareScenario(store, 'late_continue_25', continuationArgs(late, { view: 'late_blockers' }), run, context)
    compareScenario(store, 'terminal_with_late', {}, run, context)
    const denseTask = Number(store.handle.prepare('SELECT MAX(id) AS n FROM task WHERE run_id IS ?').get(run).n)
    withWriteTransaction(store.handle, () => {
      const put = putters(store.handle)
      for (let i = 0; i < 10000; i++) put.fact(denseTask, run, 'fact', 'dense-history-' + i)
      for (let i = 0; i < 60; i++) {
        const blocker = put.fact(denseTask, run, 'blocker', 'dense-blocker-' + i)
        if (i % 3 === 0) put.fact(denseTask, run, 'decision', 'dense-resolution-' + i, 'CONFIRMED', blocker)
      }
    })
    const denseContext = { ...context, task_id: denseTask, extra_history_facts: 10000, extra_blockers: 60, extra_resolvers: 20 }
    const scoped = compareScenario(store, 'scoped_heavy_first_25', { view: 'late_blockers', task_id: denseTask }, run, denseContext)
    compareScenario(store, 'scoped_heavy_continue_25', continuationArgs(scoped, { view: 'late_blockers', task_id: denseTask }), run, denseContext)
  })
}
function expectErrorInAllVariants(store, args, run, code) {
  for (const variant of VARIANTS) {
    installVariant(store.handle, variant)
    assert.throws(() => withVariant(store.handle, variant, () => store.boardPage(args, run)), { code }, code + ': ' + variant.name)
    assert.equal(store.handle.isTransaction, false)
  }
}
function runScopeFixture(run) {
  temporaryStore(store => {
    let own, sibling, foreign, pending, blockers, pendingBlocker
    withWriteTransaction(store.handle, () => {
      const put = putters(store.handle)
      own = put.task('own-terminal', 'accepted', run)
      sibling = put.task('same-run-sibling', 'accepted', run)
      foreign = put.task('foreign-parent', 'accepted', 'scope-foreign')
      pending = put.task('own-pending', 'open', run)
      put.fact(own, run, 'fact', 'basis', 'CONFIRMED')
      blockers = [put.fact(own, run, 'blocker', 'invalid-resolvers-do-not-resolve'),
        put.fact(own, run, 'blocker', 'valid-resolution'), put.fact(own, run, 'blocker', 'unresolved'),
        put.fact(own, run, 'blocker', 'refuted-blocker-still-counts', 'REFUTED')]
      put.fact(own, 'scope-foreign', 'decision', 'wrong-run', 'CONFIRMED', blockers[0])
      put.fact(sibling, run, 'decision', 'wrong-task', 'CONFIRMED', blockers[0])
      put.fact(own, run, 'fact', 'wrong-kind', 'CONFIRMED', blockers[0])
      put.fact(own, run, 'decision', 'wrong-confidence', 'REFUTED', blockers[0])
      put.fact(own, run, 'decision', 'valid-resolver', 'PLAUSIBLE', blockers[1])
      put.fact(own, 'scope-foreign', 'blocker', 'EXCLUDED_FOREIGN_RUN')
      put.fact(foreign, run, 'blocker', 'EXCLUDED_WRONG_PARENT')
      put.fact(999999999, run, 'blocker', 'EXCLUDED_ORPHAN')
      put.fact(null, run, 'blocker', 'EXCLUDED_UNATTACHED')
      pendingBlocker = put.fact(pending, run, 'blocker', 'pending-enters-late-later')
    })
    const context = { fixture: run === null ? 'null_scope' : 'string_scope', node: process.version }
    const first = compareScenario(store, 'scope_late_first', { view: 'late_blockers', limit: 1 }, run, context, false)
    assert.equal(first.total, 3); assert.equal(first.late_blocked_tasks, 1)
    assert.equal(first.late_blockers[0].fact_id, blockers[3])
    assert.doesNotMatch(JSON.stringify(first), /EXCLUDED_/)
    const rest = compareScenario(store, 'scope_late_continue', continuationArgs(first, { view: 'late_blockers', limit: 100 }), run, context, false)
    assert.deepEqual(rest.late_blockers.map(row => row.fact_id), [blockers[2], blockers[0]])
    compareScenario(store, 'scope_tasks', {}, run, context, false)
    compareScenario(store, 'scope_summary', { view: 'summary' }, run, context, false)
    const scoped = compareScenario(store, 'scope_task_filter', { view: 'late_blockers', task_id: own, limit: 1 }, run, context, false)
    assert.equal(scoped.total, 3)
    expectErrorInAllVariants(store, { view: 'late_blockers', cursor: first.pagination.next_cursor }, run, 'E_INPUT')
    expectErrorInAllVariants(store, { view: 'late_blockers', cursor: first.pagination.next_cursor - 1, page_token: first.pagination.page_token }, run, 'E_INPUT')
    expectErrorInAllVariants(store, { view: 'late_blockers', task_id: foreign }, run, 'E_CROSS_RUN')
    const initialCeiling = JSON.parse(Buffer.from(first.pagination.page_token, 'base64url').toString('utf8')).u
    assert.equal(initialCeiling, pendingBlocker)
    const resolver = putters(store.handle).fact(own, run, 'decision', 'new-resolver-above-ceiling', 'CONFIRMED', blockers[3])
    assert.ok(resolver > initialCeiling)
    expectErrorInAllVariants(store, continuationArgs(first, { view: 'late_blockers', limit: 1 }), run, 'E_PAGE_CHANGED')
    const fresh = compareScenario(store, 'scope_after_new_resolver', { view: 'late_blockers', limit: 1 }, run, context, false)
    assert.equal(fresh.total, 2)
    store.handle.prepare("UPDATE task SET status='accepted' WHERE id=?").run(pending)
    expectErrorInAllVariants(store, continuationArgs(fresh, { view: 'late_blockers', limit: 1 }), run, 'E_PAGE_CHANGED')
    const entered = compareScenario(store, 'scope_pending_blocker_enters', { view: 'late_blockers', limit: 100 }, run, context, false)
    assert.equal(entered.total, 3); assert.equal(entered.late_blockers[0].fact_id, pendingBlocker)
    assert.equal(entered.late_blocked_tasks, 2)
    emit({ kind: 'late_index_scope_checks', ...context, invalid_resolvers_ignored: true,
      later_resolver_invalidates: true, full_cohort_change_invalidates: true,
      paired_tokens_required: true, foreign_task_denied: true, no_read_writes: true })
  })
}
emit({ kind: 'late_index_probe_configuration', node: process.version, sizes, variants: VARIANTS, temporary_index: INDEX,
  index_sql: "ON fact(run_id,id,task_id) WHERE kind='blocker'", rewrite_from: ANCHOR, rewrite_to: REWRITTEN,
  quantiles: 'nearest-rank: sorted[ceil(p*n)-1]; p50 index14, p95 index28 for30samples',
  counters: 'executed prepared reads; materialized_rows/streamed_rows are rows returned to JavaScript, not SQLite visited rows; transaction exec and EXPLAIN excluded',
  timing_gate: false })
for (const size of sizes) runBench(size)
runScopeFixture('scope-a')
runScopeFixture(null)
emit({ kind: 'late_index_probe_complete', output_token_counter_equivalence: 'passed', timing_gate: false })
