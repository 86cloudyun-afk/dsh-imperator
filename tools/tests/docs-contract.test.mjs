import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const scriptNames = Object.keys(pkg.scripts ?? {})

// 扫描面 = 面向使用者的活文档：README.md + docs/ 根层 markdown。
// docs/superpowers/ 是带日期的历史设计档案（spec/plan/research），只增不改；
// 其中命令是撰写当时的快照，不参与当前契约 —— 显式排除，理由见此注释。
const docsDir = join(root, 'docs')
const docNames = ['README.md', ...(existsSync(docsDir)
  ? readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort().map((f) => `docs/${f}`)
  : [])]
// 交付包（files 白名单）必然包含 README 与 docs；缺失即契约破损，fail-closed。
assert.ok(docNames.length > 1, 'expected README.md plus at least one docs/*.md in the deliverable')
const docs = docNames.map((name) => ({ name, text: readFileSync(join(root, name), 'utf8') }))

// 本仓 CLI 的唯一实现面：tools/ 下全部 .mjs（同样在交付包内）。
const toolsDir = join(root, 'tools')
const toolText = readdirSync(toolsDir).filter((f) => f.endsWith('.mjs')).sort()
  .map((f) => readFileSync(join(toolsDir, f), 'utf8')).join('\n')

// 显式豁免：只允许「外部工具旗标 / node 内置旗标」两类，逐条写明可核查依据。
// 不允许"暂时放宽"；豁免腐烂由最后一条测试兜底（豁免必须仍被文档引用）。
const EXTERNAL_FLAGS = new Map([
  ['--profile', 'dsh CLI 自带旗标（docs/DELIVERY.md：`dsh plugin --profile web add …`），非本仓工具'],
  ['--dump-config', 'dsh CLI 自带旗标（docs/DELIVERY.md：`dsh --profile web --dump-config`），非本仓工具'],
  ['--ignore-scripts', 'npm pack 自带旗标（README 隔离实挂：禁止打包生命周期脚本），非本仓工具'],
  ['--pack-destination', 'npm pack 自带旗标（README 隔离实挂：归档仅写入本次临时目录），非本仓工具'],
  ['--test', 'node:test 内置旗标（`node --test …`），非本仓旗标'],
])

// 词边界匹配：`--install-anchor-bogus` 不得被当作 `--install-anchor` 命中。
function occurrences(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...text.matchAll(new RegExp(`${escaped}(?![A-Za-z0-9-])`, 'g'))].length
}

test('every npm script referenced by the live docs exists in package.json', () => {
  const problems = []
  for (const { name, text } of docs) {
    for (const match of text.matchAll(/npm run ([A-Za-z0-9:_.-]+)/g)) {
      const script = match[1]
      if (!scriptNames.includes(script)) {
        problems.push(`${name}: 引用 \`npm run ${script}\`，但 package.json scripts 无此项`)
      }
    }
    if (/(^|[^A-Za-z0-9:-])npm test(?![:\w-])/.test(text) && !scriptNames.includes('test')) {
      problems.push(`${name}: 引用 \`npm test\`，但 package.json 无 scripts.test`)
    }
  }
  assert.deepEqual(problems, [], `文档-脚本契约违规：\n${problems.join('\n')}`)
})

test('every CLI flag referenced by the live docs exists in tools/', () => {
  const problems = []
  for (const { name, text } of docs) {
    for (const match of text.matchAll(/--[a-z][a-z0-9-]{2,}/g)) {
      const flag = match[0]
      if (EXTERNAL_FLAGS.has(flag)) continue
      if (occurrences(toolText, flag) === 0) {
        problems.push(`${name}: 引用 \`${flag}\`，但 tools/ 下无实现（外部旗标须登记进 EXTERNAL_FLAGS 并写明依据）`)
      }
    }
  }
  assert.deepEqual(problems, [], `文档-旗标契约违规：\n${problems.join('\n')}`)
})

test('external-flag exemptions are still referenced by the live docs', () => {
  const allText = docs.map((d) => d.text).join('\n')
  const stale = [...EXTERNAL_FLAGS.keys()].filter((flag) => occurrences(allText, flag) === 0)
  assert.deepEqual(stale, [], `EXTERNAL_FLAGS 中以下旗标已不再被文档引用，应删除豁免：${stale.join(', ')}`)
})
