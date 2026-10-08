import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runVerification } from '../verify-all.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const missingProfile = join(tmpdir(), 'taskforce-runner-no-profile')
const missingInstall = join(tmpdir(), 'taskforce-runner-no-install')
// native-only 测试只在 integration 分支的 native boundaries 调用中运行，不属于 offline 清单。
const NATIVE_ONLY_TESTS = ['host-boundaries.test.mjs']

test('offline runs six scripts and explicit test files, then marks host integration unverified', async () => {
  const calls = []
  const result = await runVerification({ mode: 'offline', profileDir: missingProfile, installDir: missingInstall,
    runProcess: async (file, args, options) => {
      calls.push({ file, args, options })
      return { exitCode: 0 }
    } })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 7)
  assert.deepEqual(calls.slice(0, 6).map(({ args }) => args[0].split('/').at(-1)), [
    'verify-store.mjs', 'verify-store-v2.mjs', 'verify-store-v3.mjs',
    'verify-p3.mjs', 'verify-scope-guard.mjs', 'verify-child-control.mjs',
  ])
  assert.equal(calls[6].args[0], '--test')
  assert(calls[6].args.some(path => path.endsWith('/owner-session.test.mjs')),
    'real owner/session and fact audit behavior must be registered in the offline runner')
  // 目录锚定：期望集合由 tools/tests 的实际内容推导——孤儿测试（在目录里但未注册）与幽灵条目
  // （注册了但文件缺失）都会在此失败，且新增测试文件无需第二处手工同步。
  const expectedOfflineTests = readdirSync(join(root, 'tools/tests'))
    .filter((name) => name.endsWith('.test.mjs') && !NATIVE_ONLY_TESTS.includes(name))
    .sort()
  assert.deepEqual(calls[6].args.slice(1).map((path) => path.split('/').at(-1)).sort(), expectedOfflineTests,
    'the offline test list must equal the .test.mjs files present in tools/tests (no orphans, no ghosts)')
  assert(calls.every(({ file, args, options }) => file === process.execPath
    && args.slice(args[0] === '--test' ? 1 : 0).every(isAbsolute)
    && options.timeout === 60_000 && options.shell === false))
  assert(result.results.slice(0, 7).every(({ status }) => status === 'passed'))
  assert.deepEqual(result.results.at(-1), { name: 'host integration', status: 'unverified', exitCode: null })
})

test('offline collects a failed script and a timed out child without hiding later results', async () => {
  let calls = 0
  const result = await runVerification({ mode: 'offline', profileDir: missingProfile, installDir: missingInstall,
    runProcess: async () => {
      calls++
      if (calls === 1) return { exitCode: 3 }
      if (calls === 2) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
      return { exitCode: 0 }
    } })
  assert.equal(result.ok, false)
  assert.equal(calls, 7)
  assert.deepEqual(result.results.slice(0, 3).map(({ status }) => status), ['failed', 'failed', 'passed'])
  assert.equal(result.results[0].exitCode, 3)
  assert.equal(result.results[1].exitCode, null)
})

test('a missing script cannot be counted as passed', async () => {
  let calls = 0
  const result = await runVerification({ mode: 'offline', profileDir: missingProfile, installDir: missingInstall,
    runProcess: async () => {
      calls++
      if (calls === 1) throw Object.assign(new Error('missing executable'), { code: 'ENOENT' })
      return { exitCode: 0 }
    } })
  assert.equal(result.ok, false)
  assert.equal(result.results[0].status, 'failed')
  assert.equal(result.results[0].exitCode, null)
})

test('integration and all fail closed when required host files are absent', async () => {
  for (const mode of ['integration', 'all']) {
    const result = await runVerification({ mode, profileDir: missingProfile, installDir: missingInstall,
      runProcess: async () => ({ exitCode: 0 }) })
    assert.equal(result.ok, false)
    assert.deepEqual(result.results.at(-1), { name: 'host integration', status: 'unverified', exitCode: null })
  }
})

test('CLI locates its own package from an unrelated cwd and exits nonzero on missing host', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'taskforce-runner-cwd-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  assert.throws(() => execFileSync(process.execPath, [join(root, 'tools/verify-all.mjs'), '--mode=integration',
    '--profile-dir', join(cwd, 'missing-profile'), '--install-dir', join(cwd, 'missing-install')],
  { cwd, encoding: 'utf8', timeout: 10_000 }), (error) => {
    assert.equal(error.status, 1)
    assert.match(error.stdout, /host integration.*UNVERIFIED/i)
    return true
  })
})

test('preset CLI accepts positional profile and install flag, rejecting missing schema validator', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'taskforce-preset-cli-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const profile = join(fixture, 'profile')
  const install = join(fixture, 'modules')
  const registry = join(install, '@deepseek-ai/dsh-agent-preset-registry/lib')
  mkdirSync(profile)
  mkdirSync(registry, { recursive: true })
  writeFileSync(join(registry, 'index.js'), 'module.exports = {}\n')
  assert.throws(() => execFileSync(process.execPath, [join(root, 'tools/verify-preset.mjs'), profile,
    '--install-dir', install], { cwd: fixture, encoding: 'utf8', timeout: 10_000 }), (error) => {
    assert.equal(error.status, 1)
    assert.match(error.stdout, new RegExp(`profile\\s+: ${profile}`))
    assert.match(error.stdout, /UNVERIFIED.*entryListProblem/i)
    assert.doesNotMatch(error.stdout, /全绿/)
    return true
  })
})

test('integration runs actual boot separately and cannot hide a boot failure behind contract checks', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'taskforce-runner-anchor-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const anchor = join(fixture, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
  const calls = []
  const result = await runVerification({ mode: 'integration', installAnchor: anchor,
    runProcess: async (file, args, options) => {
      calls.push({ file, args, options })
      return { exitCode: args[0].endsWith('verify-host.mjs') ? 1 : 0 }
    } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.results.map(row => [row.name, row.status]), [
    ['preset contract', 'passed'], ['native boundaries', 'passed'], ['host integration', 'failed'], ['preset isolation', 'passed'],
  ])
  assert.equal(calls[1].options.env.DSH_INSTALL_ANCHOR, anchor)
  assert.ok(calls[2].args[0].endsWith('verify-host.mjs'))
})

test('all mode hands a resolved anchor to verify-store so S33 cannot silently skip', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'taskforce-runner-s33-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const anchor = join(fixture, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
  const calls = []
  const result = await runVerification({ mode: 'all', installAnchor: anchor,
    runProcess: async (file, args, options) => {
      calls.push({ file, args, options })
      return { exitCode: 0 }
    } })
  assert.equal(result.ok, true)
  const store = calls.find(({ args }) => args[0].endsWith('verify-store.mjs'))
  assert.deepEqual(store.args.slice(1), ['--install-anchor', anchor])
  for (const { args } of calls.filter(({ args }) => /verify-store-v[23]\.mjs$/.test(args[0]))) {
    assert.equal(args.includes('--install-anchor'), false)
  }
})

test('offline mode never passes an anchor to verify-store', async () => {
  const calls = []
  await runVerification({ mode: 'offline', installAnchor: join(tmpdir(), 'ignored', 'package.json'),
    runProcess: async (file, args, options) => {
      calls.push({ file, args, options })
      return { exitCode: 0 }
    } })
  const store = calls.find(({ args }) => args[0].endsWith('verify-store.mjs'))
  assert.equal(store.args.length, 1)
})

test('native-only boundaries test stays wired into the integration run', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'taskforce-runner-nativeonly-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const anchor = join(fixture, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
  const calls = []
  const result = await runVerification({ mode: 'integration', installAnchor: anchor,
    runProcess: async (file, args, options) => {
      calls.push({ file, args, options })
      return { exitCode: 0 }
    } })
  assert.equal(result.ok, true)
  const nativeCall = calls.find(({ args }) => args[0] === '--test'
    && args.some((path) => NATIVE_ONLY_TESTS.includes(path.split('/').at(-1))))
  assert.ok(nativeCall, `${NATIVE_ONLY_TESTS.join(', ')} must be exercised by the integration native boundaries call`)
})

for (const mode of ['integration', 'all']) {
  test(`${mode} runs host API contracts with the resolved installation anchor`, async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), 'taskforce-runner-contract-'))
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    const anchor = join(fixture, 'package.json')
    writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
    const calls = []
    const result = await runVerification({ mode, installAnchor: anchor,
      runProcess: async (file, args, options) => {
        calls.push({ file, args, options })
        return { exitCode: 0 }
      } })
    assert.equal(result.ok, true)
    const nativeCall = calls.find(({ args }) => args[0] === '--test'
      && args.includes(join(root, 'tools/tests/host-boundaries.test.mjs')))
    assert.ok(nativeCall, `${mode} must run native boundaries`)
    assert.ok(nativeCall.args.includes(join(root, 'tools/tests/host-api-contract.test.mjs')),
      `${mode} must run host API contracts in the anchored native invocation`)
    assert.equal(nativeCall.options.env.DSH_INSTALL_ANCHOR, realpathSync(anchor))
  })
}
