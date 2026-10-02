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
