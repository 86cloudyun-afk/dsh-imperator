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
