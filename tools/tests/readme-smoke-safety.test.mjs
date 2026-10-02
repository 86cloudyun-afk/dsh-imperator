import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
const section = readme.split('### 端到端实挂（隔离 DSH_HOME，不碰现有实例）')[1]
const example = section?.match(/```bash\n([\s\S]*?)\n```/)?.[1]
assert.ok(example, 'README must retain the end-to-end smoke example')

// No real npm/dsh/rm is on PATH. Even the old unsafe rm arguments only get
// recorded: this stub may delete solely a directory it created with a marker.
const fakeCommand = `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs')
const path = require('node:path')
const fixture = process.env.FAKE_FIXTURE
const scenario = process.env.FAKE_SCENARIO
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
const root = path.join(fixture, 'temp', 'dsh-taskforce-smoke.abcdefgh')
fs.appendFileSync(path.join(fixture, 'calls.jsonl'), JSON.stringify({ command, args, home: process.env.DSH_HOME }) + '\n')
const print = (value) => process.stdout.write(value + '\n')
if (command === 'mktemp') {
  if (scenario === 'mktemp-fail') process.exit(72)
  if (scenario === 'mktemp-empty') process.exit(0)
  if (scenario === 'mktemp-mismatch') { print(path.join(fixture, 'repo')); process.exit(0) }
  if (scenario === 'mktemp-file') fs.writeFileSync(root, 'not a directory')
  else if (scenario === 'mktemp-symlink') fs.symlinkSync(path.join(fixture, 'repo'), root)
  else {
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, '.created-by-fake-mktemp'), '')
  }
  print(root)
} else if (command === 'npm' && args[0] === 'pack') {
  if (scenario === 'pack-fail') process.exit(73)
  if (scenario === 'pack-fail-output') { print('local-dsh-taskforce-0.2.1.tgz'); process.exit(73) }
  if (scenario === 'pack-empty') process.exit(0)
  const index = args.indexOf('--pack-destination')
  const destination = index < 0 ? process.cwd() : args[index + 1]
  // The stub itself cannot write outside the disposable fixture.
  if (destination !== root && destination !== path.join(fixture, 'repo')) process.exit(74)
  const name = 'local-dsh-taskforce-0.2.1.tgz'
  const archive = path.join(destination, name)
  if (scenario === 'pack-traversal') print('../../repo/keep.tgz')
  else if (scenario === 'pack-absolute') print(path.join(fixture, 'repo', 'keep.tgz'))
  else if (scenario === 'pack-multiline') print(name + '\nsecond.tgz')
  else if (scenario === 'pack-directory') { fs.mkdirSync(archive); print(name) }
  else if (scenario === 'pack-symlink') { fs.symlinkSync(path.join(fixture, 'repo', 'keep.tgz'), archive); print(name) }
  else if (scenario === 'pack-missing') print(name)
  else { fs.writeFileSync(archive, 'fake archive'); print(name) }
} else if (command === 'npm' && args[0] === 'run') {
  if (scenario === 'verification-fail') process.exit(75)
} else if (command === 'dsh') {
  if (scenario === 'plugin-fail' && args[0] === 'plugin') process.exit(76)
  if (args.includes('--dump-config')) print('taskforce\ntaskforce-store')
  if (scenario === 'boot-interrupted' && args.includes('--host')) process.exit(130)
  if (scenario === 'boot-sigint' && args.includes('--host')) {
    // Signal only this fake command and its own waiting bash, never a process group.
    process.kill(process.ppid, 'SIGINT')
    process.kill(process.pid, 'SIGINT')
  }
} else if (command === 'mkdir') {
  if (args.length !== 1 || args[0] !== path.join(root, 'home')) process.exit(77)
  fs.mkdirSync(args[0])
} else if (command === 'rm') {
  for (const target of args.filter(arg => !arg.startsWith('-'))) {
    if (target === root && fs.existsSync(path.join(root, '.created-by-fake-mktemp'))
        && !fs.lstatSync(root).isSymbolicLink()) fs.rmSync(root, { recursive: true, force: true })
  }
} else if (command === 'grep') {
  process.stdout.write(fs.readFileSync(0, 'utf8').split('\n').filter(line => line.includes(args[0])).join('\n'))
} else if (command === 'dirname') print(path.dirname(args[0]))
else if (command === 'realpath') print(fs.realpathSync(args[0]))
else process.exit(78)
`

function runExample(t, scenario) {
  const fixture = mkdtempSync(join(tmpdir(), 'taskforce-readme-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const repo = join(fixture, 'repo')
  const bin = join(fixture, 'bin')
  const temp = join(fixture, 'temp')
  for (const dir of [repo, bin, temp]) mkdirSync(dir)
  writeFileSync(join(repo, 'keep.tgz'), 'user-owned archive')
  writeFileSync(join(repo, 'checkout-sentinel'), 'user-owned checkout')
  for (const name of ['npm', 'mktemp', 'dsh', 'rm', 'mkdir', 'grep', 'dirname', 'realpath']) {
    writeFileSync(join(bin, name), fakeCommand, { mode: 0o755 })
  }
  const originalHome = join(fixture, 'existing-home')
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', example +
    '\ntask_example_exit=$?; printf "PARENT_HOME=%s\\n" "$DSH_HOME"; exit "$task_example_exit"'], {
    cwd: repo, encoding: 'utf8', timeout: 10_000,
    env: { PATH: bin, TMPDIR: temp, DSH_HOME: originalHome, FAKE_FIXTURE: fixture, FAKE_SCENARIO: scenario },
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, result.stderr)
  const calls = readFileSync(join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(readFileSync(join(repo, 'keep.tgz'), 'utf8'), 'user-owned archive')
  assert.equal(readFileSync(join(repo, 'checkout-sentinel'), 'utf8'), 'user-owned checkout')
  return { result, calls, originalHome, root: join(temp, 'dsh-taskforce-smoke.abcdefgh') }
}

for (const scenario of ['mktemp-fail', 'mktemp-empty', 'mktemp-mismatch', 'mktemp-file', 'mktemp-symlink']) {
  test(`README stops on ${scenario} without packing or claiming cleanup ownership`, (t) => {
    const { result, calls } = runExample(t, scenario)
    assert.notEqual(result.status, 0, 'temporary-directory creation/validation must fail closed')
    assert.deepEqual(calls.map(call => call.command), ['mktemp'])
  })
}

for (const scenario of ['pack-fail', 'pack-fail-output', 'pack-empty', 'pack-traversal', 'pack-absolute',
  'pack-multiline', 'pack-directory', 'pack-symlink', 'pack-missing']) {
  test(`README rejects ${scenario} before DSH and cleans only its owned directory`, (t) => {
    const { result, calls, root } = runExample(t, scenario)
    assert.deepEqual(calls.filter(call => call.command === 'rm')
      .flatMap(call => call.args.filter(arg => !arg.startsWith('-'))), [root])
    assert.notEqual(result.status, 0, 'packing/validation must fail closed')
    assert.equal(calls.some(call => call.command === 'dsh'), false)
    assert.equal(existsSync(root), false, 'the owned temporary directory must be removed')
  })
}

for (const scenario of ['success', 'boot-interrupted', 'boot-sigint', 'plugin-fail', 'verification-fail']) {
  test(`README ${scenario} preserves the legal flow and cleans its temporary home and archive`, (t) => {
    const { result, calls, root, originalHome } = runExample(t, scenario)
    const success = ['success', 'boot-interrupted', 'boot-sigint'].includes(scenario)
    assert.equal(result.status === 0, success, result.stderr)
    const pack = calls.find(call => call.command === 'npm' && call.args[0] === 'pack')
    assert.ok(pack.args.includes('--ignore-scripts'), 'the actual pack invocation must disable lifecycle scripts')
    const plugin = calls.find(call => call.command === 'dsh' && call.args[0] === 'plugin')
    assert.deepEqual(plugin.args, ['plugin', '--profile', 'web', 'add', join(root, 'local-dsh-taskforce-0.2.1.tgz')])
    assert.equal(plugin.home, join(root, 'home'))
    if (success) {
      assert.ok(calls.some(call => call.command === 'dsh' && call.args.includes('--dump-config')))
      assert.ok(calls.some(call => call.command === 'dsh' && call.args.includes('--no-open')))
      assert.ok(calls.some(call => call.command === 'npm' && call.args[0] === 'run' && call.args[1] === 'test:all'))
      assert.ok(result.stdout.includes(`PARENT_HOME=${originalHome}`), 'the caller DSH_HOME must be preserved')
    }
    assert.deepEqual(calls.filter(call => call.command === 'rm')
      .flatMap(call => call.args.filter(arg => !arg.startsWith('-'))), [root])
    assert.equal(existsSync(root), false)
  })
}
