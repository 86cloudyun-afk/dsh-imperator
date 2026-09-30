import assert from 'node:assert/strict'
import { test } from 'node:test'
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
