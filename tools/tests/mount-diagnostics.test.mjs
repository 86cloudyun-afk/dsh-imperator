import assert from 'node:assert/strict'
import { test } from 'node:test'

// 本守卫只依赖 lib/（随包发布）——不依赖 .github / .git，包内与仓库检出内都应成立。
const OWNERS = Symbol.for('dsh-taskforce.mount-owners')
const PACKAGE = '@local/dsh-taskforce'
const { apply } = await import('../../lib/index.js')

/** 最小可用 host ctx：捕获告警；registry 返回可用 disposer（成功路径所需）。 */
function makeCtx(captured) {
  return {
    logger: { warn: (line) => captured.push(line) },
    get: (name) => (name === 'agentPresets' ? { register: async () => () => {} } : undefined),
    effect: (fn) => {
      try { fn() } catch { /* 探针不因宿主钩子差异中断 */ }
      return () => {}
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

test('a contended mount slot emits a diagnostic that names cause and consequence', async (t) => {
  const captured = []
  globalThis[OWNERS] = new Map([[PACKAGE, Symbol('other-activation')]])
  t.after(() => { delete globalThis[OWNERS] })
  apply(makeCtx(captured))
  await settle()
  const slotWarnings = captured.filter((line) => line.includes('mount slot unavailable'))
  assert.equal(slotWarnings.length, 1, `expected exactly one slot diagnostic, got ${slotWarnings.length}`)
  assert.match(slotWarnings[0], /another activation already owns @local\/dsh-taskforce/,
    'the diagnostic must name the cause')
  assert.match(slotWarnings[0], /stays inactive and the preset is NOT declared/,
    'the diagnostic must state the consequence')
})

test('a successful activation emits no slot-contention diagnostic', async (t) => {
  const captured = []
  delete globalThis[OWNERS]
  t.after(() => { delete globalThis[OWNERS] })
  apply(makeCtx(captured))
  await settle()
  assert.equal(captured.filter((line) => line.includes('mount slot unavailable')).length, 0,
    'a clean activation must not emit the contention diagnostic')
  assert.equal(captured.filter((line) => line.includes('declared (')).length, 1,
    'a clean activation must still report the declaration')
})
