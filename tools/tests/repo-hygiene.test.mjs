import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))

// 环境兼容：本测试不依赖 .git / .github —— 同一套断言在仓库检出与 npm pack 产物（lib/tools/docs…）
// 内都必须成立。文件遍历只依赖目录本身（跳过 node_modules/.git/.worktrees，缺失也不必存在）。
//
// `.worktrees` 与本仓库 `.gitignore` 首行（`.worktrees/`）逐字对应：嵌套 worktree 是完整工作副本，
// 不属于仓库内容；扫描它们会虚增计数，并可能把未提交内容误报为命中或以豁免掩盖。
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees'])
const MAX_FILE_BYTES = 4 * 1024 * 1024

const PATTERNS = [
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['aws-access-key-id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['credential-assignment', /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{16,}["']/gi],
]

// 显式豁免清单：`<相对路径>::<模式标签>` → 原因。新增条目必须写明可核查依据。
// 基线为空：2026-10-02 实测全仓 72 文件、7 类模式零命中（分类记录见 PR 描述）。
const EXEMPTIONS = new Map([
  // 例：['docs/EXAMPLE.md::github-token', '官方文档中的占位符示例，值本身不是凭据'],
])

// 合成示例放行条件（双条件，防误放宽）：
//   ① 文件内带 `synthetic-example` 标记；② 命中值包含白名单占位符。
// 白名单值用拼接写法构造，避免本文件自身被这些模式命中。
const SYNTHETIC_MARKER = 'synthetic-example'
const SYNTHETIC_VALUES = new Set([
  'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWX',
  'AKIA' + 'IOSFODNN7EXAMPLE',
  'sk-' + 'abcdefghijklmnopqrstuvwxyz012345',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (st.isFile()) out.push(path)
  }
  return out
}

function scan() {
  const findings = []
  const files = walk(root)
  for (const file of files) {
    const st = statSync(file)
    if (st.size > MAX_FILE_BYTES) continue
    const buffer = readFileSync(file)
    if (buffer.includes(0)) continue // 二进制（NUL 启发式）
    const text = buffer.toString('utf8')
    const rel = relative(root, file)
    const marked = text.includes(SYNTHETIC_MARKER)
    for (const [label, pattern] of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const value = match[0]
        const synthetic = marked && [...SYNTHETIC_VALUES].some((v) => value.includes(v))
        if (synthetic) continue
        if (EXEMPTIONS.has(`${rel}::${label}`)) continue
        // 只记录前缀与长度，避免把疑似凭据全文写进日志
        findings.push({ file: rel, label, prefix: value.slice(0, 4), length: value.length })
      }
    }
  }
  return { findings, scanned: files.length }
}

test('repository contains no credential-shaped strings outside the exemption list', () => {
  const { findings, scanned } = scan()
  assert.ok(scanned > 0, 'walk must visit at least one file')
  const detail = findings
    .map((f) => `${f.file} [${f.label}] prefix=${f.prefix}… len=${f.length}`)
    .join('\n')
  assert.deepEqual(findings, [],
    `疑似凭据命中（合成示例须带 ${SYNTHETIC_MARKER} 标记并落在白名单，或登记进 EXEMPTIONS）：\n${detail}`)
})

test('exemption entries carry a non-empty, well-formed reason', () => {
  for (const [key, reason] of EXEMPTIONS) {
    assert.match(key, /^[^:]+::[a-z0-9-]+$/, `豁免键格式应为 <相对路径>::<模式标签>: ${key}`)
    assert.ok(typeof reason === 'string' && reason.trim().length > 0, `豁免条目缺少原因: ${key}`)
  }
})

// 同步守卫（单向包含）：`.gitignore` 中的顶层目录模式必须都出现在 SKIP_DIRS 中——
// 防止未来新增忽略目录（新的 worktree 布局、缓存目录等）时扫描范围悄悄失配。
// 只做单向：SKIP_DIRS 允许有额外条目（如 `.git`，它不出现在 .gitignore 中）。
// 打包产物不含 `.gitignore`（files 白名单之外），故该断言只在仓库检出内执行；
// 源码树里文件缺失则 fail-closed（判据与 workflow/engines 契约测试一致：看 `.git` 是否存在）。
const IGNORE_FILE = join(root, '.gitignore')
const ignoreSkipReason = !existsSync(IGNORE_FILE) && !existsSync(join(root, '.git'))
  ? 'packed deliverable excludes .gitignore — the ignore/skip sync contract is validated in the repository checkout'
  : false

test('.gitignore top-level directory patterns stay covered by SKIP_DIRS',
  { skip: ignoreSkipReason }, () => {
    const topLevelDirs = readFileSync(IGNORE_FILE, 'utf8').split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!') && line.endsWith('/'))
      .map((line) => line.replace(/^\//, '').replace(/\/$/, ''))
      .filter((name) => name.length > 0 && !name.includes('/'))
    const missing = topLevelDirs.filter((name) => !SKIP_DIRS.has(name))
    assert.deepEqual(missing, [],
      `以下 .gitignore 顶层目录未被 SKIP_DIRS 覆盖（扫描会误入）：${missing.join(', ')}`)
  })
