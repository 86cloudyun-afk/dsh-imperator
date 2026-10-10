#!/usr/bin/env node
/** Synthetic, provider-free evidence. Timing is informational; assertions are gates.
 * node tools/probe-nextgen.mjs --facts=10000 --events=10000 --rounds=5
 * Repeat with 100000/1000000 explicitly. Fresh processes do not imply cold OS caches.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const SELF = fileURLToPath(import.meta.url)
const TASK_INDEX = 'idx_probe_blocker_task_run_id'
const VARIANTS = ['planner_default', 'rows_run_index', 'rows_task_index']
const MARKER = '.nextgen-synthetic'
const RUN = 'probe-run'
let phase = 'startup'
const emit = value => console.log(JSON.stringify(value))
const ERROR_CODES = ['ERR_ASSERTION', 'E_CROSS_RUN', 'E_PAGE_CHANGED', 'E_STORE_BUSY', 'E_INPUT', 'ERR_SQLITE_ERROR']
const OPERATORS = ['strictEqual', 'deepStrictEqual', 'equal', 'notStrictEqual', '==', '===', '!=', '!==', 'throws', 'doesNotThrow', 'match', 'fail']
const SOURCES = ['probe-nextgen.mjs', 'soak-nextgen.mjs', 'board-page.js', 'index.js', 'working-context.mjs', 'event-projection.mjs', 'sqlite.js', 'page-cursor.js']
export function safeDiagnostic(error, stage, fallback = 'E_PROBE_ASSERTION_OR_RUNTIME') {
  const source = typeof error?.stack === 'string' ? /(?:^|[ /\\(])(probe-nextgen\.mjs|soak-nextgen\.mjs|board-page\.js|index\.js|working-context\.mjs|event-projection\.mjs|sqlite\.js|page-cursor\.js):(\d+):\d+/m.exec(error.stack) : null
  return { code: ERROR_CODES.includes(error?.code) ? error.code : fallback,
    stage: typeof stage === 'string' && /^[a-z0-9_-]{1,100}$/.test(stage) ? stage : 'unknown',
    ...(OPERATORS.includes(error?.operator) ? { operator: error.operator } : {}),
    ...(source ? { source: source[1], line: Number(source[2]) }
      : SOURCES.includes(error?.source) && Number.isSafeInteger(error?.line) ? { source: error.source, line: error.line } : {}),
    ...(typeof error?.expected === 'number' && Number.isFinite(error.expected) ? { expected: error.expected } : {}),
    ...(typeof error?.actual === 'number' && Number.isFinite(error.actual) ? { actual: error.actual } : {}) }
}
const digest = value => createHash('sha256').update(value).digest('hex')
const elapsed = at => performance.now() - at
export function options(argv = process.argv.slice(2)) {
  const out = { facts: 10000, events: 10000, rounds: 5 }
  for (const arg of argv) {
    const match = /^--(facts|events|rounds)=(\d+)$/.exec(arg)
    if (!match) throw new TypeError('expected --facts=N --events=N --rounds=N')
    const n = Number(match[2]), max = match[1] === 'rounds' ? 100 : 1000000
    assert.ok(Number.isSafeInteger(n) && n >= (match[1] === 'rounds' ? 1 : 100) && n <= max, 'option out of bounds')
    out[match[1]] = n
  }
  return out
}
export const memory = () => {
  const m = process.memoryUsage()
  return { rss_bytes: m.rss, heap_used_bytes: m.heapUsed, heap_total_bytes: m.heapTotal,
    peak_rss_bytes: process.resourceUsage().maxRSS * 1024 }
}
const summary = samples => {
  const sorted = [...samples].sort((a, b) => a - b)
  return { samples: samples.length, p50_ms: sorted[Math.ceil(sorted.length * .5) - 1],
    p95_ms: sorted[Math.ceil(sorted.length * .95) - 1] }
}
export function sizes(root, db) {
  const size = suffix => { const file = join(root, 'taskforce.db' + suffix); return existsSync(file) ? statSync(file).size : 0 }
  const page_count = db ? Number(db.prepare('PRAGMA page_count').get().page_count) : undefined
  const page_size = db ? Number(db.prepare('PRAGMA page_size').get().page_size) : undefined
  const freelist_count = db ? Number(db.prepare('PRAGMA freelist_count').get().freelist_count) : undefined
  return { database_bytes: size(''), wal_bytes: size('-wal'), shm_bytes: size('-shm'),
    ...(db ? { page_count, page_size, freelist_count, logical_live_bytes: (page_count - freelist_count) * page_size } : {}) }
}
export function syntheticRoot(prefix = 'taskforce-nextgen-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(root, MARKER), 'synthetic only\n')
  return root
}
function requireSynthetic(root) {
  assert.equal(readFileSync(join(root, MARKER), 'utf8'), 'synthetic only\n', 'refusing a non-synthetic root')
}
export function putters(db) {
  const task = db.prepare('INSERT INTO task(title,status,run_id,created_at,updated_at) VALUES(?,?,?,?,?)')
  const fact = db.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at,resolves_fact_id) VALUES(?,?,?,?,?,?,?)')
  return {
    task: (label, status, run) => Number(task.run(label, status, run, 'synthetic', 'synthetic').lastInsertRowid),
    fact: (id, run, kind, confidence = 'PLAUSIBLE', resolves = null) =>
      Number(fact.run(id, run, kind, 'synthetic', confidence, 'synthetic', resolves).lastInsertRowid),
  }
}
export async function populate(store, count, density = 'sparse') {
  const { withWriteTransaction } = await import('../lib/store/sqlite.js')
  return withWriteTransaction(store.handle, () => {
    const put = putters(store.handle), own = put.task('dense task', 'accepted', RUN)
    const empty = put.task('empty task', 'accepted', RUN)
    const foreign = Array.from({ length: 32 }, (_, i) => put.task('foreign', 'accepted', 'foreign-' + i))
    // One dense history, interspersed foreign runs, sparse or dense blocker ratio.
    const stride = density === 'dense' ? 5 : 100
    for (let i = 0; i < count; i++) {
      put.fact(i % 2 ? own : foreign[i % foreign.length], i % 2 ? RUN : 'foreign-' + (i % foreign.length), 'fact')
      if (i % stride === 0) put.fact(foreign[i % foreign.length], 'foreign-' + (i % foreign.length), 'blocker')
    }
    // Enough own members for genuine first/middle/final pages in every size.
    const ownBlockers = Math.max(75, Math.min(500, Math.floor(count / stride)))
    const ids = []
    for (let i = 0; i < ownBlockers; i++) {
      const b = put.fact(own, RUN, 'blocker')
      if (i % 4 === 0) put.fact(own, RUN, 'decision', 'CONFIRMED', b)
      else ids.push(b)
    }
    return { own, empty, ids, ordinary_facts: count, own_blockers: ownBlockers, density }
  })
}
function rowVariant(sql, variant) {
  if (!sql.startsWith('SELECT b.id AS fact_id,') || !sql.includes("AND b.kind='blocker'")) return sql
  const normalized = sql.replace(/ FROM fact b(?: INDEXED BY [A-Za-z0-9_]+)? JOIN task t/, ' FROM fact b JOIN task t')
  assert.notEqual(normalized.indexOf(' FROM fact b JOIN task t'), -1, 'late row SQL changed; update probe recognition')
  if (variant === 'planner_default') return normalized
  const index = variant === 'rows_run_index' ? 'idx_fact_blocker_run_id' : TASK_INDEX
  return normalized.replace(' FROM fact b JOIN task t', ' FROM fact b INDEXED BY ' + index + ' JOIN task t')
}
function withVariant(db, variant, work, capture) {
  const original = db.prepare, prepare = original.bind(db)
  db.prepare = sql => {
    const actual = rowVariant(sql, variant), statement = prepare(actual)
    if (capture && actual.startsWith('SELECT b.id AS fact_id,')) {
      const all = statement.all.bind(statement)
      statement.all = (...params) => {
        capture.plans.push(prepare('EXPLAIN QUERY PLAN ' + actual).all(...params).map(row => row.detail))
        capture.row_queries++
        const result = all(...params)
        capture.rows_returned_to_javascript += result.length
        return result
      }
    }
    return statement
  }
  try { return work() } finally { db.prepare = original }
}
function readOnly(store, read) {
  const changes = Number(store.handle.prepare('SELECT total_changes() AS n').get().n)
  const value = read()
  assert.equal(Number(store.handle.prepare('SELECT total_changes() AS n').get().n), changes, 'read wrote data')
  assert.equal(store.handle.isTransaction, false)
  return value
}
function continuation(page, base) {
  assert.ok(page.pagination.next_cursor && page.pagination.page_token, 'fixture lacks continuation')
  return { ...base, cursor: page.pagination.next_cursor, page_token: page.pagination.page_token }
}
async function pageCases(store, fixture, variant) {
  const { cohortPagination } = await import('../lib/store/page-cursor.js')
  const base = { view: 'late_blockers', task_id: fixture.own, limit: 25 }
  const read = args => readOnly(store, () => withVariant(store.handle, variant, () => store.boardPage(args, RUN)))
  const first = read(base), pages = [{ args: base, result: first }]
  let page = first
  while (page.pagination.has_more) {
    assert.ok(pages.length < 100, 'unbounded traversal')
    const args = continuation(page, base)
    page = read(args); pages.push({ args, result: page })
  }
  assert.deepEqual(pages.flatMap(p => p.result.late_blockers.map(row => row.fact_id)), [...fixture.ids].reverse())
  // Protocol helper creates a valid cohort token at the last member, exercising
  // a no-row continuation even though the public final page emits no next token.
  const state = JSON.parse(Buffer.from(first.pagination.page_token, 'base64url').toString('utf8'))
  delete state.c
  const last = fixture.ids[0]
  const terminal = cohortPagination({ limit: 25, next_cursor: last, has_more: true }, state)
  const exhausted = { ...base, cursor: last, page_token: terminal.page_token }
  assert.deepEqual(read(exhausted).late_blockers, [])
  const unscopedBase = { view: 'late_blockers', limit: 25 }
  let unscopedPage = read(unscopedBase)
  const unscopedPages = [{ args: unscopedBase, result: unscopedPage }]
  while (unscopedPage.pagination.has_more) {
    assert.ok(unscopedPages.length < 100, 'unbounded unscoped traversal')
    const args = continuation(unscopedPage, unscopedBase)
    unscopedPage = read(args); unscopedPages.push({ args, result: unscopedPage })
  }
  assert.deepEqual(unscopedPages.flatMap(p => p.result.late_blockers.map(row => row.fact_id)), [...fixture.ids].reverse())
  const unscopedState = JSON.parse(Buffer.from(unscopedPages[0].result.pagination.page_token, 'base64url').toString('utf8'))
  delete unscopedState.c
  const unscopedTerminal = cohortPagination({ limit: 25, next_cursor: last, has_more: true }, unscopedState)
  const unscopedExhausted = { ...unscopedBase, cursor: last, page_token: unscopedTerminal.page_token }
  assert.deepEqual(read(unscopedExhausted).late_blockers, [])
  return [
    { name: 'first', args: base },
    { name: 'middle', args: pages[Math.floor(pages.length / 2)].args },
    { name: 'final', args: pages.at(-1).args },
    { name: 'exhausted_continuation', args: exhausted },
    { name: 'exhausted_first', args: { ...base, task_id: fixture.empty } },
    { name: 'unscoped_first', args: unscopedBase },
    { name: 'unscoped_middle', args: unscopedPages[Math.floor(unscopedPages.length / 2)].args },
    { name: 'unscoped_final', args: unscopedPages.at(-1).args },
    { name: 'unscoped_exhausted_continuation', args: unscopedExhausted },
  ]
}
async function writeCosts(store, fixture, rounds) {
  const { withWriteTransaction } = await import('../lib/store/sqlite.js')
  const put = putters(store.handle), result = [], writtenBlockers = []
  for (const kind of ['fact', 'blocker', 'decision']) {
    const times = []
    for (let round = 0; round < rounds; round++) {
      const at = performance.now()
      withWriteTransaction(store.handle, () => {
        for (let i = 0; i < 100; i++) {
          const id = put.fact(fixture.empty, RUN, kind, 'CONFIRMED', kind === 'decision' ? writtenBlockers[round * 100 + i] : null)
          if (kind === 'blocker') writtenBlockers.push(id)
        }
      })
      times.push(elapsed(at))
    }
    result.push({ kind, batch_size: 100, ...summary(times) })
  }
  return result
}
async function boardWorker(root, variant, rounds, migrationMode) {
  phase = 'board-open'
  requireSynthetic(root); assert.ok(VARIANTS.includes(variant))
  const start = performance.now()
  const { TaskforceStore } = await import('../lib/store/index.js')
  const import_ms = elapsed(start), store = new TaskforceStore(root, { journalMode: 'wal' })
  const fixture = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
  try {
    const openAt = performance.now(); store.open(); const open_migration_ms = elapsed(openAt)
    const indexAt = performance.now()
    if (variant === 'rows_task_index') store.handle.exec('CREATE INDEX ' + TASK_INDEX + " ON fact(task_id,run_id,id) WHERE kind='blocker'")
    const additional_index_create_ms = elapsed(indexAt)
    const firstAt = performance.now()
    readOnly(store, () => withVariant(store.handle, variant, () => store.boardPage({ view: 'late_blockers', task_id: fixture.own }, RUN)))
    const first_read_ms = elapsed(firstAt), open_plus_first_read_ms = elapsed(openAt)
    phase = 'board-page-cases'
    const cases = await pageCases(store, fixture, variant), outputs = [], measurements = []
    for (const scenario of cases) {
      phase = 'board-' + scenario.name
      const capture = { plans: [], row_queries: 0, rows_returned_to_javascript: 0 }
      const result = readOnly(store, () => withVariant(store.handle, variant, () => store.boardPage(scenario.args, RUN), capture))
      assert.equal(capture.row_queries, 1, 'probe failed to recognize the selected-row query')
      const json = JSON.stringify(result); outputs.push(json)
      assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, ...result, viewer: 'lead:synthetic', can_accept: true })) <= 65536)
      const times = []
      for (let i = 0; i < rounds; i++) {
        const at = performance.now()
        const reread = withVariant(store.handle, variant, () => store.boardPage(scenario.args, RUN))
        times.push(elapsed(at))
        assert.equal(JSON.stringify(reread), json, 'unchanged page/token changed')
      }
      measurements.push({ scenario: scenario.name, output_sha256: digest(json), output_bytes: Buffer.byteLength(json),
        selected_rows: result.late_blockers.length, ...summary(times), ...capture })
    }
    phase = 'board-write-costs'
    const before_write = sizes(root, store.handle), writes = await writeCosts(store, fixture, rounds), after_write = sizes(root, store.handle)
    const reference = JSON.stringify(withVariant(store.handle, variant, () => store.boardPage({ view: 'late_blockers', task_id: fixture.own }, RUN)))
    store.close()
    phase = 'board-reopen'
    const reopened = new TaskforceStore(root, { journalMode: 'wal' })
    let reopened_open_ms, reopened_read_ms
    try {
      const at = performance.now(); reopened.open(); reopened_open_ms = elapsed(at)
      const readAt = performance.now()
      assert.equal(JSON.stringify(withVariant(reopened.handle, variant, () => reopened.boardPage({ view: 'late_blockers', task_id: fixture.own }, RUN))), reference)
      reopened_read_ms = elapsed(readAt)
    } finally { reopened.close() }
    return { kind: 'nextgen_board', variant, density: fixture.density, facts: fixture.ordinary_facts,
      startup_migration_mode: migrationMode,
      import_ms, open_migration_ms, additional_index_create_ms, first_read_ms, open_plus_first_read_ms,
      reopened_open_ms, reopened_read_ms, before_write, after_write, writes, measurements, ...memory(),
      private_outputs: outputs }
  } finally { store.close() }
}
export async function scopeFixture() {
  const { TaskforceStore } = await import('../lib/store/index.js')
  for (const run of ['scope-run', null]) {
    const root = syntheticRoot(), store = new TaskforceStore(root)
    try {
      store.open(); const p = putters(store.handle)
      const own = p.task('own', 'accepted', run), sibling = p.task('sibling', 'accepted', run)
      const foreign = p.task('foreign', 'accepted', 'foreign')
      const one = p.fact(own, run, 'blocker'), two = p.fact(own, run, 'blocker')
      p.fact(own, 'foreign', 'decision', 'CONFIRMED', one)
      p.fact(sibling, run, 'decision', 'CONFIRMED', one)
      p.fact(own, run, 'fact', 'CONFIRMED', one)
      p.fact(own, run, 'decision', 'REFUTED', one)
      p.fact(own, 'foreign', 'blocker'); p.fact(foreign, run, 'blocker')
      p.fact(null, run, 'blocker'); p.fact(999999999, run, 'blocker')
      store.handle.exec('CREATE INDEX ' + TASK_INDEX + " ON fact(task_id,run_id,id) WHERE kind='blocker'")
      let reference
      const base = { view: 'late_blockers', task_id: own, limit: 1 }
      for (const variant of VARIANTS) {
        const first = readOnly(store, () => withVariant(store.handle, variant, () => store.boardPage(base, run)))
        assert.equal(first.total, 2); assert.equal(first.late_blockers[0].fact_id, two)
        const next = withVariant(store.handle, variant, () => store.boardPage(continuation(first, base), run))
        assert.deepEqual(next.late_blockers.map(row => row.fact_id), [one])
        const json = JSON.stringify([first, next])
        if (reference === undefined) reference = json
        else assert.equal(json, reference, 'scope JSON/token parity')
        assert.throws(() => store.boardPage({ ...base, task_id: foreign }, run), { code: 'E_CROSS_RUN' })
      }
      const first = store.boardPage(base, run)
      const upper = JSON.parse(Buffer.from(first.pagination.page_token, 'base64url').toString()).u
      assert.ok(p.fact(own, run, 'decision', 'CONFIRMED', two) > upper)
      for (const variant of VARIANTS) {
        assert.throws(() => withVariant(store.handle, variant, () => store.boardPage(continuation(first, base), run)), { code: 'E_PAGE_CHANGED' })
      }
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  }
  return { null_scope: true, string_scope: true, foreign_parent_denied: true, invalid_resolvers_ignored: true, resolver_above_ceiling_invalidates: true }
}
const freeze = value => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export function eventHistory(count, repeatedFailure = false) {
  return Array.from({ length: count }, (_, i) => freeze(i % 2 === 0
    ? { seq: i, type: 'tool/call', data: { callId: 'c' + Math.floor(i / 2), name: repeatedFailure ? 'read' : 'subagent', arguments: { path: 'synthetic' } } }
    : { seq: i, type: 'tool/result', data: { callId: 'c' + Math.floor(i / 2), isError: repeatedFailure } }))
}
function runtime(plugin, config) {
  const hooks = new Map(), owner = {}
  plugin.apply({ on: (name, fn) => hooks.set(name, fn),
    get: name => name === 'agentPresets' ? { composedPreset: ctx => ctx?.preset ?? owner } : undefined }, config)
  const agent = { ctx: { preset: owner }, session: { header: { id: 'synthetic-root' }, events: [], surface: { nodes: [] } } }
  return { agent, hooks, pre: () => hooks.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] })) }
}
export async function hookEvidence(count, rounds) {
  const guard = await import('../lib/plugins/guard.mjs'), context = await import('../lib/plugins/working-context.mjs')
  const results = []
  for (const containerMode of ['mutable_outer', 'frozen_outer']) {
  for (const repeatedFailure of [false, true]) {
    const guardOptions = { stallAction: 'observe', stepDownRequests: 0 }
    const gh = runtime(guard, guardOptions), ch = runtime(context)
    const gp = guard.createGuardProjection(), fp = context.createFlowProjection()
    const base = eventHistory(count, repeatedFailure)
    base.push(freeze({ seq: count, type: 'todo/write', data: { todos: [{ content: 'synthetic task', status: 'in_progress' }] } }))
    let history = base
    const scenario = async (name, mutate) => {
      phase = 'hooks-' + name
      if (mutate) mutate()
      if (containerMode === 'frozen_outer' && !Object.isFrozen(history)) Object.freeze(history)
      gh.agent.session.events = history; ch.agent.session.events = history
      const before = { guard: gp.processedEvents, flow: fp.processedEvents }
      const at = performance.now(), gd = await gh.pre(), cd = await ch.pre(), hook_ms = elapsed(at)
      const after_hook_memory = memory()
      // Compare actual hooks with public full-replay rendering, outside timing.
      const expected = context.renderWorkingContext(history)
      const visible = context.contextHistory(ch.agent, history).text
      const projected = cd.messages.find(context.isContextMessage)?.content[0].text
      assert.equal(projected, expected === visible ? undefined : expected)
      assert.deepEqual(gp.read(history), guard.foldGuardSignals(history))
      assert.deepEqual(fp.read(history), context.foldSubagentFlow(history))
      if (name === 'unchanged_reread' || name === 'append') {
        const added = name === 'append' ? 1 : 0
        assert.equal(gp.processedEvents - before.guard, added, 'guard incremental reducer input count')
        assert.equal(fp.processedEvents - before.flow, added, 'flow incremental reducer input count')
      }
      const guardMessage = gd.messages.find(m => m.source?.kind === guard.name)
      if (guardMessage) assert.equal(guardMessage.source.signal, guard.foldGuardSignals(history).echo?.signal)
      results.push({ scenario: name, container_mode: containerMode, repeated_failure_tail: repeatedFailure, events: history.length, hook_ms,
        guard_reducer_inputs: gp.processedEvents - before.guard, flow_reducer_inputs: fp.processedEvents - before.flow,
        ...after_hook_memory })
      return cd
    }
    await scenario('initial_replay')
    for (let i = 0; i < rounds; i++) await scenario('unchanged_reread')
    for (let i = 0; i < rounds; i++) await scenario('append', () => {
      const event = freeze({ seq: history.length, type: 'todo/write', data: { todos: [{ content: 'appended task', status: 'in_progress' }] } })
      if (containerMode === 'frozen_outer') history = [...history, event]
      else history.push(event)
    })
    await scenario('replacement', () => { history = [...history]; history[Math.floor(count / 2)] = freeze({ seq: Math.floor(count / 2), type: 'turn/start', data: {} }) })
    await scenario('reorder', () => { history = [...history]; [history[1], history[2]] = [history[2], history[1]] })
    await scenario('mutable_restore', () => { history = JSON.parse(JSON.stringify(history)) })
    await scenario('mutable_change', () => { history.at(-1).data.todos[0].content = 'restored change' })
    await scenario('truncation', () => { history = history.slice(0, Math.max(1, history.length - 8)) })
    await scenario('same_id_session_replacement', () => {
      gh.agent.session = { ...gh.agent.session }; ch.agent.session = { ...ch.agent.session }
    })
    // Persist the current context as a frozen event, then hide it via compaction.
    history = history.map((event, seq) => freeze({ ...event, seq }))
    const line = context.renderWorkingContext(history)
    if (line !== undefined) {
      history.push(freeze({ seq: history.length, type: 'user/message', data: context.createContextMessage(line) }))
      ch.agent.session.surface.nodes = [history.length - 1]
      await scenario('visible_publication')
      ch.agent.session.surface.nodes = []
      await scenario('compaction_republish')
    }
  }
  }
  return results
}
async function invokeWorker(args) {
  const at = performance.now()
  const child = spawnSync(process.execPath, [SELF, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 300000 })
  if (child.status !== 0) {
    let failure
    try { failure = JSON.parse(child.stdout) } catch { /* no raw child output */ }
    if (failure?.kind === 'nextgen_failure') {
      phase = 'worker-' + (typeof failure.stage === 'string' ? failure.stage : 'unknown')
      emit({ kind: 'nextgen_worker_failure', ...safeDiagnostic(failure, phase) })
    }
  }
  assert.equal(child.status, 0, 'worker failed; no raw child diagnostics exported')
  assert.equal(child.error, undefined, 'worker launch failed')
  return { report: JSON.parse(child.stdout), fresh_process_total_wall_ms: elapsed(at) }
}
async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--worker-board') {
    emit(await boardWorker(args[1], args[2], Number(args[3]), args[4])); return
  }
  if (args[0] === '--worker-events') {
    emit({ kind: 'nextgen_events', events: Number(args[1]), measurements: await hookEvidence(Number(args[1]), Number(args[2])) }); return
  }
  const opts = options(args), root = syntheticRoot()
  emit({ kind: 'nextgen_configuration', ...opts, node: process.version, sqlite: process.versions.sqlite, v8: process.versions.v8,
    platform: process.platform, architecture: process.arch, timing_gate: false,
    cold_os_cache: 'not measured', workload: 'synthetic; no provider calls', variants: VARIANTS,
    counters: 'rows returned to JavaScript and separate projection reducer inputs; not SQLite visits',
    event_timing: 'complete guard/context pre-step hooks; replay oracles and separate reducer counters outside timing',
    memory_scope: 'whole harness process sampled immediately after hooks; includes benchmark projections and retained oracles from previous samples' })
  try {
    const { TaskforceStore } = await import('../lib/store/index.js')
    for (const density of ['sparse', 'dense']) {
      const seedRoot = join(root, density); mkdirSync(seedRoot)
      writeFileSync(join(seedRoot, MARKER), 'synthetic only\n')
      const seed = new TaskforceStore(seedRoot, { journalMode: 'wal' })
      let fixture
      try {
        seed.open(); const at = performance.now(); fixture = await populate(seed, opts.facts, density)
        emit({ kind: 'nextgen_seed', density, facts: opts.facts, seed_ms: elapsed(at), ...sizes(seedRoot, seed.handle) })
      } finally { seed.close() }
      let reference
      for (const migrationMode of ['existing_index', 'recreate_existing_blocker_index']) {
        for (const variant of VARIANTS) {
          const clone = join(root, density + '-' + migrationMode + '-' + variant); mkdirSync(clone)
          writeFileSync(join(clone, MARKER), 'synthetic only\n')
          copyFileSync(join(seedRoot, 'taskforce.db'), join(clone, 'taskforce.db'))
          writeFileSync(join(clone, 'fixture.json'), JSON.stringify(fixture))
          if (migrationMode === 'recreate_existing_blocker_index') {
            // Mutate only the disposable clone, before the timed fresh process.
            // Store.open() performs the real existing-index migration.
            const { DatabaseSync } = await import('node:sqlite')
            const db = new DatabaseSync(join(clone, 'taskforce.db'))
            try { db.exec('DROP INDEX idx_fact_blocker_run_id') } finally { db.close() }
          }
          const { report, fresh_process_total_wall_ms } = await invokeWorker(['--worker-board', clone, variant, String(opts.rounds), migrationMode])
          if (reference === undefined) reference = report.private_outputs
          else assert.deepEqual(report.private_outputs, reference, 'exact page JSON/token equivalence')
          delete report.private_outputs
          emit({ ...report, fresh_process_total_wall_ms, exact_json_tokens_equal: true })
          rmSync(clone, { recursive: true, force: true })
        }
      }
    }
    phase = 'scope-fixtures'
    emit({ kind: 'nextgen_scope', ...(await scopeFixture()) })
    const { report, fresh_process_total_wall_ms } = await invokeWorker(['--worker-events', String(opts.events), String(opts.rounds)])
    emit({ kind: report.kind, events: report.events, fresh_process_total_wall_ms })
    for (const measurement of report.measurements) emit({ kind: 'nextgen_event_measurement', ...measurement })
    const groups = new Map()
    for (const m of report.measurements) {
      const key = JSON.stringify([m.scenario, m.container_mode, m.repeated_failure_tail])
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(m)
    }
    for (const measurements of groups.values()) {
      const first = measurements[0]
      emit({ kind: 'nextgen_event_summary', scenario: first.scenario, container_mode: first.container_mode,
        repeated_failure_tail: first.repeated_failure_tail, ...summary(measurements.map(m => m.hook_ms)),
        max_sampled_rss_bytes: Math.max(...measurements.map(m => m.rss_bytes)),
        whole_process_peak_rss_bytes: Math.max(...measurements.map(m => m.peak_rss_bytes)) })
    }
    emit({ kind: 'nextgen_complete', semantic_assertions: 'passed', timing_gate: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().catch(error => { emit({ kind: 'nextgen_failure', ...safeDiagnostic(error, phase) }); process.exitCode = 1 })
}
