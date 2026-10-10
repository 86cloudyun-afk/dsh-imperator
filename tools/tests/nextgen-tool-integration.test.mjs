import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { apply as applyTools } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'

const RUN = 'nextgen-tool-root'
const CHILD = 'nextgen-tool-worker'
function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'imperator-nextgen-tools-')))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'source.js'), 'process.exitCode = 0\n')
  const store = tempStore(t)
  const lead = { id: RUN, session: { header: { id: RUN, cwd } } }
  const worker = { id: CHILD, session: { header: { id: CHILD, cwd, parentSession: RUN, origin: 'subagent', delegationDepth: 1 } } }
  const foreign = { id: 'nextgen-foreign-root', session: { header: { id: 'nextgen-foreign-root', cwd } } }
  const reviewer = { id: 'nextgen-tool-reviewer', session: { header: { id: 'nextgen-tool-reviewer', cwd, parentSession: RUN, origin: 'subagent', delegationDepth: 1 } } }
  const agents = new Map([lead, worker, foreign, reviewer].map(a => [a.id, a]))
  worker.ctx = { tools: { async execute(input) {
    assert.equal(input.agent, worker)
    assert.equal(input.name, 'bash')
    assert.equal(input.arguments.workdir, cwd)
    assert.equal(input.arguments.command, 'node source.js')
    const actual = spawnSync(process.execPath, ['source.js'], { cwd, encoding: 'utf8' })
    return { isError: false, content: [], value: { kind: 'foreground', exitCode: actual.status,
      signal: actual.signal, timedOut: false, aborted: false, timeoutMs: 60000,
      stdout: { text: actual.stdout, truncated: false }, stderr: { text: actual.stderr, truncated: false } } }
  } } }
  const definitions = []
  // Real plugin/store; only the native registry is a boundary fixture.
  applyTools({ logger: { warn() {} },
    get(name) {
      if (name === 'taskforceStore') return store
      if (name === 'agents') return { get: id => agents.get(id) }
    },
    tools: { register(definition) { definitions.push(definition); return () => {} } },
  })
  let callSequence = 0
  async function call(name, args, agent = lead) {
    const definition = definitions.find(d => d.name === name)
    assert.ok(definition, 'missing next-generation model capability: ' + name)
    return JSON.parse(await definition.execute(args, { agent, token: {}, rootCallId: 'nextgen-tool-call-' + (++callSequence), signal: new AbortController().signal }))
  }
  return { store, cwd, lead, worker, foreign, reviewer, call }
}
function coding(extra = {}) {
  return { title: 'bounded coding workflow', objective: 'verify source', scope: ['source.js'],
    deliverables: ['source.js'], non_goals: ['deployment'], dependencies: [],
    verification_files: ['source.js'], verification_command: 'node source.js',
    request_key: 'create-coding', ...extra }
}

test('workflow model create derives scope and execution workspace from the actual root', async t => {
  const f = fixture(t)
  const created = await f.call('task_workflow_create', coding({
    run_id: 'forged-run', actor: { isRoot: true, sessionId: 'forged-root' },
    cwd: '/forged-workspace', verification_cwd: '/forged-workspace', evidence_policy: 'legacy',
  }))
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.ok(Number.isSafeInteger(created.task_id))
  const task = f.store.boardPage({ task_id: created.task_id }, RUN).task
  assert.equal(task.run_id, RUN)
  assert.equal(task.evidence_policy, 'execution')
  assert.equal(task.verification_cwd, f.cwd)
  assert.equal(task.verification_command, 'node source.js')
  assert.equal(f.store.stats('forged-run').tasks.total, 0)
  const ordinary = await f.call('task_open', { title: 'existing legacy contract' })
  assert.equal(ordinary.ok, true)
  assert.equal(f.store.boardPage({ task_id: ordinary.task_id }, RUN).task.evidence_policy, 'legacy')
})

test('worker cannot create a coding workflow by forging lead or run fields', async t => {
  const f = fixture(t)
  const result = await f.call('task_workflow_create', coding({
    actor: 'lead', isRoot: true, run_id: RUN, sessionId: RUN,
  }), f.worker)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_NOT_LEAD', JSON.stringify(result))
  assert.equal(f.store.stats(RUN).tasks.total, 0)
})

test('model stage approval forwards the version fence and real worker claim obeys it', async t => {
  const f = fixture(t)
  const created = await f.call('task_workflow_create', coding())
  assert.equal(created.ok, true, JSON.stringify(created))
  const early = await f.call('task_claim', { task_id: created.task_id, child_id: CHILD }, f.worker)
  assert.equal(early.ok, false)
  assert.match(early.code, /^E_WORKFLOW_/)
  const version = f.store.handle.prepare('SELECT row_version FROM workflow WHERE task_id=?').get(created.task_id).row_version
  const forged = await f.call('task_workflow_submit', {
    task_id: created.task_id, action: 'approve_plan', expected_version: version, request_key: 'approve-forged', isRoot: true, actor: RUN,
  }, f.worker)
  assert.equal(forged.ok, false)
  const approved = await f.call('task_workflow_submit', {
    task_id: created.task_id, action: 'approve_plan', expected_version: version, request_key: 'approve-real',
  })
  assert.equal(approved.ok, true, JSON.stringify(approved))
  const claimed = await f.call('task_claim', { task_id: created.task_id, child_id: CHILD }, f.worker)
  assert.equal(claimed.ok, true, JSON.stringify(claimed))
  assert.equal(f.store.boardPage({ task_id: created.task_id }, RUN).task.owner_session, CHILD)
})

test('workflow state cannot disclose another root run plan or task content', async t => {
  const f = fixture(t)
  const sentinel = 'FOREIGN_WORKFLOW_SECRET'
  const created = await f.call('task_workflow_create', coding({ title: sentinel, objective: sentinel }))
  assert.equal(created.ok, true, JSON.stringify(created))
  const result = await f.call('task_workflow_state', { task_id: created.task_id, run_id: RUN, actor: RUN }, f.foreign)
  assert.equal(result.ok, false)
  assert.ok(['E_CROSS_RUN', 'E_WORKFLOW_SCOPE'].includes(result.code), JSON.stringify(result))
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN_WORKFLOW_SECRET/)
})

test('model workflow completes through real execution, independent review and fenced lead acceptance', async t => {
  const f = fixture(t)
  const created = await f.call('task_workflow_create', coding())
  assert.equal(created.ok, true, JSON.stringify(created))
  const id = created.task_id
  const state = () => f.call('task_workflow_state', { task_id: id })
  const action = async (name, extra, actor = f.lead) => f.call('task_workflow_submit', {
    task_id: id, action: name, expected_version: (await state()).row_version, request_key: name, ...extra }, actor)
  assert.equal((await action('approve_plan')).ok, true)
  assert.equal((await f.call('task_claim', { task_id: id, child_id: CHILD }, f.worker)).ok, true)
  const verified = await f.call('task_verify', { task_id: id, command: 'node source.js' }, f.worker)
  assert.equal(verified.ok, true, JSON.stringify(verified))
  assert.equal(verified.status, 'completed')
  const artifact = await action('record_artifact', {}, f.worker)
  assert.equal(artifact.ok, true, JSON.stringify(artifact))
  const selfReview = await action('record_review', { request_key: 'self-review', revision_id: artifact.revision_id,
    requirements_result: 'pass', quality_result: 'pass', findings: [], actor: 'reviewer', isRoot: true }, f.worker)
  assert.equal(selfReview.ok, false)
  assert.equal(selfReview.code, 'E_WORKFLOW_REVIEW')
  const reviewed = await action('record_review', { revision_id: artifact.revision_id,
    requirements_result: 'pass', quality_result: 'pass', findings: [] }, f.reviewer)
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed))
  assert.equal((await f.call('task_submit', { task_id: id }, f.worker)).ok, true)
  const version = (await state()).row_version
  const stale = await f.call('task_accept', { task_id: id, expected_version: version - 1, request_key: 'accept' })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'E_WORKFLOW_VERSION')
  const acceptArgs = { task_id: id, expected_version: version, request_key: 'accept' }
  const accepted = await f.call('task_accept', acceptArgs)
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  assert.equal(accepted.execution_verified, true)
  assert.equal((await state()).stage, 'completed')
  assert.deepEqual(await f.call('task_accept', acceptArgs), accepted)
})

test('model workflow action whitelist and rework preserve durable generation fences', async t => {
  const f = fixture(t)
  const created = await f.call('task_workflow_create', coding())
  assert.equal(created.ok, true, JSON.stringify(created))
  const id = created.task_id
  const before = await f.call('task_workflow_state', { task_id: id })
  const invalid = await f.call('task_workflow_submit', { task_id: id, action: 'create',
    expected_version: before.row_version, request_key: 'invalid', title: 'arbitrary method' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'E_WORKFLOW_INPUT')
  assert.deepEqual(await f.call('task_workflow_state', { task_id: id }), before)
  const rejected = await f.call('task_reject', { task_id: id, reason: 'revise approved scope',
    expected_version: before.row_version, request_key: 'return' })
  assert.equal(rejected.ok, true, JSON.stringify(rejected))
  const after = await f.call('task_workflow_state', { task_id: id })
  assert.equal(after.stage, 'plan')
  assert.equal(after.evidence_generation, before.evidence_generation + 1)
  assert.equal(after.rework_count, 1)
  assert.equal(after.row_version, before.row_version + 1)
  assert.deepEqual(await f.call('task_reject', { task_id: id, reason: 'revise approved scope',
    expected_version: before.row_version, request_key: 'return' }), rejected)
})
