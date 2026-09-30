#!/usr/bin/env node
/** Real DSH preset isolation. No model input, API credential or user profile. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { controlledProfile, nativeModule, resolveInstallAnchor } from './host-runtime.mjs'
import { option } from './verify-preset.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function verifyIsolation({ installAnchor, installDir } = {}) {
  const anchor = resolveInstallAnchor({ installAnchor, installDir })
  const fixture = await controlledProfile(anchor, ROOT)
  const emergency = () => fixture.dispose()
  process.once('exit', emergency)
  const previousExitCode = process.exitCode
  const handles = new Set(), prepared = new WeakSet(), checks = []
  let app, registry, agents, serial = 0
  const check = async (name, fn) => { await fn(); checks.push(name); console.log(`ISOLATION_PASS: ${name}`) }
  try {
    const [{ renderPrompt }, { agentEvents }, { createToolResultMessage }] = await Promise.all([
      nativeModule(anchor, '@deepseek-ai/dsh-system-prompt'), nativeModule(anchor, '@deepseek-ai/dsh-agent'),
      nativeModule(anchor, '@deepseek-ai/dsh-llm'),
    ])
    const { runProfile } = await import(pathToFileURL(join(dirname(anchor), 'lib/profile-boot.js')).href)
    app = await runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web',
      patchFiles: [fixture.overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
    registry = app.ctx.get('agentPresets'); agents = app.ctx.get('agents')
    const create = async preset => {
      const handle = await agents.create({ sessionId: `isolation-${++serial}`, meta: { cwd: fixture.root },
        setup: async (ctx, agent) => {
          const bound = await registry.mount(ctx, preset)
          agent.session.append('agent-preset/selected', { agentPreset: bound.id })
        } })
      handles.add(handle); return handle
    }
    const dispose = async handle => { await handle.dispose(); handles.delete(handle) }
    const snapshot = async (handle, expected) => {
      const agent = handle.agent
      if (!prepared.has(agent)) {
        agent.ctx.systemPrompt.variable('model', () => 'isolation-no-model')
        agent.ctx.systemPrompt.variable('cwd', () => fixture.root)
        prepared.add(agent)
      }
      const prompt = renderPrompt(await agent.ctx.systemPrompt.assemble({ agent, scope: agent }))
      const names = agent.ctx.tools.schemas(agent).map(row => row.name)
      assert.equal(registry.composedPreset(agent.ctx), expected)
      assert.equal(prompt.includes('你是「任务部队」'), expected === 'taskforce')
      assert.equal(names.some(name => name.startsWith('task_')), expected === 'taskforce')
      if (expected === 'standard') {
        assert.doesNotMatch(prompt, /派发前先作决策|\[任务部队/)
        for (const tool of ['write', 'edit', 'bash']) assert(names.includes(tool), `standard lost ${tool}`)
      }
      return names
    }
    const execute = (handle, name, args, callId = `probe-${++serial}`) => handle.agent.ctx.tools.execute({
      agent: handle.agent, name, arguments: args, callId, signal: new AbortController().signal,
    })
    const write = async (handle, allowed) => {
      const file = join(fixture.root, `output-${++serial}.txt`)
      const result = await execute(handle, 'write', { file_path: file, content: 'isolated verification\n' })
      assert.equal(existsSync(file), allowed, result.error?.message)
      assert.equal(result.isError, !allowed, result.error?.message)
      if (!allowed) assert.match(result.error.message, /E_ORCHESTRATOR_SCOPE_DENIED/)
    }
    const preStep = (handle, next = async () => ({ kind: 'enter', messages: [] })) =>
      agentEvents(handle.agent.ctx, handle.agent).waterfall('agent/pre-step', {
        messages: [], turn: 2, step: 1, signal: new AbortController().signal,
      }, next)
    const tfMessages = decision => decision.messages.filter(row => row.source?.kind?.startsWith('taskforce'))
    const failures = async handle => {
      const session = handle.agent.session
      session.append('turn/start', { turn: 1 })
      for (let step = 1; step <= 6; step++) {
        const callId = `failure-${step}`, args = { file_path: join(fixture.root, 'missing.txt') }
        session.append('step/start', { turn: 1, step })
        const called = session.append('tool/call', { turn: 1, step, callId, name: 'read', arguments: JSON.stringify(args) })
        const result = await execute(handle, 'read', args, callId)
        assert.equal(result.isError, true)
        session.append('tool/result', { turn: 1, step,
          message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
          ...(result.error?.info ? { error: result.error.info } : {}) },
        { surfaceOp: 'append', sourceEventSeqs: [called.seq] })
        session.append('step/end', { turn: 1, step })
      }
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return tfMessages(await preStep(handle))
    }

    const standard = await create(undefined)
    await check('default standard has no TaskForce persona, tools or write restriction', async () => {
      await snapshot(standard, 'standard'); await write(standard, true)
    })
    const tf = await create('taskforce')
    await check('selected TaskForce has its rules and real execution denial', async () => {
      await snapshot(tf, 'taskforce'); await write(tf, false)
    })
    await check('existing and new standard agents remain isolated while TaskForce is live', async () => {
      for (const handle of [standard, await create('standard')]) { await snapshot(handle, 'standard'); await write(handle, true) }
    })
    await check('minimal preset does not inherit TaskForce rules or tools', async () => {
      await snapshot(await create('minimal'), 'minimal')
    })
    const switching = await create('taskforce')
    await check('TaskForce to standard immediately restores tools and actual writes', async () => {
      await registry.select(switching.agent, 'standard')
      await snapshot(switching, 'standard'); await write(switching, true)
      assert.equal(tfMessages(await preStep(switching)).length, 0)
    })
    await check('repeated standard/TaskForce selection restores policy without stale restrictions', async () => {
      for (let i = 0; i < 4; i++) {
        await registry.select(switching.agent, 'taskforce'); await snapshot(switching, 'taskforce'); await write(switching, false)
        await registry.select(switching.agent, 'standard'); await snapshot(switching, 'standard'); await write(switching, true)
      }
    })
    await check('leaving TaskForce preserves independent host safety restrictions', async () => {
      const handle = await create('taskforce')
      const unguard = handle.agent.ctx.tools.guard(exec => exec.name === 'bash' ? 'ISOLATION_HOST_POLICY' : undefined)
      const unfilter = handle.agent.ctx.tools.restrict({ deny: ['bash'] })
      try {
        await registry.select(handle.agent, 'standard'); await write(handle, true)
        assert(!handle.agent.ctx.tools.schemas(handle.agent).some(row => row.name === 'bash'))
        const result = await execute(handle, 'bash', { command: 'true' })
        assert.equal(result.isError, true); assert.match(result.error.message, /ISOLATION_HOST_POLICY/)
      } finally { unguard(); unfilter() }
    })
    await check('an in-progress pre-step cannot inject rules or reinstall guards after switching', async () => {
      const handle = await create('taskforce')
      app.ctx.get('taskforceStore').openTask({ title: 'must not appear in standard' }, handle.agent.id)
      const decision = await preStep(handle, async () => {
        await registry.select(handle.agent, 'standard'); return { kind: 'enter', messages: [] }
      })
      assert.equal(tfMessages(decision).length, 0)
      await snapshot(handle, 'standard'); await write(handle, true)
    })
    await check('a standard-selected session resumes from persistence without TaskForce policy', async () => {
      const id = switching.agent.id
      assert.equal(await switching.agent.session.flush(), true)
      await dispose(switching)
      const handle = await agents.resume({ resumeSessionId: id, setup: async (ctx, agent) => {
        const selected = app.ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
        assert.equal(selected, 'standard'); await registry.mount(ctx, selected)
      } })
      handles.add(handle); await snapshot(handle, 'standard'); await write(handle, true)
    })
    await check('standard failures do not invoke TaskForce status or failure hooks', async () => {
      assert.equal((await failures(await create('standard'))).length, 0)
    })
    await check('TaskForce failure hooks remain active as a positive control', async () => {
      const messages = await failures(await create('taskforce'))
      assert(messages.some(row => row.source.kind === 'taskforce-guard' && row.source.signal === 'echo'))
    })
    await check('retired and new preset revisions do not apply each other’s restrictions', async () => {
      const old = await create('taskforce')
      const entry = [...app.ctx.loader.entries()].find(row => row.options.id === 'taskforce' && row.options.name === '@local/dsh-taskforce')
      assert(entry)
      await entry.update({ disabled: true }); await app.ctx.loader.await()
      await entry.update({ disabled: false }); await app.ctx.loader.await()
      const newer = await create('taskforce')
      await write(old, false); await write(newer, false)
      await registry.select(old.agent, 'standard'); await snapshot(old, 'standard'); await write(old, true)
      await write(newer, false)
      await registry.select(old.agent, 'taskforce'); await write(old, false)
      await registry.select(old.agent, 'standard'); await write(old, true)
      await snapshot(standard, 'standard'); await write(standard, true)
    })
  } finally {
    try { try { for (const handle of [...handles].reverse()) await handle.dispose() }
      finally { await app?.shutdown.shutdown(1) }
    } finally {
      fixture.dispose(); process.removeListener('exit', emergency)
      assert.equal(existsSync(fixture.root), false)
      process.exitCode = previousExitCode
    }
  }
  checks.push('agent, host and disposable home cleanup')
  console.log(`ISOLATION_VERIFIED: ${checks.length} checks; no model requests`)
  return { ok: true, checks }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  try { await verifyIsolation({ installAnchor: option(args, '--install-anchor'), installDir: option(args, '--install-dir') }) }
  catch (error) { console.error(`ISOLATION_FAILED: ${error.message}`); process.exitCode = 1 }
}
