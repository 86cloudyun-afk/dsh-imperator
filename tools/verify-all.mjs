#!/usr/bin/env node
import { resolveInstallAnchor } from './host-runtime.mjs'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SCRIPTS = [
  'verify-store.mjs', 'verify-store-v2.mjs', 'verify-store-v3.mjs',
  'verify-p3.mjs', 'verify-scope-guard.mjs', 'verify-child-control.mjs',
]
const TESTS = [
  'operations.test.mjs',
  'workflow-engine.test.mjs',
  'model-regression.test.mjs',
  'governor.test.mjs',
  'sqlite.test.mjs',
  'store-atomicity.test.mjs',
  'store-evidence.test.mjs',
  'lifecycle.test.mjs',
  'verify-runner.test.mjs',
  'deliberate-orchestration.test.mjs',
  'guard-causality.test.mjs',
  'incremental-projection.test.mjs',
  'store-scope-integrity.test.mjs',
  'sqlite-failure-safety.test.mjs',
  'working-state.test.mjs',
  'process-runner.test.mjs',
  'context-boundaries.test.mjs',
  'board-batching.test.mjs',
  'board-pagination.test.mjs',
  'read-snapshot.test.mjs',
  'lifecycle-recovery.test.mjs',
  'ptc-events.test.mjs',
  'continuation-flow.test.mjs',
  'store-reassignment.test.mjs',
  'host-runtime.test.mjs',
  'integration-contract.test.mjs',
  'package-delivery.test.mjs',
  'preset-isolation.test.mjs',
  'docs-contract.test.mjs',
  'readme-smoke-safety.test.mjs',
  'exit-propagation.test.mjs',
  'repo-hygiene.test.mjs',
  'error-code-contract.test.mjs',
  'submit-status-code.test.mjs',
  'hint-status-submit-contract.test.mjs',
  'sqlite-fault-hint.test.mjs',
  'host-api-contract.test.mjs',
  'workflow-contract.test.mjs',
  'engines-contract.test.mjs',
  'code-hint-coverage.test.mjs',
  'mount-diagnostics.test.mjs',
  'tool-args-contract.test.mjs',
  'hint-dispatch-order.test.mjs',
  'close-failed-owner-guard.test.mjs',
  'submit-audit-attribution.test.mjs',
  'owner-session.test.mjs',
  'execution-receipts.test.mjs',
  'execution-adoption.test.mjs',
  'tool-recovery.test.mjs',
  'nextgen-tool-integration.test.mjs',
]

/** Run one direct child with an explicit deadline and bounded termination grace. */
export function defaultRunProcess(file, args, options = {}) {
  const { timeout = 60_000, ...spawnOptions } = options
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new TypeError('Process timeout must be a positive 32-bit millisecond integer')
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { ...spawnOptions, stdio: 'inherit' })
    let timedOut = false
    let forceTimer
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      timedOut = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 500)
    }, timeout)
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', (exitCode, signal) => {
      cleanup()
      resolveResult({ exitCode, signal, timedOut })
    })
  })
}

/** Runs independent checks and reports host checks separately. No work starts on import. */
export async function runVerification({ mode = 'offline', profileDir,
  installDir, installAnchor, runProcess = defaultRunProcess } = {}) {
  if (!['offline', 'integration', 'all'].includes(mode)) throw new TypeError(`Unknown verification mode: ${mode}`)
  const results = []
  async function run(name, args, env) {
    try {
      const outcome = await runProcess(process.execPath, args, { cwd: ROOT, shell: false, timeout: 60_000, ...(env ? { env } : {}) })
      const exitCode = Number.isInteger(outcome?.exitCode) ? outcome.exitCode : null
      const interrupted = outcome?.timedOut === true || Boolean(outcome?.signal)
      results.push({ name, status: exitCode === 0 && !interrupted ? 'passed' : 'failed', exitCode,
        ...(outcome?.timedOut === true ? { timedOut: true } : {}),
        ...(outcome?.signal ? { signal: outcome.signal } : {}) })
    } catch (error) {
      results.push({ name, status: 'failed', exitCode: Number.isInteger(error?.code) ? error.code : null })
    }
  }

  let anchor
  if (mode !== 'offline' && (profileDir === undefined || existsSync(profileDir))) {
    try { anchor = resolveInstallAnchor({ installAnchor, installDir }) } catch { /* fail closed below */ }
  }

  if (mode !== 'integration') {
    for (const script of SCRIPTS) {
      // With a resolved native host, verify-store must cross-check its fallback
      // schema compiler against the real dsh-tools (S33) instead of skipping it.
      const extra = anchor !== undefined && script === 'verify-store.mjs' ? ['--install-anchor', anchor] : []
      await run(script, [join(HERE, script), ...extra])
    }
    await run('node:test', ['--test', ...TESTS.map((file) => join(HERE, 'tests', file))])
  }
  if (mode === 'offline' || anchor === undefined) {
    results.push({ name: 'host integration', status: 'unverified', exitCode: null })
  } else {
    await run('preset contract', [join(HERE, 'verify-preset.mjs'), '--install-anchor', anchor,
      ...(profileDir === undefined ? [] : ['--profile-dir', resolve(profileDir)])])
    await run('native boundaries', ['--test', join(HERE, 'tests/host-boundaries.test.mjs'), join(HERE, 'tests/host-runtime.test.mjs'),
      join(HERE, 'tests/host-api-contract.test.mjs')],
      { ...process.env, DSH_INSTALL_ANCHOR: anchor })
    await run('host integration', [join(HERE, 'verify-host.mjs'), '--install-anchor', anchor])
    await run('preset isolation', [join(HERE, 'verify-isolation.mjs'), '--install-anchor', anchor])
  }
  return { ok: results.every(({ status }) => status === 'passed' || (mode === 'offline' && status === 'unverified')),
    results }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (flag) => {
    const index = process.argv.indexOf(flag)
    const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`))
    return inline ? inline.slice(flag.length + 1) : index < 0 ? undefined : process.argv[index + 1]
  }
  try {
    const { ok, results } = await runVerification({ mode: value('--mode') ?? 'offline',
      profileDir: value('--profile-dir'), installDir: value('--install-dir'), installAnchor: value('--install-anchor') })
    for (const { name, status, exitCode, timedOut, signal } of results) {
      console.log(`${name}: ${status.toUpperCase()}${exitCode === null ? '' : ` (exit ${exitCode})`}${timedOut ? ' (timeout)' : ''}${signal ? ` (${signal})` : ''}`)
    }
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
