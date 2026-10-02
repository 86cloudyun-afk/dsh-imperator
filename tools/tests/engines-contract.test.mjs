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
  ? 'packed deliverable excludes .github — the engines/matrix contract is validated in the repository checkout'
  : false

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const enginesNode = pkg?.engines?.node

// 契约：engines.node = CI 矩阵实际测试的 node 版本的 `^X.Y.Z || ^A.B.C` 并集。
// 声明得更宽 = 声称未测版本兼容；声明得更窄 = 已测版本不被戳记。两个方向都必须让本测试失败。
// 调整契约的正确方式：矩阵与 engines 同改（本测试即提醒器）。
function matrixVersions() {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const match = workflow.match(/node:\s*\[([^\]]*)\]/)
  assert.ok(match, 'verify.yml must declare a node matrix entry')
  return [...match[1].matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0])
}

test('package.json declares a machine-readable node engine range', () => {
  assert.equal(typeof enginesNode, 'string', 'package.json must carry engines.node')
  assert.ok(enginesNode.trim().length > 0, 'engines.node must not be empty')
})

test('engines.node is exactly the CI-tested node release train', { skip: packedSkipReason }, () => {
  const matrix = matrixVersions()
  assert.ok(matrix.length > 0, 'CI matrix must list at least one version')

  const engineVersions = [...enginesNode.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0])
  assert.deepEqual(
    [...new Set(engineVersions.map((v) => v.split('.')[0]))].sort(),
    [...new Set(matrix.map((v) => v.split('.')[0]))].sort(),
    `engines.node must cover exactly the majors in CI matrix ${JSON.stringify(matrix)}`,
  )

  for (const version of matrix) {
    assert.ok(
      enginesNode.includes(version),
      `CI-tested version ${version} must appear in engines.node "${enginesNode}" (the declared floor is the tested floor)`,
    )
  }
})
