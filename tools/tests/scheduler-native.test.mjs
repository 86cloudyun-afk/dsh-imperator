import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { controlledProfile, installationVersion, resolveInstallAnchor } from '../host-runtime.mjs'

let anchor, skip
try { anchor = resolveInstallAnchor({}) } catch (error) { skip = error.message }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Shared acquisition used by the main native matrix and setup-fault probes.
async function acquireSchedulerFixture(inspect) {
  const previousExitCode = process.exitCode
  const version = installationVersion(anchor)
  const mainDeadline = setTimeout(() => { console.error('SCHEDULER_DEADLINE_60S'); process.exit(124) }, 60000)
  try {
    inspect?.({ mainDeadline, previousExitCode })
    const fixture = await controlledProfile(anchor, root)
    const cleanup = () => fixture.emergencyDispose()
    process.once('exit', cleanup)
    return { fixture, cleanup, mainDeadline, previousExitCode, version }
  } catch (error) {
    clearTimeout(mainDeadline)
    process.exitCode = previousExitCode
    throw error
  }
}

async function cleanupScheduler({ fixture, application, workingStore, handles, cleanup, mainDeadline, previousExitCode, version, requests, failures = [] }) {
  const cleanupStarted = Date.now()
  const cleanupDeadline = setTimeout(() => { console.error('SCHEDULER_CLEANUP_DEADLINE_12S'); process.exit(125) }, 12000)
  let disposed = 0, shutdown = false, remaining
  try {
    for (const handle of handles.reverse()) {
      try { await fixture.teardown(() => handle.dispose()); disposed++ } catch (error) { failures.push(error) }
    }
    try { if (application) { remaining = application.ctx.get('agents').list().length; assert.equal(remaining, 0) } }
    catch (error) { failures.push(error) }
  } finally {
    try { workingStore?.close() } catch (error) { failures.push(error) }
    finally {
      try { await fixture.shutdown(1); shutdown = Boolean(application) } catch (error) { failures.push(error) }
      finally {
        try { fixture.dispose() } catch (error) { failures.push(error) }
        finally {
          if (fixture.isDisposed()) process.off('exit', cleanup)
          else fixture.whenDisposed.then(() => process.off('exit', cleanup))
          clearTimeout(cleanupDeadline)
          clearTimeout(mainDeadline)
          process.exitCode = previousExitCode
          console.log('SCHEDULER_CLEANUP_OBSERVED ' + JSON.stringify({ version, handles_disposed: disposed,
            remaining_live_agents: remaining, application_shutdown: shutdown, profile_removed: !existsSync(fixture.root),
            cleanup_ms: Date.now() - cleanupStarted, model_requests: requests }))
        }
      }
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'scheduler verification and cleanup failed')
}

test('pinned official H01 preparation and H03 strict flush raw readback; no model requests', { skip }, async t => {
  const helpers = await import('../../lib/scheduler/dsh-host.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e })
  assert.equal(typeof helpers.prepareNativeIdentity, 'function', 'native identity preparation missing')
  assert.equal(typeof helpers.flushNativeCheckpoint, 'function', 'strict native checkpoint missing')
  const { fixture, cleanup, mainDeadline, previousExitCode, version } = await acquireSchedulerFixture()
  let application, workingStore, requests = 0
  const handles = [], failures = []
  try {
    application = await fixture.runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web',
      patchFiles: [fixture.overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
    const { ctx } = application
    ctx.on('agent/request', () => { requests++; throw new Error('model requests forbidden') })
    const agents = ctx.get('agents')
    const parent = await agents.create({ sessionId: 'scheduler-root', meta: { cwd: fixture.root } })
    handles.push(parent)
    const prepared = helpers.prepareNativeIdentity(ctx, { version, parentAgent: parent.agent, session_id: 'scheduler-reserved' })
    assert.equal(prepared.root_run_id, parent.agent.id)
    assert.equal(prepared.delegation_depth, 1)
    const child = await agents.create({ sessionId: prepared.session_id, parentAgent: parent.agent,
      meta: { cwd: fixture.root, parentSession: prepared.parent_session_id, origin: 'subagent', delegationDepth: prepared.delegation_depth } })
    handles.push(child)
    assert.equal(child.agent.id, prepared.session_id)
    assert.equal(child.agent.session.header.parentSession, parent.agent.id)
    assert.equal(typeof child.agent.session.snapshotEvents, 'function')
    const before = child.agent.session.snapshotEvents()
    assert.ok(Object.isFrozen(before))
    assert.equal(child.agent.session.snapshotEvents(), before)
    child.agent.session.append('agent-preset/selected', { agentPreset: 'taskforce' })
    const after = child.agent.session.snapshotEvents()
    assert.ok(Object.isFrozen(after))
    assert.notEqual(after, before)
    assert.equal(child.agent.session.snapshotEvents(), after)
    assert.equal(after.length, before.length + 1)
    assert.ok(Object.isFrozen(after.at(-1)))
    console.log('SCHEDULER_SNAPSHOT_VERIFIED ' + JSON.stringify({ version, frozen: true, reused_until_append: true, stable_previous_length: before.length, frozen_event: true }))
    const sessionsBefore = ctx.get('sessions'), sessionsAgain = ctx.get('sessions')
    const original = Symbol.for('cordis.original')
    assert.notEqual(sessionsBefore, sessionsAgain)
    assert.equal(typeof sessionsBefore[original], 'object')
    assert.ok(sessionsBefore[original])
    assert.equal(sessionsBefore[original], sessionsAgain[original])
    assert.equal(sessionsAgain.get(child.agent.id), child.agent.session)
    console.log('SCHEDULER_SERVICE_IDENTITY_VERIFIED ' + JSON.stringify({ version, fresh_contextual_proxy: true, exact_original_target: true }))
    const backend = ctx.get('sessionPersistence')
    const checkpoint = await helpers.flushNativeCheckpoint(ctx, { version, session: child.agent.session, persistence: backend })
    assert.equal(checkpoint.session_id, child.agent.id)
    assert.ok(checkpoint.event_count >= 1)
    assert.match(checkpoint.digest, /^[a-f0-9]{64}$/)
    assert.equal(checkpoint.terminal, false)
    assert.equal(checkpoint.quiescence_proven, false)
    assert.equal(requests, 0)
    const requireHost = createRequire(anchor)
    const { delegationDepthOf } = await import(new URL('./types/depth.js', pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-subagent'))))
    const create = async options => {
      const handle = await agents.create(options)
      handles.push(handle)
      assert.equal(agents.get(handle.agent.id), handle.agent)
      return handle
    }
    const prepare = agent => helpers.prepareNativeIdentity(ctx, { version, parentAgent: agent, session_id: 'scheduler-unused' })
    const checkPrepared = (agent, run, depth) => {
      const value = prepare(agent)
      assert.deepEqual(value, { session_id: 'scheduler-unused', parent_session_id: agent.id,
        root_run_id: run.id, delegation_depth: depth, native_enabled: false })
      assert.ok(Object.isFrozen(value))
      return value
    }
    const seed = await create({ sessionId: 'scheduler-seed', meta: { cwd: fixture.root } })
    const fork = await create({ sessionId: 'scheduler-fork', meta: { cwd: fixture.root, parentSession: seed.agent.id, isSeeded: true },
      seed: [], inheritedEventCount: 0 })
    const forkChild = await create({ sessionId: 'scheduler-fork-child', parentAgent: fork.agent,
      meta: { cwd: fixture.root, parentSession: fork.agent.id, origin: 'subagent', delegationDepth: 1 } })
    const forkGrandchild = await create({ sessionId: 'scheduler-fork-grandchild', parentAgent: forkChild.agent,
      meta: { cwd: fixture.root, parentSession: forkChild.agent.id, origin: 'subagent', delegationDepth: 2 } })
    assert.ok(agents.roots().includes(fork.agent))
    assert.equal(fork.agent.session.header.parentSession, seed.agent.id)
    assert.equal(fork.agent.session.header.origin, undefined)
    assert.equal(fork.agent.session.header.delegationDepth, undefined)
    assert.equal(delegationDepthOf(fork.agent), 0)
    await t.test('ordinary fork retains its independent run with a live seed source', () => {
      checkPrepared(fork.agent, fork.agent, 1)
    })
    await t.test('a real child of an ordinary fork may prepare depth two', () => {
      assert.equal(delegationDepthOf(forkChild.agent), 1)
      checkPrepared(forkChild.agent, fork.agent, 2)
    })
    await t.test('a real fork grandchild refuses depth three', () => {
      assert.equal(delegationDepthOf(forkGrandchild.agent), 2)
      assert.throws(() => prepare(forkGrandchild.agent), { code: 'E_SCHEDULER_CAPABILITY' })
    })
    await seed.dispose()
    assert.equal(agents.get(seed.agent.id), undefined)
    await t.test('ordinary fork and delegated child retain their run with the seed source offline', () => {
      assert.ok(agents.roots().includes(fork.agent))
      checkPrepared(fork.agent, fork.agent, 1)
      checkPrepared(forkChild.agent, fork.agent, 2)
    })
    const runtimeAgents = new Map()
    for (const [label, headerDepth, runtimeDepth, expected] of [
      ['runtime-only-one', undefined, 1, 2],
      ['runtime-only-two', undefined, 2, null],
      ['durable-one-runtime-zero', 1, 0, 2],
      ['durable-zero-runtime-one', 0, 1, 2],
      ['durable-two-runtime-one', 2, 1, null],
      ['durable-one-runtime-two', 1, 2, null],
    ]) {
      const runtime = await create({ sessionId: 'scheduler-' + label, parentAgent: parent.agent,
        meta: { cwd: fixture.root, parentSession: parent.agent.id, ...(headerDepth === undefined ? {} : { delegationDepth: headerDepth }) },
        agentOptions: { subagentDepth: runtimeDepth } })
      runtimeAgents.set(label, runtime.agent)
      assert.equal(runtime.agent.session.header.delegationDepth, headerDepth)
      assert.equal(runtime.agent.options.subagentDepth, runtimeDepth)
      assert.equal(delegationDepthOf(runtime.agent), Math.max(headerDepth ?? 0, runtimeDepth))
      await t.test('actual Agent options: ' + label, () => {
        if (expected === null) assert.throws(() => prepare(runtime.agent), { code: 'E_SCHEDULER_CAPABILITY' })
        else checkPrepared(runtime.agent, parent.agent, expected)
      })
    }
    await t.test('actual runtime-only depth two without a delegated parent refuses', async () => {
      const runtime = await create({ sessionId: 'scheduler-runtime-root-two', meta: { cwd: fixture.root }, agentOptions: { subagentDepth: 2 } })
      assert.equal(delegationDepthOf(runtime.agent), 2)
      assert.throws(() => prepare(runtime.agent), { code: 'E_SCHEDULER_CAPABILITY' })
    })
    await t.test('actual Agent clones and fresh proxies are rejected as parent identity', () => {
      assert.throws(() => prepare({ ...fork.agent }), { code: 'E_SCHEDULER_CAPABILITY' })
      assert.throws(() => prepare(new Proxy(fork.agent, {})), { code: 'E_SCHEDULER_CAPABILITY' })
    })
    assert.equal(requests, 0)
    // Exercise the real projection on actual registered Agents/options/get.
    // Hook registration, optional scope membership and next are controlled;
    // this is not a native Agent loop or model turn. SQLite is an isolated store.
    const [{ apply: applyWorkingContext }, { deriveIdentity }, { TaskforceStore }] = await Promise.all([
      import('../../lib/plugins/working-context.mjs'), import('../../lib/tools/index.js'), import('../../lib/store/index.js'),
    ])
    const runtimeGrandchild = await create({ sessionId: 'scheduler-runtime-grandchild',
      parentAgent: runtimeAgents.get('runtime-only-one'), meta: { cwd: fixture.root,
        parentSession: runtimeAgents.get('runtime-only-one').id, origin: 'subagent', delegationDepth: 2 } })
    const paddedRoot = await create({ sessionId: ' scheduler-root ', meta: { cwd: fixture.root } })
    const paddedChild = await create({ sessionId: ' scheduler-padded-child ', parentAgent: paddedRoot.agent,
      meta: { cwd: fixture.root, parentSession: paddedRoot.agent.id }, agentOptions: { subagentDepth: 1 } })
    assert.equal(paddedRoot.agent.session.header.id, ' scheduler-root ')
    assert.equal(paddedChild.agent.session.header.id, ' scheduler-padded-child ')
    assert.equal(paddedChild.agent.options.subagentDepth, 1)
    assert.equal(paddedChild.agent.session.header.delegationDepth, undefined)
    workingStore = new TaskforceStore(join(fixture.root, 'context-store'))
    const domains = new Map(), contextRuns = []
    for (const run of [undefined, parent.agent.id, fork.agent.id, child.agent.id, forkChild.agent.id,
      ...[...runtimeAgents.values()].map(agent => agent.id), runtimeGrandchild.agent.id,
      paddedRoot.agent.id, paddedChild.agent.id, paddedChild.agent.id.trim()]) {
      const title = 'NATIVE_CONTEXT_SCOPE_' + domains.size + '_TASK'
      const task = workingStore.openTask({ title }, run)
      const count = domains.size + 1
      for (let index = 0; index < count; index++) {
        workingStore.recordFact({ task_id: task.task_id, statement: 'private native fact ' + index }, run)
      }
      domains.set(run, { title, count })
    }
    const db = workingStore.open(), changes = () => db.prepare('SELECT total_changes() AS n').get().n
    const workingState = workingStore.workingState.bind(workingStore)
    workingStore.workingState = run => { contextRuns.push(run); return workingState(run) }
    const contextHooks = new Map()
    applyWorkingContext({ on: (name, fn) => contextHooks.set(name, fn),
      get: name => name === 'agents' ? agents : name === 'taskforceStore' ? workingStore : undefined })
    const checkContext = async (agent, run) => {
      assert.equal(agents.get(agent.id), agent, 'actual registered Agent, not a header/options copy')
      assert.equal(deriveIdentity(agent, agents).runId, run, 'uncached real tool identity')
      contextRuns.length = 0
      const before = changes()
      const result = await contextHooks.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] }))
      assert.equal(changes(), before, 'native projection reads must not write SQLite')
      assert.deepEqual(contextRuns, [run], 'native projection must select the exact tool run')
      const output = result.messages.flatMap(message => message.content ?? []).map(block => block.text ?? '').join('\n')
      for (const [domain, expected] of domains) {
        if (domain === run) {
          assert.ok(output.includes(expected.title), 'missing task for native run ' + JSON.stringify(run))
          assert.ok(output.includes('事实 ' + expected.count + ' 条'), 'incorrect native fact count')
        } else assert.ok(!output.includes(expected.title), 'other native/legacy domain must stay isolated')
      }
    }
    for (const [label, agent, run] of [
      ['ordinary root', parent.agent, parent.agent.id],
      ['ordinary fork with offline seed', fork.agent, fork.agent.id],
      ['durable child', child.agent, parent.agent.id],
      ['child of ordinary fork', forkChild.agent, fork.agent.id],
      ...[...runtimeAgents].map(([label, agent]) => [label, agent, parent.agent.id]),
      ['runtime-only ancestor', runtimeGrandchild.agent, parent.agent.id],
      ['exact padded root', paddedRoot.agent, paddedRoot.agent.id],
      ['exact padded child and live parent', paddedChild.agent, paddedRoot.agent.id],
    ]) {
      await t.test('working context with actual native Agent: ' + label, () => checkContext(agent, run))
    }
    await paddedRoot.dispose()
    assert.equal(agents.get(paddedRoot.agent.id), undefined)
    await t.test('working context exact padded offline depth-one parent', () => checkContext(paddedChild.agent, paddedRoot.agent.id))
    assert.equal(requests, 0)
    console.log('WORKING_CONTEXT_NATIVE_OBSERVED ' + JSON.stringify({ version, exact_live_agents: true,
      runtime_only_ancestor: true, exact_padded_ids: true, controlled_hook_scope_and_next: true,
      real_sqlite: true, projection_writes: 0, native_agent_loop: false, model_requests: requests }))
    assert.equal(helpers.nativeSchedulerCapabilities({ version, native_enabled: true }).native_enabled, false)
    assert.ok(helpers.nativeSchedulerCapabilities({ version }).capabilities.every(capability => capability.enabled === false))
    console.log('SCHEDULER_IDENTITY_MATRIX_OBSERVED ' + JSON.stringify({ version, exact_live_agents: true,
      fork_seed_source_disposed: true, runtime_options_observed: true, native_enabled: false, model_requests: requests }))
    for (const name of ['cordis', 'dsh-agent', 'dsh-session', 'dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-subprocess']) {
      const entry = requireHost.resolve('@deepseek-ai/' + name)
      const bytes = readFileSync(entry)
      let directory = dirname(entry), manifest
      while (true) {
        try { const candidate = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); if (candidate.name === '@deepseek-ai/' + name) { manifest = candidate; break } } catch {}
        const parentDir = dirname(directory)
        if (parentDir === directory) throw new Error('package manifest unavailable')
        directory = parentDir
      }
      console.log('SCHEDULER_PACKAGE_EVIDENCE ' + JSON.stringify({ name: manifest.name, version: manifest.version, entry_sha256: createHash('sha256').update(bytes).digest('hex') }))
    }
    console.log('SCHEDULER_HOST_VERIFIED ' + JSON.stringify({ version, checks: ['prebound-id', 'live-parent', 'strict-flush', 'raw-readback'], native_enabled: false, model_requests: requests }))
  } catch (error) { failures.push(error) }
  finally {
    await cleanupScheduler({ fixture, application, workingStore, handles, cleanup, mainDeadline, previousExitCode, version, requests, failures })
  }
})


async function exerciseSchedulerCloseFault({ failAt, primary, inspect } = {}) {
  const { TaskforceStore } = await import('../../lib/store/index.js')
  const resources = await acquireSchedulerFixture()
  const { fixture, cleanup, mainDeadline, previousExitCode } = resources
  const baselineExit = process.rawListeners('exit').filter(callback => callback !== cleanup && callback.listener !== cleanup)
  const disposeFixture = fixture.dispose, diagnostic = new Error('injected fixture diagnostic')
  const failures = []
  let failure, setupFailure, sentinel
  try {
    fixture.dispose = () => { disposeFixture(); throw diagnostic }
    Object.assign(resources, { disposeFixture, diagnostic, attempted: false })
    inspect?.(resources)
    const application = resources.application = await fixture.runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web',
      patchFiles: [fixture.overlay], get args() {
        if (failAt === 'boot') throw primary
        return ['--host', '127.0.0.1', '--port', '0', '--no-open']
      } })
    const events = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT']
    const before = events.map(event => process.rawListeners(event))
    const shutdown = application.shutdown.shutdown.bind(application.shutdown)
    application.shutdown.shutdown = (...args) => {
      resources.attempted = true
      assert.deepEqual(events.map(event => process.rawListeners(event)), before, 'callbacks must cover actual shutdown')
      return shutdown(...args)
    }
    const workingStore = resources.workingStore = new TaskforceStore(join(fixture.root, 'close-fault'))
    const open = workingStore.open.bind(workingStore)
    workingStore.open = () => { const db = open(); if (failAt === 'store') throw primary; return db }
    workingStore.open()
    const close = workingStore.close.bind(workingStore)
    sentinel = new Error('actual store close sentinel')
    workingStore.close = () => { close(); throw sentinel }
  } catch (error) { resources.setupFailure = setupFailure = error; failures.push(error) }
  finally {
    try { await cleanupScheduler({ ...resources, handles: [], requests: 0, failures }) }
    catch (error) { failure = error }
  }
  if (setupFailure) throw failure
  assert.equal(resources.attempted, true, 'actual store.close error skipped native shutdown')
  const all = error => error instanceof AggregateError ? error.errors.flatMap(all) : [error]
  assert.ok(all(failure).includes(sentinel))
  assert.ok(all(failure).includes(diagnostic))
  assert.equal(existsSync(fixture.root), false)
  assert.equal(mainDeadline._destroyed, true)
  assert.deepEqual(process.rawListeners('exit'), baselineExit)
  assert.equal(process.exitCode, previousExitCode)
}

test('scheduler store close failure still shuts down the actual app and preserves cleanup errors', { skip },
  () => exerciseSchedulerCloseFault())

for (const failAt of ['boot', 'store']) {
  test('scheduler actual ' + failAt + ' setup rejection releases its fixture and preserves both errors', { skip }, async () => {
    const primary = new Error('actual ' + failAt + ' setup sentinel')
    const events = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT']
    const before = events.map(event => process.rawListeners(event)), previousHome = process.env.DSH_HOME
    const previousTelemetry = process.env.DSH_TELEMETRY_DISABLED
    const previousExitCode = process.exitCode
    let resources, failure
    try {
      try { await exerciseSchedulerCloseFault({ failAt, primary, inspect: value => { resources = value } }) }
      catch (error) { failure = error }
      console.log('SCHEDULER_SETUP_FAILURE_OBSERVED ' + JSON.stringify({ failAt,
        original_error: failure === resources.setupFailure || failure?.errors?.includes(resources.setupFailure),
        fixture_disposed: resources.fixture.isDisposed(), profile_removed: !existsSync(resources.fixture.root),
        main_timer_cleared: resources.mainDeadline._destroyed, application_shutdown: resources.attempted }))
      assert.equal(resources.fixture.isDisposed(), true, 'setup rejection bypassed fixture cleanup')
      const all = error => error instanceof AggregateError ? error.errors.flatMap(all) : [error]
      assert.ok(all(failure).includes(resources.setupFailure), 'actual setup rejection identity lost')
      // Native boot wraps host-preparation errors with cause; preserve both
      // exact objects, rather than treating the SDK wrapper as cleanup loss.
      if (failAt === 'boot') assert.equal(resources.setupFailure.cause, primary)
      else assert.equal(resources.setupFailure, primary)
      assert.ok(all(failure).includes(resources.diagnostic), 'secondary fixture diagnostic lost')
      assert.equal(resources.attempted, failAt === 'store')
      assert.equal(existsSync(resources.fixture.root), false)
      assert.equal(resources.mainDeadline._destroyed, true)
      assert.equal(process.rawListeners('exit').some(callback => callback === resources.cleanup || callback.listener === resources.cleanup), false)
      assert.deepEqual(events.map(event => process.rawListeners(event)), before)
      assert.equal(process.env.DSH_HOME, previousHome)
      assert.equal(process.env.DSH_TELEMETRY_DISABLED, previousTelemetry)
      assert.equal(process.exitCode, previousExitCode)
      const next = await controlledProfile(anchor, root); next.dispose()
    } finally {
      // RED-only fallback also protects failed assertions; not the path under test.
      if (resources) {
        try { resources.workingStore?.close() } catch {}
        try { await resources.fixture.shutdown(1) }
        finally {
          try { resources.disposeFixture() }
          finally { clearTimeout(resources.mainDeadline); process.off('exit', resources.cleanup); process.exitCode = previousExitCode }
        }
      }
    }
  })
}

test('scheduler fixture acquisition rejection clears the already-started main deadline', { skip }, async () => {
  const active = await controlledProfile(anchor, root)
  const ownedHome = process.env.DSH_HOME, previousExitCode = process.exitCode
  const events = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT', 'exit']
  const before = events.map(event => process.rawListeners(event))
  let timer
  try {
    await assert.rejects(acquireSchedulerFixture(value => { timer = value.mainDeadline }), /active controlled profile/)
    assert.equal(timer._destroyed, true, 'rejected fixture acquisition retained the main deadline')
    assert.equal(process.env.DSH_HOME, ownedHome, 'rejection must not disturb the existing fixture')
    assert.equal(active.isDisposed(), false)
    assert.equal(existsSync(active.root), true)
    assert.deepEqual(events.map(event => process.rawListeners(event)), before)
    assert.equal(process.exitCode, previousExitCode)
  } finally { clearTimeout(timer); active.dispose() }
})
