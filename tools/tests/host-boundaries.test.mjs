import assert from 'node:assert/strict'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { TASKFORCE_DEFINITION } from '../../lib/preset.js'
import { apply as applyScope, DENY_CODE } from '../../lib/plugins/orchestrator-scope.mjs'

// Integration supplies an explicit installation; offline checks never claim a
// native boundary was tested when the host is absent.
const anchor = process.env.DSH_INSTALL_ANCHOR
const native = async (name) => import(pathToFileURL(createRequire(anchor).resolve(name)).href)
const options = { skip: !anchor && 'requires DSH_INSTALL_ANCHOR' }

async function fixture(t) {
  const [{ Context }, { createScope }, { SessionStore }, { ToolRuntime }, { SystemPrompt }] = await Promise.all([
    native('@deepseek-ai/cordis'), native('@deepseek-ai/dsh-scope'),
    native('@deepseek-ai/dsh-session'), native('@deepseek-ai/dsh-tools'), native('@deepseek-ai/dsh-system-prompt'),
  ])
  const owner = {}
  const scope = createScope(new Context(), owner)
  t.after(() => scope.dispose())
  const ctx = scope.ctx
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  const agent = (id, parent = owner, meta = {}) => {
    const value = { options: {}, session: sessions.create(id, { meta }) }
    const childScope = createScope(ctx, value, { parent })
    value.ctx = childScope.ctx
    t.after(() => childScope.dispose())
    return value
  }
  return { ctx, owner, agent, createScope }
}

test('native PTC transport cannot write from the root; children retain execution', options, async (t) => {
  const { ctx, agent } = await fixture(t)
  const root = await mkdtemp(join(tmpdir(), 'taskforce-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const [{ LocalFileSystem }, { LocalSubprocessRuntime }, { default: Sandbox }, { NodePtcRuntime }] = await Promise.all([
    native('@deepseek-ai/dsh-fs-local'), native('@deepseek-ai/dsh-subprocess-local'),
    native('@deepseek-ai/dsh-sandbox-local'), native('@deepseek-ai/dsh-ptc-runtime-node'),
  ])
  new LocalFileSystem(ctx, LocalFileSystem.Config({ cwd: root }))
  new LocalSubprocessRuntime(ctx)
  new Sandbox(ctx, Sandbox.Config({}))
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access',
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
  new NodePtcRuntime(ctx, NodePtcRuntime.Config({ timeoutMs: 10_000 }))
  ctx.tools.register({ name: 'bash', description: 'execution probe', parameters: {},
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  applyScope(ctx)
  const main = agent('root', undefined, { cwd: root })
  main.ctx.tools.presentAs('both')
  await ctx.serial('agent/created', { agent: main })
  const artifact = join(root, 'artifact.txt')
  const execute = (caller, callId) => caller.ctx.tools.execute({ agent: caller, callId, name: 'run_code',
    arguments: { code: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(artifact)}, 'done'); return 'done';`,
      description: 'isolated execution boundary check' }, signal: new AbortController().signal })
  const denied = await execute(main, 'root-write')
  assert.equal(denied.isError, true, 'root run_code must be denied before execution')
  assert.match(denied.error.message, new RegExp(DENY_CODE))
  await assert.rejects(access(artifact), { code: 'ENOENT' })
  // The reserved transport must never poison restrict({ deny }): bash is hidden.
  assert.equal(main.ctx.tools.schemas(main).some(({ name }) => name === 'bash'), false)

  const child = agent('child', main, { cwd: root, origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
  child.ctx.tools.presentAs('both')
  await ctx.serial('agent/created', { agent: child })
  assert.equal((await execute(child, 'child-write')).isError, false)
  await access(artifact)

  const presentation = TASKFORCE_DEFINITION.plugins.find(({ name }) => name === '@deepseek-ai/dsh-agent-tool-presentation')
  assert.ok(presentation, 'preset must choose its own tool presentation')
  const plugin = await native(presentation.name)
  const nativeMain = agent('native-root', undefined, { cwd: root })
  plugin.apply(nativeMain.ctx, plugin.Config(presentation.config))
  await ctx.serial('agent/created', { agent: nativeMain })
  assert.equal(nativeMain.ctx.tools.schemas(nativeMain).some(({ name }) => name === 'run_code'), false)
  assert.equal(nativeMain.ctx.tools.schemas(nativeMain).some(({ name }) => name === 'bash'), false)
})

test('main session denies pwsh execution the same way as bash (first-party shell twin)', options, async (t) => {
  const { ctx, agent } = await fixture(t)
  let pwshHandlerRuns = 0
  let bashHandlerRuns = 0
  ctx.tools.register({ name: 'bash', description: 'execution probe', parameters: {},
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => { bashHandlerRuns += 1; return {} } })
  ctx.tools.register({ name: 'pwsh', description: 'powershell execution probe', parameters: {},
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => { pwshHandlerRuns += 1; return {} } })
  applyScope(ctx)
  const main = agent('root-pwsh')
  await ctx.serial('agent/created', { agent: main })
  const execute = (name) => main.ctx.tools.execute({
    agent: main, callId: `probe-${name}`, name,
    arguments: { command: 'echo hi' }, signal: new AbortController().signal,
  })
  const deniedBash = await execute('bash')
  const deniedPwsh = await execute('pwsh')
  assert.equal(deniedBash.isError, true)
  assert.equal(deniedPwsh.isError, true)
  assert.match(deniedBash.error.message, new RegExp(DENY_CODE))
  assert.match(deniedPwsh.error.message, new RegExp(DENY_CODE))
  assert.equal(bashHandlerRuns, 0, 'bash handler must not run under orchestrator scope')
  assert.equal(pwshHandlerRuns, 0, 'pwsh handler must not run under orchestrator scope')
  assert.equal(main.ctx.tools.schemas(main).some(({ name }) => name === 'bash'), false)
  assert.equal(main.ctx.tools.schemas(main).some(({ name }) => name === 'pwsh'), false)
  // Child retention for execution tools is covered by the PTC/bash case above;
  // this case only closes the main-session deny-list hole for pwsh.
})

test('both native delegation providers replace the orchestrator persona in children', options, async (t) => {
  const { ctx, owner, agent, createScope } = await fixture(t)
  const [{ renderPrompt }, persona, { applyChildComposition }] = await Promise.all([
    native('@deepseek-ai/dsh-system-prompt'), native('@deepseek-ai/dsh-persona'), native('@deepseek-ai/dsh-subagent'),
  ])
  const tool = await native('@deepseek-ai/dsh-tool-subagent')
  ctx.systemPrompt.variable('model', () => 'test-model')
  ctx.systemPrompt.variable('cwd', () => '/tmp')
  const generation = {}
  const scope = createScope(ctx, generation, { parent: owner })
  t.after(() => scope.dispose())
  const row = TASKFORCE_DEFINITION.plugins.find(({ id }) => id === 'persona')
  persona.apply(scope.ctx, persona.Config(row.config))
  const parent = agent('parent')
  for (const row of TASKFORCE_DEFINITION.plugins.find(({ id }) => id === 'delegation').config.filter(({ name }) => name === '@deepseek-ai/dsh-tool-subagent')) {
    const child = agent(row.id, generation, { origin: 'subagent', delegationDepth: 1, parentSession: 'parent' })
    const config = tool.Config(row.config)
    applyChildComposition(child.ctx, parent, { persona: config.persona })
    const prompt = renderPrompt(await child.ctx.systemPrompt.assemble({ scope: child }))
    assert.equal(prompt.includes('**你自己不动手**'), false, `${config.provider} child inherits root execution ban`)
    assert.match(prompt, /执行者/)
    assert.match(prompt, /验收/)
  }
})

test('spawn and fork both allow one nested delegation and stop at depth two', options, async () => {
  const [{ SubagentRuntime, resolveChildDepth }, { Config }] = await Promise.all([
    native('@deepseek-ai/dsh-subagent'), native('@deepseek-ai/dsh-tool-subagent'),
  ])
  const rows = TASKFORCE_DEFINITION.plugins.find(({ id }) => id === 'delegation').config
  for (const row of rows.filter(({ name }) => name === '@deepseek-ai/dsh-tool-subagent')) {
    const config = Config(row.config)
    const maximum = SubagentRuntime.prototype.resolveMaxDepth.call({ config: { maxDepth: { get: () => 1 } } }, config.maxDepth)
    const parent = (depth) => ({ options: {}, session: { header: { delegationDepth: depth } } })
    assert.equal(resolveChildDepth(parent(1), maximum), 2, `${config.provider} must support depth two`)
    assert.throws(() => resolveChildDepth(parent(2), maximum), { name: 'SubagentDepthError' })
  }
})

test('native task_verify without bash fails closed and root cannot use the verifier to execute', options, async t => {
  const { ctx, agent } = await fixture(t)
  const { apply: applyTools } = await import('../../lib/tools/index.js')
  const { tempStore } = await import('./helpers.mjs')
  const { writeFile } = await import('node:fs/promises')
  const cwd = await mkdtemp(join(tmpdir(), 'taskforce-native-verifier-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'source.js'), 'source\n')
  const store = tempStore(t)
  const main = agent('receipt-root', undefined, { cwd })
  const worker = agent('receipt-worker', main, { cwd, origin: 'subagent', delegationDepth: 1, parentSession: 'receipt-root' })
  const byId = new Map([main, worker].map(a => [a.session.header.id, a]))
  ctx.provide('taskforceStore', store)
  ctx.provide('agents', { get: id => byId.get(id) })
  applyTools(ctx)
  const id = store.openTask({ title: 'native capability', evidence_policy: 'execution', verification_files: ['source.js'], verification_command: 'true' }, 'receipt-root', { sessionId: 'receipt-root', cwd, isRoot: true }).task_id
  store.claimTask({ task_id: id, child_id: 'receipt-worker' }, 'receipt-root', 'receipt-worker', 'receipt-worker')
  const call = async caller => {
    const result = await caller.ctx.tools.execute({ agent: caller, callId: `verify-${caller.session.header.id}`, name: 'task_verify', arguments: { task_id: id, command: 'true' }, signal: new AbortController().signal })
    assert.equal(result.isError, false, result.error?.message)
    return JSON.parse(result.value)
  }
  assert.equal((await call(main)).code, 'E_VERIFICATION_ROLE')
  const missing = await call(worker)
  assert.equal(missing.code, 'E_VERIFICATION_CAPABILITY')
  assert.equal(missing.verified, false)
  assert.equal(store.board(id, 'receipt-root').receipts[0].status, 'unknown')
})

test('native task_verify awaits real bash, correlates its parent and retains native guard denials', options, async t => {
  const { ctx, agent } = await fixture(t)
  const [{ LocalSubprocessRuntime }, { LocalBashExecutor }, { ShellEnvRegistry }, bash, { apply: applyTools }, { tempStore }] = await Promise.all([
    native('@deepseek-ai/dsh-subprocess-local'), native('@deepseek-ai/dsh-bash-local'),
    native('@deepseek-ai/dsh-shell-env'), native('@deepseek-ai/dsh-tool-bash'), import('../../lib/tools/index.js'), import('./helpers.mjs'),
  ])
  const { writeFile, readFile } = await import('node:fs/promises')
  const cwd = await mkdtemp(join(tmpdir(), 'taskforce-native-receipt-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'source.js'), 'source\n')
  const store = tempStore(t)
  new LocalSubprocessRuntime(ctx)
  new ShellEnvRegistry(ctx)
  new LocalBashExecutor(ctx, LocalBashExecutor.Config({ cwd, maxTimeoutMs: 120000 }))
  bash.apply(ctx, { enableRunInBackground: false, promoteOnTimeout: false })
  const main = agent('receipt-root', undefined, { cwd })
  // Separate tool scope matches independently created live agent sessions;
  // session metadata, rather than inheriting the root's restrict layer, supplies lineage.
  const worker = agent('receipt-worker', undefined, { cwd, origin: 'subagent', delegationDepth: 1, parentSession: 'receipt-root' })
  const byId = new Map([main, worker].map(a => [a.session.header.id, a]))
  ctx.provide('taskforceStore', store)
  ctx.provide('agents', { get: id => byId.get(id) })
  applyTools(ctx)
  applyScope(ctx)
  await ctx.serial('agent/created', { agent: main })
  await ctx.serial('agent/created', { agent: worker })
  const command = "printf 'native receipt\\n'; printf 'native stderr\\n' >&2"
  const id = store.openTask({ title: 'real native receipt', evidence_policy: 'execution', verification_files: ['source.js'], verification_command: command }, 'receipt-root', { sessionId: 'receipt-root', cwd, isRoot: true }).task_id
  store.claimTask({ task_id: id, child_id: 'worker-label' }, 'receipt-root', 'receipt-worker', 'receipt-worker')
  let outerToken, bashCalls = 0
  ctx.tools.guard(exec => {
    if (exec.name === 'task_verify') outerToken = exec.token
    if (exec.name === 'bash' && exec.agent === worker) {
      bashCalls++
      assert.equal(exec.parent, outerToken)
      assert.equal(exec.rootCallId, 'real-verification')
      assert.equal(store.board(id, 'receipt-root').receipts[0].status, 'pending')
    }
  })
  const call = async () => {
    const result = await worker.ctx.tools.execute({ agent: worker, callId: 'real-verification', name: 'task_verify', arguments: { task_id: id, command }, signal: new AbortController().signal })
    assert.equal(result.isError, false, result.error?.message)
    return JSON.parse(result.value)
  }
  const first = await call()
  assert.equal(first.verified, true, JSON.stringify({ first, receipts: store.board(id, 'receipt-root').receipts }))
  assert.equal(bashCalls, 1)
  const receipt = store.board(id, 'receipt-root').receipts[0]
  assert.equal(await readFile(receipt.logs.stdout.path, 'utf8'), 'native receipt\n')
  assert.equal(await readFile(receipt.logs.stderr.path, 'utf8'), 'native stderr\n')
  assert.equal(receipt.exit_code, 0)
  const dispose = worker.ctx.tools.guard(exec => exec.name === 'bash' ? 'native approval/policy denial probe' : undefined)
  t.after(dispose)
  assert.equal((await call()).verified, false)
  store.submitTask({ task_id: id }, 'receipt-root', 'receipt-worker', 'receipt-worker')
  assert.throws(() => store.acceptTask({ task_id: id }, 'receipt-root', 'lead', 'receipt-root'), { code: 'E_VERIFICATION_RECEIPT' })
})

for (const operation of ['task_submit', 'task_close', 'task_claim']) {
  test(`native legal child session ID lead cannot ${operation} a sibling task`, options, async t => {
    const { ctx, agent } = await fixture(t)
    const [{ apply: applyTools }, { tempStore }] = await Promise.all([import('../../lib/tools/index.js'), import('./helpers.mjs')])
    const store = tempStore(t)
    const main = agent('reserved-root')
    const special = agent('lead', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'reserved-root' })
    const sibling = agent('sibling', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'reserved-root' })
    const ordinary = agent('ordinary', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'reserved-root' })
    const byId = new Map([main, special, sibling, ordinary].map(a => [a.session.header.id, a]))
    ctx.provide('taskforceStore', store)
    ctx.provide('agents', { get: id => byId.get(id) })
    applyTools(ctx)
    let sequence = 0
    const call = async (caller, name, args) => {
      const result = await caller.ctx.tools.execute({ agent: caller, callId: `reserved-${++sequence}`, name,
        arguments: args, signal: new AbortController().signal })
      assert.equal(result.isError, false, result.error?.message)
      return JSON.parse(result.value)
    }
    const id = (await call(main, 'task_open', { title: operation })).task_id
    await call(sibling, 'task_claim', { task_id: id, child_id: 'sibling-label' })
    if (operation === 'task_claim') {
      await call(sibling, 'task_submit', { task_id: id })
      await call(main, 'task_reject', { task_id: id, reason: 'redo' })
    }
    const snapshot = () => ({ task: store.taskOf(id, 'reserved-root'),
      facts: store.handle.prepare('SELECT * FROM fact WHERE task_id = ? ORDER BY id').all(id),
      handoffs: store.handle.prepare('SELECT * FROM handoff WHERE task_id = ? ORDER BY id').all(id) })
    const before = snapshot()
    const args = { task_id: id, ...(operation === 'task_close' ? { result: 'failed' }
      : operation === 'task_claim' ? { child_id: 'lead-nickname' } : {}) }
    assert.equal((await call(ordinary, operation, args)).code, 'E_TASK_CONFLICT')
    assert.equal((await call(special, operation, args)).code, 'E_TASK_CONFLICT', 'the actual session ID lead must not confer root authority')
    assert.deepEqual(snapshot(), before)
  })
}

test('native child lead retains own-task operations and real root audits its reassignment', options, async t => {
  const { ctx, agent } = await fixture(t)
  const [{ apply: applyTools }, { tempStore }] = await Promise.all([import('../../lib/tools/index.js'), import('./helpers.mjs')])
  const store = tempStore(t), main = agent('reserved-root')
  const special = agent('lead', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'reserved-root' })
  const sibling = agent('sibling', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'reserved-root' })
  const byId = new Map([main, special, sibling].map(a => [a.session.header.id, a]))
  ctx.provide('taskforceStore', store)
  ctx.provide('agents', { get: id => byId.get(id) })
  applyTools(ctx)
  let sequence = 0
  const call = async (caller, name, args) => {
    const result = await caller.ctx.tools.execute({ agent: caller, callId: `reserved-own-${++sequence}`, name,
      arguments: args, signal: new AbortController().signal })
    assert.equal(result.isError, false, result.error?.message)
    return JSON.parse(result.value)
  }
  const id = (await call(main, 'task_open', { title: 'own task' })).task_id
  assert.equal((await call(special, 'task_claim', { task_id: id, child_id: 'nickname' })).owner_session, 'lead')
  assert.equal((await call(special, 'task_fact', { task_id: id, kind: 'fact', statement: 'observed', child_id: 'forged-root' })).ok, true)
  assert.equal((await call(special, 'task_submit', { task_id: id, note: 'worker submits' })).ok, true)
  for (const [name, args] of [['task_accept', { waiver_reason: 'forged' }], ['task_reject', { reason: 'forged' }]]) {
    assert.equal((await call(special, name, { task_id: id, ...args })).code, 'E_NOT_LEAD')
  }
  assert(store.board(id, 'reserved-root').facts.every(f => f.actor_session === 'lead' && f.by === 'lead'))
  assert.equal((await call(main, 'task_accept', { task_id: id })).ok, true)
  assert.equal(store.board(id, 'reserved-root').facts[0].actor_session, 'reserved-root')
  const cancelId = (await call(main, 'task_open', { title: 'own cancellation' })).task_id
  await call(special, 'task_claim', { task_id: cancelId, child_id: 'nickname' })
  assert.equal((await call(special, 'task_close', { task_id: cancelId, result: 'failed', note: 'worker cancels' })).ok, true)
  assert.equal(store.board(cancelId, 'reserved-root').facts[0].actor_session, 'lead')
  const reassignId = (await call(main, 'task_open', { title: 'root reassignment' })).task_id
  await call(sibling, 'task_claim', { task_id: reassignId, child_id: 'sibling-label' })
  await call(sibling, 'task_submit', { task_id: reassignId })
  await call(main, 'task_reject', { task_id: reassignId, reason: 'redo' })
  assert.equal((await call(main, 'task_claim', { task_id: reassignId, child_id: 'lead' })).reassigned, true)
  assert.equal(store.board(reassignId, 'reserved-root').facts[0].actor_session, 'reserved-root')
})

test('native root with actual session ID lead keeps root mutation authority and audit identity', options, async t => {
  const { ctx, agent } = await fixture(t)
  const [{ apply: applyTools }, { tempStore }] = await Promise.all([import('../../lib/tools/index.js'), import('./helpers.mjs')])
  const store = tempStore(t), main = agent('lead')
  const worker = agent('worker', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'lead' })
  const replacement = agent('replacement', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'lead' })
  const byId = new Map([main, worker, replacement].map(a => [a.session.header.id, a]))
  ctx.provide('taskforceStore', store)
  ctx.provide('agents', { get: id => byId.get(id) })
  applyTools(ctx)
  let sequence = 0
  const call = async (name, args) => {
    const result = await main.ctx.tools.execute({ agent: main, callId: `root-lead-${++sequence}`, name,
      arguments: args, signal: new AbortController().signal })
    assert.equal(result.isError, false, result.error?.message)
    return JSON.parse(result.value)
  }
  const id = (await call('task_open', { title: 'real root named lead' })).task_id
  assert.equal((await call('task_claim', { task_id: id, child_id: 'worker' })).owner_session, 'worker')
  assert.equal((await call('task_fact', { task_id: id, kind: 'fact', statement: 'root evidence' })).ok, true)
  assert.equal((await call('task_submit', { task_id: id, note: 'root submit' })).ok, true)
  assert.equal((await call('task_reject', { task_id: id, reason: 'root reassign' })).ok, true)
  assert.equal((await call('task_claim', { task_id: id, child_id: 'replacement' })).reassigned, true)
  assert.equal((await call('task_submit', { task_id: id, note: 'root ready' })).ok, true)
  assert.equal((await call('task_accept', { task_id: id })).ok, true)
  assert(store.board(id, 'lead').facts.every(f => f.actor_session === 'lead' && f.by === 'lead'))
  const cancelId = (await call('task_open', { title: 'root cancellation' })).task_id
  assert.equal((await call('task_close', { task_id: cancelId, result: 'failed', note: 'root cancels' })).ok, true)
  assert.equal(store.board(cancelId, 'lead').facts[0].actor_session, 'lead')
})

for (const operation of ['claim-and-submit', 'sibling-submit']) {
  test(`native distinct worker IDs with surrounding whitespace retain exact ownership: ${operation}`, options, async t => {
    const { ctx, agent } = await fixture(t)
    const [{ apply: applyTools }, { tempStore }] = await Promise.all([import('../../lib/tools/index.js'), import('./helpers.mjs')])
    const store = tempStore(t), main = agent('exact-root')
    const padded = agent(' worker ', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'exact-root' })
    const plain = agent('worker', main, { origin: 'subagent', delegationDepth: 1, parentSession: 'exact-root' })
    const byId = new Map([main, padded, plain].map(a => [a.session.header.id, a]))
    ctx.provide('taskforceStore', store)
    ctx.provide('agents', { get: id => byId.get(id) })
    applyTools(ctx)
    let sequence = 0
    const call = async (caller, name, args) => {
      const result = await caller.ctx.tools.execute({ agent: caller, callId: `exact-owner-${++sequence}`, name,
        arguments: args, signal: new AbortController().signal })
      assert.equal(result.isError, false, result.error?.message)
      return JSON.parse(result.value)
    }
    const id = (await call(main, 'task_open', { title: operation })).task_id
    const claimed = await call(padded, 'task_claim', { task_id: id, child_id: 'shared-label' })
    if (operation === 'sibling-submit') {
      const before = store.taskOf(id, 'exact-root')
      assert.equal((await call(plain, 'task_submit', { task_id: id })).code, 'E_TASK_CONFLICT', 'plain sibling must not inherit the padded real owner identity')
      assert.deepEqual(store.taskOf(id, 'exact-root'), before)
      assert.equal((await call(plain, 'task_claim', { task_id: id, child_id: 'shared-label' })).code, 'E_TASK_CONFLICT')
      assert.equal((await call(plain, 'task_close', { task_id: id, result: 'failed' })).code, 'E_TASK_CONFLICT')
      return
    }
    assert.equal(claimed.owner_session, ' worker ', 'the host owner session must be stored verbatim')
    assert.equal((await call(padded, 'task_claim', { task_id: id, child_id: 'other-nickname' })).already, true)
    await call(padded, 'task_fact', { task_id: id, kind: 'fact', statement: 'exact actor audit' })
    assert.equal((await call(padded, 'task_submit', { task_id: id, note: 'actual padded worker' })).ok, true)
    assert(store.board(id, 'exact-root').facts.every(f => f.actor_session === ' worker ' && f.by === 'worker'))
    assert.equal((await call(padded, 'task_close', { task_id: id, result: 'failed', note: 'actual padded owner' })).ok, true)
    assert.equal(store.board(id, 'exact-root').facts[0].actor_session, ' worker ')
  })
}

test('native roots differing by surrounding whitespace cannot read or mutate each other through task pages or legacy reads', options, async t => {
  const { ctx, agent } = await fixture(t)
  const [{ apply: applyTools }, { tempStore }] = await Promise.all([import('../../lib/tools/index.js'), import('./helpers.mjs')])
  const store = tempStore(t), padded = agent(' root '), plain = agent('root')
  const byId = new Map([padded, plain].map(a => [a.session.header.id, a]))
  ctx.provide('taskforceStore', store)
  ctx.provide('agents', { get: id => byId.get(id) })
  applyTools(ctx)
  let sequence = 0
  const call = async (caller, name, args) => {
    const result = await caller.ctx.tools.execute({ agent: caller, callId: `exact-run-${++sequence}`, name,
      arguments: args, signal: new AbortController().signal })
    assert.equal(result.isError, false, result.error?.message)
    return JSON.parse(result.value)
  }
  const id = (await call(padded, 'task_open', { title: 'padded root secret' })).task_id
  assert.equal((await call(plain, 'task_board', {})).tasks.length, 0, 'distinct root IDs must not share the same task scope')
  assert.equal((await call(plain, 'task_board', { task_id: id })).code, 'E_CROSS_RUN')
  assert.equal((await call(plain, 'task_close', { task_id: id, result: 'failed' })).code, 'E_CROSS_RUN')
  assert.equal(store.taskOf(id, ' root ').task.run_id, ' root ')
  assert.equal(store.board({}, 'root').tasks.length, 0)
  assert.throws(() => store.taskOf(id, 'root'), { code: 'E_CROSS_RUN' })
  assert.throws(() => store.board(id, 'root'), { code: 'E_CROSS_RUN' })
  await call(padded, 'task_fact', { task_id: id, kind: 'artifact', statement: 'private artifact', evidence_path: 'PRIVATE_ARTIFACT' })
  await call(padded, 'task_submit', { task_id: id })
  assert.equal((await call(padded, 'task_accept', { task_id: id })).ok, true)
  const foreignHistory = await call(plain, 'task_board', { task_id: id, view: 'facts' })
  assert.equal(foreignHistory.code, 'E_CROSS_RUN')
  assert.doesNotMatch(JSON.stringify(foreignHistory), /PRIVATE_ARTIFACT|private artifact/)
  assert((await call(padded, 'task_board', { task_id: id, view: 'facts' })).facts.some(f => f.evidence === 'PRIVATE_ARTIFACT'))
  assert.throws(() => store.boardPage({ task_id: id, view: 'facts' }, 'root'), { code: 'E_CROSS_RUN' })
})

test('native padded real owner completes strict verification with exact receipt ownership and audit', options, async t => {
  const { ctx, agent } = await fixture(t)
  const [{ LocalSubprocessRuntime }, { LocalBashExecutor }, { ShellEnvRegistry }, bash, { apply: applyTools }, { tempStore }] = await Promise.all([
    native('@deepseek-ai/dsh-subprocess-local'), native('@deepseek-ai/dsh-bash-local'), native('@deepseek-ai/dsh-shell-env'),
    native('@deepseek-ai/dsh-tool-bash'), import('../../lib/tools/index.js'), import('./helpers.mjs'),
  ])
  const { writeFile } = await import('node:fs/promises')
  const cwd = await mkdtemp(join(tmpdir(), 'taskforce-padded-receipt-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'source.js'), 'source\n')
  new LocalSubprocessRuntime(ctx)
  new ShellEnvRegistry(ctx)
  new LocalBashExecutor(ctx, LocalBashExecutor.Config({ cwd, maxTimeoutMs: 120000 }))
  bash.apply(ctx, { enableRunInBackground: false, promoteOnTimeout: false })
  const store = tempStore(t), main = agent('exact-receipt-root', undefined, { cwd })
  const worker = agent(' worker ', undefined, { cwd, origin: 'subagent', delegationDepth: 1, parentSession: 'exact-receipt-root' })
  const sibling = agent('worker', undefined, { cwd, origin: 'subagent', delegationDepth: 1, parentSession: 'exact-receipt-root' })
  const byId = new Map([main, worker, sibling].map(a => [a.session.header.id, a]))
  ctx.provide('taskforceStore', store)
  ctx.provide('agents', { get: id => byId.get(id) })
  applyTools(ctx)
  applyScope(ctx)
  for (const a of [main, worker, sibling]) await ctx.serial('agent/created', { agent: a })
  let sequence = 0
  const call = async (caller, name, args) => {
    const result = await caller.ctx.tools.execute({ agent: caller, callId: `exact-receipt-${++sequence}`, name,
      arguments: args, signal: new AbortController().signal })
    assert.equal(result.isError, false, result.error?.message)
    return JSON.parse(result.value)
  }
  const command = "printf 'exact owner receipt\\n'"
  const id = (await call(main, 'task_open', { title: 'padded strict owner', evidence_policy: 'execution',
    verification_files: ['source.js'], verification_command: command })).task_id
  await call(worker, 'task_claim', { task_id: id, child_id: 'shared-label' })
  assert.equal((await call(worker, 'task_verify', { task_id: id, command })).verified, true)
  const receipt = store.board(id, 'exact-receipt-root').receipts[0]
  assert.equal(receipt.owner_session, ' worker ')
  assert.equal(receipt.actor_session, ' worker ')
  assert.equal((await call(sibling, 'task_verify', { task_id: id, command })).code, 'E_TASK_CONFLICT')
  assert.equal((await call(worker, 'task_submit', { task_id: id, note: 'verified padded owner' })).ok, true)
  assert.equal((await call(main, 'task_accept', { task_id: id })).ok, true)
})
