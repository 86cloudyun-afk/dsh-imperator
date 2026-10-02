import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const WORKFLOW = join(root, '.github/workflows/verify.yml')

// package.json 的 files 白名单不含 .github：npm 归档内没有 workflow 文件。
// 用 .git 区分源码树与打包产物——源码树里文件缺失仍必须失败，打包产物里如实跳过并说明原因。
const packedSkipReason = !existsSync(WORKFLOW) && !existsSync(join(root, '.git'))
  ? 'packed deliverable excludes .github — the workflow contract is validated in the repository checkout'
  : false

const lines = packedSkipReason ? [] : readFileSync(WORKFLOW, 'utf8').split('\n')

function exactlyOneLineContaining(needle) {
  const matches = lines.filter((line) => line.includes(needle))
  assert.equal(matches.length, 1, `expected exactly one workflow line containing ${JSON.stringify(needle)}, found ${matches.length}`)
  return matches[0]
}

test('native workflow never hardcodes the packed deliverable filename', { skip: packedSkipReason }, () => {
  assert.doesNotMatch(lines.join('\n'), /local-dsh-taskforce-\d+\.\d+\.\d+\.tgz/,
    'the npm pack filename follows package.json version and must not be duplicated as a literal in the workflow')
})

test('native workflow resolves the packed filename from pack.json and fails closed', { skip: packedSkipReason }, () => {
  const resolveLine = exactlyOneLineContaining('PACK_FILE=')
  assert.match(resolveLine, /pack\.json/, 'filename must be read from the recorded pack.json')
  assert.match(resolveLine, /filename/, 'the parsed pack.json entry must expose its filename field')
  const guardLine = exactlyOneLineContaining('test -n "$PACK_FILE"')
  assert.match(guardLine, /\$PACK_FILE/, 'an empty resolution must fail closed before tar runs')
})

test('tar unpack and checksum reuse the single resolved filename', { skip: packedSkipReason }, () => {
  const unpackLine = exactlyOneLineContaining('tar -xzf')
  assert.match(unpackLine, /\$PACK_FILE/, 'tar must consume the resolved filename, not a literal')
  const checksumLine = exactlyOneLineContaining('source.tar.gz > SHA256SUMS')
  assert.match(checksumLine, /\$PACK_FILE/, 'checksums must cover the same resolved deliverable file')
})

// 每个 uses: 行必须同时是「40 位十六进制 SHA」且带「# vX.Y.Z」版本备注。
// 出处：notes/AUDIT-imperator-20261002T064348Z.md 候选 C2 ——
// docs/superpowers/plans/2026-09-29-taskforce-phase-a.md:162 要求 actions 固定为
// 「经官方 tag 核对的 SHA」；版本注释正是该核对留下的可审计痕迹。
const PINNED_ACTION = /^uses: [^\s@]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/

test('every pinned action carries a 40-hex SHA and its version comment', { skip: packedSkipReason }, () => {
  const usesLines = lines
    .filter((line) => /^\s*(?:- )?uses:/.test(line))
    .map((line) => line.trim().replace(/^- /, ''))
  // fail-loud 自证：静态解析型守卫最常见的自失效方式是「解析塌了 ⇒ 空集 ⇒ 恒真」，
  // 所以先钉住数量下限（工作流现有 6 条 uses: 行）——解析失败必须报错而非静默全绿。
  assert.ok(usesLines.length >= 6, `expected at least six uses: lines, parsed ${usesLines.length}`)
  for (const line of usesLines) {
    assert.match(line, PINNED_ACTION,
      `a pinned action must carry a 40-hex SHA plus a trailing "# vX.Y.Z" comment, got ${JSON.stringify(line)}`)
  }
})
