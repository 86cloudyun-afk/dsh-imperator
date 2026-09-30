import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as runner from '../verify-all.mjs'

for (const outcome of [{ exitCode: 0, timedOut: true }, { exitCode: 0, signal: 'SIGTERM' }]) {
  test(`verification never counts an interrupted zero exit as success: ${JSON.stringify(outcome)}`, async () => {
    const report = await runner.runVerification({ runProcess: async () => outcome })
    assert.equal(report.ok, false)
    assert.equal(report.results[0].status, 'failed')
  })
}
test('timeout remains failure when a SIGTERM handler exits zero', async () => {
  assert.equal(typeof runner.defaultRunProcess, 'function')
  const outcome = await runner.defaultRunProcess(process.execPath, ['-e',
    "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(0), 2500)"],
  { timeout: 700, shell: false })
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.exitCode, 0)
})
test('a child ignoring SIGTERM is force-stopped after the grace period', async () => {
  assert.equal(typeof runner.defaultRunProcess, 'function')
  const outcome = await runner.defaultRunProcess(process.execPath, ['-e',
    "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 3000)"],
  { timeout: 700, shell: false })
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.signal, 'SIGKILL')
  assert.equal(outcome.exitCode, null)
})
test('normal completion and missing executable retain correct results', async () => {
  assert.equal(typeof runner.defaultRunProcess, 'function')
  const outcome = await runner.defaultRunProcess(process.execPath, ['-e', 'process.exit(0)'], { timeout: 2000, shell: false })
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.signal, null)
  await assert.rejects(runner.defaultRunProcess('/taskforce-no-such-program', [], { timeout: 500, shell: false }), { code: 'ENOENT' })
})
