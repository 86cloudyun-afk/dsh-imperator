import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { TaskforceStore } from '../../lib/store/index.js'
import { installationVersion } from '../host-runtime.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply as applyTools } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'

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

const hostAnchor = process.env.DSH_INSTALL_ANCHOR
const hostModule = name => import(pathToFileURL(createRequire(hostAnchor).resolve(name)).href)
for (const kind of ['direct', 'ancestor']) {
  test('actual native bash verifies a ' + kind + ' root symlink and strict acceptance reads its real logs',
    { skip: !hostAnchor && 'requires DSH_INSTALL_ANCHOR; offline receipt shapes are not native proof' }, async t => {
      const f = linkedFixture(t, kind)
      const [{ Context }, { createScope }, { SessionStore }, { ToolRuntime }, { SystemPrompt },
        { LocalSubprocessRuntime }, { LocalBashExecutor }, { ShellEnvRegistry }, bash] = await Promise.all([
        hostModule('@deepseek-ai/cordis'), hostModule('@deepseek-ai/dsh-scope'),
        hostModule('@deepseek-ai/dsh-session'), hostModule('@deepseek-ai/dsh-tools'),
        hostModule('@deepseek-ai/dsh-system-prompt'), hostModule('@deepseek-ai/dsh-subprocess-local'),
        hostModule('@deepseek-ai/dsh-bash-local'), hostModule('@deepseek-ai/dsh-shell-env'),
        hostModule('@deepseek-ai/dsh-tool-bash'),
      ])
      const scope = createScope(new Context(), {})
      t.after(() => scope.dispose())
      const ctx = scope.ctx
      new SystemPrompt(ctx, { includeHarnessIdentity: false })
      new ToolRuntime(ctx)
      const sessions = new SessionStore(ctx)
      new LocalSubprocessRuntime(ctx)
      new ShellEnvRegistry(ctx)
      new LocalBashExecutor(ctx, LocalBashExecutor.Config({ cwd: f.cwd, maxTimeoutMs: 120000 }))
      if (installationVersion(hostAnchor) === '0.2.1-alpha.2') {
        const [{ default: LocalFileSystem }, { default: SessionProjectionRegistry }, { default: WorkingDirectory }] = await Promise.all([
          hostModule('@deepseek-ai/dsh-fs-local'), hostModule('@deepseek-ai/dsh-session-projection'),
          hostModule('@deepseek-ai/dsh-working-directory'),
        ])
        await ctx.plugin(LocalFileSystem, { cwd: f.cwd })
        await ctx.plugin(SessionProjectionRegistry)
        await ctx.plugin(WorkingDirectory, { defaultDirectory: f.cwd })
      }
      await ctx.plugin(bash, { enableRunInBackground: false, promoteOnTimeout: false })
      const agents = [
        { options: {}, session: sessions.create(run, { meta: { cwd: f.cwd } }) },
        { options: {}, session: sessions.create(identity.sessionId, { meta: {
          cwd: f.cwd, origin: 'subagent', delegationDepth: 1, parentSession: run,
        } }) },
      ]
      for (const agent of agents) {
        const childScope = createScope(ctx, agent)
        agent.ctx = childScope.ctx
        t.after(() => childScope.dispose())
      }
      const [main, worker] = agents
      const byId = new Map(agents.map(agent => [agent.session.header.id, agent]))
      ctx.provide('taskforceStore', f.store)
      ctx.provide('agents', { get: id => byId.get(id) })
      applyTools(ctx)
      await ctx.serial('agent/created', { agent: main })
      await ctx.serial('agent/created', { agent: worker })
      const id = f.open(); f.claim(id)
      const nativeResult = await worker.ctx.tools.execute({ agent: worker,
        callId: 'linked-native-' + kind, name: 'task_verify', arguments: { task_id: id, command },
        signal: new AbortController().signal })
      assert.equal(nativeResult.isError, false, nativeResult.error?.message)
      const result = JSON.parse(nativeResult.value)
      assert.equal(result.verified, true, JSON.stringify(result))
      const receipt = f.store.board(id, run).receipts[0]
      assert.equal(receipt.kind, 'foreground')
      assert.equal(receipt.exit_code, 0)
      assert.equal(receipt.output_complete, true)
      assert.equal(readFileSync(receipt.logs.stdout.path, 'utf8'), 'verified\n')
      assert.equal(readFileSync(receipt.logs.stderr.path, 'utf8'), 'diagnostic\n')
      f.submit(id)
      assert.equal(f.accept(id).execution_verified, true)
    })
}
