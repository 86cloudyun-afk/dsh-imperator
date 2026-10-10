#!/usr/bin/env node
/** Isolated same-run density experiment. Production files are never edited.
 * Build tools/probe-sqlite-status.c as a loadable extension, then:
 * node tools/probe-run-density.mjs --blockers=100000 --rounds=10 --statistics=none --others=terminal --extension=/absolute/probe_status.so
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { TaskforceStore } from '../lib/store/index.js'
import { withWriteTransaction } from '../lib/store/sqlite.js'
import { cohortPagination } from '../lib/store/page-cursor.js'
import { putters, syntheticRoot, sizes, memory, safeDiagnostic } from './probe-nextgen.mjs'

const SELF = fileURLToPath(import.meta.url), RUN = 'same-run-density'
const PARTIAL = 'idx_probe_blocker_task_run_id'
const VARIANTS = ['planner_default', 'rows_run_index', 'rows_existing_task_index', 'rows_task_partial']
const emit = value => console.log(JSON.stringify(value))
const hash = value => createHash('sha256').update(value).digest('hex')
let phase = 'configuration'
function parse(args) {
  const config = { blockers: 100000, rounds: 10, statistics: 'none', others: 'terminal' }
  for (const arg of args) {
    const match = /^--(blockers|rounds|statistics|others|extension)=(.+)$/.exec(arg)
    assert.ok(match, 'unknown argument')
    config[match[1]] = ['blockers', 'rounds'].includes(match[1]) ? Number(match[2]) : match[2]
  }
  assert.ok(Number.isSafeInteger(config.blockers) && config.blockers >= 1000 && config.blockers <= 1000000)
  assert.ok(Number.isSafeInteger(config.rounds) && config.rounds >= 3 && config.rounds <= 30)
  assert.ok(['none', 'analyzed'].includes(config.statistics))
  assert.ok(['terminal', 'active'].includes(config.others))
  assert.equal(typeof config.extension, 'string')
  config.extension = resolve(config.extension)
  return config
}
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: sorted.length, p50_ms: sorted[Math.ceil(sorted.length * .5) - 1], p95_ms: sorted[Math.ceil(sorted.length * .95) - 1] }
}
function seed(store, config) {
  return withWriteTransaction(store.handle, () => {
    const p = putters(store.handle), target = p.task('tiny target', 'accepted', RUN)
    const empty = p.task('empty target', 'accepted', RUN)
    const other = Array.from({ length: 200 }, () => p.task('same-run other', config.others === 'terminal' ? 'accepted' : 'open', RUN))
    const foreign = p.task('foreign', 'accepted', 'foreign-run')
    for (let i = 0; i < 8; i++) p.fact(target, RUN, 'fact')
    const ids = []
    for (let i = 0; i < config.blockers; i++) {
      p.fact(other[i % other.length], RUN, 'blocker')
      if ([Math.floor(config.blockers / 4), Math.floor(config.blockers / 2), Math.floor(config.blockers * 3 / 4)].includes(i + 1)) {
        for (let j = 0; j < 25; j++) ids.push(p.fact(target, RUN, 'blocker'))
      }
    }
    for (let i = 0; i < 25; i++) p.fact(foreign, 'foreign-run', 'blocker')
    assert.equal(ids.length, 75)
    return { target, empty, ids, other_tasks: other.length, target_blockers: ids.length,
      other_blockers: config.blockers, other_status: config.others }
  })
}
function rewrite(sql, variant) {
  if (!sql.startsWith('SELECT b.id AS fact_id,')) return sql
  const plain = sql.replace(/ FROM fact b(?: INDEXED BY [A-Za-z0-9_]+)? JOIN task t/, ' FROM fact b JOIN task t')
  assert.ok(plain.includes(' FROM fact b JOIN task t'), 'row SQL recognition changed')
  if (variant === 'planner_default') return plain
  const index = variant === 'rows_run_index' ? 'idx_fact_blocker_run_id'
    : variant === 'rows_existing_task_index' ? 'idx_fact_task_id' : PARTIAL
  return plain.replace(' FROM fact b JOIN task t', ' FROM fact b INDEXED BY ' + index + ' JOIN task t')
}
function variantRead(store, variant, args, capture) {
  const db = store.handle, original = db.prepare, prepare = original.bind(db)
  db.prepare = sql => {
    const actual = rewrite(sql, variant), statement = prepare(actual)
    if (sql.startsWith('SELECT b.id AS fact_id,')) {
      const all = statement.all.bind(statement)
      statement.all = (...params) => {
        if (capture?.profile) {
          capture.plan = prepare('EXPLAIN QUERY PLAN ' + actual).all(...params).map(row => row.detail)
          prepare('SELECT probe_vm_steps(?,1), probe_fullscan_steps(?,1)').get(actual, actual)
        }
        const at = performance.now(), rows = all(...params)
        if (capture) capture.row_ms = performance.now() - at
        if (capture?.profile) {
          const counters = prepare('SELECT probe_vm_steps(?,0) AS vm_steps, probe_fullscan_steps(?,0) AS fullscan_steps').get(actual, actual)
          capture.sqlite_vm_steps = Number(counters.vm_steps)
          capture.sqlite_fullscan_steps = Number(counters.fullscan_steps)
          capture.rows_returned_to_javascript = rows.length
          capture.sql_sha256 = hash(actual)
          assert.ok(capture.sqlite_vm_steps > 0, 'native statement counters unavailable')
          capture.keepAlive = statement
        }
        return rows
      }
    }
    return statement
  }
  try { return store.boardPage(args, RUN) } finally { db.prepare = original }
}
function cases(store, fixture, variant) {
  const base = { view: 'late_blockers', task_id: fixture.target, limit: 25 }
  const first = variantRead(store, variant, base)
  const middleArgs = { ...base, cursor: first.pagination.next_cursor, page_token: first.pagination.page_token }
  const middle = variantRead(store, variant, middleArgs)
  const finalArgs = { ...base, cursor: middle.pagination.next_cursor, page_token: middle.pagination.page_token }
  const last = variantRead(store, variant, finalArgs)
  assert.deepEqual([...first.late_blockers, ...middle.late_blockers, ...last.late_blockers].map(r => r.fact_id), [...fixture.ids].reverse())
  assert.equal(last.pagination.next_cursor, null)
  const state = JSON.parse(Buffer.from(first.pagination.page_token, 'base64url').toString('utf8')); delete state.c
  const terminal = cohortPagination({ limit: 25, next_cursor: fixture.ids[0], has_more: true }, state)
  const exhausted = { ...base, cursor: fixture.ids[0], page_token: terminal.page_token }
  assert.deepEqual(variantRead(store, variant, exhausted).late_blockers, [])
  const unscoped = { view: 'late_blockers', limit: 25 }, unscopedFirst = variantRead(store, variant, unscoped)
  const expectedTotal = fixture.target_blockers + (fixture.other_status === 'terminal' ? fixture.other_blockers : 0)
  assert.equal(unscopedFirst.total, expectedTotal, 'same-run/foreign membership')
  const unscopedState = JSON.parse(Buffer.from(unscopedFirst.pagination.page_token, 'base64url').toString('utf8')); delete unscopedState.c
  const oldest = fixture.other_status === 'terminal'
    ? Number(store.handle.prepare("SELECT MIN(id) AS n FROM fact WHERE run_id=? AND kind='blocker'").get(RUN).n) : fixture.ids[0]
  const unscopedToken = cohortPagination({ limit: 25, next_cursor: oldest, has_more: true }, unscopedState).page_token
  return [
    { name: 'scoped_first', args: base }, { name: 'scoped_middle', args: middleArgs },
    { name: 'scoped_final', args: finalArgs }, { name: 'scoped_exhausted', args: exhausted },
    { name: 'scoped_empty_first', args: { ...base, task_id: fixture.empty } },
    { name: 'unscoped_first', args: unscoped },
    { name: 'unscoped_exhausted', args: { ...unscoped, cursor: oldest, page_token: unscopedToken } },
  ]
}
function writeCosts(store, fixture, rounds) {
  const p = putters(store.handle), blockers = [], results = []
  for (const kind of ['fact', 'blocker', 'decision']) {
    const times = []
    for (let sample = 0; sample < rounds; sample++) {
      const at = performance.now()
      withWriteTransaction(store.handle, () => {
        for (let i = 0; i < 100; i++) {
          const id = p.fact(fixture.empty, RUN, kind, 'CONFIRMED', kind === 'decision' ? blockers[sample * 100 + i] : null)
          if (kind === 'blocker') blockers.push(id)
        }
      })
      times.push(performance.now() - at)
    }
    results.push({ kind, batch_size: 100, ...quantiles(times) })
  }
  return results
}
function worker(root, variant, config) {
  assert.equal(readFileSync(join(root, '.nextgen-synthetic'), 'utf8'), 'synthetic only\n')
  assert.ok(VARIANTS.includes(variant))
  const fixture = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
  const store = new TaskforceStore(root)
  // Only this disposable clone allows the local test extension. No production
  // connection or module is altered; this is the same Node SQLite engine.
  store.handle = new DatabaseSync(join(root, 'taskforce.db'), { allowExtension: true })
  const db = store.handle
  try {
    db.loadExtension(config.extension)
    db.enableLoadExtension(false)
    const createAt = performance.now()
    if (variant === 'rows_task_partial') db.exec('CREATE INDEX ' + PARTIAL + " ON fact(task_id,run_id,id) WHERE kind='blocker'")
    const candidate_index_create_ms = performance.now() - createAt
    const analysisAt = performance.now()
    if (config.statistics === 'analyzed') db.exec('ANALYZE')
    const analyze_ms = performance.now() - analysisAt
    const writesBefore = Number(db.prepare('SELECT total_changes() AS n').get().n)
    const scenarios = cases(store, fixture, variant), measurements = [], private_outputs = []
    for (const scenario of scenarios) {
      phase = scenario.name
      const capture = { profile: true }
      const value = variantRead(store, variant, scenario.args, capture), json = JSON.stringify(value)
      private_outputs.push(json)
      assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, ...value, viewer: 'synthetic', can_accept: true })) <= 65536)
      const times = [], rowTimes = [], samples = scenario.name.startsWith('unscoped') ? Math.min(3, config.rounds) : config.rounds
      // Warmup is outside measurement; fresh process is not cold OS-cache.
      variantRead(store, variant, scenario.args)
      for (let i = 0; i < samples; i++) {
        const timing = {}, at = performance.now()
        const reread = variantRead(store, variant, scenario.args, timing)
        times.push(performance.now() - at); rowTimes.push(timing.row_ms)
        assert.equal(JSON.stringify(reread), json, 'page/token changed')
      }
      delete capture.keepAlive; delete capture.profile; delete capture.row_ms
      measurements.push({ scenario: scenario.name, board: quantiles(times), selected_rows_query: quantiles(rowTimes),
        ...capture, json_bytes: Buffer.byteLength(json), output_sha256: hash(json), selected_rows: value.late_blockers.length })
    }
    assert.equal(Number(db.prepare('SELECT total_changes() AS n').get().n), writesBefore, 'board wrote data')
    assert.equal(db.isTransaction, false)
    const storage_before_write = sizes(root, db)
    const write_costs = writeCosts(store, fixture, config.rounds)
    const storage_after_write = sizes(root, db)
    return { kind: 'density_measurement', node: process.version, sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
      variant, ...fixture, ids: undefined, target: undefined, empty: undefined, statistics: config.statistics,
      candidate_index_create_ms, analyze_ms, storage_before_write, write_costs, storage_after_write, ...memory(), measurements, private_outputs }
  } finally { store.close() }
}
function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--worker') {
    emit(worker(args[1], args[2], JSON.parse(readFileSync(join(args[1], 'config.json'), 'utf8')))); return
  }
  const config = parse(args), root = syntheticRoot('taskforce-density-')
  emit({ kind: 'density_configuration', node: process.version, v8: process.versions.v8,
    blockers: config.blockers, rounds: config.rounds, statistics: config.statistics, others: config.others,
    variants: VARIANTS, timing_gate: false, cold_os_cache: 'not measured', scope: 'synthetic provider-free query experiment',
    counters: 'actual selected-query SQLite VM steps and fullscan steps from sqlite3_stmt_status in the Node SQLite connection; not row visits; JS rows separate',
    sqlite_row_visits: null, row_visit_limit: 'node:sqlite does not expose stmt_scanstatus row-visit API',
    continuation_fixture: 'scoped middle/final use actual previous output; exhausted tokens use cohortPagination over unchanged cohort',
    unscoped_samples: Math.min(config.rounds, 3) })
  try {
    const seedRoot = join(root, 'seed'); mkdirSync(seedRoot)
    const store = new TaskforceStore(seedRoot)
    let fixture
    try {
      store.open(); const at = performance.now(); fixture = seed(store, config)
      emit({ kind: 'density_seed', blockers: config.blockers, other_tasks: fixture.other_tasks,
        target_blockers: fixture.target_blockers, seed_ms: performance.now() - at, storage: sizes(seedRoot, store.handle) })
    } finally { store.close() }
    let reference
    for (const variant of VARIANTS) {
      phase = variant
      const clone = join(root, variant); mkdirSync(clone)
      writeFileSync(join(clone, '.nextgen-synthetic'), 'synthetic only\n')
      copyFileSync(join(seedRoot, 'taskforce.db'), join(clone, 'taskforce.db'))
      writeFileSync(join(clone, 'fixture.json'), JSON.stringify(fixture))
      writeFileSync(join(clone, 'config.json'), JSON.stringify(config))
      const at = performance.now()
      const child = spawnSync(process.execPath, [SELF, '--worker', clone, variant], {
        encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024 })
      if (child.status !== 0) {
        let failure
        try { failure = JSON.parse(child.stdout) } catch { /* no raw diagnostics */ }
        emit({ kind: 'density_worker_failure', status: child.status, signal: child.signal,
          ...safeDiagnostic(failure, variant) })
      }
      assert.equal(child.status, 0, 'density worker failed')
      const result = JSON.parse(child.stdout)
      if (reference === undefined) reference = result.private_outputs
      else assert.deepEqual(result.private_outputs, reference, 'exact JSON/token mismatch across access paths')
      delete result.private_outputs
      emit({ ...result, fresh_process_total_ms: performance.now() - at, exact_json_tokens_equal: true })
      rmSync(clone, { recursive: true, force: true })
    }
    emit({ kind: 'density_complete', exact_json_tokens_equal: true, read_no_writes: true, timing_gate: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try { main() } catch (error) {
    const line = /probe-run-density\.mjs:(\d+):\d+/.exec(error?.stack ?? '')
    emit({ kind: 'density_failure', ...safeDiagnostic(error, phase),
      ...(line ? { source: 'probe-run-density.mjs', line: Number(line[1]) } : {}) })
    process.exitCode = 1
  }
}
