import assert from 'node:assert/strict'
import test from 'node:test'
import { STORE_CODES } from '../../lib/store/index.js'
import { tempStore } from './helpers.mjs'

const run = 'run-a'
function open(store, title = '核对') { return store.openTask({ title }, run).task_id }
function fact(store, id, kind, confidence = 'PLAUSIBLE', extra = {}) {
  return store.recordFact({ task_id: id, kind, confidence, statement: `${kind} ${confidence}`, ...extra }, run).fact_id
}
function submit(store, id) { store.submitTask({ task_id: id }, run) }
function rawResolution(store, id, blocker, kind, confidence, resolutionRun = run) {
  store.handle.prepare('INSERT INTO fact (task_id, kind, statement, confidence, run_id, resolves_fact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, 'legacy invalid resolution', confidence, resolutionRun, blocker, '2026-01-01T00:00:00.000Z')
}

test('REFUTED-only evidence cannot pass acceptance, but a confirmed counterfinding can', (t) => {
  const store = tempStore(t)
  const id = open(store)
  fact(store, id, 'artifact', 'REFUTED', { evidence_path: 'old.log' })
  submit(store, id)
  assert.throws(() => store.acceptTask({ task_id: id }, run, 'lead'), { code: STORE_CODES.evidenceMissing })
  const counter = fact(store, id, 'fact', 'CONFIRMED', { statement: '已确认原主张被反证', evidence_path: 'counter.log' })
  const accepted = store.acceptTask({ task_id: id }, run, 'lead')
  assert.deepEqual(accepted.evidence_basis.fact_ids, [counter])
})

test('only a valid decision resolves a blocker; invalid API writes leave no row', (t) => {
  const store = tempStore(t)
  const id = open(store)
  fact(store, id, 'fact')
  const blocker = fact(store, id, 'blocker')
  const before = store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n
  for (const [kind, confidence] of [['artifact', 'CONFIRMED'], ['decision', 'REFUTED']]) {
    assert.throws(() => fact(store, id, kind, confidence, { resolves_fact_id: blocker }), { code: STORE_CODES.resolutionInvalid })
  }
  assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n, before)
  submit(store, id)
  assert.equal(store.board({ task_id: id }, run).task.blockers, 1)
  fact(store, id, 'decision', 'PLAUSIBLE', { resolves_fact_id: blocker })
  assert.equal(store.board({ task_id: id }, run).task.blockers, 0)
  assert.equal(store.acceptTask({ task_id: id }, run, 'lead').status, 'accepted')
})

test('malformed historical resolutions never hide blockers in readers or acceptance', (t) => {
  const store = tempStore(t)
  const id = open(store)
  fact(store, id, 'fact')
  const blocker = fact(store, id, 'blocker')
  const another = open(store, '另一任务')
  rawResolution(store, id, blocker, 'artifact', 'CONFIRMED')
  rawResolution(store, id, blocker, 'decision', 'REFUTED')
  rawResolution(store, id, blocker, 'decision', 'BROKEN')
  rawResolution(store, id, blocker, 'decision', 'CONFIRMED', 'run-b')
  rawResolution(store, another, blocker, 'decision', 'CONFIRMED')
  submit(store, id)
  assert.equal(store.taskOf(id, run).blockers, 1)
  assert.equal(store.board({ task_id: id }, run).task.blockers, 1)
  assert.equal(store.board({}, run).tasks.find((task) => task.id === id).blockers, 1)
  assert.equal(store.stats(run).blockers_open, 1)
  assert.equal(store.statsAllRuns().blockers_open, 1)
  assert.equal(store.handle.prepare('SELECT blockers_open FROM v_run_board WHERE id = ?').get(id).blockers_open, 1)
  assert.throws(() => store.acceptTask({ task_id: id }, run, 'lead'), /未解 blocker/)
  // The legacy view deliberately reports the historical total, independent of resolution validity.
  assert.equal(store.handle.prepare('SELECT blockers FROM v_task_board WHERE id = ?').get(id).blockers, 1)
})

test('historical accepted status survives evidence review and invalid late resolution', (t) => {
  const store = tempStore(t)
  const id = open(store)
  fact(store, id, 'fact', 'REFUTED')
  submit(store, id)
  store.acceptTask({ task_id: id, waiver_reason: '人工核对旧记录' }, run, 'lead')
  const blocker = fact(store, id, 'blocker')
  rawResolution(store, id, blocker, 'decision', 'REFUTED')
  const detail = store.board({ task_id: id }, run)
  assert.equal(detail.task.status, 'accepted')
  assert.equal(detail.task.blockers, 1)
  assert.ok(detail.validation_warnings.some((warning) => warning.code === 'W_EVIDENCE_REVIEW'))
  assert.equal(store.board({}, run).late_blockers[0].blockers[0].fact_id, blocker)
  assert.equal(store.stats(run).blockers_late, 1)
  assert.equal(store.handle.prepare('SELECT blockers_open FROM v_run_board WHERE id = ?').get(id).blockers_open, 1)
})

test('waiver with actual basis reports the actual count in the acceptance audit', (t) => {
  const store = tempStore(t)
  const id = open(store)
  fact(store, id, 'artifact', 'PLAUSIBLE', { evidence_path: 'artifact.log' })
  submit(store, id)
  store.acceptTask({ task_id: id, waiver_reason: '复核仍需人工判断' }, run, 'lead')
  const audit = store.board({ task_id: id }, run).facts.find((row) => row.statement.startsWith('验收通过'))
  assert.match(audit.statement, /依据事实 1 条/)
})

test('a blocker with a mismatched historical run cannot be resolved by a new write', (t) => {
  const store = tempStore(t)
  const id = open(store)
  const blocker = fact(store, id, 'blocker')
  store.handle.prepare('UPDATE fact SET run_id = ? WHERE id = ?').run('run-b', blocker)
  assert.throws(() => fact(store, id, 'decision', 'CONFIRMED', { resolves_fact_id: blocker }), { code: STORE_CODES.resolutionInvalid })
  assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact WHERE resolves_fact_id = ?').get(blocker).n, 0)
})

test('migration rebuilds an old run board view without changing its columns', (t) => {
  const store = tempStore(t)
  const id = open(store)
  const blocker = fact(store, id, 'blocker')
  rawResolution(store, id, blocker, 'decision', 'REFUTED')
  store.handle.exec('DROP VIEW v_run_board')
  store.handle.exec('CREATE VIEW v_run_board AS SELECT t.run_id, t.id, t.title, t.status, t.owner, (SELECT COUNT(*) FROM fact f WHERE f.task_id=t.id) AS fact_count, (SELECT COUNT(*) FROM fact b WHERE b.task_id=t.id AND b.kind=\'blocker\' AND NOT EXISTS (SELECT 1 FROM fact r WHERE r.resolves_fact_id=b.id)) AS blockers_open FROM task t')
  assert.equal(store.handle.prepare('SELECT blockers_open FROM v_run_board WHERE id = ?').get(id).blockers_open, 0)
  store.migrate(store.handle)
  assert.deepEqual(store.handle.prepare('PRAGMA table_info(v_run_board)').all().map((row) => row.name),
    ['run_id', 'id', 'title', 'status', 'owner', 'fact_count', 'blockers_open'])
  assert.equal(store.handle.prepare('SELECT blockers_open FROM v_run_board WHERE id = ?').get(id).blockers_open, 1)
})
