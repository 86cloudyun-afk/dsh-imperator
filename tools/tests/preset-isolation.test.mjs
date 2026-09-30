import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, DENY_CODE } from '../../lib/plugins/orchestrator-scope.mjs'

// Contract model for offline lifecycle checks. Real registry.select(), scope
// routing and actual writes are covered by verify-isolation.mjs in native CI.
function fixture() {
  const listeners = new Map(), effects = [], agents = new Map()
  const ctx = {
    preset: 'taskforce',
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'agentPresets') return { composedPreset: target => target.preset }
      if (name === 'agents') return { get: id => agents.get(id) }
    },
    on(name, fn) { const callbacks = listeners.get(name) ?? []; callbacks.push(fn); listeners.set(name, callbacks) },
    effect(fn) { const undo = fn(); effects.push(undo); return undo },
  }
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  function agent(id, preset = 'taskforce') {
    const guards = new Set(), restrictions = new Set()
    const state = { guards, restrictions, guardCalls: 0, failGuardCleanup: false, failFilterCleanup: false }
    const a = { id, session: { header: { id } }, ctx: { preset }, state }
    a.ctx.tools = {
      guard(fn) {
        state.guardCalls++; guards.add(fn)
        return () => { if (state.failGuardCleanup) throw new Error('injected guard cleanup failure'); guards.delete(fn) }
      },
      restrict(value) {
        restrictions.add(value)
        return () => { if (state.failFilterCleanup) throw new Error('injected filter cleanup failure'); restrictions.delete(value) }
      },
      schemas() {
        const denied = new Set([...restrictions].flatMap(row => row.deny))
        return ['read', 'bash', 'write', 'edit', 'run_code'].filter(n => !denied.has(n)).map(name => ({ name }))
      },
    }
    a.write = () => { for (const guard of guards) { const denial = guard({ agent: a, name: 'write' }); if (typeof denial === 'string') throw new Error(denial) } return true }
    agents.set(id, a)
    return a
  }
  apply(ctx)
  const enter = a => emit('agent/created', { agent: a })
  const select = (a, id) => { a.ctx.preset = id; emit('tools/change'); emit('agent-preset/selected', a.id, id) }
  const pre = async (a, next = async () => ({ kind: 'enter', messages: [] })) => {
    for (const fn of listeners.get('agent/pre-step') ?? []) await fn({ agent: a }, next)
  }
  return { ctx, agent, enter, select, pre, emit, dispose: () => { for (const fn of effects.reverse()) fn?.() } }
}
const visible = a => a.ctx.tools.schemas().map(row => row.name)
const denied = a => assert.throws(() => a.write(), error => error.message.includes(DENY_CODE))

test('leaving TaskForce releases only its own guard and filter before the next step', () => {
  const f = fixture(), a = f.agent('root')
  f.enter(a); denied(a); assert(!visible(a).includes('write'))
  f.select(a, 'standard')
  assert.equal(a.write(), true)
  assert(visible(a).includes('write'))
  assert.equal(a.state.guards.size, 0); assert.equal(a.state.restrictions.size, 0)
})

test('registry recompose tools/change clears old restrictions even without a selected log event', () => {
  const f = fixture(), a = f.agent('root')
  f.enter(a); a.ctx.preset = 'minimal'; f.emit('tools/change')
  assert.equal(a.state.guards.size, 0); assert.equal(a.state.restrictions.size, 0)
})

test('a forged selected event cannot disable a still-composed TaskForce policy', () => {
  const f = fixture(), a = f.agent('root')
  f.enter(a); f.emit('agent-preset/selected', a.id, 'standard'); denied(a)
})

test('standard and unrelated session notifications cannot acquire TaskForce restrictions', () => {
  const f = fixture(), tf = f.agent('tf'), standard = f.agent('standard', 'standard')
  f.enter(tf); f.enter(standard); f.emit('agent-preset/selected', standard.id, 'taskforce')
  assert.equal(standard.write(), true); assert.equal(standard.state.guardCalls, 0); denied(tf)
})

test('repeated blank-session switching restores TaskForce without duplicate active registrations', () => {
  const f = fixture(), a = f.agent('root')
  f.enter(a)
  for (let i = 0; i < 12; i++) {
    f.select(a, 'standard'); assert.equal(a.write(), true)
    f.select(a, 'taskforce'); denied(a)
    assert.equal(a.state.guards.size, 1); assert.equal(a.state.restrictions.size, 1)
  }
  f.select(a, 'standard'); assert.equal(a.state.guards.size, 0)
})

test('leaving does not remove independent host guards or host visibility restrictions', () => {
  const f = fixture(), a = f.agent('root')
  const other = () => { throw new Error('HOST_POLICY') }
  a.ctx.tools.guard(other); a.ctx.tools.restrict({ deny: ['bash'] })
  f.enter(a); f.select(a, 'standard')
  assert.deepEqual([...a.state.guards], [other]); assert(!visible(a).includes('bash'))
  assert(visible(a).includes('write')); assert.throws(a.write, /HOST_POLICY/)
})

test('an awaited pre-step cannot reinstall policy after composition changes', async () => {
  const f = fixture(), a = f.agent('root')
  f.enter(a)
  await f.pre(a, async () => { f.select(a, 'standard'); return { kind: 'enter', messages: [] } })
  assert.equal(a.write(), true); assert.equal(a.state.guards.size, 0)
})

test('plugin disposal releases owned registrations while unrelated rules survive', () => {
  const f = fixture(), a = f.agent('a'), b = f.agent('b')
  const other = () => {}; b.ctx.tools.guard(other)
  f.enter(a); f.enter(b); f.dispose(); f.dispose()
  assert.equal(a.state.guards.size, 0); assert.deepEqual([...b.state.guards], [other])
  assert.equal(a.state.restrictions.size, 0); assert.equal(b.state.restrictions.size, 0)
  f.emit('agent-preset/selected', a.id, 'taskforce'); assert.equal(a.state.guards.size, 0)
})

test('failed cleanup keeps exact disposers for retry, attempts both layers and stops stale policy', () => {
  const f = fixture(), a = f.agent('root')
  f.enter(a); a.state.failGuardCleanup = true
  f.select(a, 'standard')
  assert.equal(a.state.restrictions.size, 0, 'filter cleanup must run even when guard cleanup throws')
  assert.equal(a.write(), true, 'a stale TaskForce guard cannot enforce rules in standard')
  a.state.failGuardCleanup = false; f.emit('tools/change')
  assert.equal(a.state.guards.size, 0)
})

test('failed filter cleanup is retried rather than forgetting its disposer', () => {
  const f = fixture(), a = f.agent('root')
  f.enter(a); a.state.failFilterCleanup = true; f.select(a, 'standard')
  assert.equal(a.state.guards.size, 0)
  a.state.failFilterCleanup = false; f.emit('tools/change')
  assert.equal(a.state.restrictions.size, 0)
})

test('working context cannot publish a TaskForce message after awaited preset departure', async () => {
  const { apply: working } = await import('../../lib/plugins/working-context.mjs')
  let hook
  const a = { session: { header: { id: 'root' }, events: [] }, ctx: { preset: 'taskforce' } }
  const ctx = { preset: 'taskforce', on: (_event, fn) => { hook = fn }, get: name => name === 'agentPresets'
    ? { composedPreset: target => target.preset } : name === 'taskforceStore'
      ? { workingState: () => ({ activeTasks: 1, factCount: 1, task: { id: 1, title: 'private task' } }) } : undefined }
  working(ctx)
  const decision = await hook({ agent: a }, async () => {
    a.ctx.preset = 'standard'; return { kind: 'enter', messages: [] }
  })
  assert.deepEqual(decision.messages, [])
})

test('failure guard does not inject messages after awaited preset departure', async () => {
  const { apply: guard } = await import('../../lib/plugins/guard.mjs')
  const hooks = new Map()
  const events = [1, 2, 3].flatMap(id => [
    { type: 'tool/call', data: { callId: String(id), name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { callId: String(id), error: 'missing' } },
  ])
  const a = { session: { events }, ctx: { preset: 'taskforce' } }
  guard({ preset: 'taskforce', on: (event, fn) => hooks.set(event, fn),
    get: () => ({ composedPreset: target => target.preset }) }, { echoFailures: 2 })
  const decision = await hooks.get('agent/pre-step')({ agent: a }, async () => {
    a.ctx.preset = 'standard'; return { kind: 'enter', messages: [] }
  })
  assert.deepEqual(decision.messages, [])
})

test('linked packages resolve the native scope through the host package catalog', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createScopeMembership } = await import('../../lib/plugins/scope-membership.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'taskforce-scope-package-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-scope', exports: './index.cjs' }))
  writeFileSync(join(dir, 'index.cjs'), 'exports.scopeOf = ctx => ctx.nativeScope; exports.scopeChainOf = key => key?.chain ?? [];')
  const revision = {}, nextRevision = {}
  const ctx = { nativeScope: revision, baseUrl: import.meta.url, get: name => name === 'pluginPackages' ? {
    packageOf(specifier, parent) {
      assert.equal(specifier, '@deepseek-ai/dsh-scope'); assert.equal(parent, import.meta.url)
      return { name: specifier, manifestPath: join(dir, 'package.json') }
    },
  } : undefined }
  const owns = createScopeMembership(ctx)
  assert.equal(owns({ ctx: { nativeScope: { chain: [revision] } } }), true)
  assert.equal(owns({ ctx: { nativeScope: { chain: [nextRevision] } } }), false)
  assert.equal(owns({ ctx: { nativeScope: { chain: [] } } }), false)
})

test('a native host with unavailable scope support fails activation instead of assuming global ownership', async () => {
  const { createScopeMembership } = await import('../../lib/plugins/scope-membership.mjs')
  const ctx = { get: name => name === 'pluginPackages' ? { packageOf: () => undefined } : undefined }
  assert.throws(() => createScopeMembership(ctx), /native scope unavailable/)
})
