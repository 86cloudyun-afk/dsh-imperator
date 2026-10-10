import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { apply as applyTools } from '../../lib/tools/index.js'
import { STORE_CODES } from '../../lib/store/index.js'
import { tempStore } from './helpers.mjs'

/**
 * Legacy unbound tasks keep the historical submission/idempotence path.
 * Real-session authorization is covered in owner-session.test.mjs;
 * this file protects old positional callers and their display audit labels.
 */
const RUN = 'run-a'
const lead = { id: RUN, options: {}, session: { header: { id: RUN } } }
const childOf = (id) => ({
  id,
  options: {},
  session: { header: { id, origin: 'subagent', delegationDepth: 1, parentSession: RUN } },
})

function toolCaller(store) {
  const definitions = []
  applyTools({
    logger: { warn() {} },
    get(name) {
      if (name === 'taskforceStore') return store
      if (name === 'agents') return { get: (id) => (id === RUN ? lead : undefined) }
    },
    tools: { register: (definition) => definitions.push(definition) },
  })
  return async (name, args, agent = lead) =>
    JSON.parse(await definitions.find((definition) => definition.name === name).execute(args, { agent }))
}

const snapshot = (store, id) => ({
  task: store.taskOf({ task_id: id }, RUN).task,
  facts: store.handle.prepare('SELECT * FROM fact WHERE task_id = ? ORDER BY id').all(id),
  handoffs: store.handle.prepare('SELECT * FROM handoff WHERE task_id = ? ORDER BY id').all(id),
})

test('提交审计的署名反映真实调用者（owner 自己 / 主会话代交）', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)

  const ownId = store.openTask({ title: '自己交' }, RUN).task_id
  store.claimTask({ task_id: ownId, child_id: 'worker-a' }, RUN)
  const okOwn = await call('task_submit', { task_id: ownId, note: '自己交' }, childOf('worker-a'))
  assert.equal(okOwn.ok, true)
  assert.equal(okOwn.status, 'submitted')
  const ownFact = store.handle
    .prepare("SELECT * FROM fact WHERE task_id = ? AND statement = ?").get(ownId, '提交验收：自己交')
  assert.equal(ownFact.created_by, 'worker-a')

  const leadId = store.openTask({ title: '主会话代交' }, RUN).task_id
  store.claimTask({ task_id: leadId, child_id: 'worker-c' }, RUN)
  const okLead = await call('task_submit', { task_id: leadId, note: '主会话代交' }, lead)
  assert.equal(okLead.ok, true)
  assert.equal(okLead.status, 'submitted')
  const leadFact = store.handle
    .prepare("SELECT * FROM fact WHERE task_id = ? AND statement = ?").get(leadId, '提交验收：主会话代交')
  assert.equal(leadFact.created_by, 'lead', '主会话代交不得被记成原 owner 自己提交')
})

test('submitted 上的幂等重试不回退（横跨 owner / 主会话 / 非 owner 三种 caller）', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '幂等' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  assert.equal((await call('task_submit', { task_id: id }, childOf('worker-a'))).status, 'submitted')

  const before = snapshot(store, id)
  for (const [agent, label] of [[childOf('worker-a'), 'owner'], [lead, 'lead'], [childOf('worker-b'), '非 owner']]) {
    const retry = await call('task_submit', { task_id: id, note: '重复说明不得落库' }, agent)
    assert.equal(retry.ok, true, `${label} 的幂等重试仍须成功`)
    assert.equal(retry.status, 'submitted')
    assert.equal(retry.already, true)
  }
  assert.deepEqual(snapshot(store, id), before, '幂等重试不得产生任何写入')
})

test('open（尚无认领者）任务仍可被任何同 run 调用者提交 —— 刻意的宽路径不回退', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '未认领就交' }, RUN).task_id
  const submitted = await call('task_submit', { task_id: id }, childOf('worker-z'))
  assert.equal(submitted.ok, true)
  assert.equal(submitted.status, 'submitted')
  assert.ok(
    submitted.warnings.some((w) => w.includes('没有认领者')),
    '既有契约：无认领者直接提交仍须给出 warning',
  )
})

test('rejected 仍须先 task_claim（E_STATUS）—— 既有语义不回退', async (t) => {
  const store = tempStore(t)
  const call = toolCaller(store)
  const id = store.openTask({ title: '被打回' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  store.recordFact({ task_id: id, kind: 'fact', statement: '证据', confidence: 'CONFIRMED' }, RUN)
  store.submitTask({ task_id: id }, RUN)
  store.rejectTask({ task_id: id, reason: '缺行号' }, RUN, 'lead')

  const denied = await call('task_submit', { task_id: id }, childOf('worker-a'))
  assert.equal(denied.ok, false)
  assert.equal(denied.code, STORE_CODES.status, 'rejected 仍走 E_STATUS（状态边界优先于 owner 权限）')
})


for (const kind of ['fact', 'decision']) test('submission time survives a later ' + kind + ' and submit aliases', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) })
  const store = tempStore(t)
  const id = store.openTask({ title: 'submission chronology' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  const blocker = kind === 'decision'
    ? store.recordFact({ task_id: id, kind: 'blocker', statement: 'waiting' }, RUN).fact_id : null
  const first = store.submitTask({ task_id: id }, RUN)
  t.mock.timers.tick(1000)
  const later = store.recordFact({ task_id: id, kind, statement: 'later activity',
    ...(blocker === null ? {} : { resolves_fact_id: blocker }) }, RUN)
  assert.notEqual(later.created_at, first.submitted_at)
  const before = snapshot(store, id)
  for (const result of [undefined, 'done', 'partial']) {
    const retry = result === undefined ? store.submitTask({ task_id: id }, RUN)
      : store.closeTask({ task_id: id, result }, RUN)
    assert.equal(retry.already, true)
    assert.equal(retry.submitted_at, first.submitted_at)
    assert.notEqual(retry.submitted_at, later.created_at)
    assert.deepEqual(snapshot(store, id), before, 'retries must remain read-only')
  }
  assert.equal(before.task.submitted_at, first.submitted_at)
  assert.equal(before.task.updated_at, later.created_at)
})

test('a fresh submission after reject and claim persists its new time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) })
  const store = tempStore(t)
  const id = store.openTask({ title: 'resubmission chronology' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  const first = store.submitTask({ task_id: id }, RUN)
  t.mock.timers.tick(1000)
  store.rejectTask({ task_id: id, reason: 'redo' }, RUN, 'lead')
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  t.mock.timers.tick(1000)
  const second = store.submitTask({ task_id: id }, RUN)
  assert.equal(second.already, false)
  assert.notEqual(second.submitted_at, first.submitted_at)
  assert.equal(store.taskOf(id, RUN).task.submitted_at, second.submitted_at)
  assert.equal(store.board({ task_id: id }, RUN).task.submitted_at, second.submitted_at)
})

test('old-schema submitted rows migrate with an unknown nullable submission time', t => {
  const store = tempStore(t)
  const legacy = new DatabaseSync(store.dbPath)
  legacy.exec("CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT, status TEXT NOT NULL, owner TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
  legacy.prepare('INSERT INTO task(title,status,created_at,updated_at) VALUES(?,?,?,?)')
    .run('legacy submission', 'submitted', '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z')
  legacy.close()
  store.open()
  const retry = store.submitTask({ task_id: 1 })
  assert.equal(retry.already, true)
  assert.equal(retry.submitted_at, null, 'last activity cannot establish legacy submission time')
  assert.equal(store.taskOf(1).task.submitted_at, null)
  const column = store.handle.prepare('PRAGMA table_info(task)').all().find(row => row.name === 'submitted_at')
  assert.equal(column.type, 'TEXT')
  assert.equal(column.notnull, 0)
})


test('legacy unbound non-owner submission notes identify the real caller', async t => {
  const store = tempStore(t), call = toolCaller(store)
  const id = store.openTask({ title: 'non-owner submission audit' }, RUN).task_id
  store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
  const result = await call('task_submit', { task_id: id, note: 'substitute delivery' }, childOf('worker-b'))
  assert.equal(result.ok, true)
  assert.equal(result.status, 'submitted')
  const audit = store.handle.prepare('SELECT * FROM fact WHERE task_id=? AND statement=?').get(id, '提交验收：substitute delivery')
  assert.ok(audit)
  assert.equal(audit.kind, 'decision')
  assert.equal(audit.created_by, 'worker-b')
  assert.equal(audit.actor_session, 'worker-b')
  assert.equal(store.taskOf(id, RUN).task.owner, 'worker-a')
})

test('both close submission aliases preserve owner, non-owner and root audit identity', async t => {
  const store = tempStore(t), call = toolCaller(store)
  for (const result of ['done', 'partial']) {
    for (const [agent, display, session] of [
      [childOf('worker-a'), 'worker-a', 'worker-a'],
      [childOf('worker-b'), 'worker-b', 'worker-b'],
      [lead, 'lead', RUN],
    ]) {
      const id = store.openTask({ title: 'alias audit ' + result + '/' + display }, RUN).task_id
      store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
      const delivered = await call('task_close', { task_id: id, result, note: 'alias delivery' }, agent)
      assert.equal(delivered.ok, true)
      assert.equal(delivered.status, 'submitted')
      assert.equal(delivered.alias_of, 'submitTask')
      const audit = store.handle.prepare('SELECT * FROM fact WHERE task_id=? AND statement=?').get(id, '提交验收：alias delivery')
      assert.ok(audit)
      assert.equal(audit.created_by, display)
      assert.equal(audit.actor_session, session)
      assert.equal(store.taskOf(id, RUN).task.owner, 'worker-a')
    }
  }
})

test('empty submission notes add no audit fact through submit or either close alias', async t => {
  const store = tempStore(t), call = toolCaller(store)
  for (const result of [undefined, 'done', 'partial']) {
    for (const note of [undefined, '', ' \t ']) {
      const id = store.openTask({ title: 'empty submission audit' }, RUN).task_id
      store.claimTask({ task_id: id, child_id: 'worker-a' }, RUN)
      const submitted = await call(result === undefined ? 'task_submit' : 'task_close',
        { task_id: id, ...(result === undefined ? {} : { result }), ...(note === undefined ? {} : { note }) }, childOf('worker-a'))
      assert.equal(submitted.ok, true)
      assert.equal(submitted.status, 'submitted')
      assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM fact WHERE task_id=?').get(id).n, 0)
    }
  }
})
