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
test('pinned official H01 preparation and H03 strict flush raw readback; no model requests', { skip }, async t => {
  const helpers = await import('../../lib/scheduler/dsh-host.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e })
  assert.equal(typeof helpers.prepareNativeIdentity, 'function', 'native identity preparation missing')
  assert.equal(typeof helpers.flushNativeCheckpoint, 'function', 'strict native checkpoint missing')
  const previousExitCode = process.exitCode
  const version = installationVersion(anchor)
  const mainDeadline = setTimeout(() => { console.error('SCHEDULER_DEADLINE_60S'); process.exit(124) }, 60000)
  const fixture = await controlledProfile(anchor, root)
  const cleanup = () => fixture.dispose()
  process.once('exit', cleanup)
  let application, requests = 0
  const handles = []
  try {
    const { runProfile } = await import(pathToFileURL(join(dirname(anchor), 'lib/profile-boot.js')).href)
    application = await runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web',
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
  } finally {
    const cleanupStarted = Date.now()
    const cleanupDeadline = setTimeout(() => { console.error('SCHEDULER_CLEANUP_DEADLINE_12S'); process.exit(125) }, 12000)
    let disposed = 0, shutdown = false, remaining
    try {
      for (const handle of handles.reverse()) { await handle.dispose(); disposed++ }
      remaining = application?.ctx.get('agents').list().length
      assert.equal(remaining, 0)
    } finally {
      try { await application?.shutdown.shutdown(1); shutdown = true }
      finally {
        process.off('exit', cleanup)
        fixture.dispose()
        clearTimeout(cleanupDeadline)
        clearTimeout(mainDeadline)
        process.exitCode = previousExitCode
        console.log('SCHEDULER_CLEANUP_OBSERVED ' + JSON.stringify({ version, handles_disposed: disposed,
          remaining_live_agents: remaining, application_shutdown: shutdown, profile_removed: !existsSync(fixture.root),
          cleanup_ms: Date.now() - cleanupStarted, model_requests: requests }))
      }
    }
  }
})
