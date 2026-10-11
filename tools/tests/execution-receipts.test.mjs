import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { TaskforceStore } from '../../lib/store/index.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { apply as applyTools } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'
import { latestExecution } from '../../lib/store/execution.js'

const run = 'receipt-run'
const identity = { sessionId: 'worker', runId: run, isRoot: false }
const command = "printf 'verified\\n'; printf 'diagnostic\\n' >&2"
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'taskforce-execution-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'source.js'), 'export const answer = 42\n')
  const store = tempStore(t)
  const context = { sessionId: run, cwd, isRoot: true }
  const input = { title: 'strict coding', evidence_policy: 'execution', verification_files: ['source.js'], verification_command: command }
  const open = () => store.openTask(input, run, context).task_id
  const claim = id => store.claimTask({ task_id: id, child_id: 'nickname' }, run, 'worker', 'worker')
  const submit = id => store.submitTask({ task_id: id }, run, 'worker', 'worker')
  const accept = (id, extra = {}) => store.acceptTask({ task_id: id, ...extra }, run, 'lead', run)
  return { cwd, store, context, input, open, claim, submit, accept }
}

// Task19 P4A: public pending intent only; no command or completion is run.
const p4CoordinateFields = ['call_id', 'root_call_id', 'parent_call_id']
const p4ReceiptFields = ['run_id', 'owner_session', 'actor_session', 'command', ...p4CoordinateFields]
const p4PendingCases = []
for (const field of p4CoordinateFields) {
  for (const position of ['leading', 'middle', 'trailing']) {
    const coordinates = { call_id: 'call-ordinary', root_call_id: 'root-ordinary', parent_call_id: 'parent-ordinary' }
    coordinates[field] = position === 'leading' ? '\0' + field
      : position === 'middle' ? field + '\0suffix' : field + '\0'
    p4PendingCases.push({ label: `${field}-${position}`, coordinates })
  }
}
for (const position of ['leading', 'middle', 'trailing']) {
  const coordinates = Object.fromEntries(p4CoordinateFields.map(field => [field,
    position === 'leading' ? '\0' + field : position === 'middle' ? field + '\0suffix' : field + '\0']))
  p4PendingCases.push({ label: `joint-${position}`, coordinates })
}
const p4LiteralControls = ['Tordinary', 'J"literal"', '{"coordinate":true}', 'literal\\u0000', '普通🙂']
for (let rotation = 0; rotation < p4LiteralControls.length; rotation++) {
  p4PendingCases.push({ label: `literal-rotation-${rotation}`, coordinates: Object.fromEntries(
    p4CoordinateFields.map((field, index) => [field, p4LiteralControls[(rotation + index) % p4LiteralControls.length]])) })
}
p4PendingCases.push({ label: 'omitted-parent', coordinates: { call_id: 'call-without-parent', root_call_id: 'root-without-parent' } })

// Keep every receipt visible through E1's unchanged LIMIT 10.
for (let offset = 0; offset < p4PendingCases.length; offset += 10) {
  const cases = p4PendingCases.slice(offset, offset + 10)
  test(`Task19 pending receipt call provenance survives board and detail forwarding, batch ${offset / 10 + 1}`, t => {
    assert.equal(p4PendingCases.length, 18)
    assert.ok(cases.length > 0 && cases.length <= 10)
    const f = fixture(t), id = f.open(); f.claim(id)
    const creationHandle = f.store.open()
    const sourceBytes = readFileSync(join(f.cwd, 'source.js'))
    const canonicalCwd = realpathSync(f.cwd)
    const expected = new Map()
    const observed = { pending_returns: 0, oracle_opens: 0, oracle_rows: 0, oracle_cells: 0,
      public_receipts: 0, public_fields: 0, creation_board: 0, creation_boardPage: 0,
      reopened_board: 0, reopened_boardPage: 0, read_only_phases: 0 }
    t.after(() => t.diagnostic(JSON.stringify({ p4a_batch: offset / 10 + 1, observed })))
    for (const entry of cases) {
      const pending = f.store.recordExecution({ task_id: id, status: 'pending', command,
        timeout_ms: 60000, ...entry.coordinates }, run, identity)
      observed.pending_returns++
      assert.equal(pending.task_id, id)
      assert.equal(typeof pending.receipt_id, 'string'); assert.ok(pending.receipt_id.length > 0)
      assert.equal(expected.has(pending.receipt_id), false, 'public generated receipt IDs must be distinct')
      assert.equal(pending.status, 'pending'); assert.equal(pending.verified, false)
      expected.set(pending.receipt_id, { label: entry.label, values: {
        run_id: run, owner_session: identity.sessionId, actor_session: identity.sessionId, command,
        ...entry.coordinates, parent_call_id: entry.coordinates.parent_call_id ?? null } })
    }
    assert.equal(expected.size, cases.length)

    function readStoredReceipts() {
      const oracle = new DatabaseSync(f.store.dbPath, { readOnly: true })
      observed.oracle_opens++
      try {
        // Public node:sqlite is only a read-only oracle. No product transport or
        // raw NUL-bearing TEXT is used to establish expected stored values.
        const cells = p4ReceiptFields.map(field => `json_quote(${field}) AS ${field}_json, typeof(${field}) AS ${field}_type`).join(', ')
        const rows = oracle.prepare('SELECT id, receipt_id, task_id, status, ended_at, logs, outcome,'
          + ' typeof(logs) AS logs_type, typeof(outcome) AS outcome_type, ' + cells
          + ' FROM execution_receipt WHERE task_id = ? AND run_id IS ? ORDER BY id DESC').all(id, run)
        assert.equal(rows.length, cases.length)
        assert.deepEqual(rows.map(row => row.receipt_id).sort(), [...expected.keys()].sort())
        for (const row of rows) {
          observed.oracle_rows++
          const entry = expected.get(row.receipt_id)
          assert.ok(entry, 'stored receipt must match an actual creation return')
          assert.equal(row.task_id, id); assert.equal(row.status, 'pending'); assert.equal(row.ended_at, null)
          assert.equal(row.logs, null); assert.equal(row.logs_type, 'null')
          assert.equal(row.outcome, null); assert.equal(row.outcome_type, 'null')
          for (const field of p4ReceiptFields) {
            assert.equal(row[field + '_type'], entry.values[field] === null ? 'null' : 'text', `${entry.label}:${field}:storage-type`)
            assert.equal(JSON.parse(row[field + '_json']), entry.values[field], `${entry.label}:${field}:stored-cell`)
            observed.oracle_cells++
          }
        }
        assert.equal(oracle.prepare('SELECT total_changes() AS n').get().n, 0)
        return rows
      } finally { oracle.close() }
    }

    function assertPhase(store, phase) {
      const db = store.open()
      if (phase === 'creation') assert.equal(db, creationHandle, 'must read the still-open creation handle')
      else assert.notEqual(db, creationHandle, 'reopened reads need a different connection')
      const before = db.prepare('SELECT total_changes() AS n').get().n
      const stored = readStoredReceipts()
      for (const route of ['board', 'boardPage']) {
        const detail = route === 'board' ? store.board(id, run) : store.boardPage({ task_id: id }, run)
        observed[`${phase}_${route}`]++
        assert.equal(store.open(), db, 'route must keep the same public store connection')
        assert.equal(detail.scope, 'task'); assert.equal(detail.task.id, id)
        assert.equal(detail.task.status, 'claimed'); assert.equal(detail.task.evidence_generation, 0)
        assert.equal(detail.receipts.length, cases.length)
        assert.deepEqual(detail.receipts.map(row => row.receipt_id).sort(), [...expected.keys()].sort())
        // The original reader orders by native row id DESC, not UUID or time.
        assert.deepEqual(detail.receipts.map(row => row.receipt_id), stored.map(row => row.receipt_id))
        for (let index = 0; index < detail.receipts.length; index++) {
          const row = detail.receipts[index], entry = expected.get(row.receipt_id)
          observed.public_receipts++
          assert.ok(entry, 'public receipt must match an actual creation return')
          assert.ok(Number.isSafeInteger(row.id) && row.id > 0)
          if (index > 0) assert.ok(detail.receipts[index - 1].id > row.id)
          assert.equal(row.id, stored[index].id); assert.equal(row.task_id, id)
          for (const field of p4ReceiptFields) {
            assert.equal(Object.hasOwn(row, field), true, `${phase}:${route}:${entry.label}:${field}:own`)
            assert.equal(row[field], entry.values[field], `${phase}:${route}:${entry.label}:${field}`)
            observed.public_fields++
          }
          assert.equal(row.status, 'pending'); assert.equal(row.logs, null); assert.equal(row.ended_at, null)
          assert.equal(row.evidence_generation, 0); assert.equal(row.timeout_ms, 60000)
          assert.equal(Object.hasOwn(row, 'verified'), false)
          assert.equal(Object.hasOwn(row, 'outcome'), false)
          assert.equal(row.cwd, canonicalCwd); assert.deepEqual(row.verification_files, ['source.js'])
          assert.equal(row.snapshot.length, 1); assert.equal(row.snapshot[0].path, 'source.js')
          assert.equal(row.snapshot[0].sha256, createHash('sha256').update(sourceBytes).digest('hex'))
        }
      }
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before, 'oracle and board reads must not write')
      assert.deepEqual(readFileSync(join(f.cwd, 'source.js')), sourceBytes)
      assert.equal(existsSync(join(f.store.root, 'receipts')), false)
      observed.read_only_phases++
    }

    assertPhase(f.store, 'creation')
    assert.equal(f.store.open(), creationHandle)
    f.store.close()
    const reopened = new TaskforceStore(f.store.root)
    try { assertPhase(reopened, 'reopened') } finally { reopened.close() }
    assert.deepEqual(observed, { pending_returns: cases.length, oracle_opens: 2,
      oracle_rows: cases.length * 2, oracle_cells: cases.length * 7 * 2,
      public_receipts: cases.length * 4, public_fields: cases.length * 7 * 4,
      creation_board: 1, creation_boardPage: 1, reopened_board: 1, reopened_boardPage: 1, read_only_phases: 2 })
  })
}

test('Task16 verification target preserves complete owner and fixed command before pending receipt writes', t => {
  const f = fixture(t), full = 'worker\0suffix', actor = { sessionId: full, isRoot: false }, fixed = 'echo ok\0suffix'
  const id = f.store.openTask({ ...f.input, verification_command: fixed }, run, f.context).task_id
  f.store.claimTask({ task_id: id, child_id: 'display' }, run, actor, full)
  const db = f.store.open(), changes = db.prepare('SELECT total_changes() AS n').get().n
  assert.throws(() => f.store.verificationTarget(id, run, { sessionId: 'worker', isRoot: false }), { code: 'E_TASK_CONFLICT' })
  const target = f.store.verificationTarget(id, run, actor)
  assert.equal(target.owner_session, full); assert.equal(target.verification_command, fixed)
  assert.throws(() => f.store.recordExecution({ task_id: id, status: 'pending', command: 'echo ok',
    timeout_ms: 60000, call_id: 'call', root_call_id: 'root' }, run, actor), { code: 'E_VERIFICATION_COMMAND' })
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
  assert.equal(db.prepare('SELECT count(*) AS n FROM execution_receipt').get().n, 0)
  assert.equal(existsSync(join(f.store.root, 'receipts')), false)
})

test('Task16 receipt completion independently checks complete actor and never promotes unknown evidence', t => {
  const f = fixture(t), full = 'worker\0suffix', actor = { sessionId: full, isRoot: false }, fixed = 'echo ok\0suffix'
  const id = f.store.openTask({ ...f.input, verification_command: fixed }, run, f.context).task_id
  f.store.claimTask({ task_id: id, child_id: 'display' }, run, actor, full)
  const pending = f.store.recordExecution({ task_id: id, status: 'pending', command: fixed,
    timeout_ms: 60000, call_id: 'call', root_call_id: 'root' }, run, actor)
  const db = f.store.open(), before = db.prepare('SELECT * FROM execution_receipt').all(), source = readFileSync(join(f.cwd, 'source.js'))
  const completion = { task_id: id, receipt_id: pending.receipt_id,
    native_result: { isError: true, error: { message: 'fixture observation', info: { code: 'E_TEST_OBSERVATION' } } } }
  assert.throws(() => f.store.recordExecution(completion, run, { sessionId: 'worker', isRoot: false }), { code: 'E_VERIFICATION_RECEIPT' })
  assert.deepEqual(db.prepare('SELECT * FROM execution_receipt').all(), before)
  assert.equal(existsSync(join(f.store.root, 'receipts')), false)
  assert.deepEqual(readFileSync(join(f.cwd, 'source.js')), source)
  const latest = latestExecution(db, { id, run_id: run })
  for (const [field, expected] of Object.entries({ run_id: run, owner_session: full, actor_session: full, command: fixed })) assert.equal(latest[field], expected)
  const completed = f.store.recordExecution(completion, run, actor)
  assert.equal(completed.status, 'unknown'); assert.equal(completed.verified, false)
})

// Losing strictPolicy validation or using fact basis for execution would make these fail.
test('execution creation rejects missing manifest, trusted cwd, fixed command or root authority', t => {
  const { store, input, context } = fixture(t)
  for (const [args, trusted] of [
    [{ ...input, verification_files: undefined }, context],
    [{ ...input, verification_files: [] }, context],
    [{ ...input, verification_command: ' ' }, context],
    [input, undefined], [input, { ...context, cwd: undefined }],
    [input, { ...context, isRoot: false }],
    [{ ...input, evidence_policy: 'fabricated' }, context],
  ]) assert.throws(() => store.openTask(args, run, trusted), { code: 'E_VERIFICATION_POLICY' })
  assert.equal(store.stats(run).tasks.total, 0)
})

test('strict acceptance cannot be manufactured with an artifact statement', t => {
  const { store, open, claim, submit, accept } = fixture(t)
  const id = open(); claim(id)
  store.recordFact({ task_id: id, kind: 'artifact', statement: 'exit 0', evidence_path: 'fake.log' }, run, 'worker', 'worker')
  submit(id)
  assert.throws(() => accept(id), { code: 'E_VERIFICATION_RECEIPT' })
})

const sha = text => createHash('sha256').update(text).digest('hex')
const foreground = (extra = {}) => ({ isError: false, value: { kind: 'foreground', exitCode: 0,
  signal: null, timedOut: false, aborted: false, timeoutMs: 60000,
  stdout: { text: 'verified\n', truncated: false }, stderr: { text: 'diagnostic\n', truncated: false }, ...extra }, content: [] })
async function verify(f, id, options = {}) {
  const { runTaskVerification } = await import('../../lib/tools/verification.js')
  const agent = options.agent ?? { session: { header: { id: identity.sessionId } } }
  const exec = options.exec ?? { agent, signal: new AbortController().signal, token: {}, rootCallId: 'outer-call' }
  return runTaskVerification({ store: f.store, identity: options.identity ?? identity, agent,
    task_id: id, command, execute: async () => foreground(), ...options, exec, signal: exec.signal })
}

const nativeJobNext = '本次验证观察到原生非 foreground 结果；请由发起本次验证的原生会话在其当前进程中使用宿主 job_output/job_kill 检查并确认 job 已结束后，再重新验证。任务重新分配不会转移原生 job 权限。'
const nonforeground = (extra = {}, envelope = {}) => ({ isError: false,
  value: { kind: 'promoted', jobId: 'bash-observed-1', timeoutMs: 50, ...extra }, content: [], ...envelope })
const expectedJob = (kind = 'promoted', job_id = 'bash-observed-1', timeout_ms = 50) => ({
  kind, job_id, timeout_ms, scope: 'current-owner-process', durable: false,
})

// Dropping the observed native locator, copying extra fields, or treating it as
// successful/durable evidence must fail these public wrapper/store assertions.
for (const kind of ['promoted', 'background']) {
  test(`${kind} returns only bounded current-caller native job diagnostics and remains unaccepted`, async t => {
    const f = fixture(t), id = f.open(); f.claim(id)
    const result = await verify(f, id, { execute: async () => nonforeground({ kind,
      output: 'PRIVATE_RENDERED_OUTPUT', spillPath: '/private/spill', error: { message: 'PRIVATE_ERROR' },
      owner: 'forged-owner', durable: true, extra: 'PRIVATE_EXTRA',
    }, { content: [{ type: 'text', text: 'PRIVATE_RENDERER jobId=forged' }] }) })
    assert.deepEqual(result.native_job, expectedJob(kind, 'bash-observed-1', kind === 'promoted' ? 50 : null))
    assert.equal(result.next, nativeJobNext)
    assert.equal(result.status, 'unknown'); assert.equal(result.verified, false)
    assert.equal(result.output_complete, false)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|\/private\/|forged/)
    const row = f.store.board(id, run).receipts[0]
    assert.equal(row.kind, kind); assert.equal(row.actual_timeout_ms, null)
    assert.equal(row.logs.stdout.bytes, 0); assert.equal(row.logs.stderr.bytes, 0)
    assert.equal(Object.hasOwn(row, 'native_job'), false)
    assert.equal(Object.hasOwn(row, 'job_id'), false)
    f.submit(id); assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  })
}

for (const [label, jobId, expected] of [
  ['one character', 'Z', 'Z'], ['all allowed punctuation', '0.A_z:-9', '0.A_z:-9'],
  ['256 characters', 'a'.repeat(256), 'a'.repeat(256)], ['257 characters', 'a'.repeat(257), null],
  ['empty', '', null], ['initial punctuation', '-job', null], ['slash', 'bash/job', null],
  ['space', 'bash job', null], ['leading whitespace', ' bash', null], ['trailing whitespace', 'bash ', null],
  ['trailing newline', 'bash\n', null], ['carriage return', 'bash\r', null], ['control separator', 'bash\u0000job', null],
  ['unicode', 'bash-工作', null],
  ['number', 123, null], ['boolean', true, null], ['object', { id: 'bash' }, null],
  ['array', ['bash'], null], ['null', null, null], ['missing', undefined, null],
]) test(`native job ID projection: ${label}`, async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  const result = await verify(f, id, { execute: async () => nonforeground({ jobId }) })
  assert.deepEqual(result.native_job, expectedJob('promoted', expected))
})

for (const [label, timeoutMs, expected] of [
  ['minimum', 1, 1], ['safe maximum', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ['zero', 0, null], ['negative', -1, null], ['fraction', 1.5, null],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1, null], ['infinity', Infinity, null],
  ['NaN', NaN, null], ['string', '50', null], ['boolean', true, null],
  ['object', {}, null], ['array', [50], null], ['null', null, null], ['missing', undefined, null],
]) test(`promoted timeout projection: ${label}`, async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  const result = await verify(f, id, { execute: async () => nonforeground({ timeoutMs }) })
  assert.deepEqual(result.native_job, expectedJob('promoted', 'bash-observed-1', expected))
})

for (const [label, result] of [
  ['foreground', foreground({ jobId: 'unrelated' })],
  ['error carrying a promoted value', nonforeground({}, { isError: true, error: { message: 'denied' } })],
  ['missing isError', nonforeground({}, { isError: undefined })],
  ['null isError', nonforeground({}, { isError: null })],
  ['nonboolean isError', nonforeground({}, { isError: 0 })],
  ['unknown kind', nonforeground({ kind: 'unknown' })],
  ['null kind', nonforeground({ kind: null })],
  ['missing kind', nonforeground({ kind: undefined })],
  ['rendered text only', { isError: false, value: null, content: [{ type: 'text', text: JSON.stringify(nonforeground().value) }] }],
]) test(`${label} does not gain native job diagnostics`, async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  const response = await verify(f, id, { execute: async () => result })
  assert.equal(Object.hasOwn(response, 'native_job'), false)
  assert.equal(Object.hasOwn(response, 'next'), false)
  assert.equal(response.verified, label === 'foreground')
})

test('native job diagnostics do not survive a new store connection, backup or restore', async t => {
  const { backup, restore } = await import('../../lib/operations/index.js')
  const f = fixture(t), id = f.open(); f.claim(id)
  const jobId = 'unique-process-local-job-4de089'
  const result = await verify(f, id, { execute: async () => nonforeground({ jobId }) })
  const row = f.store.handle.prepare('SELECT * FROM execution_receipt WHERE receipt_id=?').get(result.receipt_id)
  assert.doesNotMatch(JSON.stringify(row), /native_job|job_id|jobId|unique-process-local-job-4de089/)
  const reopened = new TaskforceStore(f.store.root)
  t.after(() => reopened.close())
  assert.equal(Object.hasOwn(reopened.board(id, run).receipts[0], 'native_job'), false)
  const directory = mkdtempSync(join(tmpdir(), 'taskforce-job-archive-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const archive = join(directory, 'backup'), restored = join(directory, 'restored')
  assert.equal((await backup({ root: f.store.root, out: archive })).ok, true)
  const manifestText = readFileSync(join(archive, 'manifest.json'), 'utf8')
  assert.doesNotMatch(manifestText, /native_job|job_id|jobId|unique-process-local-job-4de089/)
  for (const entry of JSON.parse(manifestText).files) {
    assert.equal(readFileSync(join(archive, entry.path)).includes(Buffer.from(jobId)), false)
  }
  const snapshot = new DatabaseSync(join(archive, 'taskforce.db'), { readOnly: true })
  try { assert.deepEqual(snapshot.prepare('SELECT * FROM execution_receipt WHERE receipt_id=?').get(result.receipt_id), row) }
  finally { snapshot.close() }
  assert.equal((await restore({ backup: archive, out: restored })).ok, true)
  const restoredStore = new TaskforceStore(restored)
  try {
    assert.deepEqual(restoredStore.open().prepare('SELECT * FROM execution_receipt WHERE receipt_id=?').get(result.receipt_id), row)
    restoredStore.submitTask({ task_id: id }, run, 'worker', 'worker')
    assert.throws(() => restoredStore.acceptTask({ task_id: id }, run, 'lead', run), { code: 'E_VERIFICATION_RECEIPT' })
  } finally { restoredStore.close() }
  assert.deepEqual(result.native_job, expectedJob('promoted', jobId))
})

test('promotion after owner/generation drift remains an observation for the original invoking session', async t => {
  const f = fixture(t), id = f.open(); f.claim(id); f.submit(id)
  const result = await verify(f, id, { execute: async input => {
    assert.equal(input.agent.session.header.id, 'worker')
    f.store.rejectTask({ task_id: id, reason: 'handover' }, run, 'lead', run)
    f.store.claimTask({ task_id: id, child_id: 'replacement' }, run, 'lead', 'replacement')
    f.store.submitTask({ task_id: id }, run, 'replacement', 'replacement')
    return nonforeground()
  } })
  const row = f.store.board(id, run).receipts[0], task = f.store.taskOf(id, run).task
  assert.equal(task.owner_session, 'replacement'); assert.equal(task.evidence_generation, 1)
  assert.equal(row.owner_session, 'worker'); assert.equal(row.actor_session, 'worker')
  assert.equal(row.evidence_generation, 0); assert.equal(row.status, 'unknown')
  assert.equal(result.verified, false); assert.equal(result.output_complete, false)
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  assert.equal(Object.hasOwn(row, 'native_job'), false)
  assert.deepEqual(result.native_job, expectedJob())
  assert.equal(result.next, nativeJobNext)
})

test('promotion diagnostics cannot escape before the receipt completion is durable', async t => {
  const f = fixture(t), id = f.open(); f.claim(id); f.submit(id)
  f.store.handle.exec("CREATE TEMP TRIGGER refuse_promoted BEFORE UPDATE ON execution_receipt BEGIN SELECT RAISE(ABORT, 'promotion receipt failed'); END")
  await assert.rejects(verify(f, id, { execute: async () => nonforeground() }), /promotion receipt failed/)
  assert.equal(f.store.board(id, run).receipts[0].status, 'pending')
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
})

test('manifest rejects missing, escaping, absolute, directory and external symlink paths', t => {
  const f = fixture(t), outside = join(f.store.root, 'outside.js')
  writeFileSync(outside, 'outside')
  symlinkSync(outside, join(f.cwd, 'external.js'))
  for (const path of ['missing.js', '../outside.js', outside, '.', 'external.js']) {
    assert.throws(() => f.store.openTask({ ...f.input, verification_files: [path] }, run, f.context), { code: 'E_VERIFICATION_POLICY' })
  }
})

test('native foreground result persists command, owner, generation, correlated call and full log digests before returning', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  const agent = { session: { header: { id: 'worker' } } }
  const exec = { agent, token: {}, rootCallId: 'outer-id', signal: new AbortController().signal }
  let calls = 0
  const result = await verify(f, id, { agent, exec, execute: async input => {
    calls++
    assert.equal(input.agent, agent); assert.equal(input.parent, exec.token)
    assert.equal(input.signal, exec.signal); assert.equal(input.rootCallId, 'outer-id')
    assert.equal(typeof input.callId, 'string')
    assert.equal(input.name, 'bash')
    assert.deepEqual(input.arguments, { command, description: `验证任务 ${id} 的固定验收命令`, workdir: f.cwd, timeoutMs: 60000, run_in_background: false })
    assert.equal(f.store.board(id, run).receipts[0].status, 'pending')
    return foreground()
  } })
  assert.equal(calls, 1); assert.equal(result.verified, true)
  const row = f.store.board(id, run).receipts[0]
  assert.equal(row.command, command); assert.equal(row.actor_session, 'worker')
  assert.equal(row.owner_session, 'worker'); assert.equal(row.evidence_generation, 0)
  assert.equal(row.status, 'completed'); assert.equal(row.root_call_id, 'outer-id')
  assert.equal(row.snapshot[0].sha256, sha(readFileSync(join(f.cwd, 'source.js'))))
  for (const [stream, text] of [['stdout', 'verified\n'], ['stderr', 'diagnostic\n']]) {
    assert.equal(readFileSync(row.logs[stream].path, 'utf8'), text)
    assert.equal(row.logs[stream].sha256, sha(text))
    assert(row.logs[stream].path.startsWith(join(f.store.root, 'receipts') + '/'))
  }
  f.submit(id)
  assert.equal(f.accept(id).execution_verified, true)
})

test('fixed command, timeout, worker owner and outer context are validated before native dispatch', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  for (const [options, code] of [
    [{ command: 'true' }, 'E_VERIFICATION_COMMAND'],
    [{ command: command + ' ' }, 'E_VERIFICATION_COMMAND'],
    [{ timeout_ms: 0 }, 'E_VERIFICATION_POLICY'], [{ timeout_ms: 120001 }, 'E_VERIFICATION_POLICY'],
    [{ timeout_ms: 1.5 }, 'E_VERIFICATION_POLICY'],
    [{ identity: { ...identity, isRoot: true } }, 'E_VERIFICATION_ROLE'],
    [{ identity: { ...identity, sessionId: 'sibling' } }, 'E_TASK_CONFLICT'],
    [{ identity: { ...identity, runId: 'other' } }, 'E_CROSS_RUN'],
    [{ exec: {} }, 'E_VERIFICATION_CAPABILITY'],
    [{ execute: undefined }, 'E_VERIFICATION_CAPABILITY'],
  ]) await assert.rejects(verify(f, id, { ...options, execute: options.execute === undefined && 'execute' in options ? undefined : async () => {
    assert.fail('invalid invocation reached native bash')
  } }), { code })
  assert.equal(f.store.board(id, run).receipts.length, 0)
})

for (const [name, result] of [
  ['nonzero', foreground({ exitCode: 7 })],
  ['signal', foreground({ signal: 'SIGTERM' })],
  ['timeout', foreground({ timedOut: true })],
  ['abort', foreground({ aborted: true })],
  ['runner failure', foreground({ sandbox: { runnerFailed: true } })],
  ['truncated', foreground({ stdout: { text: 'tail', truncated: true, spillPath: '/untrusted/spill' } })],
  ['oversized combined logs', foreground({ stdout: { text: 'x'.repeat(2 * 1024 * 1024), truncated: false } })],
  ['background', { isError: false, value: { kind: 'background', jobId: 'job' }, content: [] }],
  ['promoted', { isError: false, value: { kind: 'promoted', jobId: 'job', output: 'running' }, content: [] }],
  ['denied', { isError: true, error: { message: 'policy denied' }, content: [{ type: 'text', text: 'exit 0' }] }],
  ['missing exit fields', { isError: false, value: { kind: 'foreground', stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }, content: [] }],
  ['display text only', { isError: false, value: 'exit 0', content: [] }],
]) test(`latest ${name} blocks strict acceptance over earlier success and artifact`, async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  await verify(f, id)
  f.store.recordFact({ task_id: id, kind: 'artifact', statement: 'old verification passes', evidence_path: 'old.log' }, run)
  const latest = await verify(f, id, { execute: async () => result })
  assert.equal(latest.verified, false)
  assert.equal(f.store.board(id, run).receipts.length, 2)
  f.submit(id); assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
})

test('latest pending receipt blocks acceptance during a new awaited invocation', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  await verify(f, id); f.submit(id)
  let release, entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const verification = verify(f, id, { execute: async () => {
    entered(); return await new Promise(resolve => { release = resolve })
  } })
  await enteredPromise
  assert.equal(f.store.board(id, run).receipts[0].status, 'pending')
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  release(foreground({ exitCode: 1 })); await verification
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
})

for (const mutation of ['log missing', 'log changed', 'source changed', 'source missing', 'external symlink']) {
  test(`${mutation} invalidates a persisted successful receipt`, async t => {
    const f = fixture(t), id = f.open(); f.claim(id)
    await verify(f, id); f.submit(id)
    const receipt = f.store.board(id, run).receipts[0]
    if (mutation === 'log missing') rmSync(receipt.logs.stdout.path)
    if (mutation === 'log changed') writeFileSync(receipt.logs.stdout.path, 'forged')
    if (mutation === 'source changed') writeFileSync(join(f.cwd, 'source.js'), 'modified')
    if (mutation === 'source missing') rmSync(join(f.cwd, 'source.js'))
    if (mutation === 'external symlink') {
      rmSync(join(f.cwd, 'source.js')); writeFileSync(join(f.store.root, 'other.js'), 'export const answer = 42\n')
      symlinkSync(join(f.store.root, 'other.js'), join(f.cwd, 'source.js'))
    }
    assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  })
}

test('source mutation during the command and an aborted outer signal never produce successful evidence', async t => {
  for (const scenario of ['source', 'abort']) {
    const f = fixture(t), id = f.open(); f.claim(id)
    const controller = new AbortController()
    const agent = { session: { header: { id: 'worker' } } }
    const result = await verify(f, id, { agent, exec: { agent, signal: controller.signal, token: {}, rootCallId: 'outer' }, execute: async () => {
      if (scenario === 'source') writeFileSync(join(f.cwd, 'source.js'), 'modified')
      else controller.abort()
      return foreground()
    } })
    assert.equal(result.verified, false); f.submit(id)
    assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  }
})

test('reject increments generation; reassigning owner cannot reuse a receipt or accept an in-flight predecessor', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  await verify(f, id); f.submit(id)
  f.store.rejectTask({ task_id: id, reason: 'rework' }, run, 'lead', run)
  assert.equal(f.store.taskOf(id, run).task.evidence_generation, 1)
  f.store.claimTask({ task_id: id, child_id: 'nickname' }, run, 'lead', 'replacement')
  f.store.submitTask({ task_id: id }, run, 'replacement', 'replacement')
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  await assert.rejects(verify(f, id), { code: 'E_TASK_CONFLICT' })
  await verify(f, id, { identity: { ...identity, sessionId: 'replacement' }, agent: { session: { header: { id: 'replacement' } } } })
  assert.equal(f.accept(id).execution_verified, true)
})

test('owner/generation changes while awaiting are retained as stale host observations', async t => {
  const f = fixture(t), id = f.open(); f.claim(id); f.submit(id)
  const result = await verify(f, id, { execute: async () => {
    f.store.rejectTask({ task_id: id, reason: 'handover' }, run, 'lead', run)
    f.store.claimTask({ task_id: id, child_id: 'replacement' }, run, 'lead', 'replacement')
    f.store.submitTask({ task_id: id }, run, 'replacement', 'replacement')
    return foreground()
  } })
  assert.equal(result.verified, false)
  assert.equal(f.store.board(id, run).receipts[0].owner_session, 'worker')
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
})

test('native rejection, exception and receipt persistence failure block earlier success', async t => {
  for (const scenario of ['throw', 'persistence']) {
    const f = fixture(t), id = f.open(); f.claim(id)
    await verify(f, id); f.submit(id)
    if (scenario === 'persistence') f.store.handle.exec("CREATE TEMP TRIGGER refuse_receipt BEFORE UPDATE ON execution_receipt BEGIN SELECT RAISE(ABORT, 'receipt update failed'); END")
    const promise = verify(f, id, { execute: async () => {
      if (scenario === 'throw') throw new Error('native infrastructure failed')
      return foreground()
    } })
    if (scenario === 'throw') assert.equal((await promise).verified, false)
    else { await assert.rejects(promise, /receipt update failed/); assert.equal(f.store.board(id, run).receipts[0].status, 'pending') }
    assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  }
})

test('strict manual waiver is explicit, audited separately and never labelled verification success', t => {
  const f = fixture(t), id = f.open(); f.claim(id); f.submit(id)
  const result = f.accept(id, { waiver_reason: 'manual inspection approved' })
  assert.equal(result.execution_verified, false)
  const board = f.store.board(id, run)
  assert.equal(board.execution_waivers[0].reason, 'manual inspection approved')
  assert.equal(board.execution_waivers[0].actor_session, run)
  assert.match(board.facts[0].statement, /人工豁免/)
  assert.match(board.facts[0].statement, /非验证通过/)
})

function toolCaller(f, backend) {
  const root = { options: {}, session: { header: { id: run, cwd: f.cwd } } }
  const worker = { options: {}, session: { header: { id: 'worker', cwd: f.cwd, origin: 'subagent', delegationDepth: 1, parentSession: run } } }
  const agents = new Map([[run, root], ['worker', worker]])
  const definitions = []
  const tools = { register: definition => definitions.push(definition), ...(backend ? { execute: backend } : {}) }
  root.ctx = worker.ctx = { tools }
  applyTools({ logger: { warn() {} }, tools, get: name => name === 'taskforceStore' ? f.store : name === 'agents' ? { get: id => agents.get(id) } : undefined })
  const call = async (name, args, agent = root) => {
    const tool = definitions.find(d => d.name === name)
    assert.ok(tool, `${name} must be registered`)
    return JSON.parse(await tool.execute(args, { agent, token: {}, rootCallId: 'outer-tool', signal: new AbortController().signal }))
  }
  return { call, root, worker }
}

test('task tools bind strict creation to trusted root cwd; verify forwards native context and cannot forge receipt fields', async t => {
  const f = fixture(t)
  const { call, worker } = toolCaller(f, async input => { assert.equal(input.agent, worker); return foreground() })
  assert.equal((await call('task_open', f.input, worker)).code, 'E_VERIFICATION_POLICY')
  const opened = await call('task_open', { ...f.input, cwd: '/forged', verification_cwd: '/forged' })
  assert.equal(opened.ok, true)
  assert.equal(f.store.taskOf(opened.task_id, run).task.verification_cwd, f.cwd)
  await call('task_claim', { task_id: opened.task_id, child_id: 'nickname' }, worker)
  assert.equal((await call('task_verify', { task_id: opened.task_id, command })).code, 'E_VERIFICATION_ROLE')
  const checked = await call('task_verify', { task_id: opened.task_id, command, exitCode: 100,
    owner_session: 'forged', stdout: 'forged', log_path: '/forged' }, worker)
  assert.equal(checked.verified, true)
  const row = f.store.board(opened.task_id, run).receipts[0]
  assert.equal(row.exit_code, 0); assert.equal(row.actor_session, 'worker')
})

test('task_verify missing native capability fails closed and legacy tasks preserve their evidence gate', async t => {
  const f = fixture(t), { call, worker } = toolCaller(f)
  const id = f.open(); f.claim(id)
  const result = await call('task_verify', { task_id: id, command }, worker)
  assert.equal(result.code, 'E_VERIFICATION_CAPABILITY'); assert.equal(result.ok, false)
  assert.match(result.hint, /宿主/)
  const old = f.store.openTask({ title: 'legacy' }, run).task_id
  assert.equal(f.store.taskOf(old, run).task.evidence_policy, 'legacy')
  f.store.recordFact({ task_id: old, kind: 'artifact', statement: 'evidence' }, run)
  f.store.submitTask({ task_id: old }, run)
  assert.equal(f.accept(old).status, 'accepted')
})

test('native registry without bash reports capability failure and retains unknown intent', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  const result = await verify(f, id, { execute: async () => ({ isError: true,
    error: { message: 'unknown tool "bash"', info: { code: 'UNKNOWN_TOOL' } }, content: [] }) })
  assert.equal(result.code, 'E_VERIFICATION_CAPABILITY')
  assert.equal(result.verified, false)
  assert.equal(Object.hasOwn(result, 'native_job'), false)
  assert.equal(Object.hasOwn(result, 'next'), false)
  assert.equal(f.store.board(id, run).receipts[0].status, 'unknown')
})

test('receipt retains requested timeout and native actual timeout without inventing fields', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  for (const timeout of [1, 120000]) {
    await verify(f, id, { timeout_ms: timeout, execute: async input => {
      assert.equal(input.arguments.timeoutMs, timeout)
      assert.equal(f.store.board(id, run).receipts[0].timeout_ms, timeout)
      return foreground({ timeoutMs: timeout })
    } })
    const row = f.store.board(id, run).receipts[0]
    assert.equal(row.timeout_ms, timeout); assert.equal(row.actual_timeout_ms, timeout)
  }
})

test('receipt persists across a new connection and pending survives a lost completion', async t => {
  const { TaskforceStore } = await import('../../lib/store/index.js')
  const f = fixture(t), id = f.open(); f.claim(id)
  await verify(f, id); f.submit(id)
  const reopened = new TaskforceStore(f.store.root)
  t.after(() => reopened.close())
  assert.equal(reopened.board(id, run).receipts[0].status, 'completed')
  reopened.recordExecution({ task_id: id, status: 'pending', command, timeout_ms: 60000,
    call_id: 'crashed-invocation', root_call_id: 'crashed-outer' }, run, identity)
  const third = new TaskforceStore(f.store.root)
  t.after(() => third.close())
  assert.equal(third.board(id, run).receipts[0].status, 'pending')
  assert.throws(() => third.acceptTask({ task_id: id }, run, 'lead', run), { code: 'E_VERIFICATION_RECEIPT' })
})

test('reject alone invalidates old success even when the same owner reclaims', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  await verify(f, id); f.submit(id)
  f.store.rejectTask({ task_id: id, reason: 'redo verification' }, run, 'lead', run)
  f.claim(id); f.submit(id)
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  await verify(f, id)
  assert.equal(f.store.board(id, run).receipts[0].evidence_generation, 1)
  assert.equal(f.accept(id).execution_verified, true)
})

test('rewriting then restoring source during execution invalidates metadata snapshot', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  const original = readFileSync(join(f.cwd, 'source.js'))
  const result = await verify(f, id, { execute: async () => {
    writeFileSync(join(f.cwd, 'source.js'), 'changed')
    writeFileSync(join(f.cwd, 'source.js'), original)
    return foreground()
  } })
  assert.equal(result.verified, false); f.submit(id)
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
})

test('log persistence failure has a receipt error and keeps the new pending intent', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  await verify(f, id); f.submit(id)
  rmSync(join(f.store.root, 'receipts'), { recursive: true })
  writeFileSync(join(f.store.root, 'receipts'), 'not a directory')
  await assert.rejects(verify(f, id), { code: 'E_VERIFICATION_RECEIPT' })
  assert.equal(f.store.board(id, run).receipts[0].status, 'pending')
  assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
})

test('a silently skipped receipt update cannot report completion', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  f.store.handle.exec("CREATE TEMP TRIGGER ignore_receipt BEFORE UPDATE ON execution_receipt BEGIN SELECT RAISE(IGNORE); END")
  await assert.rejects(verify(f, id), { code: 'E_VERIFICATION_RECEIPT' })
  assert.equal(f.store.board(id, run).receipts[0].status, 'pending')
})

test('sandbox access denial cannot become strict success even with shell exit zero', async t => {
  const f = fixture(t), id = f.open(); f.claim(id)
  await verify(f, id)
  const denied = await verify(f, id, { execute: async () => foreground({ sandbox: { mode: 'workspace-write', denied: true } }) })
  assert.equal(denied.verified, false)
  f.submit(id); assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
})

function linkedFixture(t, kind) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'taskforce-linked-receipts-')))
  const physical = join(directory, 'physical'), alias = join(directory, 'alias')
  mkdirSync(physical)
  symlinkSync(physical, alias)
  const root = kind === 'direct' ? alias : join(alias, 'nested')
  const cwd = join(directory, 'workspace')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'source.js'), 'export const answer = 42\n')
  const store = new TaskforceStore(root)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const context = { sessionId: run, cwd, isRoot: true }
  const input = { title: 'linked strict coding', evidence_policy: 'execution',
    verification_files: ['source.js'], verification_command: command }
  const open = () => store.openTask(input, run, context).task_id
  const claim = id => store.claimTask({ task_id: id, child_id: 'nickname' }, run, 'worker', 'worker')
  const submit = id => store.submitTask({ task_id: id }, run, 'worker', 'worker')
  const accept = id => store.acceptTask({ task_id: id }, run, 'lead', run)
  return { directory, cwd, store, context, input, open, claim, submit, accept }
}

for (const kind of ['direct', 'ancestor']) {
  test('strict receipts accept a configured ' + kind + ' root symlink with unchanged textual log paths', async t => {
    const f = linkedFixture(t, kind), id = f.open(); f.claim(id)
    const result = await verify(f, id)
    assert.equal(result.verified, true, 'successful receipt under a legitimate root alias must verify')
    const receipt = f.store.board(id, run).receipts[0]
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(receipt.logs[stream].path, join(f.store.root, 'receipts', receipt.receipt_id + '.' + stream + '.log'))
      assert.notEqual(realpathSync(receipt.logs[stream].path), receipt.logs[stream].path)
    }
    f.submit(id)
    assert.equal(f.accept(id).execution_verified, true)
  })
}

for (const kind of ['file', 'directory']) {
  test('strict receipt rejects an external ' + kind + ' symlink beneath a legitimate root alias', async t => {
    const f = linkedFixture(t, 'direct'), id = f.open(); f.claim(id)
    await verify(f, id)
    const receipt = f.store.board(id, run).receipts[0]
    const foreign = join(f.directory, 'foreign')
    if (kind === 'file') {
      writeFileSync(foreign, readFileSync(receipt.logs.stdout.path))
      rmSync(receipt.logs.stdout.path)
      symlinkSync(foreign, receipt.logs.stdout.path)
    } else {
      renameSync(join(f.store.root, 'receipts'), foreign)
      symlinkSync(foreign, join(f.store.root, 'receipts'))
    }
    f.submit(id)
    assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
  })
}

test('strict receipt keeps old-root textual provenance invalid after copying into a new root', async t => {
  const f = linkedFixture(t, 'direct'), id = f.open(); f.claim(id)
  await verify(f, id); f.submit(id)
  const oldLogs = f.store.board(id, run).receipts[0].logs
  const relocatedRoot = join(f.directory, 'relocated')
  f.store.close()
  cpSync(realpathSync(f.store.root), relocatedRoot, { recursive: true })
  const relocated = new TaskforceStore(relocatedRoot)
  t.after(() => relocated.close())
  assert.deepEqual(relocated.board(id, run).receipts[0].logs, oldLogs)
  assert.throws(() => relocated.acceptTask({ task_id: id }, run, 'lead', run), { code: 'E_VERIFICATION_RECEIPT' })
})

test('legacy resolved blocker path remains human-reviewed basis and cannot satisfy strict execution', t => {
  const f = fixture(t)
  for (const strict of [false, true]) {
    const id = strict ? f.open() : f.store.openTask({ title: 'legacy investigation' }, run).task_id
    f.claim(id)
    const blocker = f.store.recordFact({ task_id: id, kind: 'blocker', statement: 'observed build failure',
      evidence_path: 'logs/build.log' }, run, 'worker', 'worker').fact_id
    f.store.recordFact({ task_id: id, kind: 'decision', statement: 'investigation concluded',
      resolves_fact_id: blocker }, run, 'worker', 'worker')
    f.submit(id)
    if (strict) assert.throws(() => f.accept(id), { code: 'E_VERIFICATION_RECEIPT' })
    else {
      const accepted = f.accept(id)
      assert.equal(accepted.status, 'accepted')
      assert.deepEqual(accepted.evidence_basis.fact_ids, [blocker])
      assert.equal(accepted.waiver, null)
    }
  }
})


// Task19 E2: manual acceptance waiver only; no verification or command is run.
const task19WaiverFields = ['reason', 'actor_session', 'run_id']
const task19WaiverCases = []
for (const field of task19WaiverFields) for (const position of ['leading', 'middle', 'trailing']) {
  const values = { reason: 'manual exception', actor_session: 'root-audit', run_id: 'waiver-run' }
  values[field] = position === 'leading' ? '\0' + field : position === 'middle' ? field + '\0suffix' : field + '\0'
  task19WaiverCases.push({ label: `${field}-${position}`, values })
}
for (const position of ['leading', 'middle', 'trailing']) {
  task19WaiverCases.push({ label: `joint-${position}`, values: Object.fromEntries(task19WaiverFields.map(field =>
    [field, position === 'leading' ? '\0' + field : position === 'middle' ? field + '\0suffix' : field + '\0'])) })
}
const task19WaiverLiterals = ['Tordinary', 'J"literal"', '{"waiver":true}', 'literal\\u0000', '中文🙂']
for (let rotation = 0; rotation < task19WaiverLiterals.length; rotation++) {
  task19WaiverCases.push({ label: `literal-rotation-${rotation}`, values: Object.fromEntries(task19WaiverFields.map((field, index) =>
    [field, task19WaiverLiterals[(rotation + index) % task19WaiverLiterals.length]])) })
}
task19WaiverCases.push({ label: 'native-null-run-and-audit', values: { reason: 'manual exception', actor_session: null, run_id: null } })
task19WaiverCases.push({ label: 'full-detail-no-display-omission', values: {
  reason: 'manual exception\0' + '"\\'.repeat(130), actor_session: 'root\0' + 'x'.repeat(257), run_id: 'waiver-long' } })

for (const entry of task19WaiverCases) {
  test(`Task19 waiver audit preserves accepted rationale and actor: ${entry.label}`, t => {
    const f = fixture(t), scope = entry.values.run_id
    const actor = entry.values.actor_session === null ? 'lead' : { sessionId: entry.values.actor_session, isRoot: true }
    const sourceBytes = readFileSync(join(f.cwd, 'source.js'))
    const id = f.store.openTask(f.input, scope, f.context).task_id
    assert.equal(f.store.claimTask({ task_id: id, child_id: 'nickname' }, scope, 'worker', 'worker').status, 'claimed')
    assert.equal(f.store.submitTask({ task_id: id }, scope, 'worker', 'worker').status, 'submitted')
    const accepted = f.store.acceptTask({ task_id: id, waiver_reason: `  ${entry.values.reason}  ` }, scope, actor)
    assert.equal(accepted.task_id, id); assert.equal(accepted.status, 'accepted')
    assert.equal(accepted.execution_verified, false); assert.equal(accepted.execution_receipt, null)
    assert.equal(accepted.waiver.reason, entry.values.reason); assert.equal(accepted.waiver.by, 'lead')
    assert.equal(accepted.waiver.at, accepted.accepted_at)
    assert.equal(accepted.fact_count, 0); assert.equal(accepted.resolved_blockers, 0)
    assert.equal(accepted.evidence_basis.count, 0)
    assert.match(accepted.warnings.join('\n'), /人工豁免/)
    const creationHandle = f.store.open()
    let storedId
    function check(reader, phase) {
      const oracle = new DatabaseSync(f.store.dbPath, { readOnly: true })
      try {
        const rows = oracle.prepare('SELECT id, task_id, evidence_generation, receipt_id, created_at,'
          + ' json_quote(reason) AS reason_json, typeof(reason) AS reason_type,'
          + ' json_quote(actor_session) AS actor_session_json, typeof(actor_session) AS actor_session_type,'
          + ' json_quote(run_id) AS run_id_json, typeof(run_id) AS run_id_type'
          + ' FROM execution_waiver WHERE task_id=? ORDER BY id DESC').all(id)
        assert.equal(rows.length, 1)
        const row = rows[0]
        assert.ok(Number.isSafeInteger(row.id) && row.id > 0)
        if (storedId === undefined) storedId = row.id
        assert.equal(row.id, storedId); assert.equal(row.task_id, id)
        assert.equal(row.evidence_generation, 0); assert.equal(row.receipt_id, null)
        assert.equal(row.created_at, accepted.accepted_at)
        for (const field of task19WaiverFields) {
          assert.equal(row[field + '_type'], entry.values[field] === null ? 'null' : 'text', `${phase}:${field}:type`)
          assert.equal(JSON.parse(row[field + '_json']), entry.values[field], `${phase}:${field}:stored`)
        }
        assert.equal(oracle.prepare('SELECT COUNT(*) AS n FROM execution_receipt WHERE task_id=?').get(id).n, 0)
        assert.equal(oracle.prepare('SELECT total_changes() AS n').get().n, 0)
      } finally { oracle.close() }
      const db = reader.open(), before = db.prepare('SELECT total_changes() AS n').get().n
      for (const route of ['board', 'boardPage']) {
        const result = reader[route]({ task_id: id }, scope)
        assert.equal(result.task.id, id); assert.equal(result.task.status, 'accepted')
        assert.equal(result.task.evidence_policy, 'execution'); assert.equal(result.task.evidence_generation, 0)
        assert.equal(result.task.run_id, scope); assert.equal(result.task.owner_session, 'worker')
        assert.equal(result.task.verification_command, command)
        assert.equal(result.task.verification_cwd, realpathSync(f.cwd))
        assert.deepEqual(result.task.verification_files, ['source.js'])
        assert.equal(result.task.fact_count, 1); assert.equal(result.task.open, false)
        assert.deepEqual(result.receipts, [])
        assert.equal(result.execution_waivers.length, 1)
        const waiver = result.execution_waivers[0]
        assert.equal(waiver.id, storedId); assert.equal(waiver.task_id, id)
        assert.equal(waiver.evidence_generation, 0); assert.equal(waiver.receipt_id, null)
        assert.equal(waiver.created_at, accepted.accepted_at)
        for (const field of task19WaiverFields) assert.equal(waiver[field], entry.values[field], `${phase}:${route}:${field}`)
        assert.equal(Object.hasOwn(waiver, 'truncated'), false)
        assert.equal(Object.hasOwn(waiver, 'truncated_fields'), false)
        assert.equal(result.facts.length, 1)
        const decision = result.facts[0]
        assert.equal(decision.kind, 'decision'); assert.equal(decision.confidence, 'PLAUSIBLE')
        assert.equal(decision.evidence, null); assert.equal(decision.by, 'lead')
        assert.match(decision.statement, /人工豁免/); assert.match(decision.statement, /非验证通过/)
        assert.ok(decision.statement.includes(entry.values.reason))
      }
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
      assert.deepEqual(readFileSync(join(f.cwd, 'source.js')), sourceBytes)
      assert.equal(existsSync(join(f.store.root, 'receipts')), false)
    }
    assert.equal(f.store.open(), creationHandle); check(f.store, 'creation')
    f.store.close()
    const reopened = new TaskforceStore(f.store.root)
    try { assert.notEqual(reopened.open(), creationHandle); check(reopened, 'reopened') } finally { reopened.close() }
  })
}

test('Task19 waiver history keeps the ten newest public rows across rework and reopen', t => {
  const f = fixture(t), id = f.open(), actor = { sessionId: 'root-audit', isRoot: true }
  const sourceBytes = readFileSync(join(f.cwd, 'source.js'))
  f.claim(id)
  const reasons = Array.from({ length: 11 }, (_, generation) => `manual exception ${generation}\0review missing verification`)
  for (let generation = 0; generation < reasons.length; generation++) {
    if (generation > 0) {
      assert.equal(f.store.rejectTask({ task_id: id, reason: 'rework' }, run, actor).status, 'rejected')
      f.claim(id)
    }
    f.submit(id)
    const accepted = f.store.acceptTask({ task_id: id, waiver_reason: reasons[generation] }, run, actor)
    assert.equal(accepted.status, 'accepted'); assert.equal(accepted.execution_verified, false)
    assert.equal(accepted.execution_receipt, null); assert.equal(accepted.waiver.reason, reasons[generation])
  }
  const creationHandle = f.store.open()
  function check(reader) {
    const oracle = new DatabaseSync(f.store.dbPath, { readOnly: true })
    let rows
    try {
      rows = oracle.prepare('SELECT id, evidence_generation, json_quote(reason) AS reason_json, typeof(reason) AS reason_type'
        + ' FROM execution_waiver WHERE task_id=? AND run_id IS ? ORDER BY id DESC').all(id, run)
      assert.equal(rows.length, 11)
      assert.equal(new Set(rows.map(row => row.id)).size, 11)
      rows.forEach((row, index) => {
        assert.equal(row.evidence_generation, 10 - index); assert.equal(row.reason_type, 'text')
        assert.equal(JSON.parse(row.reason_json), reasons[10 - index])
      })
      assert.equal(oracle.prepare('SELECT COUNT(*) AS n FROM execution_receipt WHERE task_id=?').get(id).n, 0)
      assert.equal(oracle.prepare('SELECT total_changes() AS n').get().n, 0)
    } finally { oracle.close() }
    const db = reader.open(), before = db.prepare('SELECT total_changes() AS n').get().n
    for (const route of ['board', 'boardPage']) {
      const result = reader[route]({ task_id: id }, run)
      assert.equal(result.task.status, 'accepted'); assert.equal(result.task.evidence_generation, 10)
      assert.deepEqual(result.receipts, [])
      assert.deepEqual(result.execution_waivers.map(row => row.id), rows.slice(0, 10).map(row => row.id))
      result.execution_waivers.forEach((row, index) => {
        assert.equal(row.reason, reasons[10 - index]); assert.equal(row.evidence_generation, 10 - index)
        assert.equal(row.actor_session, actor.sessionId); assert.equal(row.run_id, run); assert.equal(row.receipt_id, null)
      })
    }
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
    assert.deepEqual(readFileSync(join(f.cwd, 'source.js')), sourceBytes)
    assert.equal(existsSync(join(f.store.root, 'receipts')), false)
  }
  assert.equal(f.store.open(), creationHandle); check(f.store)
  f.store.close()
  const reopened = new TaskforceStore(f.store.root)
  try { assert.notEqual(reopened.open(), creationHandle); check(reopened) } finally { reopened.close() }
})

// Task19 E1: fault the executed generated receipt row, never the metadata-only star.
for (const task19E1FaultRoute of ['board', 'boardPage']) {
  for (const task19E1FaultField of ['call_id', 'root_call_id', 'parent_call_id']) {
    test(`Task19 E1 ${task19E1FaultRoute} rejects malformed ${task19E1FaultField} on the real generated read`, t => {
      const f = fixture(t), id = f.open(); f.claim(id)
      const coordinates = { call_id: 'call\0valid', root_call_id: 'root\0valid', parent_call_id: 'parent\0valid' }
      const pending = f.store.recordExecution({ task_id: id, status: 'pending', command,
        timeout_ms: 60000, ...coordinates }, run, identity)
      assert.equal(pending.status, 'pending'); assert.equal(pending.verified, false)
      const expected = { run_id: run, owner_session: identity.sessionId, actor_session: identity.sessionId,
        command, ...coordinates }
      const source = readFileSync(join(f.cwd, 'source.js'))
      const storedReceipts = () => {
        const oracle = new DatabaseSync(f.store.dbPath, { readOnly: true })
        try {
          const rows = oracle.prepare("SELECT json_object('id',id,'receipt_id',receipt_id,'task_id',task_id,"
            + "'run_id',run_id,'evidence_generation',evidence_generation,'owner_session',owner_session,"
            + "'actor_session',actor_session,'command',command,'cwd',cwd,'verification_files',verification_files,"
            + "'status',status,'started_at',started_at,'ended_at',ended_at,'call_id',call_id,"
            + "'root_call_id',root_call_id,'parent_call_id',parent_call_id,'timeout_ms',timeout_ms,"
            + "'snapshot',snapshot,'outcome',outcome,'logs',logs) AS row_json FROM execution_receipt ORDER BY id").all()
          assert.equal(oracle.prepare('SELECT total_changes() AS n').get().n, 0)
          return rows.map(row => JSON.parse(row.row_json))
        } finally { oracle.close() }
      }
      const before = storedReceipts()
      assert.equal(before.length, 1)
      assert.equal(before[0].receipt_id, pending.receipt_id); assert.equal(before[0].task_id, id)
      for (const [field, value] of Object.entries(expected)) assert.equal(before[0][field], value)
      assert.equal(before[0].status, 'pending'); assert.equal(before[0].ended_at, null)
      assert.equal(before[0].logs, null); assert.equal(before[0].outcome, null)
      assert.equal(JSON.parse(before[0].snapshot)[0].sha256, sha(source))
      assert.equal(existsSync(join(f.store.root, 'receipts')), false)

      const db = f.store.open(), originalPrepare = db.prepare, prepare = originalPrepare.bind(db)
      const changes = prepare('SELECT total_changes() AS n').get().n
      const suffix = ' FROM execution_receipt WHERE task_id = ? AND run_id IS ? ORDER BY id DESC LIMIT 10'
      const counts = {
        original: { prepare: 0, columns: 0, get: 0, all: 0, iterate: 0, run: 0 },
        generated: { prepare: 0, columns: 0, get: 0, all: 0, iterate: 0, run: 0 },
      }
      const bindings = []
      let injections = 0
      db.prepare = sql => {
        const statement = prepare(sql)
        if (!sql.startsWith('SELECT ') || !sql.endsWith(suffix)) return statement
        const kind = sql === 'SELECT *' + suffix ? 'original' : 'generated'
        const count = counts[kind]
        count.prepare++
        const columns = statement.columns.bind(statement)
        statement.columns = (...args) => { count.columns++; return columns(...args) }
        for (const method of ['get', 'all', 'iterate', 'run']) {
          const read = statement[method].bind(statement)
          statement[method] = (...args) => {
            count[method]++
            if (kind === 'generated') bindings.push([...args])
            const rows = read(...args)
            if (kind === 'generated' && method === 'all') {
              assert.deepEqual(args, [id, run])
              assert.equal(rows.length, 1)
              const row = rows[0]
              assert.equal(Object.getPrototypeOf(row), null)
              assert.equal(row.id, before[0].id); assert.equal(row.receipt_id, pending.receipt_id)
              assert.equal(row.task_id, id); assert.equal(row.status, 'pending')
              // Every selected field is valid before independently corrupting a later coordinate.
              for (const [field, value] of Object.entries(expected)) {
                assert.equal(row[field], value.includes('\0') ? 'J' + JSON.stringify(value) : 'T' + value,
                  field + ' must have valid transport before the intended injection')
              }
              row[task19E1FaultField] = 'J"Task19 invalid receipt transport without NUL"'
              injections++
            }
            return rows
          }
        }
        return statement
      }
      const unreturned = Symbol('no public result')
      let result = unreturned
      try {
        assert.throws(() => { result = f.store[task19E1FaultRoute]({ task_id: id }, run) },
          { code: 'E_STORE_INTEGRITY', message: 'SQLite 文本读取证据无效' })
      } finally { db.prepare = originalPrepare }
      assert.equal(result, unreturned)
      assert.equal(injections, 1)
      assert.deepEqual(counts, {
        original: { prepare: 1, columns: 1, get: 0, all: 0, iterate: 0, run: 0 },
        generated: { prepare: 1, columns: 1, get: 0, all: 1, iterate: 0, run: 0 },
      })
      assert.deepEqual(bindings, [[id, run]])
      assert.equal(db.isTransaction, false)
      assert.equal(prepare('SELECT total_changes() AS n').get().n, changes)
      assert.deepEqual(storedReceipts(), before)
      assert.deepEqual(readFileSync(join(f.cwd, 'source.js')), source)
      assert.equal(existsSync(join(f.store.root, 'receipts')), false)
    })
  }
}

// Count the real public reader pair; oracle/setup reads occur outside this hook.
function task19ReceiptLifecycle(t, db, originalSql, match, args, rowCount, work, mutate) {
  const originalPrepare = db.prepare, prepare = originalPrepare.bind(db), records = []
  db.prepare = sql => {
    const statement = prepare(sql)
    if (!match(sql)) return statement
    const record = { kind: sql === originalSql ? 'original' : 'generated', columns: 0,
      get: 0, all: 0, iterate: 0, run: 0, bindings: [], rows: [] }
    records.push(record)
    const columns = statement.columns.bind(statement)
    statement.columns = (...values) => { record.columns++; return columns(...values) }
    for (const method of ['get', 'all', 'iterate', 'run']) {
      const read = statement[method].bind(statement)
      statement[method] = (...values) => {
        record[method]++; record.bindings.push(values)
        const result = read(...values)
        if (method === 'all') {
          assert.equal(Array.isArray(result), true); record.rows.push(result.length)
          if (record.kind === 'generated' && mutate) mutate(result)
        }
        return result
      }
    }
    return statement
  }
  let result
  try { result = work() } finally { db.prepare = originalPrepare }
  t.diagnostic('public SQL lifecycle ' + JSON.stringify({ originalSql, records }))
  assert.deepEqual(records, rowCount === null ? [] : [
    { kind: 'original', columns: 1, get: 0, all: 0, iterate: 0, run: 0, bindings: [], rows: [] },
    { kind: 'generated', columns: 1, get: 0, all: 1, iterate: 0, run: 0, bindings: [args], rows: [rowCount] },
  ])
  return result
}

for (const site of ['E1', 'E2']) {
  test(`Task19 ${site} public lifecycle preserves full-run fields with zero, one and multiple rows before and after reopen`, t => {
    const f = fixture(t), scope = 'receipt-lifecycle\0run', owner = 'worker\0owner'
    const actor = { sessionId: owner, isRoot: false }, lead = { sessionId: 'root\0audit', isRoot: true }
    const fixed = 'echo never executed\0fixed', source = readFileSync(join(f.cwd, 'source.js'))
    const id = f.store.openTask({ ...f.input, verification_command: fixed }, scope,
      { ...f.context, sessionId: scope }).task_id
    const claim = () => f.store.claimTask({ task_id: id, child_id: 'display' }, scope, actor, owner)
    claim()
    const table = site === 'E1' ? 'execution_receipt' : 'execution_waiver'
    const fields = site === 'E1'
      ? ['run_id', 'owner_session', 'actor_session', 'command', 'call_id', 'root_call_id', 'parent_call_id']
      : ['reason', 'actor_session', 'run_id']
    const suffix = ' FROM ' + table + ' WHERE task_id = ? AND run_id IS ? ORDER BY id DESC LIMIT 10'
    const expected = [], creationHandle = f.store.open()
    const check = (reader, phase) => {
      const oracle = new DatabaseSync(f.store.dbPath, { readOnly: true })
      let stored
      try {
        stored = oracle.prepare('SELECT id, receipt_id, evidence_generation,'
          + (site === 'E1' ? 'status, logs, outcome, ended_at,' : 'created_at,')
          + fields.map(field => 'typeof(' + field + ') AS ' + field + '_type, json_quote(' + field + ') AS ' + field + '_json').join(',')
          + ' FROM ' + table + ' WHERE task_id=? AND run_id IS ? ORDER BY id DESC').all(id, scope)
        assert.equal(stored.length, expected.length)
        stored.forEach((row, index) => {
          const wanted = expected.at(-1 - index)
          for (const field of fields) {
            assert.equal(row[field + '_type'], wanted[field] === null ? 'null' : 'text')
            assert.equal(JSON.parse(row[field + '_json']), wanted[field])
          }
          if (site === 'E1') {
            assert.equal(row.receipt_id, wanted.receipt_id); assert.equal(row.status, 'pending')
            assert.equal(row.logs, null); assert.equal(row.outcome, null); assert.equal(row.ended_at, null)
          } else {
            assert.equal(row.receipt_id, null); assert.equal(row.evidence_generation, wanted.evidence_generation)
            assert.equal(row.created_at, wanted.created_at)
          }
        })
        assert.equal(oracle.prepare('SELECT total_changes() AS n').get().n, 0)
      } finally { oracle.close() }
      const db = reader.open(), changes = db.prepare('SELECT total_changes() AS n').get().n
      assert.equal(db === creationHandle, phase === 'creation')
      for (const route of ['board', 'boardPage']) {
        const result = task19ReceiptLifecycle(t, db, 'SELECT *' + suffix,
          sql => sql.startsWith('SELECT ') && sql.endsWith(suffix), [id, scope], expected.length,
          () => reader[route]({ task_id: id }, scope))
        assert.equal(result.task.id, id); assert.equal(result.task.run_id, scope)
        assert.equal(result.task.status, site === 'E1' || expected.length === 0 ? 'claimed' : 'accepted')
        assert.equal(result.task.evidence_generation, site === 'E1' ? 0 : Math.max(0, expected.length - 1))
        const rows = site === 'E1' ? result.receipts : result.execution_waivers
        assert.deepEqual(rows.map(row => row.id), stored.map(row => row.id))
        rows.forEach((row, index) => {
          const wanted = expected.at(-1 - index)
          for (const field of fields) assert.equal(row[field], wanted[field])
          if (site === 'E1') {
            assert.equal(row.receipt_id, wanted.receipt_id); assert.equal(row.task_id, id)
            assert.equal(row.status, 'pending'); assert.equal(row.logs, null)
            assert.equal(Object.hasOwn(row, 'verified'), false); assert.equal(Object.hasOwn(row, 'outcome'), false)
          } else { assert.equal(row.receipt_id, null); assert.deepEqual(result.receipts, []) }
        })
      }
      assert.equal(db.isTransaction, false)
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
      assert.deepEqual(readFileSync(join(f.cwd, 'source.js')), source)
      assert.equal(existsSync(join(f.store.root, 'receipts')), false)
    }
    check(f.store, 'creation')
    for (let index = 0; index < 2; index++) {
      if (site === 'E1') {
        const coordinates = { call_id: 'call\0' + index, root_call_id: 'root\0' + index,
          parent_call_id: index === 0 ? null : 'parent\0full' }
        const pending = f.store.recordExecution({ task_id: id, status: 'pending', command: fixed,
          timeout_ms: 60000, ...coordinates }, scope, actor)
        assert.equal(pending.task_id, id); assert.equal(pending.status, 'pending'); assert.equal(pending.verified, false)
        expected.push({ ...coordinates, receipt_id: pending.receipt_id, run_id: scope,
          owner_session: owner, actor_session: owner, command: fixed })
      } else {
        if (index > 0) { f.store.rejectTask({ task_id: id, reason: 'rework' }, scope, lead); claim() }
        f.store.submitTask({ task_id: id }, scope, actor, owner)
        const reason = 'manual\0exception ' + index
        const accepted = f.store.acceptTask({ task_id: id, waiver_reason: reason }, scope, lead)
        assert.equal(accepted.execution_verified, false); assert.equal(accepted.execution_receipt, null)
        assert.equal(accepted.waiver.reason, reason)
        expected.push({ reason, actor_session: lead.sessionId, run_id: scope,
          evidence_generation: index, created_at: accepted.accepted_at })
      }
      check(f.store, 'creation')
    }
    f.store.close()
    const reopened = new TaskforceStore(f.store.root)
    try { check(reopened, 'reopened') } finally { reopened.close() }
  })
}
