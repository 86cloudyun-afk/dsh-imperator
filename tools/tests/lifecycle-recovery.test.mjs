import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { apply } from '../../lib/index.js'
import { fakePresetHost } from './helpers.mjs'
const owners = Symbol.for('dsh-taskforce.mount-owners')
const settle = () => new Promise(resolve => setImmediate(resolve))
afterEach(() => { delete globalThis[owners] })

test('effect registration failure before start releases the slot for retry', async () => {
  const error = new Error('effect registry unavailable')
  assert.throws(() => apply({ effect() { throw error } }), e => e === error)
  let created = 0
  const host = fakePresetHost({ register: () => { created++; return () => {} } })
  apply(host.ctx)
  await settle()
  assert.equal(created, 1)
  await host.disposeAll()
})
test('effect registration failure after callback cannot leave an unowned pending mount', async () => {
  let created = 0
  const host = fakePresetHost({ register: () => { created++; return () => {} } })
  const error = new Error('effect registration rejected')
  host.ctx.effect = callback => { callback(); throw error }
  assert.throws(() => apply(host.ctx), e => e === error)
  await settle()
  assert.equal(created, 0, 'rejected effect must not mount later in a microtask')
  const retry = fakePresetHost({ register: () => { created++; return () => {} } })
  apply(retry.ctx)
  await settle()
  assert.equal(created, 1)
  await retry.disposeAll()
})
test('immediate unload cancels registration before it starts', async () => {
  let created = 0
  const host = fakePresetHost({ register: () => { created++; return () => {} } })
  apply(host.ctx)
  await host.disposeAll()
  assert.equal(created, 0)
  assert.equal(globalThis[owners].has('@local/dsh-taskforce'), false)
})
test('unprintable registration failure still releases ownership with safe diagnostics', async () => {
  const error = { toString() { throw new Error('bad string conversion') } }
  const host = fakePresetHost({ register: () => { throw error } })
  apply(host.ctx)
  await settle()
  assert.match(host.logs.join('\n'), /declaring preset failed/)
  assert.equal(globalThis[owners].has('@local/dsh-taskforce'), false)
  await host.disposeAll()
})
test('unprintable disposal failure retains ownership without rejecting cleanup', async () => {
  const error = { toString() { throw new Error('bad string conversion') } }
  const host = fakePresetHost({ register: () => () => { throw error } })
  apply(host.ctx)
  await settle()
  await assert.doesNotReject(host.disposeAll())
  assert.equal(globalThis[owners].has('@local/dsh-taskforce'), true)
  assert.match(host.logs.join('\n'), /unmounting preset failed/)
})
