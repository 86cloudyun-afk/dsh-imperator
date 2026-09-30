#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveInstallAnchor } from './host-runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SCRIPTS = [
  'verify-store.mjs', 'verify-store-v2.mjs', 'verify-store-v3.mjs',
  'verify-p3.mjs', 'verify-scope-guard.mjs', 'verify-child-control.mjs',
]
const TESTS = [
  'sqlite.test.mjs', 'store-atomicity.test.mjs', 'store-evidence.test.mjs',
  'lifecycle.test.mjs', 'verify-runner.test.mjs',
  'ptc-events.test.mjs', 'store-reassignment.test.mjs', 'host-runtime.test.mjs',
]

function defaultRunProcess(file, args, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (exitCode) => resolveResult({ exitCode }))
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
      results.push({ name, status: exitCode === 0 ? 'passed' : 'failed', exitCode })
    } catch (error) {
      results.push({ name, status: 'failed', exitCode: Number.isInteger(error?.code) ? error.code : null })
    }
  }

  if (mode !== 'integration') {
    for (const script of SCRIPTS) await run(script, [join(HERE, script)])
    await run('node:test', ['--test', ...TESTS.map((file) => join(HERE, 'tests', file))])
  }

  let anchor
  if (mode !== 'offline' && (profileDir === undefined || existsSync(profileDir))) {
    try { anchor = resolveInstallAnchor({ installAnchor, installDir }) } catch { /* report unverified below */ }
  }
  if (mode === 'offline' || anchor === undefined) {
    results.push({ name: 'host integration', status: 'unverified', exitCode: null })
  } else {
    await run('preset contract', [join(HERE, 'verify-preset.mjs'), '--install-anchor', anchor,
      ...(profileDir === undefined ? [] : ['--profile-dir', resolve(profileDir)])])
    await run('native boundaries', ['--test', join(HERE, 'tests/host-boundaries.test.mjs'), join(HERE, 'tests/host-runtime.test.mjs')],
      { ...process.env, DSH_INSTALL_ANCHOR: anchor })
    await run('host integration', [join(HERE, 'verify-host.mjs'), '--install-anchor', anchor])
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
    for (const { name, status, exitCode } of results) {
      console.log(`${name}: ${status.toUpperCase()}${exitCode === null ? '' : ` (exit ${exitCode})`}`)
    }
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
