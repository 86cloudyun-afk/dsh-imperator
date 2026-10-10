import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { controlledProfile, installationVersion, nativeModule, resolveInstallAnchor } from '../host-runtime.mjs'

let anchor, skip
try { anchor = resolveInstallAnchor({}) } catch (error) { skip = error.message }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
test('pinned official H01 preparation and H03 strict flush raw readback; no model requests', { skip }, async () => {
  const helpers = await import('../../lib/scheduler/dsh-host.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e })
  assert.equal(typeof helpers.prepareNativeIdentity, 'function', 'native identity preparation missing')
  assert.equal(typeof helpers.flushNativeCheckpoint, 'function', 'strict native checkpoint missing')
  const previousExitCode = process.exitCode
  const version = installationVersion(anchor)
  const fixture = await controlledProfile(anchor, root)
  const cleanup = () => fixture.dispose()
  process.once('exit', cleanup)
  let application
  const handles = []
  try {
    const { runProfile } = await import(pathToFileURL(join(dirname(anchor), 'lib/profile-boot.js')).href)
    application = await runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web',
      patchFiles: [fixture.overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
    const { ctx } = application
    let requests = 0
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
    const backend = ctx.get('sessionPersistence')
    const checkpoint = await helpers.flushNativeCheckpoint(ctx, { version, session: child.agent.session, persistence: backend })
    assert.equal(checkpoint.session_id, child.agent.id)
    assert.match(checkpoint.digest, /^[a-f0-9]{64}$/)
    assert.equal(checkpoint.terminal, false)
    assert.equal(checkpoint.quiescence_proven, false)
    assert.equal(requests, 0)
    const requireHost = createRequire(anchor)
    for (const name of ['dsh-agent', 'dsh-session', 'dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-subprocess']) {
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
    try { for (const handle of handles.reverse()) await handle.dispose() }
    finally { try { await application?.shutdown.shutdown(1) } finally { process.off('exit', cleanup); fixture.dispose(); process.exitCode = previousExitCode } }
  }
})
