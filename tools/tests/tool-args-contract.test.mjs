import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const source = readFileSync(fileURLToPath(new URL('../../lib/tools/index.js', import.meta.url)), 'utf8')

// 双向一致性守卫：`TOOL_SPECS.parameters`（模型看到的声明）与 `handlers`（实际读取）必须互相对齐。
// 两类静默缺陷：① 声明了但 handler 从不读取（模型传了不生效）；② handler 读未声明字段（schema 放行但文档没写）。
// 提取走静态文本解析（与 code-hint 守卫同族）；源文件风格改变时**必须失败并提示**，不得静默通过。

/** 从 `TOOL_SPECS` 提取每个工具声明的参数名。 */
function extractSpecParams(src) {
  const out = new Map()
  let tool = null
  let inParams = false
  for (const line of src.split('\n')) {
    const toolMatch = /^  ([a-z_][a-z0-9_]*): \{$/.exec(line)
    if (toolMatch !== null) {
      tool = toolMatch[1]
      inParams = false
      out.set(tool, new Set())
      continue
    }
    if (tool === null) continue
    if (/^    parameters: \{$/.test(line)) {
      inParams = true
      continue
    }
    if (inParams === true && /^    \},?$/.test(line)) {
      inParams = false
      continue
    }
    if (inParams === true) {
      const paramMatch = /^      ([a-zA-Z_][a-zA-Z0-9_]*): \{/.exec(line)
      if (paramMatch !== null) out.get(tool).add(paramMatch[1])
    }
  }
  return out
}

/** 从 `handlers` 提取每个 handler 实际读取的 `args.<name>`。 */
function extractHandlerArgs(src) {
  const start = src.indexOf('  const handlers = {')
  assert.ok(start >= 0, 'extraction failed: `const handlers = {` not found — source layout changed?')
  const out = new Map()
  let current = null
  for (const line of src.slice(start).split('\n')) {
    const handlerMatch = /^    ([a-z_][a-z0-9_]*): async \(args, exec\) => \{$/.exec(line)
    if (handlerMatch !== null) {
      current = handlerMatch[1]
      out.set(current, new Set())
      continue
    }
    if (current === null) continue
    for (const match of line.matchAll(/args\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) out.get(current).add(match[1])
  }
  return out
}

const specParams = extractSpecParams(source)
const handlerArgs = extractHandlerArgs(source)

/** 显式豁免：`<工具>::<参数>` → 原因。空基线；新增条目必须写明可核查依据。 */
const EXEMPT = new Map([
  // 例：['task_x::legacy_param', '保留给旧客户端；handler 有意不读取'],
])

test('extraction is fail-loud: both sides must parse non-trivially', () => {
  assert.ok(specParams.size >= 10, `TOOL_SPECS parsed ${specParams.size} tools (expected >=10) — parser likely broke`)
  assert.ok(handlerArgs.size >= 10, `handlers parsed ${handlerArgs.size} entries (expected >=10) — parser likely broke`)
  for (const [tool, params] of specParams) {
    assert.ok(params.size > 0, `${tool}: parsed zero declared parameters — parser likely broke`)
  }
  for (const [tool, read] of handlerArgs) {
    assert.ok(read.size > 0, `${tool}: parsed zero args reads — parser likely broke`)
  }
})

test('direction A: every declared parameter is read by its handler', () => {
  const violations = []
  for (const [tool, params] of specParams) {
    const read = handlerArgs.get(tool)
    assert.ok(read !== undefined, `${tool}: declared in TOOL_SPECS but has no handler`)
    for (const name of params) {
      if (read.has(name) || EXEMPT.has(`${tool}::${name}`)) continue
      violations.push(`${tool}::${name}`)
    }
  }
  assert.deepEqual(violations, [],
    `declared-but-never-read parameters (silently ignored): ${violations.join(', ')}`)
})

test('direction B: every args.<name> read by a handler is declared', () => {
  const violations = []
  for (const [tool, read] of handlerArgs) {
    const params = specParams.get(tool)
    assert.ok(params !== undefined, `${tool}: has a handler but is not declared in TOOL_SPECS`)
    for (const name of read) {
      if (params.has(name) || EXEMPT.has(`${tool}::${name}`)) continue
      violations.push(`${tool}::${name}`)
    }
  }
  assert.deepEqual(violations, [],
    `undeclared parameters read by handlers (implicit args): ${violations.join(', ')}`)
})

test('exemption list cannot rot: every entry must still describe a real mismatch', () => {
  for (const key of EXEMPT.keys()) {
    const [tool, name] = key.split('::')
    const declared = specParams.get(tool)?.has(name) === true
    const read = handlerArgs.get(tool)?.has(name) === true
    assert.ok(declared !== read,
      `stale exemption ${key}: no longer a mismatch (declared=${declared} read=${read}) — remove it`)
  }
})
