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
import { diagnoseModelRuntime } from './verify-model.mjs'

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
    let modelRequests = 0
    ctx.on('agent/request', () => { modelRequests++; throw new Error('native verifier forbids model requests') })
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
    const strict = await task(parent.agent, 'task_open', { title: 'native strict coding receipt',
      evidence_policy: 'execution', verification_files: ['evidence.txt'], verification_command: 'printf native-verification' })
    assert.equal(strict.ok, true)
    await task(child.agent, 'task_claim', { task_id: strict.task_id, child_id: 'worker-label' })
    const bound = ctx.get('taskforceStore').taskOf(strict.task_id, parent.agent.id).task
    const renamed = await task(child.agent, 'task_claim', { task_id: strict.task_id, child_id: 'other-worker-label' })
    assert.equal(renamed.already, true)
    assert.equal(renamed.owner_session, child.agent.id)
    assert.equal(renamed.owner, bound.owner)
    assert.equal((await task(parent.agent, 'task_verify', { task_id: strict.task_id,
      command: 'printf native-verification' })).code, 'E_VERIFICATION_ROLE')
    const receipt = await task(child.agent, 'task_verify', { task_id: strict.task_id, command: 'printf native-verification' })
    assert.equal(receipt.verified, true, JSON.stringify(receipt))
    assert.equal(ctx.get('taskforceStore').board(strict.task_id, parent.agent.id).receipts[0].exit_code, 0)
    await task(child.agent, 'task_submit', { task_id: strict.task_id })
    assert.equal((await task(parent.agent, 'task_accept', { task_id: strict.task_id })).execution_verified, true)
    pass('native strict receipt closes through real preset tools without model requests')
    const failed = await task(parent.agent, 'task_open', { title: 'native nonzero receipt',
      evidence_policy: 'execution', verification_files: ['evidence.txt'], verification_command: 'exit 7' })
    await task(child.agent, 'task_claim', { task_id: failed.task_id, child_id: 'worker-label' })
    assert.equal((await task(child.agent, 'task_verify', { task_id: failed.task_id, command: 'exit 7' })).verified, false)
    assert.equal(ctx.get('taskforceStore').board(failed.task_id, parent.agent.id).receipts[0].exit_code, 7)
    await task(child.agent, 'task_submit', { task_id: failed.task_id })
    assert.equal((await task(parent.agent, 'task_accept', { task_id: failed.task_id })).code, 'E_VERIFICATION_RECEIPT')
    pass('native nonzero receipt cannot be accepted and root verification is denied')
    // Verify the live service, not an assumed global depth default.
    const { Config: subagentConfig } = await nativeModule(anchor, '@deepseek-ai/dsh-tool-subagent')
    const runtime = parent.agent.ctx.get('subagents')
    for (const row of TASKFORCE_DEFINITION.plugins.find(row => row.id === 'delegation').config
      .filter(row => row.name === '@deepseek-ai/dsh-tool-subagent')) {
      assert.equal(runtime.resolveMaxDepth(subagentConfig(row.config).maxDepth), 2, row.id)
    }
    pass('live spawn and fork depth are both two')

    // Hiding run_code in native presentation is not sufficient protection.
    const forbidden = join(fixture.root, 'root-ptc-must-not-write.txt')
    // Presentation is declared once per scope. Use another disposable root;
    // do not mask a boundary assertion by attempting a conflicting reset.
    const ptcRoot = await agents.create({ sessionId: 'taskforce-probe-ptc', meta: { cwd: fixture.root },
      setup: async (agentCtx, agent) => {
        await registry.mount(agentCtx, 'taskforce')
        agent.session.append('agent-preset/selected', { agentPreset: 'taskforce' })
      } })
    handles.push(ptcRoot)
    ptcRoot.agent.ctx.tools.presentAs('both')
    const denied = await execute(ptcRoot.agent, 'run_code', { description: 'isolated boundary regression',
      code: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(forbidden)}, 'must not exist'); return 'done';` })
    assert.equal(denied.isError, true)
    assert.equal(existsSync(forbidden), false)
    pass('root PTC boundary survives presentation changes')


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
        dispatched: 1, settledNotices: 0, delegatedResults: 1, failedDispatches: 1, settled: 0, inFlight: 0,
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

    // Execute real failures without a model, then persist the exact public
    // AgentLoop result shape (source has callId, never toolName).
    for (const [index, name] of ['todo_write', 'unknown-diagnostic-probe'].entries()) {
      const turn = 3, step = index + 1, callId = 'diagnostic-reused-id'
      const called = child.agent.session.append('tool/call', { turn, step, callId, name, arguments: '{}' })
      const result = await child.agent.ctx.tools.execute({ agent: child.agent, name, arguments: {}, callId,
        signal: new AbortController().signal })
      assert.equal(result.isError, true)
      const message = createToolResultMessage({ callId, content: result.content, isError: result.isError })
      assert.deepEqual(message.source, { kind: 'tool', callId })
      child.agent.session.append('tool/result', { turn, step, message, error: result.error.info },
        { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
    }
    const diagnostics = diagnoseModelRuntime({ sessions: [parent, child].map(({ agent }) => ({
      id: agent.id, events: agent.session.snapshotEvents(),
    })) })
    assert.equal(diagnostics.counts['native-tool-error'], 8)
    assert.deepEqual(diagnostics.details.map(({ toolName, errorCode }) => [toolName, errorCode]), [
      ...Array.from({ length: 3 }, () => ['subagent', 'ABORTED_BEFORE_DISPATCH']),
      ...Array.from({ length: 3 }, () => ['read', 'FS_NOT_FOUND']),
      ['todo_write', 'INVALID_ARGS'], [null, 'UNKNOWN_TOOL'],
    ])
    // Cover every actually mounted schema, including child-only execution tools.
    for (const { agent } of [parent, child]) {
      for (const { name } of agent.ctx.tools.schemas(agent)) {
        const detail = diagnoseModelRuntime({ sessions: [{ events: [
          { type: 'tool/call', data: { turn: 1, step: 1, callId: 'schema', name } },
          { type: 'tool/result', data: { turn: 1, step: 1,
            message: createToolResultMessage({ callId: 'schema', content: [], isError: true }) } },
        ] }] }).details[0]
        assert.equal(detail.toolName, name, 'mounted schema missing from diagnostic allowlist')
        assert.equal(detail.unknownTool, false)
      }
    }
    assert.equal(modelRequests, 0)
    pass('native nameless failures retain scoped tool names and finite diagnostic codes without model requests')

    const opened = await task(parent.agent, 'task_open', { title: 'native tool closure' })
    const id = opened.task_id
    assert.ok(opened.ok)
    assert.equal((await task(child.agent, 'task_claim', { task_id: id, child_id: child.agent.id })).owner, child.agent.id)
    assert.equal((await task(child.agent, 'task_accept', { task_id: id })).code, 'E_NOT_LEAD')
    await task(child.agent, 'task_fact', { task_id: id, kind: 'artifact', statement: 'verified artifact', evidence_path: artifact, confidence: 'CONFIRMED' })
    assert.equal((await task(child.agent, 'task_submit', { task_id: id })).status, 'submitted')
    assert.equal((await task(parent.agent, 'task_accept', { task_id: id })).status, 'accepted')
    assert.equal((await task(parent.agent, 'task_reject', { task_id: id, reason: 'fresh executor required' })).status, 'rejected')
    // A different display label cannot change the bound owner's authority.
    const sameOwner = await task(child.agent, 'task_claim', { task_id: id, child_id: 'worker-nickname' })
    assert.equal(sameOwner.ok, true)
    assert.equal(sameOwner.owner, child.agent.id)
    assert.equal(sameOwner.owner_session, child.agent.id)
    await task(child.agent, 'task_submit', { task_id: id })
    await task(parent.agent, 'task_reject', { task_id: id, reason: 'explicit owner reassignment' })
    // Use a real sibling for the non-owner rejection probe (Task 1 contract).
    const sibling = await agents.create({ sessionId: 'taskforce-probe-sibling', parentAgent: parent.agent,
      meta: { cwd: fixture.root, origin: 'subagent', delegationDepth: 1, parentSession: parent.agent.id },
      setup: agentCtx => applyChildComposition(agentCtx, parent.agent, { persona: workerConfig.persona }) })
    handles.push(sibling)
    const competitor = await task(parent.agent, 'task_open', { title: 'bound nickname competition' })
    await task(child.agent, 'task_claim', { task_id: competitor.task_id, child_id: 'shared-nickname' })
    const ownerBefore = ctx.get('taskforceStore').taskOf(competitor.task_id, parent.agent.id)
    for (const [name, args] of [['task_claim', { child_id: 'shared-nickname' }], ['task_submit', {}],
      ['task_close', { result: 'failed' }]]) {
      assert.equal((await task(sibling.agent, name, { task_id: competitor.task_id, ...args })).code, 'E_TASK_CONFLICT')
    }
    assert.deepEqual(ctx.get('taskforceStore').taskOf(competitor.task_id, parent.agent.id), ownerBefore)
    pass('native bound nickname is idempotent and a real competitor cannot claim, submit or cancel')
    assert.equal((await task(sibling.agent, 'task_claim', { task_id: id, child_id: 'replacement', actor: 'lead' })).code, 'E_TASK_CONFLICT')
    assert.equal((await task(parent.agent, 'task_claim', { task_id: id, child_id: 'replacement' })).owner, 'replacement')
    const board = await task(parent.agent, 'task_board', { task_id: id })
    assert.equal(board.task.status, 'claimed')
    assert.equal(board.handoffs.length, 1)
    pass('native task tools, role rejection, acceptance and audited reassignment')
    const pagedIds = []
    for (let i = 0; i < 31; i++) pagedIds.push((await task(parent.agent, 'task_open', {
      title: `native page ${i} ${'标题😀'.repeat(2000)}` })).task_id)
    const rawPage = await execute(parent.agent, 'task_board', {})
    assert.equal(rawPage.isError, false, rawPage.error?.message)
    assert.ok(Buffer.byteLength(rawPage.value, 'utf8') <= 65536)
    let page = JSON.parse(rawPage.value)
    assert.equal(page.ok, true)
    assert.equal(page.pagination.limit, 25)
    assert.ok(page.tasks.length > 0 && page.tasks.length <= 25)
    assert.equal(page.pagination.has_more, true)
    assert.ok(page.tasks.some(row => row.truncated), 'large titles must disclose clipping')
    const seen = page.tasks.map(row => row.id)
    while (page.pagination.has_more) {
      page = await task(parent.agent, 'task_board', { cursor: page.pagination.next_cursor })
      seen.push(...page.tasks.map(row => row.id))
    }
    assert.equal(new Set(seen).size, seen.length)
    assert(pagedIds.every(id => seen.includes(id)), 'native cursors must recover every clipped task')
    assert.equal((await task(parent.agent, 'task_board', { task_id: pagedIds[0] })).task.title,
      `native page 0 ${'标题😀'.repeat(2000)}`)
    pass('registered native task_board defaults are bounded and cursors preserve full task reachability')
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
