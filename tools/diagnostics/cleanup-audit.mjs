#!/usr/bin/env node
// Temporary diagnostic evidence, never an acceptance substitute.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const verifier = new URL('../verify-host.mjs', import.meta.url).href
const runtime = new URL('../host-runtime.mjs', import.meta.url).href
const evidence = process.argv[2]
assert.ok(evidence, 'diagnostic evidence directory is required')
assert.ok(process.env.DSH_INSTALL_ANCHOR, 'exact native install anchor is required')
mkdirSync(evidence, { recursive: true })
const records = []
let strictFailures = 0
const prefix = 'CLEANUP_DIAGNOSTIC='
const header = [
  'const started = performance.now();',
  "const { writeSync } = await import('node:fs');",
  "const mark = phase => writeSync(1, 'CLEANUP_DIAGNOSTIC=' + JSON.stringify({phase, elapsed_ms: Math.round(performance.now()-started)}) + '\\n');",
  "process.on('SIGTERM', () => mark('sigterm_observed'));",
].join('\n')
function capture(mode, attempt, source) {
  const started = performance.now()
  let output = '', stderr = '', wrapper = null
  try {
    output = execFileSync(process.execPath, ['--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 12_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    output = String(error.stdout ?? '')
    stderr = String(error.stderr ?? '')
    wrapper = { code: typeof error.code === 'string' ? error.code : null,
      signal: error.signal ?? null, status: error.status ?? null,
      errno: typeof error.errno === 'number' ? error.errno : null,
      killed: typeof error.killed === 'boolean' ? error.killed : null }
  }
  const markers = output.split('\n').filter(line => line.startsWith(prefix)).map(line => {
    const row = JSON.parse(line.slice(prefix.length))
    assert.match(row.phase, /^[a-z_]{1,48}$/)
    assert.ok(Number.isSafeInteger(row.elapsed_ms) && row.elapsed_ms >= 0)
    return { phase: row.phase, elapsed_ms: row.elapsed_ms }
  }).slice(0, 32)
  const home = output.match(/^CLEANUP_ROOT=(.+)$/m)?.[1]
  const ownedHome = home?.startsWith(join(tmpdir(), 'taskforce-host-')) ? home : null
  const row = { diagnostic_only: true, acceptance: false, mode, attempt, deadline_ms: 12_000,
    elapsed_ms: Math.round(performance.now()-started), wrapper_threw: wrapper !== null,
    code: wrapper?.code ?? null, signal: wrapper?.signal ?? null,
    status: wrapper ? wrapper.status : 0, errno: wrapper?.errno ?? null,
    killed: wrapper?.killed ?? null, stdout_bytes: Buffer.byteLength(output),
    stderr_bytes: Buffer.byteLength(stderr), markers,
    success_marker: /UNEXPECTED_SUCCESS|HOST_VERIFIED/.test(output),
    owned_home_seen: Boolean(ownedHome), home_removed_before_fallback: ownedHome ? !existsSync(ownedHome) : null }
  if (ownedHome) rmSync(ownedHome, { recursive: true, force: true })
  return row
}
function publish(row) {
  records.push(row)
  writeFileSync(join(evidence, 'cleanup-observations.json'), JSON.stringify(records, null, 2))
  console.log(JSON.stringify(row))
}
for (let attempt = 1; attempt <= 3; attempt++) {
  for (const mode of ['reject', 'hang']) {
    const source = [header,
      'const { verifyHost } = await import(' + JSON.stringify(verifier) + ');',
      'await verifyHost({ configureShutdown(app, root) {',
      "writeSync(1, 'CLEANUP_ROOT=' + root + '\\n');",
      "mark('host_ready');",
      'const dispose = app.ctx.fiber.dispose.bind(app.ctx.fiber);',
      'app.ctx.fiber.dispose = async () => {',
      "mark('disposer_entered');",
      'await dispose();',
      "mark('original_disposer_finished');",
      mode === 'reject' ? "throw new Error('injected cleanup failure');" : 'return new Promise(() => {});',
      '}; }});',
      "writeSync(1, 'UNEXPECTED_SUCCESS\\n');",
    ].join('\n')
    const row = capture(mode, attempt, source)
    try {
      assert.equal(row.wrapper_threw, true, 'injected cleanup must throw at the wrapper')
      assert.equal(row.status, 1, 'forced native cleanup must never exit zero')
      assert.equal(row.success_marker, false)
      assert.equal(row.owned_home_seen, true)
      assert.equal(row.home_removed_before_fallback, true, 'forced native cleanup leaked its home')
      row.strict_original_expectation = 'pass'
    } catch {
      row.strict_original_expectation = 'fail'
      strictFailures++
    }
    publish(row)
  }
}
for (const mode of ['explicit_sigterm_pending_shutdown', 'wrapper_deadline_pending_shutdown']) {
  const source = [header,
    'const { controlledProfile, resolveInstallAnchor } = await import(' + JSON.stringify(runtime) + ');',
    "const { dirname, join } = await import('node:path');",
    "const { pathToFileURL } = await import('node:url');",
    'const anchor = resolveInstallAnchor({});',
    'const fixture = await controlledProfile(anchor, ' + JSON.stringify(root) + ');',
    "writeSync(1, 'CLEANUP_ROOT=' + fixture.root + '\\n');",
    "process.once('exit', () => fixture.dispose());",
    "const { runProfile } = await import(pathToFileURL(join(dirname(anchor), 'lib/profile-boot.js')).href);",
    "const app = await runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile:'web',",
    "patchFiles:[fixture.overlay], args:['--host','127.0.0.1','--port','0','--no-open'] });",
    "mark('host_ready');",
    'const dispose = app.ctx.fiber.dispose.bind(app.ctx.fiber);',
    'app.ctx.fiber.dispose = async () => {',
    "mark('disposer_entered');",
    'await dispose();',
    "mark('original_disposer_finished');",
    mode === 'explicit_sigterm_pending_shutdown' ? "setTimeout(() => { mark('self_sigterm_sent'); process.kill(process.pid, 'SIGTERM'); }, 25);" : '',
    'return new Promise(() => {});',
    '};',
    mode === 'wrapper_deadline_pending_shutdown' ? 'await new Promise(resolve => setTimeout(resolve, Math.max(0, 9000 - (performance.now() - started))));' : '',
    "mark('shutdown_requested');",
    'await app.shutdown.shutdown(1);',
    "mark('unexpected_shutdown_return');",
  ].join('\n')
  const row = capture(mode, 1, source)
  const phases = row.markers.map(marker => marker.phase)
  const pendingProved = phases.includes('host_ready') && phases.includes('shutdown_requested')
    && phases.includes('disposer_entered') && phases.includes('original_disposer_finished')
    && phases.includes('sigterm_observed') && !phases.includes('unexpected_shutdown_return')
  row.mechanism_observed = pendingProved && row.status === 0 && row.home_removed_before_fallback === true
    && (mode === 'wrapper_deadline_pending_shutdown' ? row.wrapper_threw && row.code === 'ETIMEDOUT' : !row.wrapper_threw)
  publish(row)
}
console.log(JSON.stringify({ diagnostic_only: true, acceptance: false, phase: 'complete',
  strict_original_cases: 6, strict_original_failures: strictFailures,
  mechanism_probes: 2, mechanism_observed: records.filter(row => row.mechanism_observed === true).length }))
process.exitCode = strictFailures ? 1 : 0
