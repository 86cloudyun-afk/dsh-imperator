import assert from 'node:assert/strict'
import test from 'node:test'
import { STORE_CODES, PENDING_STATUSES } from '../../lib/store/index.js'
import { tempStore } from './helpers.mjs'

const run = 'run-a'
const worker = { sessionId: 'evidence-worker', isRoot: false }
const lead = { sessionId: run, isRoot: true }

test('Task16 blocker resolution uses the complete fact run after task scope validation', t => {
  const store = tempStore(t), full = 'root\0suffix'
  const id = store.openTask({ title: 'exact resolution' }, full).task_id
  const blocker = store.recordFact({ task_id: id, kind: 'blocker', statement: 'blocked', confidence: 'CONFIRMED' }, full).fact_id
  const result = store.recordFact({ task_id: id, kind: 'decision', statement: 'resolved', confidence: 'CONFIRMED', resolves_fact_id: blocker }, full)
  assert.equal(result.resolves_fact_id, blocker)
  assert.equal(store.taskOf(id, full).blockers, 0)
  const stored = store.open().prepare('SELECT json_quote(run_id) AS run FROM fact WHERE id=?').get(result.fact_id)
  assert.equal(JSON.parse(stored.run), full)
})
function open(store, title = '核对') { return store.openTask({ title }, run).task_id }
function owned(store) {
  const id = open(store)
  store.claimTask({ task_id: id, child_id: '证据执行者' }, run, worker, worker.sessionId)
  return id
}
function fact(store, id, kind, confidence = 'PLAUSIBLE', extra = {}) {
  return store.recordFact({ task_id: id, kind, confidence, statement: `${kind} ${confidence}`, ...extra }, run).fact_id
}
function submit(store, id) { store.submitTask({ task_id: id }, run) }
function rawResolution(store, id, blocker, kind, confidence, resolutionRun = run) {
  store.handle.prepare('INSERT INTO fact (task_id, kind, statement, confidence, run_id, resolves_fact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, 'legacy invalid resolution', confidence, resolutionRun, blocker, '2026-01-01T00:00:00.000Z')
}

for (const kind of ['fact', 'artifact']) test(`accepted legacy ${kind} without a pointer gives future-task advice while evidence stays frozen`, t => {
  const store = tempStore(t), id = owned(store)
  const recorded = store.recordFact({ task_id: id, kind, confidence: 'PLAUSIBLE', statement: '已完成现场核对' }, run, worker)
  assert.equal(store.submitTask({ task_id: id }, run, worker).status, 'submitted')
  const accepted = store.acceptTask({ task_id: id }, run, lead)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.waiver, null)
  assert.equal(accepted.fact_count, 1)
  assert.equal(accepted.resolved_blockers, 0)
  assert.deepEqual(accepted.evidence_basis, { count: 1, fact_ids: [recorded.fact_id], with_pointer: 0, unattributed: 0 })

  const snapshot = () => ({
    task: store.handle.prepare('SELECT * FROM task WHERE id = ?').get(id),
    facts: store.handle.prepare('SELECT * FROM fact WHERE task_id = ? ORDER BY id').all(id),
  })
  const before = snapshot()
  assert.equal(before.task.status, 'accepted')
  assert.equal(before.task.evidence_policy, 'legacy')
  assert.equal(before.task.owner_session, worker.sessionId)
  assert.equal(before.task.evidence_generation, 0)
  for (const lateKind of ['fact', 'artifact']) {
    assert.throws(() => store.recordFact({ task_id: id, kind: lateKind, confidence: 'PLAUSIBLE',
      statement: '尝试事后补充产物指针', evidence_path: 'verification.log', evidence_line: 12 }, run, worker),
    { code: STORE_CODES.terminal })
    assert.deepEqual(snapshot(), before, 'terminal refusal must preserve the task, generation and all fact rows')
  }

  assert.equal(accepted.warnings.length, 1)
  const warning = accepted.warnings[0]
  assert.match(warning, /本次验收已完成/)
  assert.match(warning, /可核查性弱/)
  assert.match(warning, /后续任务.*提交.*验收前.*evidence_path.*可用.*行号/)
  assert.doesNotMatch(warning, /建议补|当前任务.*(?:补|追加)|task_(?:fact|reject)|轮询|重新(?:打开|开启|认领|复核)|自动重开|waiver_reason|豁免/)
})

test('legacy evidence recorded with a pointer before submission accepts without weak-traceability advice', t => {
  const store = tempStore(t), id = owned(store)
  const recorded = store.recordFact({ task_id: id, kind: 'artifact', confidence: 'PLAUSIBLE',
    statement: '核对结果', evidence_path: 'verification.log', evidence_line: 12 }, run, worker)
  store.submitTask({ task_id: id }, run, worker)
  const accepted = store.acceptTask({ task_id: id }, run, lead)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.waiver, null)
  assert.deepEqual(accepted.evidence_basis, { count: 1, fact_ids: [recorded.fact_id], with_pointer: 1, unattributed: 0 })
  assert.deepEqual(accepted.warnings, [])
})

test('explicit legacy waiver retains waiver advice instead of future-task pointer advice', t => {
  const store = tempStore(t), id = owned(store)
  const recorded = store.recordFact({ task_id: id, kind: 'fact', confidence: 'PLAUSIBLE', statement: '人工核对记录' }, run, worker)
  store.submitTask({ task_id: id }, run, worker)
  const accepted = store.acceptTask({ task_id: id, waiver_reason: '人工审阅原始材料' }, run, lead)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.waiver.reason, '人工审阅原始材料')
  assert.deepEqual(accepted.evidence_basis, { count: 1, fact_ids: [recorded.fact_id], with_pointer: 0, unattributed: 0 })
  assert.equal(accepted.warnings.length, 1)
  assert.match(accepted.warnings[0], /人工豁免.*人工审阅原始材料/)
  assert.match(accepted.warnings[0], /不构成"已验证事实"/)
  assert.doesNotMatch(accepted.warnings[0], /可核查性弱|后续任务/)
})

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
  assert.throws(() => store.acceptTask({ task_id: id }, run, 'lead'), { code: 'E_STORE_INTEGRITY' })
  // Correcting only the foreign association must not make the other malformed
  // resolutions valid. The genuine same-run blocker still prevents acceptance.
  store.handle.prepare('DELETE FROM fact WHERE task_id = ? AND run_id = ?').run(id, 'run-b')
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


for (const count of [0, 1, 2]) test('acceptance reports ' + count + ' distinct resolved blockers', t => {
  const store = tempStore(t), id = open(store)
  fact(store, id, 'artifact')
  for (let i = 0; i < count; i++) {
    const blocker = fact(store, id, 'blocker')
    fact(store, id, 'decision', 'CONFIRMED', { resolves_fact_id: blocker })
    fact(store, id, 'decision', 'PLAUSIBLE', { resolves_fact_id: blocker })
  }
  submit(store, id)
  assert.equal(store.acceptTask({ task_id: id }, run, 'lead').resolved_blockers, count)
})

test('REFUTED historical decisions do not count as resolved blockers or permit acceptance', t => {
  const store = tempStore(t), id = open(store)
  fact(store, id, 'artifact')
  const blocker = fact(store, id, 'blocker')
  rawResolution(store, id, blocker, 'decision', 'REFUTED')
  submit(store, id)
  assert.throws(() => store.acceptTask({ task_id: id }, run, 'lead'), { code: STORE_CODES.blockers })
  fact(store, id, 'decision', 'CONFIRMED', { resolves_fact_id: blocker })
  assert.equal(store.acceptTask({ task_id: id }, run, 'lead').resolved_blockers, 1)
})

test('terminal unresolved blockers remain visible even when recorded before cancellation', t => {
  const store = tempStore(t), id = open(store)
  const recorded = store.recordFact({ task_id: id, kind: 'blocker', statement: 'preclosure blocker' }, run)
  assert.equal(recorded.late, false)
  store.closeTask({ task_id: id, result: 'failed' }, run, 'lead')
  assert.equal(store.board({}, run).late_blockers[0].blockers[0].fact_id, recorded.fact_id)
  assert.equal(store.boardPage({}, run).late_blockers[0].fact_id, recorded.fact_id)
  assert.equal(store.stats(run).blockers_late, 1)
  const detail = store.board({ task_id: id }, run)
  assert.equal(detail.task.blockers, 1)
  assert.doesNotMatch(detail.note, /收口之后落下/, 'current terminal collection is not an insertion-time claim')
})

test('all-runs blocker statistics include every pending state, terminal and NULL scope', t => {
  const store = tempStore(t)
  for (const scope of ['run-a', 'run-b', null]) {
    for (const status of PENDING_STATUSES) {
      const id = store.openTask({ title: status }, scope).task_id
      store.handle.prepare('UPDATE task SET status=? WHERE id=?').run(status, id)
      store.recordFact({ task_id: id, kind: 'blocker', statement: 'pending' }, scope)
    }
    const closed = store.openTask({ title: 'terminal' }, scope).task_id
    store.closeTask({ task_id: closed, result: 'failed' }, scope, 'lead')
    const blocker = store.recordFact({ task_id: closed, kind: 'blocker', statement: 'terminal unresolved' }, scope).fact_id
    store.handle.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at,resolves_fact_id) VALUES(?,?,'decision','invalid','REFUTED','now',?)")
      .run(closed, scope, blocker)
    store.handle.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,'blocker','FOREIGN_SECRET','PLAUSIBLE','now')")
      .run(closed, scope === null ? 'foreign' : null)
  }
  const domains = ['run-a', 'run-b', null].map(scope => store.stats(scope))
  const global = store.statsAllRuns()
  assert.equal(global.blockers_open, domains.reduce((sum, value) => sum + value.blockers_open, 0))
  assert.equal(global.blockers_late, domains.reduce((sum, value) => sum + value.blockers_late, 0))
  assert.equal(global.blockers_open, 12)
  assert.equal(global.blockers_late, 3)
  assert.equal(global.facts.total, 21, 'explicit global facts retain raw-row statistics')
  assert.doesNotMatch(JSON.stringify(global), /FOREIGN_SECRET/)
})
