#!/usr/bin/env node
/**
 * verify-preset.mjs — 「任务部队」preset 定义的离线校验器。
 *
 * 目的：**在重启 dsh web 之前**就把会挂载失败的原因找出来。重启代价高
 * （DSH 是本机 PID 1），所以定义层的错误必须在离线阶段清零。
 *
 * 校验三层：
 *   1. 结构  —— 用 registry 自己的 `entryListProblem` 校验行树（含嵌套 group）
 *   2. 解析  —— 按 Loader 的规则解析每个行的模块名（package 名 / 相对路径）
 *   3. 运行时 —— 在隔离子进程里 import 每个模块，确认它真的是一个 Cordis 插件
 *                （有 `apply`，最好还有 `name`/`inject`）；子进程隔离顶层副作用。
 *
 * 用法：
 *   node tools/verify-preset.mjs [profileDir] [--profile-dir path] [--install-dir path]
 * 默认 profileDir = /opt/dsh/home/profiles/web（模块解析必须在该目录下进行，
 * 因为 preset 行由 profile 的 Loader 挂载，解析基准是 profile 而非本包）。
 *
 * 退出码：0 = 全绿；1 = 有 FAIL。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const option = (name) => {
  const index = process.argv.indexOf(name)
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : index < 0 ? undefined : process.argv[index + 1]
}
const PROFILE = option('--profile-dir') ?? (process.argv[2]?.startsWith('--') ? undefined : process.argv[2]) ?? '/opt/dsh/home/profiles/web'
const INSTALL = option('--install-dir') ?? '/opt/dsh/install/node_modules'

/** 收集行树（含嵌套 group 的 config 数组），保持出现顺序。 */
function collectRows(plugins, out = [], depth = 0) {
  for (const row of plugins) {
    out.push({ row, depth })
    if (Array.isArray(row.config)) collectRows(row.config, out, depth + 1)
  }
  return out
}

const fail = (message) => {
  console.log(`  ✗ FAIL  ${message}`)
  failures += 1
}
let failures = 0

// ── 载入定义 ────────────────────────────────────────────────────────────────
let definition
try {
  ({ TASKFORCE_DEFINITION: definition } = await import(pathToFileURL(join(PKG_ROOT, 'lib/preset.js')).href))
} catch (error) {
  console.error(`✗ 无法载入 lib/preset.js: ${error.message}`)
  process.exit(1)
}

console.log(`preset      : ${definition.id} (${definition.name})`)
console.log(`profile     : ${PROFILE}`)
const rows = collectRows(definition.plugins)
console.log(`rows        : ${rows.length}`)
console.log('')

// ── 第 1 层：结构 ──────────────────────────────────────────────────────────
console.log('[1/3] 结构校验（registry entryListProblem）')
try {
  const registry = await import(pathToFileURL(join(INSTALL, '@deepseek-ai/dsh-agent-preset-registry/lib/index.js')).href)
  if (typeof registry.entryListProblem !== 'function') {
    console.log('  · UNVERIFIED entryListProblem 不可用：无法证明行树结构合法')
    failures += 1
  } else {
    const problem = registry.entryListProblem(definition.plugins)
    if (problem === undefined) console.log('  ✓ 行树结构合法')
    else fail(`行树结构非法: ${problem}`)
  }
} catch (error) {
  console.log(`  · UNVERIFIED entryListProblem registry 不可载入: ${error.message}`)
  failures += 1
}

// ── 第 2、3 层：解析 + 运行时形状（在 profile 目录内的子进程里做）───────────
const probe = `
const rows = JSON.parse(process.argv[1])
const out = []
for (const { id, name } of rows) {
  if (!name) { out.push({ id, name, status: 'NO_NAME' }); continue }
  if (name === 'cordis:group') { out.push({ id, name, status: 'GROUP' }); continue }
  if (name.startsWith('.') || name.startsWith('file:') || name.startsWith('/')) {
    if (!name.startsWith('file:')) { out.push({ id, name, status: 'REL_NOT_ABS' }); continue }
    try {
      const m = await import(name)
      const apply = typeof m.apply === 'function' || typeof m.default?.apply === 'function'
      out.push({ id, name, status: apply ? 'PLUGIN' : 'NOT_PLUGIN', local: true, plugin: m.name ?? m.default?.name, inject: m.inject ?? m.default?.inject, resolved: name })
    } catch (e) {
      out.push({ id, name, status: 'IMPORT_FAIL', local: true, error: e.message.slice(0, 120), resolved: name })
    }
    continue
  }
  let resolved
  try { resolved = import.meta.resolve(name) } catch (e) { out.push({ id, name, status: 'UNRESOLVED', error: e.code }); continue }
  try {
    const m = await import(resolved)
    const apply = typeof m.apply === 'function' || typeof m.default?.apply === 'function'
    const meta = m.name ?? m.default?.name
    const inject = m.inject ?? m.default?.inject
    out.push({ id, name, status: apply ? 'PLUGIN' : 'NOT_PLUGIN', plugin: meta, inject, resolved })
  } catch (e) {
    out.push({ id, name, status: 'IMPORT_FAIL', error: e.message.slice(0, 120), resolved })
  }
}
console.log(JSON.stringify(out))
`
const payload = JSON.stringify(rows.map(({ row, depth }) => ({ id: row.id, name: row.name, depth })))
let probes = []
try {
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', probe, payload], {
    cwd: PROFILE,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  probes = JSON.parse(raw.trim().split('\n').pop())
} catch (error) {
  console.log(`  ✗ 子进程探测失败: ${error.message}`)
  failures += 1
}

console.log('')
console.log('[2/3] 模块解析  [3/3] 运行时形状')
for (const p of probes) {
  const pad = (p.id ?? '?').padEnd(26)
  if (p.status === 'GROUP') { console.log(`  · ${pad} cordis:group`); continue }
  if (p.status === 'REL_NOT_ABS') {
    fail(`${pad} 相对路径未绝对化: ${p.name}（preset 行的 baseUrl 继承声明者，相对名会在错目录解析）`)
    continue
  }
  if (p.status === 'PLUGIN') {
    const inject = p.inject === undefined ? '(none)' : JSON.stringify(p.inject)
    const where = p.local ? `  local=${String(p.resolved).replace('file://' + PKG_ROOT + '/', '')}` : ''
    console.log(`  ✓ ${pad} plugin=${p.plugin ?? '?'} inject=${inject}${where}`)
    continue
  }
  if (p.status === 'NO_NAME') { fail(`${pad} 行缺少 name`); continue }
  fail(`${pad} ${p.status} ${p.name} ${p.error ?? ''}`)
}

console.log('')
if (failures === 0) {
  console.log(`✓ 全绿：${rows.length} 行通过结构 / 解析 / 运行时三层校验`)
  process.exit(0)
}
console.log(`✗ ${failures} 项失败`)
process.exit(1)
