import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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
  const agents = new Map([lead, worker, foreign].map(a => [a.id, a]))
  const definitions = []
  // Real plugin/store; only the native registry is a boundary fixture.
  applyTools({ logger: { warn() {} },
    get(name) {
      if (name === 'taskforceStore') return store
      if (name === 'agents') return { get: id => agents.get(id) }
    },
    tools: { register(definition) { definitions.push(definition); return () => {} } },
  })
  async function call(name, args, agent = lead) {
    const definition = definitions.find(d => d.name === name)
    assert.ok(definition, 'missing next-generation model capability: ' + name)
    return JSON.parse(await definition.execute(args, { agent, signal: new AbortController().signal }))
  }
  return { store, cwd, lead, worker, foreign, call }
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
