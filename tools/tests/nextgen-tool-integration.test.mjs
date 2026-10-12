import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { apply as applyTools } from '../../lib/tools/index.js'
import { TaskforceGovernor } from '../../lib/governor/index.js'
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
  async function callRaw(name, args, agent = lead) {
    const definition = definitions.find(d => d.name === name)
    assert.ok(definition, 'missing next-generation model capability: ' + name)
    return definition.execute(args, { agent, token: {}, rootCallId: 'nextgen-tool-call-' + (++callSequence), signal: new AbortController().signal })
  }
  const call = async (...args) => JSON.parse(await callRaw(...args))
  return { store, cwd, lead, worker, foreign, reviewer, definitions, call, callRaw }
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

test('governor bind rechecks workflow dependencies after a durable reservation', async t => {
  const f = fixture(t)
  const upstream = await f.call('task_open', { title: 'upstream diagnostic decision' })
  assert.equal(upstream.ok, true)
  assert.equal((await f.call('task_submit', { task_id: upstream.task_id })).ok, true)
  assert.equal((await f.call('task_accept', { task_id: upstream.task_id, waiver_reason: 'explicit diagnostic prerequisite' })).ok, true)
  const created = await f.call('task_workflow_create', coding({ dependencies: [upstream.task_id] }))
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal((await f.call('task_workflow_submit', { task_id: created.task_id, action: 'approve_plan',
    expected_version: created.row_version, request_key: 'approve' })).ok, true)
  assert.equal((await f.call('task_claim', { task_id: created.task_id, child_id: CHILD }, f.worker)).ok, true)
  const governor = new TaskforceGovernor(f.store)
  const authority = { role: 'lead', sessionId: RUN }
  const admission = governor.reserve({ operation_key: 'reserve-workflow', task_id: created.task_id,
    generation: 0, mode: 'write', kind: 'new', resources: ['source.js'] }, RUN, authority)
  assert.equal((await f.call('task_fact', { task_id: upstream.task_id, kind: 'blocker',
    statement: 'late upstream defect invalidates admission', confidence: 'CONFIRMED' }, f.worker)).ok, true)
  assert.throws(() => governor.bind({ reservation_id: admission.reservation_id,
    generation: admission.generation, session_id: CHILD }, RUN, authority), { code: 'E_WORKFLOW_DEPENDENCY' })
  assert.equal(governor.snapshot(RUN).active_total, 1)
  const row = f.store.handle.prepare('SELECT state,session_id FROM governor_reservation WHERE reservation_id=?').get(admission.reservation_id)
  assert.equal(row.state, 'reserved')
  assert.equal(row.session_id, null)
})

test('model root can revise prerequisites after returning an unapproved plan', async t => {
  const f = fixture(t)
  const prerequisite = await f.call('task_open', { title: 'missing prerequisite' })
  const created = await f.call('task_workflow_create', coding())
  assert.equal(created.ok, true, JSON.stringify(created))
  const returned = await f.call('task_reject', { task_id: created.task_id, reason: 'include prerequisite',
    expected_version: created.row_version, request_key: 'return-unapproved' })
  assert.equal(returned.ok, true, JSON.stringify(returned))
  const state = await f.call('task_workflow_state', { task_id: created.task_id })
  assert.equal(state.stage, 'plan')
  const input = { task_id: created.task_id, action: 'set_dependencies', prerequisite_task_ids: [prerequisite.task_id],
    expected_version: state.row_version, request_key: 'revise-prerequisites' }
  const denied = await f.call('task_workflow_submit', { ...input, isRoot: true, actor: RUN }, f.worker)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'E_NOT_LEAD')
  const changed = await f.call('task_workflow_submit', input)
  assert.equal(changed.ok, true, JSON.stringify(changed))
  const revised = await f.call('task_workflow_state', { task_id: created.task_id })
  assert.deepEqual(revised.dependencies, [prerequisite.task_id])
  assert.equal(revised.row_version, state.row_version + 1)
  assert.equal((await f.call('task_workflow_submit', { task_id: created.task_id, action: 'approve_plan',
    expected_version: revised.row_version, request_key: 'approve-revised' })).ok, true)
  const approved = await f.call('task_workflow_state', { task_id: created.task_id })
  const frozen = await f.call('task_workflow_submit', { ...input, prerequisite_task_ids: [],
    expected_version: approved.row_version, request_key: 'remove-active-prerequisite' })
  assert.equal(frozen.ok, false)
  assert.equal(frozen.code, 'E_WORKFLOW_STAGE')
  assert.deepEqual((await f.call('task_workflow_state', { task_id: created.task_id })).dependencies, [prerequisite.task_id])
})

test('workflow context tool advertises an optional Boolean and forwards only host-scoped arguments', async t => {
  const f = fixture(t), spec = f.definitions.find(d => d.name === 'task_workflow_state').parameters
  assert.equal(spec.properties.include_context?.type, 'boolean')
  assert.equal(spec.required.includes('include_context'), false)
  assert.deepEqual(Object.keys(spec.properties).sort(), ['include_context', 'task_id'])
  const input = coding(), created = await f.call('task_workflow_create', input)
  assert.equal(created.ok, true)
  const args = { task_id: created.task_id }, compact = await f.call('task_workflow_state', args)
  assert.equal(Object.hasOwn(compact, 'context'), false)
  assert.deepEqual(await f.call('task_workflow_state', { ...args, include_context: false }), compact)
  const db = f.store.open(), changes = db.prepare('SELECT total_changes() AS n').get().n
  for (const include_context of [null, 0, 1, '', 'true', 'false', [], {}]) {
    const invalid = await f.call('task_workflow_state', { ...args, include_context })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'E_WORKFLOW_INPUT')
  }
  const expanded = await f.call('task_workflow_state', { ...args, include_context: true,
    run_id: 'forged', actor: { sessionId: 'forged', isRoot: true } }, f.worker)
  assert.equal(expanded.ok, true)
  assert.deepEqual(expanded.context, { plan: { objective: input.objective, scope: input.scope,
    non_goals: input.non_goals, deliverables: input.deliverables }, latest_review: null })
  const foreign = await f.call('task_workflow_state', { ...args, include_context: true, run_id: RUN,
    actor: { sessionId: RUN, isRoot: true } }, f.foreign)
  assert.equal(foreign.ok, false)
  assert.equal(foreign.code, 'E_CROSS_RUN')
  assert.equal(JSON.stringify(foreign).includes(input.objective), false)
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
})

test('workflow context tool retrieves failed findings and keeps its actual success envelope within 64KiB', async t => {
  const f = fixture(t)
  const input = coding({ objective: '界'.repeat(4000), scope: Array(2).fill('界'.repeat(512)), non_goals: [], deliverables: [] })
  const findings = Array(5).fill('界'.repeat(1024))
  const created = await f.call('task_workflow_create', input)
  assert.equal(created.ok, true, JSON.stringify(created))
  const id = created.task_id, state = () => f.call('task_workflow_state', { task_id: id })
  const action = async (name, extra = {}, actor = f.lead) => f.call('task_workflow_submit', {
    task_id: id, action: name, expected_version: (await state()).row_version, request_key: name, ...extra }, actor)
  assert.equal((await action('approve_plan')).ok, true)
  assert.equal((await f.call('task_claim', { task_id: id, child_id: CHILD }, f.worker)).ok, true)
  assert.equal((await f.call('task_verify', { task_id: id, command: 'node source.js' }, f.worker)).ok, true)
  const artifact = await action('record_artifact', {}, f.worker)
  assert.equal(artifact.ok, true)
  const review = await action('record_review', { revision_id: artifact.revision_id,
    requirements_result: 'fail', quality_result: 'unverified', findings }, f.reviewer)
  assert.equal(review.ok, true)
  const db = f.store.open(), longId = 's' + '\u0000'.repeat(199)
  db.prepare('UPDATE workflow_artifact SET producer_session=? WHERE task_id=?').run(longId, id)
  db.prepare('UPDATE workflow_review SET reviewer_session=? WHERE task_id=?').run(longId, id)
  for (let index = 0; index < 19; index++) {
    db.prepare('INSERT INTO workflow_artifact(task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at) SELECT task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at FROM workflow_artifact WHERE id=?').run(artifact.revision_id)
    db.prepare('INSERT INTO workflow_review(task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) SELECT task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at FROM workflow_review WHERE id=?').run(review.review_id)
  }
  const changes = db.prepare('SELECT total_changes() AS n').get().n
  const raw = await f.callRaw('task_workflow_state', { task_id: id, include_context: true }, f.worker)
  const result = JSON.parse(raw)
  assert.equal(result.ok, true, raw)
  assert.ok(Buffer.byteLength(raw) <= 65536, 'serialized tool envelope exceeds byte budget')
  assert.equal(result.history_truncated, true)
  assert.deepEqual(result.context.plan, { objective: input.objective, scope: input.scope, non_goals: [], deliverables: [] })
  assert.deepEqual(result.context.latest_review.findings, findings)
  assert.equal(result.context.latest_review.is_current, true)
  assert.equal(result.context.latest_review.requirements_result, 'fail')
  assert.equal(result.context.latest_review.quality_result, 'unverified')
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
  t.diagnostic('actual serialized tool response bytes=' + Buffer.byteLength(raw))
  // Tune only bounded metadata strings to an exact wire boundary. Excluding
  // ok:true from the budget would allow the subsequent one-byte overflow.
  db.prepare('UPDATE workflow_artifact SET producer_session=? WHERE task_id=?').run('s', id)
  db.prepare('UPDATE workflow_review SET reviewer_session=? WHERE task_id=?').run('s', id)
  const smallRaw = await f.callRaw('task_workflow_state', { task_id: id, include_context: true })
  assert.equal(JSON.parse(smallRaw).history_truncated, false)
  let remaining = 65536 - Buffer.byteLength(smallRaw)
  const latestId = result.context.latest_review.id
  const candidates = [
    ...db.prepare('SELECT id FROM workflow_artifact WHERE task_id=? ORDER BY id').all(id).map(row => ({ ...row, table: 'workflow_artifact', column: 'producer_session' })),
    ...db.prepare('SELECT id FROM workflow_review WHERE task_id=? AND id!=? ORDER BY id').all(id, latestId).map(row => ({ ...row, table: 'workflow_review', column: 'reviewer_session' })),
  ]
  for (const row of candidates) {
    if (remaining === 0) break
    const addedBytes = Math.min(1164, remaining)
    const identity = 's' + '\u0000'.repeat(Math.floor(addedBytes / 6)) + 'a'.repeat(addedBytes % 6)
    assert.ok(identity.length <= 200)
    db.prepare('UPDATE ' + row.table + ' SET ' + row.column + '=? WHERE id=?').run(identity, row.id)
    remaining -= addedBytes
  }
  assert.equal(remaining, 0)
  const exactRaw = await f.callRaw('task_workflow_state', { task_id: id, include_context: true })
  assert.equal(Buffer.byteLength(exactRaw), 65536)
  assert.equal(JSON.parse(exactRaw).history_truncated, false)
  const untouched = candidates.at(-1)
  assert.equal(db.prepare('SELECT ' + untouched.column + ' AS identity FROM ' + untouched.table + ' WHERE id=?').get(untouched.id).identity, 's')
  db.prepare('UPDATE ' + untouched.table + ' SET ' + untouched.column + '=? WHERE id=?').run('sa', untouched.id)
  const overflowChanges = db.prepare('SELECT total_changes() AS n').get().n
  const boundedRaw = await f.callRaw('task_workflow_state', { task_id: id, include_context: true })
  assert.ok(Buffer.byteLength(boundedRaw) <= 65536)
  assert.equal(JSON.parse(boundedRaw).history_truncated, true)
  assert.deepEqual(JSON.parse(boundedRaw).context, JSON.parse(exactRaw).context)
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, overflowChanges)
  t.diagnostic('exact envelope bytes=65536; one-byte overflow pruned to ' + Buffer.byteLength(boundedRaw))
  db.prepare('UPDATE workflow SET plan=? WHERE task_id=?').run('{PRIVATE_BAD_CONTEXT', id)
  const invalid = await f.call('task_workflow_state', { task_id: id, include_context: true })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'E_STORE_INTEGRITY')
  assert.equal(JSON.stringify(invalid).includes('PRIVATE_BAD_CONTEXT'), false)
})
