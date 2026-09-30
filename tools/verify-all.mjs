#!/usr/bin/env node
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
  'sqlite.test.mjs', 'store-atomicity.test.mjs', 'store-evidence.test.mjs',
  'lifecycle.test.mjs', 'verify-runner.test.mjs', 'deliberate-orchestration.test.mjs',
  'guard-causality.test.mjs',
]

function defaultRunProcess(file, args, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (exitCode) => resolveResult({ exitCode }))
  })
}

/** Runs independent checks and reports host checks separately. No work starts on import. */
export async function runVerification({ mode = 'offline', profileDir = '/opt/dsh/home/profiles/web',
  installDir = '/opt/dsh/install/node_modules', runProcess = defaultRunProcess } = {}) {
  if (!['offline', 'integration', 'all'].includes(mode)) throw new TypeError(`Unknown verification mode: ${mode}`)
  const results = []
  async function run(name, args) {
    try {
      const outcome = await runProcess(process.execPath, args, { cwd: ROOT, shell: false, timeout: 60_000 })
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

  const registry = join(installDir, '@deepseek-ai/dsh-agent-preset-registry/lib/index.js')
  if (mode === 'offline' || !existsSync(profileDir) || !existsSync(registry)) {
    results.push({ name: 'host integration', status: 'unverified', exitCode: null })
  } else {
    await run('host integration', [join(HERE, 'verify-preset.mjs'), '--profile-dir', resolve(profileDir),
      '--install-dir', resolve(installDir)])
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
      profileDir: value('--profile-dir'), installDir: value('--install-dir') })
    for (const { name, status, exitCode } of results) {
      console.log(`${name}: ${status.toUpperCase()}${exitCode === null ? '' : ` (exit ${exitCode})`}`)
    }
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
