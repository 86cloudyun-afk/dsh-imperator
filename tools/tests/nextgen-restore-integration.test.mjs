import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TaskforceStore } from '../../lib/store/index.js'
import { TaskforceWorkflow } from '../../lib/workflow/index.js'
import { TaskforceScheduler } from '../../lib/scheduler/index.js'
import { TaskforceGovernor } from '../../lib/governor/index.js'
import { runTaskVerification } from '../../lib/tools/verification.js'
import { backup, restore, doctor, preflight } from '../../lib/operations/index.js'

const run = ' restore-run '
const lead = { sessionId: run, isRoot: true }
const worker = { sessionId: ' restore-worker ', isRoot: false }
const reviewer = { sessionId: ' restore-reviewer ', isRoot: false }
const schedulerLead = { role: 'lead', sessionId: run }
const schedulerWorker = { role: 'worker', sessionId: worker.sessionId }
const command = 'node --check source.js'

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'imperator-restore-flow-')))
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'source.js'), 'export const answer = 42\n')
  const stores = []
  const open = root => {
    const store = new TaskforceStore(root)
    stores.push(store)
    return store
  }
  t.after(() => {
    for (const store of stores) store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const store = open(join(directory, 'live'))
  return { directory, workspace, store, open }
}

function workflow(store, workspace, prefix) {
  const flow = new TaskforceWorkflow(store)
  let sequence = 0, executions = 0
  const key = () => prefix + '-' + (++sequence)
  const state = id => flow.state({ task_id: id }, run)
  const change = (method, id, extra = {}, actor = lead) => flow[method]({
    task_id: id, expected_version: state(id).row_version, request_key: key(), ...extra,
  }, run, actor)
  const create = (extra = {}) => {
    const id = flow.create({
      title: 'restore reviewed code', request_key: key(),
      plan: { objective: 'ship checked source', scope: ['source.js'], non_goals: [], deliverables: ['checked source'] },
      verification_files: ['source.js'], verification_command: command, ...extra,
    }, run, { ...lead, cwd: workspace }).task_id
    change('approvePlan', id)
    store.claimTask({ task_id: id, child_id: 'worker' }, run, worker, worker.sessionId)
    return id
  }
  const verify = async id => {
    const agent = { session: { header: { id: worker.sessionId } } }
    const token = {}, signal = new AbortController().signal
    const result = await runTaskVerification({
      store, identity: { ...worker, runId: run }, agent, task_id: id, command,
      exec: { agent, token, rootCallId: key(), signal },
      // The injected native boundary executes a real subprocess, never a fabricated success.
      execute: async call => {
        executions++
        assert.equal(call.agent, agent)
        assert.equal(call.parent, token)
        assert.equal(call.signal, signal)
        assert.equal(call.arguments.command, command)
        assert.equal(call.arguments.workdir, workspace)
        assert.equal(call.arguments.run_in_background, false)
        const child = spawnSync(process.execPath, ['--check', 'source.js'], {
          cwd: call.arguments.workdir, encoding: 'utf8', timeout: call.arguments.timeoutMs,
        })
        if (child.error) throw child.error
        return { isError: false, content: [], value: {
          kind: 'foreground', exitCode: child.status, signal: child.signal,
          timedOut: false, aborted: false, timeoutMs: call.arguments.timeoutMs,
          stdout: { text: child.stdout, truncated: false },
          stderr: { text: child.stderr, truncated: false },
        } }
      },
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.verified, true)
    return result
  }
  const artifact = id => change('recordArtifact', id, {}, worker)
  const review = (id, actor = reviewer) => change('recordReview', id, {
    revision_id: state(id).revision_id, requirements_result: 'pass', quality_result: 'pass', findings: [],
  }, actor)
  const accept = id => store.acceptTask({
    task_id: id, expected_version: state(id).row_version, request_key: key(),
  }, run, lead)
  return { state, create, verify, artifact, review, accept, change, executions: () => executions }
}

function files(root) {
  const result = {}
  const visit = relative => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) visit(path)
      else result[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex')
    }
  }
  visit('')
  return result
}

// Removing receipt-root validation or decoupling acceptance from the reviewed revision breaks this test.
test('restored lead acceptance requires current-root execution and a new independently reviewed artifact', async t => {
  const f = fixture(t), original = workflow(f.store, f.workspace, 'original')
  const id = original.create()
  const oldReceipt = await original.verify(id)
  const oldArtifact = original.artifact(id)
  original.review(id)
  f.store.submitTask({ task_id: id }, run, worker)
  const before = original.state(id)
  assert.equal(before.stage, 'lead_acceptance')
  assert.equal(before.task_status, 'submitted')
  assert.equal(before.reviews[0].reviewer_session, reviewer.sessionId)
  assert.equal(oldArtifact.receipt_id, oldReceipt.receipt_id)

  const archive = join(f.directory, 'backup'), root = join(f.directory, 'restored')
  assert.equal((await backup({ root: f.store.root, out: archive })).ok, true)
  const restored = await restore({ backup: archive, out: root })
  assert.equal(restored.ok, true)
  assert.equal(restored.reverification_required, true)
  f.store.close()
  rmSync(f.store.root, { recursive: true })
  const store = f.open(root), resumed = workflow(store, f.workspace, 'resumed')
  assert.deepEqual(resumed.state(id), before)
  assert.equal(store.taskOf(id, run).task.owner_session, worker.sessionId)
  assert.equal((await doctor({ root })).counts.invalid_logs, 0)

  assert.throws(() => resumed.accept(id), error => error.code === 'E_WORKFLOW_EVIDENCE' && /return_for_rework/.test(error.hint))
  assert.deepEqual(resumed.state(id), before, 'refused acceptance must preserve reviewed audit')
  const receiptCount = store.open().prepare('SELECT COUNT(*) AS n FROM execution_receipt WHERE task_id=?').get(id).n
  await assert.rejects(resumed.verify(id), { code: 'E_WORKFLOW_STAGE' })
  assert.equal(resumed.executions(), 0)
  assert.equal(store.open().prepare('SELECT COUNT(*) AS n FROM execution_receipt WHERE task_id=?').get(id).n, receiptCount)
  assert.deepEqual(resumed.state(id), before)
  resumed.change('returnForRework', id, { reason: 'restore requires current-root verification' })
  store.claimTask({ task_id: id, child_id: 'worker' }, run, worker, worker.sessionId)
  const fresh = await resumed.verify(id)
  assert.notEqual(fresh.receipt_id, oldReceipt.receipt_id)
  assert.equal(resumed.state(id).task_status, 'claimed')
  store.submitTask({ task_id: id }, run, worker)
  assert.throws(() => resumed.accept(id), { code: 'E_WORKFLOW_EVIDENCE' },
    'fresh execution alone cannot reuse the historical artifact and review')
  const artifact = resumed.artifact(id)
  assert.notEqual(artifact.revision_id, oldArtifact.revision_id)
  assert.equal(artifact.receipt_id, fresh.receipt_id)
  assert.throws(() => resumed.accept(id), { code: 'E_WORKFLOW_EVIDENCE' })
  assert.throws(() => resumed.review(id, worker), { code: 'E_WORKFLOW_REVIEW' })
  resumed.review(id)
  assert.equal(resumed.accept(id).execution_verified, true)
  const completed = resumed.state(id)
  assert.equal(completed.stage, 'completed')
  assert.equal(completed.task_status, 'accepted')
  assert.equal(completed.evidence_generation, before.evidence_generation + 1)
  assert.equal(completed.rework_count, before.rework_count + 1)
  assert.equal(completed.artifacts.length, 2)
  assert.equal(completed.reviews.length, 2)
  assert.equal(store.taskOf(id, run).task.owner_session, worker.sessionId)

  const receipts = store.board({ task_id: id }, run).receipts
  const historical = receipts.find(row => row.receipt_id === oldReceipt.receipt_id)
  const current = receipts.find(row => row.receipt_id === fresh.receipt_id)
  assert.equal(historical.logs.stdout.path, join(f.store.root, 'receipts', oldReceipt.receipt_id + '.stdout.log'))
  assert.equal(current.logs.stdout.path, join(root, 'receipts', fresh.receipt_id + '.stdout.log'))
  assert.equal((await backup({ root, out: join(f.directory, 'mixed-provenance-backup') })).ok, true)
})

// Migrating the live database in doctor/preflight, dropping extension rows, or settling unknown work breaks this test.
test('doctor and disposable preflight retain workflow review, pending control, and unknown scheduler ownership', async t => {
  const f = fixture(t), flow = workflow(f.store, f.workspace, 'preflight')
  const id = flow.create()
  await flow.verify(id)
  flow.artifact(id)
  flow.review(id)
  const scheduler = new TaskforceScheduler(f.store)
  scheduler.enqueue({ request_key: 'queue', task_id: id, generation: 0,
    mode: 'write', kind: 'reuse', resources: ['repository'] }, run, schedulerWorker)
  const admitted = scheduler.admitNext({ request_key: 'admit' }, run, schedulerLead)
  assert.equal(admitted.status, 'admitted')
  const ref = { request_id: admitted.request.request_id, generation: admitted.request.generation }
  scheduler.bind({ ...ref, session_id: worker.sessionId }, run, schedulerWorker)
  scheduler.markUnknown({ ...ref, reason: 'DELIVERY_UNKNOWN' }, run, schedulerWorker)
  f.store.recovery.beginControl({ request_key: 'pending-stop', action: 'stop',
    target_id: worker.sessionId, task_id: id, payload_hash: 'a'.repeat(64),
  }, { ...lead, runId: run })
  const before = {
    workflow: flow.state(id),
    recovery: f.store.recovery.inspect({}, run),
    scheduler: scheduler.state({}, run, schedulerLead),
    governor: new TaskforceGovernor(f.store).snapshot(run),
  }
  assert.equal(before.recovery.operations[0].status, 'pending')
  assert.equal(before.scheduler.requests[0].state, 'unknown')
  assert.equal(before.governor.holds.length, 1)
  f.store.close()

  // Model an older base-store schema with already-populated extension tables.
  // The missing nullable column is additive migration input, not a changed business row.
  const db = new DatabaseSync(f.store.dbPath)
  try { db.exec('ALTER TABLE fact DROP COLUMN actor_session') } finally { db.close() }
  const snapshot = files(f.store.root)
  const diagnosed = await doctor({ root: f.store.root })
  assert.equal(diagnosed.ok, false)
  assert.ok(diagnosed.checks.some(check => check.code === 'SCHEMA_UPGRADE_REQUIRED'))
  assert.deepEqual(files(f.store.root), snapshot, 'doctor is read-only even with live extension history')
  const checked = await preflight({ root: f.store.root })
  assert.equal(checked.ok, true)
  assert.equal(checked.migration_required, true)
  assert.equal(checked.rows_preserved, true)
  assert.deepEqual(files(f.store.root), snapshot, 'preflight migration must stay in its disposable copy')

  const reopened = f.open(f.store.root)
  assert.deepEqual(new TaskforceWorkflow(reopened).state({ task_id: id }, run), before.workflow)
  assert.deepEqual(reopened.recovery.inspect({}, run), before.recovery)
  assert.deepEqual(new TaskforceScheduler(reopened).state({}, run, schedulerLead), before.scheduler)
  assert.deepEqual(new TaskforceGovernor(reopened).snapshot(run), before.governor)
  assert.equal((await doctor({ root: reopened.root })).ok, true)
})

test('restored frozen delivery with zero rework budget refuses revalidation without receipt or execution', async t => {
  const f = fixture(t), original = workflow(f.store, f.workspace, 'zero-original')
  const id = original.create({ max_reworks: 0 })
  await original.verify(id); original.artifact(id); original.review(id)
  f.store.submitTask({ task_id: id }, run, worker)
  const archive = join(f.directory, 'zero-backup'), root = join(f.directory, 'zero-restored')
  assert.equal((await backup({ root: f.store.root, out: archive })).ok, true)
  assert.equal((await restore({ backup: archive, out: root })).ok, true)
  const store = f.open(root), resumed = workflow(store, f.workspace, 'zero-resumed')
  const before = resumed.state(id), receipts = store.open().prepare('SELECT * FROM execution_receipt WHERE task_id=?').all(id)
  assert.throws(() => resumed.accept(id), error => error.code === 'E_WORKFLOW_EVIDENCE' && /授权/.test(error.hint) && /task_workflow_create/.test(error.hint))
  assert.throws(() => resumed.change('returnForRework', id, { reason: 'restore revalidation' }), { code: 'E_WORKFLOW_BUDGET' })
  await assert.rejects(resumed.verify(id), { code: 'E_WORKFLOW_STAGE' })
  assert.throws(() => resumed.artifact(id), { code: 'E_WORKFLOW_STAGE' })
  assert.equal(resumed.executions(), 0)
  assert.deepEqual(resumed.state(id), before)
  assert.deepEqual(store.open().prepare('SELECT * FROM execution_receipt WHERE task_id=?').all(id), receipts)
})
