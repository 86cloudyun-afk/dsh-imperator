import assert from 'node:assert/strict'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { TASKFORCE_DEFINITION } from '../../lib/preset.js'
import { installationVersion } from '../host-runtime.mjs'
import { apply as applyScope, DENY_CODE } from '../../lib/plugins/orchestrator-scope.mjs'

// Integration supplies an explicit installation; offline checks never claim a
// native boundary was tested when the host is absent.
const anchor = process.env.DSH_INSTALL_ANCHOR
const native = async (name) => import(pathToFileURL(createRequire(anchor).resolve(name)).href)
const options = { skip: !anchor && 'requires DSH_INSTALL_ANCHOR' }

// Native Session + pure fork preparation with explicitly authorized hook scope.
// No agent loop, model/provider request or actual delegation runs in this fixture.
async function forkObservationFixture() {
  const [{ Session }, { createToolResultMessage }, forkProvider, guard, context] = await Promise.all([
    native('@deepseek-ai/dsh-session'), native('@deepseek-ai/dsh-llm'), native('@deepseek-ai/dsh-subagent-fork-in-process'),
    import('../../lib/plugins/guard.mjs'), import('../../lib/plugins/working-context.mjs'),
  ])
  let provider
  forkProvider.apply({ subagents: { registerProvider: value => { provider = value } } }, { providerName: 'fork' })
  const childHeader = (id, parent, isSeeded) => ({ version: 4, id, createdAt: 0, isSeeded,
    origin: 'subagent', parentSession: parent.id, delegationDepth: 1 })
  const fork = async (parent, id) => {
    const { seed } = await provider.prepareContinuable({ parent: { session: parent } })
    return Session.create(id, seed, childHeader(id, parent, seed !== undefined), seed?.length ?? 0)
  }
  const hook = (apply, session, config) => {
    const hooks = new Map()
    apply({ preset: 'taskforce', on: (name, fn) => hooks.set(name, fn),
      get: name => name === 'agentPresets' ? { composedPreset: scope => scope?.preset } : undefined,
    }, config)
    const agent = { session, ctx: { preset: 'taskforce' } }
    return { agent, pre: () => hooks.get('agent/pre-step')({ agent, turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] })) }
  }
  const calls = (session, prefix, count, { failure = false, unknown = false, offset = 0 } = {}) => {
    for (let index = 1; index <= count; index++) {
      const step = offset + index, callId = `${prefix}-${step}`
      session.append('step/start', { turn: 1, step })
      const call = session.append('tool/call', { turn: 1, step, callId,
        name: failure ? 'read_counter' : 'subagent', arguments: '{}' })
      session.append('tool/result', { turn: 1, step,
        message: createToolResultMessage({ callId, isError: failure, content: [{ type: 'text', text: 'fixture receipt' }] }),
        ...(unknown ? { error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } } : {}),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      session.append('step/end', { turn: 1, step })
    }
  }
  const restore = session => Session.fromRestore(session.id, guard.sessionEvents(session), session.header,
    session.inheritedEventCount, 'shared-frozen')
  return { Session, guard, context, fork, hook, calls, restore, childHeader,
    guardOptions: { stallAction: 'observe', stepDownRequests: 0 } }
}

test('native fork owned observation: completed prefix, dispatch append and restore', options, async () => {
  const { Session, guard, context, fork, hook, calls, restore, childHeader } = await forkObservationFixture()
  const text = value => value.messages.map(message => message.content[0].text).join('\n')
  const parent = Session.create('owned-flow-parent')
  const fresh = Session.create('owned-flow-fresh', undefined, childHeader('owned-flow-fresh', parent, false), 0)
  for (const session of [parent, fresh]) {
    assert.equal(session.inheritedEventCount, 0)
    assert.deepEqual((await hook(context.apply, session).pre()).messages, [])
  }
  parent.append('turn/start', { turn: 1 })
  assert.equal((await fork(parent, 'owned-no-prefix')).inheritedEventCount, 0)
  calls(parent, 'parent', 2)
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const completed = parent.seq
  parent.append('turn/start', { turn: 2 })
  parent.append('tool/call', { turn: 2, step: 1, callId: 'current-fork', name: 'subagent_fork', arguments: '{}' })
  const child = await fork(parent, 'owned-flow-child')
  assert.equal(child.inheritedEventCount, completed)
  assert.equal(guard.sessionEvents(child)[completed].type, 'session/end-seed')
  assert.equal(guard.sessionEvents(child).some(event => event.data?.callId === 'current-fork'), false)
  const h = hook(context.apply, child)
  assert.deepEqual((await h.pre()).messages, [], 'parent dispatches must not count as child activity')
  child.append('turn/start', { turn: 1 })
  calls(child, 'child', 1)
  assert.match(text(await h.pre()), /未结算派发估计 1/)
  const restored = restore(child)
  assert.equal(restored.inheritedEventCount, completed)
  assert.ok(restored.firstLiveSeq > restored.inheritedEventCount)
  assert.match(text(await hook(context.apply, restored).pre()), /未结算派发估计 1/)
})

test('native fork owned observation: ECHO, own acknowledgment and unknown-effect barrier', options, async () => {
  const { Session, guard, fork, hook, calls, restore, guardOptions } = await forkObservationFixture()
  const parent = Session.create('owned-guard-parent')
  parent.append('turn/start', { turn: 1 })
  calls(parent, 'parent-failure', 6, { failure: true })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal((await hook(guard.apply, restore(parent), guardOptions).pre()).messages[0]?.source.signal, 'echo',
    'restored root retains its own failures')
  const child = await fork(parent, 'owned-guard-child')
  child.append('turn/start', { turn: 1 })
  const h = hook(guard.apply, child, guardOptions)
  assert.deepEqual((await h.pre()).messages, [], 'child with zero own calls has no inherited ECHO')
  calls(child, 'own-failure', 6, { failure: true })
  const warning = (await h.pre()).messages[0]
  assert.equal(warning?.source.signal, 'echo')
  assert.equal((await hook(guard.apply, restore(child), guardOptions).pre()).messages[0]?.source.signal, 'echo')
  child.append('user/message', warning, { surfaceOp: 'append' })
  assert.deepEqual((await hook(guard.apply, restore(child), guardOptions).pre()).messages, [], 'own persisted ACK survives restore')
  const unknown = await fork(parent, 'owned-guard-unknown')
  unknown.append('turn/start', { turn: 1 })
  calls(unknown, 'before', 6, { failure: true })
  calls(unknown, 'unknown', 1, { failure: true, unknown: true, offset: 6 })
  calls(unknown, 'after', 4, { failure: true, offset: 7 })
  assert.deepEqual((await hook(guard.apply, unknown, guardOptions).pre()).messages, [])
})

test('native fork owned observation: real SQLite excludes parent lifecycle and deduplicates restored child', options, async t => {
  const [{ TaskforceStore }, { attachRecoveryLifecycle }, f] = await Promise.all([
    import('../../lib/store/index.js'), import('../../lib/plugins/lifecycle.mjs'), forkObservationFixture(),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'taskforce-native-owned-'))
  const store = new TaskforceStore(directory)
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); await assert.rejects(access(directory), { code: 'ENOENT' }) })
  const lifecycle = session => f.hook(ctx => attachRecoveryLifecycle(ctx, {
    identity: () => ({ runId: 'owned-life-root' }), recovery: () => store.recovery,
  }), session)
  const rows = session => store.open().prepare("SELECT event_seq FROM lifecycle_event WHERE session_id=? AND source='session_event' ORDER BY id").all(session.id).map(row => row.event_seq)
  const parent = f.Session.create('owned-life-root')
  const fresh = f.Session.create('owned-life-fresh', undefined, f.childHeader('owned-life-fresh', parent, false), 0)
  await lifecycle(parent).pre(); await lifecycle(fresh).pre()
  assert.deepEqual(rows(parent), []); assert.deepEqual(rows(fresh), [])
  parent.append('turn/start', { turn: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const child = await f.fork(parent, 'owned-life-child')
  const start = child.append('turn/start', { turn: 1 })
  const h = lifecycle(child)
  await h.pre()
  assert.deepEqual(rows(child), [start.seq], 'parent seq 0 and 1 must never be attributed to child')
  const end = child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await h.pre(); await h.pre()
  const restored = f.restore(child)
  await lifecycle(restored).pre()
  assert.equal(restored.inheritedEventCount, 2)
  assert.ok(restored.firstLiveSeq > end.seq)
  assert.deepEqual(rows(child), [start.seq, end.seq])
  await lifecycle(f.restore(parent)).pre()
  assert.deepEqual(rows(parent), [0, 1])
  assert.deepEqual([...store.recovery.observationGaps], [])
  t.diagnostic(JSON.stringify({ host: installationVersion(anchor), inheritedCut: 2, childSeqs: rows(child),
    firstLiveSeq: restored.firstLiveSeq, modelRequests: 0, fixtureScope: 'native Session and SQLite; explicit preset registry' }))
})

test('actual native immutable Session appends match full folds; mutable restored seeds replay', options, async () => {
  const [{ Session }, { createToolResultMessage }, projections, guard, flow] = await Promise.all([
    native('@deepseek-ai/dsh-session'), native('@deepseek-ai/dsh-llm'),
    import('../../lib/plugins/event-projection.mjs'), import('../../lib/plugins/guard.mjs'),
    import('../../lib/plugins/working-context.mjs'),
  ])
  const session = Session.create('projection-native')
  const g = projections.createGuardProjection({ echoFailures: 2 })
  const f = projections.createFlowProjection()
  const read = () => {
    const events = session.snapshotEvents()
    assert.deepEqual(g.read(events), guard.foldGuardSignals(events, { echoFailures: 2 }))
    assert.deepEqual(f.read(events), flow.foldSubagentFlow(events))
    assert.equal(g.processedEvents, events.length)
    assert.equal(f.processedEvents, events.length)
    assert.deepEqual(f.read(events), flow.foldSubagentFlow(events))
    assert.equal(f.processedEvents, events.length, 'same immutable native history must reuse its reducer')
  }
  session.append('turn/start', { turn: 1 }); read()
  session.append('step/start', { turn: 1, step: 1 }); read()
  session.append('tool/call', { turn: 1, step: 1, callId: 'child', name: 'subagent', arguments: '{}' }); read()
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: 'child', content: [{ type: 'text', text: 'denied' }], isError: true }) },
  { surfaceOp: 'append', sourceEventSeqs: [2] }); read()
  session.append('step/end', { turn: 1, step: 1 }); read()
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); read()
  assert.equal(f.read(session.snapshotEvents()).dispatched, 1)
  const restored = Session.fromRestore(session.header.id, structuredClone(session.snapshotEvents()),
    structuredClone(session.header), 0, 'detached')
  const events = restored.snapshotEvents()
  assert.equal(Object.isFrozen(events[2].data), false)
  const restoredGuard = projections.createGuardProjection({ echoFailures: 2 })
  const restoredFlow = projections.createFlowProjection()
  restoredGuard.read(events); restoredFlow.read(events)
  events[2].data.name = 'read'
  assert.equal(restored.snapshotEvents(), events, 'restored in-place mutation retains snapshot identity')
  assert.deepEqual(restoredGuard.read(events), guard.foldGuardSignals(events, { echoFailures: 2 }))
  assert.deepEqual(restoredFlow.read(events), flow.foldSubagentFlow(events))
  assert.equal(restoredFlow.read(events).dispatched, 0, 'in-place mutation must change the result')
  assert.equal(restoredGuard.processedEvents, events.length * 2)
  assert.equal(restoredFlow.processedEvents, events.length * 3)
})

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

async function mountNativeWorkingDirectory(ctx, cwd) {
  if (installationVersion(anchor) !== '0.2.1-alpha.2') return
  const [{ default: LocalFileSystem }, { default: SessionProjectionRegistry }, { default: WorkingDirectory }] = await Promise.all([
    native('@deepseek-ai/dsh-fs-local'), native('@deepseek-ai/dsh-session-projection'), native('@deepseek-ai/dsh-working-directory'),
  ])
  if (!ctx.get('fs')) await ctx.plugin(LocalFileSystem, { cwd })
  if (!ctx.get('sessionProjections')) await ctx.plugin(SessionProjectionRegistry)
  if (!ctx.get('workingDirectory')) await ctx.plugin(WorkingDirectory, { defaultDirectory: cwd })
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
  await mountNativeWorkingDirectory(ctx, root)
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
  await mountNativeWorkingDirectory(ctx, cwd)
  await ctx.plugin(bash, { enableRunInBackground: false, promoteOnTimeout: false })
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

for (const scenario of ['foreground', 'promoted']) {
  test(`native task_verify default job policy: ${scenario} observation and owner cleanup`, options, async t => {
    const { ctx, agent } = await fixture(t)
    const [{ LocalSubprocessRuntime }, { LocalBashExecutor }, { ShellEnvRegistry }, { LocalJobRegistry },
      bash, { apply: applyTools }, { tempStore }, { writeFile, readFile }] = await Promise.all([
      native('@deepseek-ai/dsh-subprocess-local'), native('@deepseek-ai/dsh-bash-local'),
      native('@deepseek-ai/dsh-shell-env'), native('@deepseek-ai/dsh-jobs-local'), native('@deepseek-ai/dsh-tool-bash'),
      import('../../lib/tools/index.js'), import('./helpers.mjs'), import('node:fs/promises'),
    ])
    const cwd = await mkdtemp(join(tmpdir(), 'taskforce-native-job-'))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    await writeFile(join(cwd, 'source.js'), 'source\n')
    const store = tempStore(t), run = `job-${scenario}-root`, owner = `job-${scenario}-worker`
    const main = agent(run, undefined, { cwd })
    const worker = agent(owner, undefined, { cwd, origin: 'subagent', delegationDepth: 1, parentSession: run })
    // Native Bash binds job ownership to Agent.id; these scoped fixtures do not run an agent loop.
    main.id = run; worker.id = owner
    const byId = new Map([[run, main], [owner, worker]])
    ctx.provide('taskforceStore', store)
    ctx.provide('agents', { get: id => byId.get(id) })
    new LocalSubprocessRuntime(ctx)
    new ShellEnvRegistry(ctx)
    new LocalBashExecutor(ctx, LocalBashExecutor.Config({ cwd, maxTimeoutMs: 120000 }))
    await mountNativeWorkingDirectory(ctx, cwd)
    new LocalJobRegistry(ctx, LocalJobRegistry.Config({ pumpPollMs: 5 }))
    ctx.jobs.attachController('verification-boundary')
    await ctx.plugin(bash)
    applyTools(ctx)
    const command = scenario === 'promoted'
      ? "printf 'partial proof\\n'; sleep 1; printf 'finished\\n'" : "printf 'foreground proof\\n'"
    const timeout_ms = scenario === 'promoted' ? 50 : 1000
    const id = store.openTask({ title: scenario, evidence_policy: 'execution',
      verification_files: ['source.js'], verification_command: command }, run, { sessionId: run, cwd, isRoot: true }).task_id
    store.claimTask({ task_id: id, child_id: 'worker' }, run, owner, owner)
    let observedBash, bashCalls = 0
    ctx.tools.guard(exec => {
      if (exec.name !== 'bash') return
      bashCalls++
      assert.equal(exec.agent, worker)
      assert.equal(exec.arguments.run_in_background, false)
    })
    ctx.on('tools/result', (exec, result) => {
      if (exec.name === 'bash') observedBash = structuredClone(result)
    })
    try {
      const outer = await worker.ctx.tools.execute({ agent: worker, callId: `native-job-${scenario}`, name: 'task_verify',
        arguments: { task_id: id, command, timeout_ms }, signal: new AbortController().signal })
      assert.equal(outer.isError, false, outer.error?.message)
      const result = JSON.parse(outer.value), row = store.board(id, run).receipts[0]
      assert.equal(bashCalls, 1)
      assert.equal(observedBash.isError, false)
      assert.equal(observedBash.value.kind, scenario)
      t.diagnostic(JSON.stringify({ host: installationVersion(anchor), scenario, native: observedBash,
        result, modelRequests: 0 }))
      store.submitTask({ task_id: id }, run, owner, owner)
      if (scenario === 'foreground') {
        assert.equal(result.verified, true)
        assert.equal(Object.hasOwn(result, 'native_job'), false)
        assert.equal(Object.hasOwn(result, 'next'), false)
        assert.equal(await readFile(row.logs.stdout.path, 'utf8'), 'foreground proof\n')
        assert.equal(store.acceptTask({ task_id: id }, run, 'lead', run).execution_verified, true)
        assert.deepEqual(ctx.jobs.list(owner), [])
      } else {
        assert.equal(result.status, 'unknown'); assert.equal(result.verified, false)
        assert.equal(result.output_complete, false)
        assert.throws(() => store.acceptTask({ task_id: id }, run, 'lead', run), { code: 'E_VERIFICATION_RECEIPT' })
        assert.equal(row.owner_session, owner); assert.equal(row.kind, 'promoted')
        assert.equal(row.actual_timeout_ms, null)
        assert.equal(await readFile(row.logs.stdout.path, 'utf8'), '')
        assert.equal(await readFile(row.logs.stderr.path, 'utf8'), '')
        assert.equal(Object.hasOwn(row, 'native_job'), false)
        assert.match(observedBash.value.jobId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
        assert.equal(observedBash.value.timeoutMs, timeout_ms)
        assert.equal(ctx.jobs.get(observedBash.value.jobId, owner).id, observedBash.value.jobId)
        assert.throws(() => ctx.jobs.get(observedBash.value.jobId, run), /belongs to another session/)
        assert.deepEqual(result.native_job, { kind: 'promoted', job_id: observedBash.value.jobId,
          timeout_ms, scope: 'current-owner-process', durable: false }, 'native promotion locator must reach the invoking owner')
        assert.match(result.next, /发起本次验证的原生会话.*当前进程.*job_output\/job_kill.*确认 job 已结束后.*重新验证/)
      }
    } finally {
      // Keep cleanup independent of the response assertion, including during RED.
      for (const job of ctx.jobs.list(owner)) {
        ctx.jobs.kill(job.id, owner, 'bounded native verifier test cleanup')
        const settled = await ctx.jobs.wait(job.id, 2000, owner)
        assert.notEqual(settled.status, 'running'); assert.notEqual(settled.status, 'stopping')
        t.diagnostic(JSON.stringify({ host: installationVersion(anchor), cleanup: { job_id: job.id, status: settled.status } }))
      }
      assert.equal(ctx.jobs.list(owner).some(job => ['running', 'stopping'].includes(job.status)), false)
    }
  })
}

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
  await mountNativeWorkingDirectory(ctx, cwd)
  await ctx.plugin(bash, { enableRunInBackground: false, promoteOnTimeout: false })
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

test('native model harness applies fixed output capacity through provider, agent and genuine child options without calls', options, async t => {
  const { createNativeHarness } = await import('../verify-model.mjs')
  const workspace = await mkdtemp(join(tmpdir(), 'taskforce-native-capacity-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let observed = false, requests = 0
  const harness = await createNativeHarness({ installAnchor: anchor,
    packageRoot: new URL('../..', import.meta.url).pathname, workspace, provider: 'deepseek-official', model: 'deepseek-v4-pro',
    onRequest() { requests++; throw new Error('capacity probe forbids model requests') },
  }, { inspectNative: async ({ ctx, root }) => {
    observed = true
    assert.equal(root.options.maxTokens, 8192)
    const provider = await ctx.llm.resolveModelInfo('deepseek-official', 'capacity-probe-uncatalogued')
    assert.equal(provider.defaultMaxTokens, 8192, 'actual provider fallback must match the fixed capacity')
    const rootConfig = (await ctx.llm.prepareCall(root.options)).config
    assert.equal(rootConfig.maxTokens, 8192)
    // A catalog entry can override the provider fallback, but must not
    // override the explicit root or inherited child allowance.
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'llm-deepseek')
    assert.ok(entry)
    await entry.update({ config: { ...entry.options.config, models: [{ id: root.options.model, maxTokens: 16384 }] } })
    await ctx.loader.await()
    const catalog = await ctx.llm.resolveCallConfig({ provider: root.options.provider, model: root.options.model })
    assert.equal(catalog.maxTokens, 16384)
    assert.equal((await ctx.llm.prepareCall(root.options)).config.maxTokens, 8192)
    const { resolveChildAgentOptions, applyChildComposition, childSessionMeta } = await native('@deepseek-ai/dsh-subagent')
    const child = await ctx.agents.create({ sessionId: 'capacity-probe-child', parentAgent: root,
      agentOptions: resolveChildAgentOptions(root, undefined, 1), meta: childSessionMeta(root, 1, false),
      setup: childCtx => applyChildComposition(childCtx, root, {}),
    })
    try {
      assert.equal(child.agent.options.maxTokens, 8192)
      const childConfig = (await ctx.llm.prepareCall(child.agent.options)).config
      assert.equal(childConfig.maxTokens, 8192)
      assert.equal(childConfig.reasoningEffort, rootConfig.reasoningEffort)
      // Prove actual request-option precedence against a different provider default,
      // using public resolution only; never consume a prepared stream.
      const explicit = await ctx.llm.resolveCallConfig({ ...root.options, maxTokens: 4096 })
      assert.equal(explicit.maxTokens, 4096)
      assert.equal(explicit.reasoningEffort, rootConfig.reasoningEffort)
      assert.equal(requests, 0)
      t.diagnostic(JSON.stringify({ providerDefaultMaxTokens: provider.defaultMaxTokens,
        catalogDefaultMaxTokens: catalog.maxTokens, rootMaxTokens: rootConfig.maxTokens,
        childMaxTokens: childConfig.maxTokens, explicitOverrideMaxTokens: explicit.maxTokens,
        effortUnchanged: childConfig.reasoningEffort === rootConfig.reasoningEffort, modelRequests: requests }))
    } finally { await child.dispose() }
  } })
  try { assert.equal(observed, true, 'native configuration probe must inspect the actual harness wiring'); assert.equal(requests, 0) }
  finally { await harness.dispose() }
})

test('actual native observation policy requires worker reads, survives live edits and resets on cold resume', options, async t => {
  const { createNativeHarness } = await import('../verify-model.mjs')
  const { writeFile, readFile } = await import('node:fs/promises')
  const workspace = await mkdtemp(join(tmpdir(), 'taskforce-native-read-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const file = join(workspace, 'observed.txt')
  await writeFile(file, 'alpha\n')
  let requests = 0, inspected = false
  const harness = await createNativeHarness({ installAnchor: anchor,
    packageRoot: new URL('../..', import.meta.url).pathname, workspace, provider: 'deepseek-official', model: 'deepseek-v4-pro',
    onRequest() { requests++; throw new Error('observation probe forbids model requests') },
  }, { inspectNative: async ({ ctx, root }) => {
    inspected = true
    const { createToolResultMessage, createAssistantMessage } = await native('@deepseek-ai/dsh-llm')
    const { resolveChildAgentOptions, applyChildComposition, childSessionMeta } = await native('@deepseek-ai/dsh-subagent')
    const worker = TASKFORCE_DEFINITION.plugins.find(row => row.id === 'delegation').config.find(row => row.id === 'tool-subagent').config
    const setup = childCtx => applyChildComposition(childCtx, root, { persona: worker.persona })
    const agentOptions = resolveChildAgentOptions(root, undefined, 1)
    let child = await ctx.agents.create({ sessionId: 'native-read-child', parentAgent: root, agentOptions,
      meta: childSessionMeta(root, 1, false), setup })
    const observations = []
    ctx.on('fs/observed', (_target, observation, actor) => observations.push({ session: actor.agent.session, kind: observation.kind }))
    let call = 0
    const turns = new Map()
    const execute = async (agent, name, args) => {
      const turn = (turns.get(agent.id) ?? 0) + 1, step = 1, callId = `read-policy-${++call}`
      turns.set(agent.id, turn)
      agent.session.append('turn/start', { turn })
      agent.session.append('step/start', { turn, step })
      // Advertise the synthetic, unpaid tool dispatch using the SDK message
      // constructor so the real persistence validator can restore this log.
      agent.session.append('assistant/message', { turn, step, stream: [],
        message: createAssistantMessage({ source: { provider: 'native-probe', model: 'native-probe' },
          content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] }) }, { surfaceOp: 'append' })
      const called = agent.session.append('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
      const result = await agent.ctx.tools.execute({ agent, name, arguments: args, callId, signal: new AbortController().signal })
      agent.session.append('tool/result', { turn, step,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        ...(result.error?.info ? { error: result.error.info } : {}) },
      { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
      agent.session.append('step/end', { turn, step })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return result
    }
    const edit = (old_string, new_string) => execute(child.agent, 'edit', { file_path: file, old_string, new_string })
    const read = agent => execute(agent, 'read', { file_path: file })
    const expectCode = (result, code) => { assert.equal(result.isError, true); assert.equal(result.error?.info?.code, code) }
    try {
      expectCode(await edit('alpha', 'beta'), 'FS_NOT_OBSERVED')
      expectCode(await execute(child.agent, 'write', { file_path: file, content: 'forbidden overwrite\n' }), 'FS_NOT_OBSERVED')
      assert.equal(await readFile(file, 'utf8'), 'alpha\n')
      assert.equal((await read(root)).isError, false)
      expectCode(await edit('alpha', 'beta'), 'FS_NOT_OBSERVED')
      const countBeforeShell = observations.length
      const shellRead = await execute(child.agent, 'bash', { command: 'cat observed.txt; grep alpha observed.txt',
        description: 'Read the observation fixture through shell tools' })
      assert.equal(shellRead.isError, false)
      assert.equal(shellRead.value.kind, 'foreground')
      assert.equal(shellRead.value.exitCode, 0)
      assert.equal(shellRead.value.stdout.text, 'alpha\nalpha\n')
      assert.equal(observations.length, countBeforeShell, 'shell reads cannot create native observation state')
      expectCode(await edit('alpha', 'beta'), 'FS_NOT_OBSERVED')
      const searched = await execute(child.agent, 'grep', { pattern: 'alpha', path: file })
      assert.equal(searched.isError, false)
      assert.match(JSON.stringify(searched.content), /observed\.txt/)
      assert.equal(observations.length, countBeforeShell, 'native grep is search, not an authoritative file read')
      expectCode(await edit('alpha', 'beta'), 'FS_NOT_OBSERVED')
      assert.equal((await read(child.agent)).isError, false)
      assert.equal(observations.at(-1).session, child.agent.session)
      assert.equal((await edit('alpha', 'beta')).isError, false)
      assert.equal((await edit('beta', 'gamma')).isError, false, 'successful edit refreshes the version for another edit')
      assert.equal((await execute(child.agent, 'write', { file_path: file, content: 'written\n' })).isError, false)
      assert.equal((await edit('written', 'gamma')).isError, false, 'successful write also refreshes the observation')
      assert.equal(await readFile(file, 'utf8'), 'gamma\n')
      await writeFile(file, 'external-change\n')
      expectCode(await edit('external-change', 'delta'), 'FS_STALE_VERSION')
      assert.equal(await readFile(file, 'utf8'), 'external-change\n')
      assert.equal((await read(child.agent)).isError, false)
      assert.equal((await edit('external-change', 'delta')).isError, false)
      const priorSession = child.agent.session
      const priorEvents = priorSession.snapshotEvents().length
      assert.ok(priorSession.snapshotEvents().some(e => e.type === 'tool/call' && e.data.name === 'read'))
      await ctx.sessions.flush(priorSession)
      await child.dispose()
      child = await ctx.agents.resume({ resumeSessionId: 'native-read-child', parentAgent: root, agentOptions, setup })
      assert.equal(child.agent.id, 'native-read-child')
      assert.notEqual(child.agent.session, priorSession)
      assert.ok(child.agent.session.snapshotEvents().length >= priorEvents)
      assert.ok(child.agent.session.snapshotEvents().some(e => e.type === 'tool/call' && e.data.name === 'read'))
      expectCode(await edit('delta', 'resumed'), 'FS_NOT_OBSERVED')
      assert.equal(await readFile(file, 'utf8'), 'delta\n')
      assert.equal((await read(child.agent)).isError, false)
      assert.equal((await edit('delta', 'resumed')).isError, false)
      assert.equal((await edit('resumed', 'finished')).isError, false)
      assert.equal(await readFile(file, 'utf8'), 'finished\n')
      assert.equal((await execute(root, 'edit', { file_path: file, old_string: 'finished', new_string: 'forbidden' })).isError, true)
      assert.equal(await readFile(file, 'utf8'), 'finished\n')
      assert.equal(requests, 0)
      t.diagnostic('native observation proof: unseen/root-read/shell/native-grep/cold-resume rejected; worker read/write/edit and repeated edits pass; external change rejected; restored history retained; model requests 0')
    } finally { await child.dispose() }
  } })
  try { assert.equal(inspected, true); assert.equal(requests, 0) }
  finally { await harness.dispose() }
})

test('genuine mounted spawn fork and resumed workers receive the native read discipline', options, async t => {
  const { createNativeHarness } = await import('../verify-model.mjs')
  const workspace = await mkdtemp(join(tmpdir(), 'taskforce-read-persona-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let requests = 0, rendered = 0
  const harness = await createNativeHarness({ installAnchor: anchor,
    packageRoot: new URL('../..', import.meta.url).pathname, workspace, provider: 'deepseek-official', model: 'deepseek-v4-pro',
    onRequest() { requests++; throw new Error('persona probe forbids model requests') },
  }, { inspectNative: async ({ ctx, root }) => {
    const { renderPrompt } = await native('@deepseek-ai/dsh-system-prompt')
    const { resolveChildAgentOptions, applyChildComposition, childSessionMeta } = await native('@deepseek-ai/dsh-subagent')
    const assertDirectory = (agent, assembly) => {
      if (installationVersion(anchor) === '0.2.1-alpha.2') {
        assert.equal(assembly.sections.some(section => section.name === 'taskforce:working-directory'), false)
        assert.equal(assembly.contexts.find(context => context.name === 'working-directory:current')?.text,
          'Current working directory: ' + JSON.stringify(workspace) + '.')
        assert.equal(ctx.get('workingDirectory').get(agent.session), workspace)
      } else {
        assert.equal(assembly.variables.cwd, workspace)
        assert.ok(renderPrompt(assembly).includes(workspace), 'legacy native cwd must remain visible in the prompt')
      }
    }
    const assertWorker = async agent => {
      const assembly = await agent.ctx.systemPrompt.assemble({ scope: agent, agent })
      assertDirectory(agent, assembly)
      const prompt = renderPrompt(assembly)
      for (const contract of [/已有文件.*原生 read/, /新任务或续作.*重读/, /旧对话.*其他代理.*shell cat\/grep.*替代/,
        /原生写入\/编辑成功.*更新观察.*无需逐次重读/, /FS_NOT_OBSERVED.*FS_STALE_VERSION.*read.*核对修改/]) {
        assert.match(prompt, contract)
      }
      assert.doesNotMatch(prompt, /不执行命令/)
      assert.ok(agent.ctx.tools.schemas(agent).some(tool => tool.name === 'edit'))
      rendered++
    }
    const rootAssembly = await root.ctx.systemPrompt.assemble({ scope: root, agent: root })
    assertDirectory(root, rootAssembly)
    const rootPrompt = renderPrompt(rootAssembly)
    assert.match(rootPrompt, /不执行命令/)
    assert.equal(root.ctx.tools.schemas(root).some(tool => tool.name === 'edit'), false)
    for (const row of TASKFORCE_DEFINITION.plugins.find(row => row.id === 'delegation').config.filter(row => row.name === '@deepseek-ai/dsh-tool-subagent')) {
      const agentOptions = resolveChildAgentOptions(root, undefined, 1)
      const setup = childCtx => applyChildComposition(childCtx, root, { persona: row.config.persona })
      let child = await ctx.agents.create({ sessionId: `read-persona-${row.config.provider}`, parentAgent: root,
        agentOptions, meta: childSessionMeta(root, 1, false), setup })
      try {
        await assertWorker(child.agent)
        await ctx.sessions.flush(child.agent.session)
        await child.dispose()
        child = await ctx.agents.resume({ resumeSessionId: `read-persona-${row.config.provider}`, parentAgent: root, agentOptions, setup })
        await assertWorker(child.agent)
      } finally { await child.dispose() }
    }
  } })
  try { assert.equal(rendered, 4); assert.equal(requests, 0) }
  finally { await harness.dispose() }
})

test('native mounted compactor is rejected by the global stream boundary before any provider dispatch', options, async t => {
  const { createNativeHarness, diagnoseModelRuntime } = await import('../verify-model.mjs')
  const workspace = await mkdtemp(join(tmpdir(), 'taskforce-native-stream-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let providerDispatches = 0, requests = 0, inspected = false
  const harness = await createNativeHarness({ installAnchor: anchor,
    packageRoot: new URL('../..', import.meta.url).pathname, workspace, provider: 'deepseek-official', model: 'deepseek-flash',
    onRequest() { requests++ },
  }, { inspectNative: async ({ ctx, root }) => {
    // Last waterfall listener is a zero-network provider sentinel. It must
    // remain unreachable when the real mounted native summarizer calls stream.
    ctx.on('llm/stream', () => (async function* () { providerDispatches++; throw new Error('unpaid sentinel') })(), { global: true })
    const compactor = ctx.agentPresets.serviceFor(root, 'compaction')
    assert.equal(compactor.config.auto, true)
    assert.equal(compactor.config.maxTokens, 65536, 'production compactor configuration is preserved')
    await assert.rejects(compactor.summarize({ messages: [] }, root), /usage-or-runtime-error/)
    inspected = true
  } })
  try {
    assert.equal(inspected, true)
    assert.equal(providerDispatches, 0)
    assert.equal(requests, 0)
    assert.equal(diagnoseModelRuntime(harness.snapshot()).counts['auxiliary-call'], 1)
    t.diagnostic(JSON.stringify({ actualNativeCompaction: true, auto: true, rejectedAuxiliaryStreams: 1, providerDispatches, requests }))
  } finally { await harness.dispose() }
})

for (const scenario of ['success', 'missing-usage', 'invalid-usage', 'error', 'cap', 'route', 'capacity']) {
  test(`native real root and child lifecycle stream boundary: ${scenario}`, options, async t => {
    const { createNativeHarness, diagnoseModelRuntime } = await import('../verify-model.mjs')
    const { createUserMessage, isAgentLoopRequest } = await native('@deepseek-ai/dsh-llm')
    const workspace = await mkdtemp(join(tmpdir(), 'taskforce-native-stream-loop-'))
    t.after(() => rm(workspace, { recursive: true, force: true }))
    let dispatches = 0, admitted = 0, latched = 0
    const seen = []
    const harness = await createNativeHarness({ installAnchor: anchor,
      packageRoot: new URL('../..', import.meta.url).pathname, workspace, provider: 'deepseek-official', model: 'deepseek-flash',
      onRequest() { if (scenario === 'cap' && admitted === 1) throw new Error('request-cap'); admitted++ },
      onFailure() { latched++ },
    }, { inspectNative: async ({ ctx, root }) => {
      ctx.on('llm/stream', request => (async function* () {
        dispatches++
        assert.equal(isAgentLoopRequest(request), true, 'actual native loop brand, never manufactured by this test')
        assert.equal(request.maxTokens, 8192)
        seen.push({ maxTokens: request.maxTokens, effort: request.reasoningEffort })
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '137' } }
        if (scenario !== 'missing-usage') yield { type: 'usage', usage: { inputTokens: scenario === 'invalid-usage' ? -1 : 2, outputTokens: 3 } }
        yield { type: 'finish', reason: { kind: scenario === 'error' ? 'error' : 'stop' } }
      })(), { global: true })
      const { resolveChildAgentOptions, applyChildComposition, childSessionMeta } = await native('@deepseek-ai/dsh-subagent')
      const child = await ctx.agents.create({ sessionId: 'stream-loop-child', parentAgent: root,
        agentOptions: { ...resolveChildAgentOptions(root, undefined, 1),
          ...(scenario === 'route' ? { model: 'deepseek-v4-pro' } : {}),
          ...(scenario === 'capacity' ? { maxTokens: 65536 } : {}) },
        meta: childSessionMeta(root, 1, false), setup: childCtx => applyChildComposition(childCtx, root, {}),
      })
      const turn = async agent => {
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Reply 137.' }] }))
        await agent.whenIdle()
      }
      try {
        if (scenario === 'success') await Promise.all([turn(root), turn(child.agent)])
        else { await turn(root); await turn(child.agent) }
        assert.equal(dispatches, scenario === 'success' ? 2 : 1)
        assert.equal(admitted, dispatches)
        assert.equal(latched > 0, scenario !== 'success')
        if (scenario === 'success') {
          assert.equal(seen[0].effort, seen[1].effort)
          for (const agent of [root, child.agent]) assert.equal(agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
        }
      } finally { await child.dispose() }
    } })
    try {
      const snapshot = harness.snapshot()
      assert.equal(snapshot.streamAccounting.records.length, admitted)
      if (scenario === 'success') {
        assert.deepEqual(snapshot.streamAccounting.records.map(r => r.usage), Array(2).fill({ inputTokens: 2, outputTokens: 3 }))
        assert.ok(snapshot.streamAccounting.records.every(r => r.complete && r.ended))
        assert.deepEqual(diagnoseModelRuntime(snapshot).failureCodes, [])
      } else assert.ok(diagnoseModelRuntime(snapshot).failureCodes.length > 0)
      t.diagnostic(JSON.stringify({ scenario, nativeLoopStreams: dispatches, admitted, latched, paidRequests: 0 }))
    } finally { await harness.dispose() }
  })
}

test('actual automatic pressure compaction caught by native pre-step still fails the verifier without a helper dispatch', options, async t => {
  const { createNativeHarness, runModelVerification } = await import('../verify-model.mjs')
  const outputDir = await mkdtemp(join(tmpdir(), 'taskforce-native-auto-report-'))
  t.after(() => rm(outputDir, { recursive: true, force: true }))
  let dispatches = 0, nativeCompactionErrors = 0
  const report = await runModelVerification({ modelCalls: true, installAnchor: anchor, provider: 'deepseek-official', model: 'deepseek-flash', outputDir }, {
    createHarness: config => createNativeHarness(config, { inspectNative: async ({ ctx, root }) => {
      const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'llm-deepseek')
      await entry.update({ config: { ...entry.options.config, models: [{ id: 'deepseek-flash', contextWindow: 131072 }] } })
      await ctx.loader.await()
      assert.equal(ctx.agentPresets.serviceFor(root, 'compaction').config.auto, true)
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'compaction/end' && event.data.error !== undefined) nativeCompactionErrors++
      }, { global: true })
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        const c = ctx.agentPresets.serviceFor(agent, 'compaction')
        t.diagnostic(JSON.stringify({ pressure: c.ctx.tokenMeter.measure(agent.session).totalTokens, capacity: (await c.ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).context?.contextWindow }))
        return next()
      }, { global: true, prepend: true })
      // A long local response creates real token-meter pressure. The next
      // genuine native pre-step invokes the unchanged mounted compactor.
      ctx.on('llm/stream', () => (async function* () {
        dispatches++
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '137 ' + 'local pressure fixture '.repeat(12000) } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(), { global: true })
    } }),
  })
  assert.equal(report.ok, false)
  assert.equal(report.failure, 'usage-or-runtime-error')
  assert.equal(report.requests, 1)
  assert.equal(dispatches, 1)
  assert.equal(report.usage.inputTokens, 2)
  assert.equal(nativeCompactionErrors, 1)
  assert.equal(report.runtimeDiagnostics.counts['auxiliary-call'], 1)
  assert.equal(report.runtimeDiagnostics.counts['compaction-error'], 1)
  assert.equal(report.stages[0].ok, true)
  assert.equal(report.stages[1].ok, false)
  assert.doesNotMatch(JSON.stringify(report), /local pressure fixture/)
  t.diagnostic(JSON.stringify({ automaticPressureCompaction: true, nativeCompactionErrors, admittedAgentStreams: report.requests,
    helperDispatches: 0, paidRequests: 0, failedStage: report.stages.at(-1).name }))
})

test('native child isolated compaction service cannot bypass the global boundary', options, async t => {
  const { createNativeHarness, diagnoseModelRuntime } = await import('../verify-model.mjs')
  const workspace = await mkdtemp(join(tmpdir(), 'taskforce-native-child-helper-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let dispatches = 0
  const harness = await createNativeHarness({ installAnchor: anchor,
    packageRoot: new URL('../..', import.meta.url).pathname, workspace, provider: 'deepseek-official', model: 'deepseek-flash',
    onRequest() { throw new Error('unexpected agent request') },
  }, { inspectNative: async ({ ctx, root }) => {
    ctx.on('llm/stream', () => (async function* () { dispatches++; throw new Error('unpaid sentinel') })(), { global: true })
    const { resolveChildAgentOptions, applyChildComposition, childSessionMeta } = await native('@deepseek-ai/dsh-subagent')
    const child = await ctx.agents.create({ sessionId: 'stream-helper-child', parentAgent: root,
      agentOptions: resolveChildAgentOptions(root, undefined, 1), meta: childSessionMeta(root, 1, false),
      setup: childCtx => applyChildComposition(childCtx, root, {}),
    })
    try {
      const compactor = ctx.agentPresets.serviceFor(child.agent, 'compaction')
      assert.notEqual(compactor, ctx.agentPresets.serviceFor(root, 'compaction'))
      assert.equal(compactor.config.auto, true)
      await assert.rejects(compactor.summarize({ messages: [] }, child.agent), /usage-or-runtime-error/)
    } finally { await child.dispose() }
  } })
  try {
    assert.equal(dispatches, 0)
    assert.equal(diagnoseModelRuntime(harness.snapshot()).counts['auxiliary-call'], 1)
  } finally { await harness.dispose() }
})

test('native verifier request cap rejects the next prepared stream without losing observed usage', options, async t => {
  const { createNativeHarness, runModelVerification } = await import('../verify-model.mjs')
  const outputDir = await mkdtemp(join(tmpdir(), 'taskforce-native-cap-report-'))
  t.after(() => rm(outputDir, { recursive: true, force: true }))
  let dispatches = 0
  const report = await runModelVerification({ modelCalls: true, installAnchor: anchor, provider: 'deepseek-official', model: 'deepseek-flash', outputDir, requestCap: 1 }, {
    createHarness: config => createNativeHarness(config, { inspectNative: ({ ctx }) => {
      ctx.on('llm/stream', () => (async function* () {
        dispatches++
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '137' } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(), { global: true })
    } }),
  })
  assert.equal(report.ok, false)
  assert.equal(report.failure, 'request-cap')
  assert.equal(report.requests, 1)
  assert.equal(dispatches, 1)
  assert.equal(report.usage.inputTokens, 2)
  assert.equal(report.stages[1].requests, 0)
})

test('native public message constructors retain continuation and unknown-outcome accounting', options, async () => {
  const [{ Session }, { createUserMessage, createToolResultMessage }, { foldSubagentFlow, createFlowProjection }] = await Promise.all([
    native('@deepseek-ai/dsh-session'), native('@deepseek-ai/dsh-llm'), import('../../lib/plugins/working-context.mjs'),
  ])
  const session = Session.create('continuation-accounting-native')
  for (const callId of ['launch-a', 'launch-b']) {
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'subagent', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: 'started' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }
  const projection = createFlowProjection()
  // Source-equivalent settlement envelope built through the public SDK; the
  // private subagent settlement emitter is intentionally not imported.
  const notice = () => {
    const summary = 'Background subagent child-a finished and will do no further work unless you send it more.'
    session.append('user/message', createUserMessage({ content: [
      { type: 'text', text: summary }, { type: 'text', text: 'Its closing message:' }, { type: 'text', text: 'answer' },
    ], source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'child-a' } }), { surfaceOp: 'append' })
  }
  notice()
  assert.equal(projection.read(session.snapshotEvents()).inFlight, 1)
  notice()
  const flow = projection.read(session.snapshotEvents())
  assert.equal(flow.settledNotices, 2)
  assert.equal(flow.inFlight, 1)
  assert.deepEqual(flow, foldSubagentFlow(session.snapshotEvents()))
  assert.equal(projection.processedEvents, session.snapshotEvents().length)

  const unknown = Session.create('unknown-outcome-accounting-native')
  const call = unknown.append('tool/call', { turn: 1, step: 1, callId: 'unknown', name: 'subagent', arguments: '{}' })
  unknown.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: 'unknown', content: [{ type: 'text', text: 'uncommitted outcome' }], isError: true }),
    error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  for (const channel of ['settled-notice', 'tool-result']) {
    const flow = foldSubagentFlow(unknown.snapshotEvents(), undefined, channel)
    assert.equal(flow.delegatedResults, 1)
    assert.equal(flow.failedDispatches, 0)
    assert.equal(flow.inFlight, 1)
  }
})

for (const kind of ['direct', 'ancestor']) {
  test('actual native task_verify accepts a ' + kind + ' store root symlink with exact textual log provenance', options, async t => {
    const { ctx, agent } = await fixture(t)
    const [{ LocalSubprocessRuntime }, { LocalBashExecutor }, { ShellEnvRegistry }, bash,
      { apply: applyTools }, { TaskforceStore }] = await Promise.all([
      native('@deepseek-ai/dsh-subprocess-local'), native('@deepseek-ai/dsh-bash-local'),
      native('@deepseek-ai/dsh-shell-env'), native('@deepseek-ai/dsh-tool-bash'),
      import('../../lib/tools/index.js'), import('../../lib/store/index.js'),
    ])
    const { mkdir, realpath, symlink, writeFile, readFile } = await import('node:fs/promises')
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'taskforce-native-linked-receipt-')))
    const physical = join(directory, 'physical'), alias = join(directory, 'alias'), cwd = join(directory, 'workspace')
    await mkdir(physical); await mkdir(cwd); await symlink(physical, alias)
    await writeFile(join(cwd, 'source.js'), 'source\n')
    const root = kind === 'direct' ? alias : join(alias, 'nested')
    const store = new TaskforceStore(root)
    t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
    new LocalSubprocessRuntime(ctx)
    new ShellEnvRegistry(ctx)
    new LocalBashExecutor(ctx, LocalBashExecutor.Config({ cwd, maxTimeoutMs: 120000 }))
    await mountNativeWorkingDirectory(ctx, cwd)
    await ctx.plugin(bash, { enableRunInBackground: false, promoteOnTimeout: false })
    const main = agent('linked-root', undefined, { cwd })
    const worker = agent('linked-worker', undefined, { cwd, origin: 'subagent', delegationDepth: 1, parentSession: 'linked-root' })
    const byId = new Map([main, worker].map(value => [value.session.header.id, value]))
    ctx.provide('taskforceStore', store)
    ctx.provide('agents', { get: id => byId.get(id) })
    applyTools(ctx)
    applyScope(ctx)
    await ctx.serial('agent/created', { agent: main })
    await ctx.serial('agent/created', { agent: worker })
    const command = "printf 'linked native receipt\\n'; printf 'linked native stderr\\n' >&2"
    const id = store.openTask({ title: 'native linked receipt', evidence_policy: 'execution',
      verification_files: ['source.js'], verification_command: command },
    'linked-root', { sessionId: 'linked-root', cwd, isRoot: true }).task_id
    store.claimTask({ task_id: id, child_id: 'worker-label' }, 'linked-root', 'linked-worker', 'linked-worker')
    let bashCalls = 0, outerToken
    ctx.tools.guard(exec => {
      if (exec.name === 'task_verify') outerToken = exec.token
      if (exec.name === 'bash' && exec.agent === worker) {
        bashCalls++
        assert.equal(exec.parent, outerToken)
        assert.equal(exec.rootCallId, 'linked-symlink-' + kind)
        assert.equal(store.board(id, 'linked-root').receipts[0].status, 'pending')
      }
    })
    const nativeResult = await worker.ctx.tools.execute({ agent: worker,
      callId: 'linked-symlink-' + kind, name: 'task_verify', arguments: { task_id: id, command },
      signal: new AbortController().signal })
    assert.equal(nativeResult.isError, false, nativeResult.error?.message)
    const result = JSON.parse(nativeResult.value)
    assert.equal(result.verified, true, JSON.stringify(result))
    assert.equal(bashCalls, 1)
    const receipt = store.board(id, 'linked-root').receipts[0]
    assert.equal(receipt.kind, 'foreground')
    assert.equal(receipt.exit_code, 0)
    assert.equal(receipt.output_complete, true)
    for (const stream of ['stdout', 'stderr']) {
      const path = join(root, 'receipts', receipt.receipt_id + '.' + stream + '.log')
      assert.equal(receipt.logs[stream].path, path)
      assert.notEqual(await realpath(path), path)
    }
    assert.equal(await readFile(receipt.logs.stdout.path, 'utf8'), 'linked native receipt\n')
    assert.equal(await readFile(receipt.logs.stderr.path, 'utf8'), 'linked native stderr\n')
    store.submitTask({ task_id: id }, 'linked-root', 'linked-worker', 'linked-worker')
    assert.equal(store.acceptTask({ task_id: id }, 'linked-root', 'lead', 'linked-root').execution_verified, true)
  })
}

for (const action of ['send', 'stop']) {
  for (const publication of ['absent', 'failed-primary', 'null-journal']) {
    test('actual native Cordis ' + publication + ' journal boundary for keyless ' + action, options, async t => {
      const { ctx, agent } = await fixture(t)
      const { apply: applyTools } = await import('../../lib/tools/index.js')
      const main = agent('cordis-control-root')
      main.session.append('turn/start', { turn: 1 })
      main.session.append('step/start', { turn: 1, step: 1 })
      let effects = 0
      ctx.provide('agents', { get: id => id === main.session.header.id ? main : undefined })
      ctx.provide('subagents', {
        async listChildren() { return [{ id: 'cordis-control-child', mode: 'continuable', createdAt: 0 }] },
        async sendMessage(sender) { assert.equal(sender, main); effects++; return 'cordis-control-message' },
        interrupt(target, authority) { assert.equal(authority.agent, main); effects++ },
      })
      if (publication === 'null-journal') ctx.provide('taskforceStore', { recovery: null })
      await ctx.plugin({
        name: 'native-control-journal-probe',
        inject: ['tools'],
        apply(pluginCtx) {
          assert.ok(pluginCtx.fiber.runtime, 'exercise a running Cordis plugin, not the unguarded root context')
          if (publication !== 'null-journal') {
            assert.equal(pluginCtx.get('taskforceStore'), undefined)
            assert.throws(() => pluginCtx.taskforceStore, /without inject/,
              'the actual proxy reports normal non-injected absence through its reflective exception')
          } else {
            assert.equal(pluginCtx.get('taskforceStore').recovery, null)
          }
          const toolsCtx = publication === 'failed-primary' ? pluginCtx.extend({
            get(name) {
              if (name === 'taskforceStore') throw new Error('PRIVATE_PRIMARY_LOOKUP_FAILURE')
              return pluginCtx.get(name)
            },
          }) : pluginCtx
          applyTools(toolsCtx)
        },
      })
      const nativeResult = await main.ctx.tools.execute({
        agent: main, callId: 'cordis-control-call', name: 'task_child_' + action,
        arguments: { target_id: 'cordis-control-child', ...(action === 'send' ? { message: 'native boundary probe' } : {}) },
        signal: new AbortController().signal,
      })
      assert.equal(nativeResult.isError, false, nativeResult.error?.message)
      const result = JSON.parse(nativeResult.value)
      if (publication === 'absent') {
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.equal(result.operation.durable, false)
        assert.equal(result.operation.durability, 'unavailable')
        assert.equal(effects, 1, 'normal Cordis service absence retains one legacy effect')
      } else {
        assert.equal(effects, 0, 'failed or explicitly null journal must deny before native effect')
        assert.equal(result.code, 'E_CONTROL_JOURNAL_UNAVAILABLE', JSON.stringify(result))
        assert.match(result.hint, /原.*(?:键|retry_key)|retry_key/)
        assert.match(result.hint, /不得换键|禁止.*新.*键/)
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PRIMARY_LOOKUP_FAILURE|without inject/)
        for (const field of ['sent', 'stopped', 'delivery', 'execution']) assert.equal(Object.hasOwn(result, field), false)
      }
    })
  }
}
