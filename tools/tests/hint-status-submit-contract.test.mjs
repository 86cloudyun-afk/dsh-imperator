import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * #26 把 submit-on-rejected 改成 refuse(E_STATUS) 后，模型侧 HINT_STATUS 与
 * 状态机文档表仍写着「submit 在 rejected 可用」——与 submitTask 实现相反，
 * 会诱导模型在打回后跳过 task_claim 直接重提。本守卫钉死三处口径一致。
 */
const toolsSrc = readFileSync(fileURLToPath(new URL('../../lib/tools/index.js', import.meta.url)), 'utf8')
const storeSrc = readFileSync(fileURLToPath(new URL('../../lib/store/index.js', import.meta.url)), 'utf8')
const docsSrc = readFileSync(fileURLToPath(new URL('../../docs/STORE.md', import.meta.url)), 'utf8')

function hintStatusBlock(src) {
  const start = src.indexOf('const HINT_STATUS =')
  assert.ok(start > 0, '应能找到 HINT_STATUS 定义')
  const end = src.indexOf('\n\n', start)
  return src.slice(start, end === -1 ? undefined : end)
}

test('HINT_STATUS 不得声称 submit 可在 rejected 直接可用；须指路先 claim', () => {
  const block = hintStatusBlock(toolsSrc)
  assert.doesNotMatch(block, /submit 在 open \/ claimed \/ rejected 可用/)
  assert.match(block, /submit 只在 open \/ claimed 可用/)
  assert.match(block, /rejected 须先 task_claim/)
})

test('store 头注释与 docs/STORE.md 的 rejected 行与 submitTask 实现一致（须先 claim）', () => {
  const stale = /\| `rejected` \| ✓ \| ✓ \| ✓ \| ✓ → submitted \|/
  assert.doesNotMatch(storeSrc, stale, 'lib/store/index.js 头表仍写 rejected → submit 直接可用')
  assert.doesNotMatch(docsSrc, stale, 'docs/STORE.md 状态表仍写 rejected → submit 直接可用')
  assert.match(storeSrc, /\| `rejected` \| ✓ \| ✓ \| ✓ \| ✗ `E_STATUS`（须先 claim） \|/)
  assert.match(docsSrc, /\| `rejected` \| ✓ \| ✓ \| ✓ \| ✗ `E_STATUS`（须先 claim） \|/)
})
