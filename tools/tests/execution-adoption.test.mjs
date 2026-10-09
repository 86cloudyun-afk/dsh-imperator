import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { strictExecutionEvidence } from '../../lib/store/execution.js'
import { tempStore } from './helpers.mjs'

const RUN = 'adopted-run'
const FOREIGN_RUN = 'foreign-run'
const OWNER = { isRoot: false, sessionId: 'worker-a' }
const REPLACEMENT = { isRoot: false, sessionId: 'worker-b' }
const LEAD = { isRoot: true, sessionId: 'adoption-lead' }
const command = "printf 'verified\\n'"
const TABLES = ['task', 'fact', 'handoff', 'execution_receipt', 'execution_waiver']
const rows = store => Object.fromEntries(TABLES.map(table =>
  [table, store.handle.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()]))
const taskRows = (store, id) => Object.fromEntries(Object.entries(rows(store)).map(([table, list]) =>
  [table, list.filter(row => table === 'task' ? row.id === id : row.task_id === id)]))
const withoutRun = ({ run_id, ...row }) => row

// Public host methods create audit; SQL only injects failures or corrupt attribution.
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'execution-adoption-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'source.js'), 'export const answer = 42\n')
  const store = tempStore(t)
  let call = 0
  const open = (run = null) => store.openTask({
    title: 'execution adoption', evidence_policy: 'execution',
    verification_files: ['source.js'], verification_command: command,
  }, run, { ...LEAD, cwd }).task_id
  const claim = (id, run = null, owner = OWNER) =>
    store.claimTask({ task_id: id, child_id: 'shared-label' }, run, owner, owner.sessionId)
  const submit = (id, run = null, owner = OWNER) =>
    store.submitTask({ task_id: id, note: 'ready' }, run, owner)
  const accept = (id, run = RUN, extra = {}) =>
    store.acceptTask({ task_id: id, ...extra }, run, LEAD)
  const pending = (id, run = null, owner = OWNER) => {
    const callId = 'host-call-' + ++call
    return store.recordExecution({
      task_id: id, status: 'pending', command, timeout_ms: 60000,
      call_id: callId, root_call_id: 'outer-' + callId, parent_call_id: 'parent-' + callId,
    }, run, owner)
  }
  const complete = (id, receiptId, run = null, owner = OWNER, exitCode = 0) =>
    store.recordExecution({
      task_id: id, status: 'completed', receipt_id: receiptId,
      native_result: { isError: false, value: {
        kind: 'foreground', exitCode, signal: null, timedOut: false,
        aborted: false, timeoutMs: 60000,
        stdout: { text: 'verified\n', truncated: false },
        stderr: { text: '', truncated: false },
      } },
    }, run, owner)
  const verify = (id, run = null, owner = OWNER, exitCode = 0) =>
    complete(id, pending(id, run, owner).receipt_id, run, owner, exitCode)
  const strict = (id, run = RUN) =>
    strictExecutionEvidence(store.handle, store.root, store.taskOf(id, run).task)
  return { store, open, claim, submit, accept, pending, complete, verify, strict }
}

test('successful unassigned evidence survives adoption with real ownership intact', t => {
  const f = fixture(t), id = f.open()
  f.claim(id)
  const verified = f.verify(id)
  assert.equal(verified.verified, true)
  f.submit(id)
  const before = taskRows(f.store, id)
  const unassignedSummary = f.store.unassignedSummary()
  assert.throws(() => f.store.board(id, RUN), { code: 'E_CROSS_RUN' })

  const adopted = f.store.adoptUnassigned(RUN)
  const detail = f.store.board(id, RUN)
  assert.equal(detail.receipts.length, 1)
  assert.equal(detail.receipts[0].receipt_id, verified.receipt_id)
  assert.equal(detail.receipts[0].run_id, RUN)
  assert.deepEqual(withoutRun(rows(f.store).execution_receipt[0]),
    withoutRun(before.execution_receipt[0]))
  assert.equal(detail.task.owner_session, OWNER.sessionId)
  assert.equal(detail.task.evidence_generation, 0)
  assert.equal(unassignedSummary.execution_receipts, 1)
  assert.equal(adopted.execution_receipts, 1)
  assert.equal(adopted.execution_waivers, 0)
  assert.equal(f.store.unassignedSummary().execution_receipts, 0)
  assert.throws(() => f.store.board(id), { code: 'E_CROSS_RUN' })
  const stable = rows(f.store)
  assert.throws(() => f.submit(id, RUN, REPLACEMENT), { code: 'E_TASK_CONFLICT' })
  assert.deepEqual(rows(f.store), stable)
  const accepted = f.accept(id)
  assert.equal(accepted.execution_verified, true)
  assert.equal(accepted.execution_receipt, verified.receipt_id)
  const again = f.store.adoptUnassigned(FOREIGN_RUN)
  assert.equal(again.tasks, 0)
  assert.equal(again.execution_receipts, 0)
  assert.equal(again.execution_waivers, 0)
  assert.equal(f.store.board(id, RUN).receipts[0].run_id, RUN)
})

test('a real host waiver migrates as audit history and never becomes verified evidence', t => {
  const f = fixture(t), id = f.open()
  f.claim(id)
  const failed = f.verify(id, null, OWNER, 7)
  assert.equal(failed.verified, false)
  f.submit(id)
  const accepted = f.accept(id, null, { waiver_reason: 'manual inspection' })
  assert.equal(accepted.execution_verified, false)
  assert.equal(accepted.execution_receipt, null)
  const before = f.store.board(id)
  assert.equal(before.execution_waivers[0].receipt_id, failed.receipt_id)
  assert.equal(before.execution_waivers[0].actor_session, LEAD.sessionId)

  const adopted = f.store.adoptUnassigned(RUN)
  const after = f.store.board(id, RUN)
  assert.equal(after.execution_waivers.length, 1)
  assert.equal(adopted.execution_waivers, 1)
  assert.equal(after.execution_waivers[0].run_id, RUN)
  assert.deepEqual(withoutRun(after.execution_waivers[0]),
    withoutRun(before.execution_waivers[0]))
  assert.deepEqual(withoutRun(after.receipts[0]), withoutRun(before.receipts[0]))
  assert.match(after.facts.find(row => row.statement.startsWith('验收通过')).statement,
    /人工豁免.*非验证通过/)
  assert.equal(after.task.status, 'accepted')
  assert.throws(() => f.strict(id), { code: 'E_VERIFICATION_RECEIPT' })
  assert.equal(f.store.unassignedSummary().execution_waivers, 0)
})

test('audit-stage and final-stage failures roll back all five tables and diagnostics', t => {
  for (const table of ['execution_waiver', 'handoff']) {
    const f = fixture(t), id = f.open()
    f.claim(id); f.verify(id); f.submit(id)
    f.store.recordHandoff({ task_id: id, from_child: 'worker-a',
      to_child: 'worker-b', note: 'handoff audit' })
    f.accept(id, null, { waiver_reason: 'manual check' })
    const before = rows(f.store), migration = structuredClone(f.store.migration)
    for (const name of TABLES) assert.ok(before[name].length > 0, name)
    // Waiver failure rolls back receipt; final handoff failure rolls back all.
    f.store.handle.exec('CREATE TEMP TRIGGER fail_adopt BEFORE UPDATE OF run_id ON '
      + table + " BEGIN SELECT RAISE(ABORT, 'adoption failure'); END")
    assert.throws(() => f.store.adoptUnassigned(RUN), /adoption failure/)
    assert.deepEqual(rows(f.store), before)
    assert.deepEqual(f.store.migration, migration)
    f.store.handle.exec('DROP TRIGGER fail_adopt')
    const recovered = f.store.adoptUnassigned(RUN)
    assert.equal(recovered.execution_receipts, 1)
    assert.equal(recovered.execution_waivers, 1)
    assert.equal(f.store.board(id, RUN).execution_waivers.length, 1)
  }
})

test('adoption does not launder NULL audit rows attached to an existing target task', t => {
  const f = fixture(t), existing = f.open(RUN), unassigned = f.open()
  f.claim(existing, RUN); f.verify(existing, RUN); f.submit(existing, RUN)
  f.accept(existing, RUN, { waiver_reason: 'existing manual decision' })
  f.store.handle.prepare('UPDATE execution_receipt SET run_id = NULL WHERE task_id = ?').run(existing)
  f.store.handle.prepare('UPDATE execution_waiver SET run_id = NULL WHERE task_id = ?').run(existing)
  const before = taskRows(f.store, existing)
  f.claim(unassigned); f.verify(unassigned); f.submit(unassigned)

  f.store.adoptUnassigned(RUN)
  assert.deepEqual(taskRows(f.store, existing), before)
  const detail = f.store.board(existing, RUN)
  assert.deepEqual(detail.receipts, [])
  assert.deepEqual(detail.execution_waivers, [])
  assert.equal(detail.scope_integrity[0]?.mismatched_receipts, 1)
  assert.equal(detail.scope_integrity[0]?.mismatched_waivers, 1)
  assert.throws(() => f.strict(existing), { code: 'E_VERIFICATION_RECEIPT' })
  assert.equal(f.accept(unassigned).execution_verified, true)
})

test('foreign execution audit is hidden, counted and cannot be waived past integrity', t => {
  const f = fixture(t), id = f.open(RUN)
  f.claim(id, RUN); f.verify(id, RUN); f.submit(id, RUN)
  f.accept(id, RUN, { waiver_reason: 'initial manual review' })
  f.store.rejectTask({ task_id: id, reason: 'review again' }, RUN, LEAD)
  f.claim(id, RUN); f.submit(id, RUN)
  f.store.handle.prepare("UPDATE execution_receipt SET run_id = ?, command = 'FOREIGN_RECEIPT_SECRET' WHERE task_id = ?").run(FOREIGN_RUN, id)
  f.store.handle.prepare("UPDATE execution_waiver SET run_id = ?, reason = 'FOREIGN_WAIVER_SECRET' WHERE task_id = ?").run(FOREIGN_RUN, id)
  const before = rows(f.store), detail = f.store.board(id, RUN)
  assert.deepEqual(detail.receipts, [])
  assert.deepEqual(detail.execution_waivers, [])
  assert.doesNotMatch(JSON.stringify(detail), /FOREIGN_/)
  assert.equal(detail.scope_integrity[0]?.mismatched_receipts, 1)
  assert.equal(detail.scope_integrity[0]?.mismatched_waivers, 1)
  const summary = f.store.boardPage({ view: 'summary' }, RUN)
  assert.doesNotMatch(JSON.stringify(summary), /FOREIGN_/)
  assert.equal(summary.scope_integrity_totals.mismatched_receipts, 1)
  assert.equal(summary.scope_integrity_totals.mismatched_waivers, 1)
  assert.throws(() => f.accept(id, RUN, { waiver_reason: 'bypass attempt' }), error => {
    assert.equal(error.code, 'E_STORE_INTEGRITY')
    assert.doesNotMatch(error.message + (error.hint ?? ''), /FOREIGN_/)
    return true
  })
  assert.deepEqual(rows(f.store), before)
})

test('latest pending attempt still blocks earlier success after adoption', t => {
  const f = fixture(t), id = f.open()
  f.claim(id); f.verify(id)
  const pending = f.pending(id)
  f.submit(id)
  const before = rows(f.store).execution_receipt.map(withoutRun)
  f.store.adoptUnassigned(RUN)
  const receipts = f.store.board(id, RUN).receipts
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].receipt_id, pending.receipt_id)
  assert.equal(receipts[0].status, 'pending')
  assert.deepEqual(rows(f.store).execution_receipt.map(withoutRun), before)
  const stable = rows(f.store)
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  assert.throws(() => f.complete(id, pending.receipt_id), { code: 'E_CROSS_RUN' })
  assert.deepEqual(rows(f.store), stable)
})

test('latest failed result remains authoritative after adoption', t => {
  const f = fixture(t), id = f.open()
  f.claim(id); f.verify(id)
  const failed = f.verify(id, null, OWNER, 7)
  f.submit(id)
  const before = rows(f.store).execution_receipt.map(withoutRun)
  f.store.adoptUnassigned(RUN)
  const receipts = f.store.board(id, RUN).receipts
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].receipt_id, failed.receipt_id)
  assert.equal(receipts[0].exit_code, 7)
  assert.deepEqual(rows(f.store).execution_receipt.map(withoutRun), before)
  const stable = rows(f.store)
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  assert.deepEqual(rows(f.store), stable)
})

test('adoption cannot refresh a stale generation or transfer predecessor ownership', t => {
  for (const owner of [OWNER, REPLACEMENT]) {
    const f = fixture(t), id = f.open()
    f.claim(id); f.verify(id); f.submit(id)
    f.store.rejectTask({ task_id: id, reason: 'new generation' }, null, LEAD)
    if (owner === OWNER) f.claim(id)
    else f.store.claimTask({ task_id: id, child_id: 'replacement-label' },
      null, LEAD, owner.sessionId)
    f.submit(id, null, owner)
    const receipt = rows(f.store).execution_receipt[0]
    f.store.adoptUnassigned(RUN)
    const task = f.store.taskOf(id, RUN).task
    assert.equal(task.evidence_generation, 1)
    assert.equal(task.owner_session, owner.sessionId)
    assert.deepEqual(withoutRun(rows(f.store).execution_receipt[0]), withoutRun(receipt))
    assert.equal(f.store.board(id, RUN).receipts.length, 1)
    assert.equal(f.store.board(id, RUN).receipts[0].evidence_generation, 0)
    assert.equal(f.store.board(id, RUN).receipts[0].owner_session, OWNER.sessionId)
    const stable = rows(f.store)
    assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
    if (owner === REPLACEMENT) {
      assert.throws(() => f.submit(id, RUN, OWNER), { code: 'E_TASK_CONFLICT' })
      assert.throws(() => f.store.verificationTarget(id, RUN, OWNER), { code: 'E_TASK_CONFLICT' })
    }
    assert.deepEqual(rows(f.store), stable)
  }
})

for (const [table, column, detailKey, mismatchKey] of [
  ['execution_receipt', 'command', 'receipts', 'mismatched_receipts'],
  ['execution_waiver', 'reason', 'execution_waivers', 'mismatched_waivers'],
]) {
  for (const auditRun of [RUN, FOREIGN_RUN]) {
    test('adoption refuses ' + table + ' already assigned to ' + auditRun, t => {
      const f = fixture(t), id = f.open()
      f.claim(id); assert.equal(f.verify(id).verified, true); f.submit(id)
      assert.equal(f.accept(id, null, { waiver_reason: 'manual audit history' }).execution_verified, false)
      f.store.handle.prepare('UPDATE ' + table + ' SET run_id = ?, ' + column + ' = ? WHERE task_id = ?')
        .run(auditRun, 'FOREIGN_AUDIT_SECRET', id)
      const detail = f.store.board(id)
      assert.deepEqual(detail[detailKey], [])
      assert.equal(detail.scope_integrity[0]?.[mismatchKey], 1)
      assert.doesNotMatch(JSON.stringify(detail), /FOREIGN_AUDIT_SECRET/)
      const before = rows(f.store), migration = structuredClone(f.store.migration)
      const summary = f.store.unassignedSummary()
      assert.throws(() => f.store.adoptUnassigned(RUN), error => {
        assert.equal(error.code, 'E_STORE_INTEGRITY')
        assert.doesNotMatch(error.message + (error.hint ?? ''), /FOREIGN_AUDIT_SECRET/)
        return true
      })
      assert.deepEqual(rows(f.store), before)
      assert.deepEqual(f.store.migration, migration)
      assert.deepEqual(f.store.unassignedSummary(), summary)
    })
  }
}
