#!/usr/bin/env node
/** Synthetic scoped board workloads; timings are informational, never pass/fail gates. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { TaskforceStore } from '../lib/store/index.js'
import { withWriteTransaction } from '../lib/store/sqlite.js'

const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [1000, 5000]
if (sizes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 100000)) throw new TypeError('sizes must be integers between 1 and 100000')

function profile(store, read) {
  const prepare = store.handle.prepare.bind(store.handle)
  const statements = []
  let materializedRows = 0, streamedRows = 0
  store.handle.prepare = sql => {
    const statement = prepare(sql)
    for (const method of ['all', 'get', 'iterate']) {
      const execute = statement[method].bind(statement)
      if (method === 'iterate') {
        statement[method] = function* (...params) {
          statements.push({ sql, params })
          for (const row of execute(...params)) { streamedRows++; yield row }
        }
      } else {
        statement[method] = (...params) => {
          statements.push({ sql, params })
          const value = execute(...params)
          materializedRows += method === 'all' ? value.length : Number(value !== undefined)
          return value
        }
      }
    }
    return statement
  }
  let board
  try { board = read() } finally { store.handle.prepare = prepare }
  const plans = statements.map(({ sql, params }) => ({
    sql, plan: prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail),
  }))
  return { board, queries: statements.length, materialized_rows: materializedRows, streamed_rows: streamedRows, plans }
}
for (const tasks of sizes) {
  const root = mkdtempSync(join(tmpdir(), 'taskforce-board-bench-'))
  const store = new TaskforceStore(root)
  try {
    store.open()
    const start = performance.now()
    withWriteTransaction(store.handle, () => {
      const task = store.handle.prepare('INSERT INTO task(title,status,run_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      const fact = store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
      for (let i = 0; i < tasks; i++) {
        const id = Number(task.run('task-' + i, 'open', 'bench', 'now', 'now').lastInsertRowid)
        for (let j = 0; j < 8; j++) fact.run(id, 'bench', 'fact', 'fact-' + i + '-' + j, 'PLAUSIBLE', 'now')
      }
    })
    const seedMs = performance.now() - start
    function measure(scenario, args) {
      const read = () => store.boardPage(args, 'bench')
      for (let i = 0; i < 5; i++) read()
      const durations = []
      for (let i = 0; i < 30; i++) {
        const at = performance.now(); read(); durations.push(performance.now() - at)
      }
      durations.sort((a, b) => a - b)
      // Instrument once outside timed samples, so profiling does not distort latency.
      const { board, ...counts } = profile(store, read)
      const wire = JSON.stringify({ ok: true, ...board, viewer: 'lead:bench', can_accept: true })
      console.log(JSON.stringify({ scenario, node: process.version, tasks, facts: store.stats('bench').facts.total,
        selected_tasks: board.tasks?.length ?? 0, selected_late: board.late_blockers?.length ?? 0,
        json_bytes: Buffer.byteLength(wire), samples: durations.length, seed_ms: seedMs,
        p50_ms: durations[14], p95_ms: durations[28], ...counts }))
    }
    function continuation(scenario, view) {
      const first = store.boardPage({ view }, 'bench')
      const page = first.pagination
      if (page.next_cursor !== null) measure(scenario, { view, cursor: page.next_cursor, page_token: page.page_token })
    }
    measure('pending_first_25', {})
    continuation('pending_continue_25', 'tasks')
    measure('pending_first_100', { limit: 100 })
    store.handle.prepare("UPDATE task SET status=CASE WHEN id%4=0 THEN 'accepted' ELSE 'open' END WHERE run_id=?").run('bench')
    measure('mixed_tasks', {})
    store.handle.prepare("UPDATE task SET status='accepted' WHERE run_id=?").run('bench')
    measure('terminal_tasks', {})
    measure('terminal_summary', { view: 'summary' })
    withWriteTransaction(store.handle, () => {
      const blocker = store.handle.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) SELECT id,run_id,'blocker','late blocker','PLAUSIBLE','now' FROM task WHERE run_id=? AND id%2=0")
      blocker.run('bench')
      store.handle.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at,resolves_fact_id) SELECT task_id,run_id,'decision','resolved','CONFIRMED','now',id FROM fact WHERE run_id=? AND kind='blocker' AND task_id%4=0").run('bench')
    })
    measure('unresolved_and_resolved_late', { view: 'late_blockers' })
    continuation('late_continue_25', 'late_blockers')
    measure('terminal_with_late', {})
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}
