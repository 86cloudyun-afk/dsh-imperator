#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TASKFORCE_DEFINITION } from '../lib/preset.js'
import { foldSubagentFlow } from '../lib/plugins/working-context.mjs'
import { foldGuardSignal } from '../lib/plugins/guard.mjs'
import { controlledProfile, installationVersion, nativeModule, resolveInstallAnchor } from './host-runtime.mjs'
import { option } from './verify-preset.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Actual loopback-only web profile, no input enqueued and no model request.
 * The real registry, scoped tools, store and plugin Loader perform the work. */
export async function verifyHost({ installAnchor, installDir, configureShutdown } = {}) {
  const anchor = resolveInstallAnchor({ installAnchor, installDir })
  const previousExitCode = process.exitCode
  const fixture = await controlledProfile(anchor, ROOT)
  // Native shutdown may force process.exit on failed/stuck disposal, bypassing
  // finally. This synchronous exit hook still removes our disposable home.
  const emergencyCleanup = () => fixture.dispose()
  process.once('exit', emergencyCleanup)
  const checks = []
  let application
  const handles = []
  const pass = (name) => { checks.push(name); console.log(`HOST_PASS: ${name}`) }
  try {
    const { runProfile } = await import(pathToFileURL(join(dirname(anchor), 'lib/profile-boot.js')).href)
    application = await runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web',
      patchFiles: [fixture.overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
    // Trusted test hook for native cleanup failure injection; not a CLI flag.
    configureShutdown?.(application, fixture.root)
    const { ctx } = application
    const registry = ctx.get('agentPresets')
    const roster = async () => (await registry.list()).filter(row => row.id === 'taskforce')
    const healthy = async () => {
      const rows = await roster()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].broken, undefined, rows[0].broken)
    }
    await healthy()
    assert.ok(ctx.get('taskforceStore'))
    pass('boot roster and host store')
    const agents = ctx.get('agents')
    const parent = await agents.create({ sessionId: 'taskforce-probe-lead', meta: { cwd: fixture.root },
      setup: async (agentCtx, agent) => {
        await registry.mount(agentCtx, 'taskforce')
        agent.session.append('agent-preset/selected', { agentPreset: 'taskforce' })
      } })
    handles.push(parent)
    const workerConfig = TASKFORCE_DEFINITION.plugins.find(row => row.id === 'delegation').config.find(row => row.id === 'tool-subagent').config
    const { applyChildComposition } = await nativeModule(anchor, '@deepseek-ai/dsh-subagent')
    const child = await agents.create({ sessionId: 'taskforce-probe-child', parentAgent: parent.agent,
      meta: { cwd: fixture.root, origin: 'subagent', delegationDepth: 1, parentSession: parent.agent.id },
      setup: (agentCtx) => {
        // Native composition joins the parent's preset and replaces persona.
        applyChildComposition(agentCtx, parent.agent, { persona: workerConfig.persona })
      } })
    handles.push(child)
    let call = 0
    const execute = (agent, name, args) => agent.ctx.tools.execute({ agent, name, arguments: args,
      callId: `probe-${++call}`, signal: new AbortController().signal })
    const task = async (agent, name, args) => {
      const result = await execute(agent, name, args)
      assert.equal(result.isError, false, result.error?.message)
      return JSON.parse(result.value)
    }
    const names = parent.agent.ctx.tools.schemas(parent.agent).map(row => row.name)
    for (const name of ['task_open', 'task_claim', 'task_fact', 'task_submit', 'task_accept', 'task_reject', 'subagent', 'subagent_fork']) assert.ok(names.includes(name), name)
    for (const name of ['run_code', 'bash', 'write', 'edit']) assert.equal(names.includes(name), false, name)
    assert.equal((await execute(parent.agent, 'bash', { command: 'true' })).isError, true)
    const artifact = join(fixture.root, 'evidence.txt')
    const written = await execute(child.agent, 'write', { file_path: artifact, content: 'verified artifact\n' })
    assert.equal(written.isError, false, written.error?.message)
    assert.equal(readFileSync(artifact, 'utf8'), 'verified artifact\n')
    pass('real root tool boundary and child file execution')

    // A real provider call cancelled before dispatch cannot create a child or
    // contact an LLM. Persist its outcome exactly as native AgentLoop does.
    const { createToolResultMessage } = await nativeModule(anchor, '@deepseek-ai/dsh-llm')
    const { TOOL_ABORTED_BEFORE_DISPATCH } = await nativeModule(anchor, '@deepseek-ai/dsh-tools')
    const session = parent.agent.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const callId = 'probe-cancelled-delegation'
    const args = { description: 'cancelled delegation probe', prompt: 'must not dispatch' }
    const callEvent = session.append('tool/call', { turn: 1, step: 1, callId,
      name: 'subagent', arguments: JSON.stringify(args) })
    const cancelled = await parent.agent.ctx.tools.execute({ agent: parent.agent, name: 'subagent',
      callId, arguments: args, signal: AbortSignal.abort() })
    assert.equal(cancelled.isError, true)
    assert.equal(cancelled.error?.info?.code, TOOL_ABORTED_BEFORE_DISPATCH)
    const data = { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: cancelled.content, isError: cancelled.isError }),
      error: cancelled.error.info }
    let resultEvent = session.append('tool/result', data, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
    for (let i = 0; i < 2; i++) {
      // Valid native replacements change content alone; all three durable
      // result records still describe the same failed attempt.
      resultEvent = session.append('tool/result', { ...data,
        message: { ...data.message, content: [{ type: 'text', text: `cancelled result summary ${i}` }] } },
      { surfaceOp: { op: 'replace', startSeq: resultEvent.seq, endSeq: resultEvent.seq },
        sourceEventSeqs: [resultEvent.seq] })
    }
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const events = session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'tool/result').length, 3)
    for (const replay of [events, JSON.parse(JSON.stringify(events))]) {
      assert.deepEqual(foldSubagentFlow(replay), {
        dispatched: 0, settledNotices: 0, delegatedResults: 0, settled: 0, inFlight: 0,
      })
      assert.equal(foldGuardSignal(replay, { echoFailures: 3 }).signal, undefined)
    }
    // Provider IDs may repeat in later steps. Use real failing reads with the
    // same ID, then a real successful read to verify both sides of the chain.
    session.append('turn/start', { turn: 2 })
    const read = async (step, file) => {
      session.append('step/start', { turn: 2, step })
      const callId = 'probe-reused-id'
      const args = { file_path: file }
      const called = session.append('tool/call', { turn: 2, step, callId,
        name: 'read', arguments: JSON.stringify(args) })
      const result = await parent.agent.ctx.tools.execute({ agent: parent.agent, name: 'read',
        callId, arguments: args, signal: new AbortController().signal })
      session.append('tool/result', { turn: 2, step,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        ...(result.error?.info ? { error: result.error.info } : {}) },
      { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
      session.append('step/end', { turn: 2, step })
      return result
    }
    for (let step = 1; step <= 3; step++) {
      assert.equal((await read(step, join(fixture.root, 'missing-replay.txt'))).isError, true)
    }
    assert.equal(foldGuardSignal(session.snapshotEvents(), { echoFailures: 3 }).signal, 'echo')
    assert.equal((await read(4, artifact)).isError, false)
    assert.equal(foldGuardSignal(session.snapshotEvents(), { echoFailures: 3 }).signal, undefined)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    pass('native cancelled delegation, scoped IDs and result replacement replay')

    const opened = await task(parent.agent, 'task_open', { title: 'native tool closure' })
    const id = opened.task_id
    assert.ok(opened.ok)
    assert.equal((await task(child.agent, 'task_claim', { task_id: id, child_id: child.agent.id })).owner, child.agent.id)
    assert.equal((await task(child.agent, 'task_accept', { task_id: id })).code, 'E_NOT_LEAD')
    await task(child.agent, 'task_fact', { task_id: id, kind: 'artifact', statement: 'verified artifact', evidence_path: artifact, confidence: 'CONFIRMED' })
    assert.equal((await task(child.agent, 'task_submit', { task_id: id })).status, 'submitted')
    assert.equal((await task(parent.agent, 'task_accept', { task_id: id })).status, 'accepted')
    assert.equal((await task(parent.agent, 'task_reject', { task_id: id, reason: 'fresh executor required' })).status, 'rejected')
    assert.equal((await task(child.agent, 'task_claim', { task_id: id, child_id: 'replacement', actor: 'lead' })).code, 'E_TASK_CONFLICT')
    assert.equal((await task(parent.agent, 'task_claim', { task_id: id, child_id: 'replacement' })).owner, 'replacement')
    const board = await task(parent.agent, 'task_board', { task_id: id })
    assert.equal(board.task.status, 'claimed')
    assert.equal(board.handoffs.length, 1)
    pass('native task tools, role rejection, acceptance and audited reassignment')
    for (const handle of handles.splice(0).reverse()) await handle.dispose()
    assert.equal(agents.get('taskforce-probe-child'), undefined)
    assert.equal(agents.get('taskforce-probe-lead'), undefined)
    pass('agent handle teardown')

    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'taskforce' && entry.options.name === '@local/dsh-taskforce')
    assert.ok(entry, 'host plugin Loader entry missing')
    const toggle = async (disabled) => { await entry.update({ disabled }); await ctx.loader.await() }
    await toggle(true)
    assert.equal((await roster()).length, 0)
    await toggle(false)
    await healthy()
    pass('native plugin disable and re-enable')

    // A real duplicate declaration makes register reject. Remove the conflict
    // and explicitly re-enable: the package must have released its failed slot.
    await toggle(true)
    const conflict = await registry.register(TASKFORCE_DEFINITION)
    try {
      await toggle(false)
      assert.equal(globalThis[Symbol.for('dsh-taskforce.mount-owners')]?.has('@local/dsh-taskforce') ?? false, false)
      await toggle(true)
    } finally { await conflict() }
    await toggle(false)
    await healthy()
    pass('native registration failure and explicit recovery')
    return { ok: true, dsh: installationVersion(anchor), node: process.version, checks }
  } finally {
    try {
      try { for (const handle of handles.reverse()) await handle.dispose() }
      // Native shutdown forces the supplied code on rejection/cleanup timeout.
      // Keep failure selected until every disposer and fixture cleanup returns.
      finally { await application?.shutdown.shutdown(1) }
    } finally {
      fixture.dispose()
      process.removeListener('exit', emergencyCleanup)
      assert.equal(existsSync(fixture.root), false, 'isolated home leaked')
      process.exitCode = previousExitCode
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const result = await verifyHost({ installAnchor: option(args, '--install-anchor'), installDir: option(args, '--install-dir') })
    console.log(`HOST_VERIFIED: DSH ${result.dsh}, Node ${result.node}, ${result.checks.length} checks`)
  } catch (error) { console.error(`HOST_FAILED: ${error.message}`); process.exitCode = 1 }
}
