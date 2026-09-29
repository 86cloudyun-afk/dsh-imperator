import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { apply, inject, name } from '../../lib/index.js'
import { acquireMount } from '../../lib/lifecycle/mount-state.js'
import { fakePresetHost as createFakePresetHost } from './helpers.mjs'

const packageName = '@local/dsh-taskforce'
const owners = Symbol.for('dsh-taskforce.mount-owners')
const legacy = Symbol.for('dsh-web.mounted-plugins')
let expectedStderr

function fakePresetHost(options) {
  return createFakePresetHost({ ...options, onLog: (line) => expectedStderr.push(`${line}\n`) })
}

function capturePluginStderr(write, actual) {
  return function (chunk, encoding, callback) {
    if (!String(chunk).startsWith('[taskforce] ')) {
      return write.call(process.stderr, chunk, encoding, callback)
    }
    actual.push(String(chunk))
    if (typeof encoding === 'function') encoding()
    else if (typeof callback === 'function') callback()
    return true
  }
}

beforeEach((t) => {
  const actual = []
  expectedStderr = []
  const write = process.stderr.write
  process.stderr.write = capturePluginStderr(write, actual)
  t.after(() => {
    process.stderr.write = write
    assert.deepEqual(actual, expectedStderr, 'lifecycle stderr mirrors expected host diagnostics')
  })
})

afterEach(() => {
  delete globalThis[owners]
  delete globalThis[legacy]
})

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settled = () => new Promise((resolve) => setImmediate(resolve))

test('public plugin identity remains available', () => {
  assert.equal(name, 'taskforce')
  assert.deepEqual(inject, ['agentPresets'])
})

test('stderr capture passes unrelated output through without counting it as plugin diagnostics', () => {
  const forwarded = []
  const actual = []
  const sink = function (chunk, encoding, callback) {
    forwarded.push([chunk, encoding])
    callback?.()
    return false
  }
  const capturedWrite = capturePluginStderr(sink, actual)
  const warning = '(node:1234) ExperimentalWarning: SQLite is an experimental feature\n'
  let callbackCalled = false
  assert.equal(capturedWrite(warning, 'utf8', () => { callbackCalled = true }), false)
  assert.equal(callbackCalled, true)
  assert.deepEqual(forwarded, [[warning, 'utf8']])
  assert.deepEqual(actual, [])
  capturedWrite('[taskforce] preset "taskforce" declared (20 rows)\n')
  assert.deepEqual(actual, ['[taskforce] preset "taskforce" declared (20 rows)\n'])
  assert.equal(forwarded.length, 1)
})

test('owner tokens release only their own slot once and preserve other packages', () => {
  const first = acquireMount(packageName)
  const other = acquireMount('@other/plugin')
  assert.equal(typeof first.token, 'symbol')
  assert.equal(acquireMount(packageName), null)
  assert.equal(first.release(), true)
  assert.equal(first.release(), false)
  const replacement = acquireMount(packageName)
  assert.equal(first.release(), false)
  assert.equal(acquireMount('@other/plugin'), null)
  assert.equal(replacement.release(), true)
  assert.equal(other.release(), true)
})

test('unload releases ownership after disposal and allows a fresh activation', async () => {
  let registrations = 0
  let active = 0
  const register = () => {
    registrations++
    active++
    return async () => { active-- }
  }
  const first = fakePresetHost({ register })
  apply(first.ctx)
  await settled()
  assert.equal(active, 1)
  assert.match(first.logs.join('\n'), /preset "taskforce" declared/)
  await first.disposeAll()
  assert.equal(active, 0)

  const second = fakePresetHost({ register })
  apply(second.ctx)
  await settled()
  assert.equal(registrations, 2)
  assert.equal(active, 1)
  await second.disposeAll()
})

test('concurrent duplicate apply only registers one declaration', async () => {
  const gate = deferred()
  let registrations = 0
  const register = () => { registrations++; return gate.promise }
  const first = fakePresetHost({ register })
  const duplicate = fakePresetHost({ register })
  apply(first.ctx)
  apply(duplicate.ctx)
  await settled()
  assert.equal(registrations, 1)
  gate.resolve(() => {})
  await settled()
  await first.disposeAll()
  await duplicate.disposeAll()
})

test('registration rejection frees ownership for explicit reactivation', async () => {
  let registrations = 0
  const register = () => {
    registrations++
    if (registrations === 1) return Promise.reject(new Error('initial failure'))
    return () => {}
  }
  const first = fakePresetHost({ register })
  apply(first.ctx)
  await settled()
  assert.match(first.logs.join('\n'), /declaring preset failed: initial failure/)
  const second = fakePresetHost({ register })
  apply(second.ctx)
  await settled()
  assert.equal(registrations, 2)
  await first.disposeAll()
  await second.disposeAll()
})

test('pending registration retains its slot until its late disposer finishes', async () => {
  const registration = deferred()
  const cleanup = deferred()
  let registrations = 0
  let active = 0
  const register = () => {
    registrations++
    if (registrations === 1) return registration.promise.then(() => {
      active++
      return async () => { await cleanup.promise; active-- }
    })
    active++
    return () => { active-- }
  }
  const first = fakePresetHost({ register })
  apply(first.ctx)
  await settled()
  const disposing = first.disposeAll()
  const tooEarly = fakePresetHost({ register })
  apply(tooEarly.ctx)
  await settled()
  assert.equal(registrations, 1)
  registration.resolve()
  await settled()
  assert.equal(active, 1)
  assert.doesNotMatch(first.logs.join('\n'), /declared/)
  apply(tooEarly.ctx)
  await settled()
  assert.equal(registrations, 1)
  cleanup.resolve()
  await disposing
  assert.equal(active, 0)
  const second = fakePresetHost({ register })
  apply(second.ctx)
  await settled()
  assert.equal(registrations, 2)
  assert.equal(active, 1)
  await second.disposeAll()
})

test('duplicate disposal cannot release ownership held by a newer instance', async () => {
  let registrations = 0
  const register = () => { registrations++; return () => {} }
  const first = fakePresetHost({ register })
  apply(first.ctx)
  await settled()
  await first.disposeAll()
  const second = fakePresetHost({ register })
  apply(second.ctx)
  await settled()
  await first.disposeAll()
  apply(fakePresetHost({ register }).ctx)
  await settled()
  assert.equal(registrations, 2)
  await second.disposeAll()
})

test('legacy occupied package and other plugins remain untouched', async () => {
  const occupied = new Set([packageName, '@other/plugin'])
  globalThis[legacy] = occupied
  let registrations = 0
  const blocked = fakePresetHost({ register: () => { registrations++; return () => {} } })
  apply(blocked.ctx)
  await settled()
  assert.equal(registrations, 0)
  assert.deepEqual([...occupied], [packageName, '@other/plugin'])
  occupied.delete(packageName)
  apply(blocked.ctx)
  await settled()
  assert.equal(registrations, 1)
  await blocked.disposeAll()
  assert.deepEqual([...occupied], ['@other/plugin'])
})

test('different module copies share the same ownership map', async () => {
  const copy = await import('../../lib/index.js?lifecycle-copy=1')
  let registrations = 0
  const register = () => { registrations++; return () => {} }
  const first = fakePresetHost({ register })
  const second = fakePresetHost({ register })
  apply(first.ctx)
  copy.apply(second.ctx)
  await settled()
  assert.equal(registrations, 1)
  await first.disposeAll()
  copy.apply(second.ctx)
  await settled()
  assert.equal(registrations, 2)
  await second.disposeAll()
})

test('failed disposer keeps slot and reports error', async () => {
  let registrations = 0
  const register = () => { registrations++; return async () => { throw new Error('unmount failed') } }
  const first = fakePresetHost({ register })
  apply(first.ctx)
  await settled()
  await first.disposeAll()
  assert.match(first.logs.join('\n'), /unmount failed/)
  apply(fakePresetHost({ register }).ctx)
  await settled()
  assert.equal(registrations, 1)
})

test('missing disposer keeps slot and reports a contract error', async () => {
  let registrations = 0
  const register = () => { registrations++; return undefined }
  const first = fakePresetHost({ register })
  apply(first.ctx)
  await settled()
  assert.match(first.logs.join('\n'), /disposer/)
  await first.disposeAll()
  apply(fakePresetHost({ register }).ctx)
  await settled()
  assert.equal(registrations, 1)
})
