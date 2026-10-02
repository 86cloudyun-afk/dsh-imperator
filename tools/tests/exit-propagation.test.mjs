import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFY_SCRIPTS = [
  'verify-store.mjs', 'verify-store-v2.mjs', 'verify-store-v3.mjs',
  'verify-scope-guard.mjs', 'verify-child-control.mjs',
]

// C5 回归守卫：process.exit() 不等待 stdout 队列落盘，管道消费 + 大输出会截断报告尾部
// （实测 50000 行经管道只剩 2145 行；process.exitCode 为完整 50000 行）。
// 静态断言是机制级的：截断的唯一触发源就是该调用的存在，与输出大小、消费者快慢无关，
// 因此比行为断言稳定；下面的管道冒烟另行覆盖「改坏主流程」的常见回归。
test('verification scripts never call process.exit (stdout flush regression guard)', () => {
  for (const script of VERIFY_SCRIPTS) {
    const source = readFileSync(join(root, 'tools', script), 'utf8')
    assert.doesNotMatch(source, /\bprocess\.exit\(/,
      `${script} must propagate status via process.exitCode so buffered stdout is flushed before exit`)
  }
})

test('verify-store keeps a complete report tail when stdout is a pipe', () => {
  const result = spawnSync(process.execPath, [join(root, 'tools', 'verify-store.mjs')], {
    encoding: 'utf8', timeout: 60_000, shell: false,
  })
  assert.equal(result.status, 0, `verify-store.mjs exited with ${result.status}: ${result.stderr}`)
  assert.match(result.stdout, /断言：\d+ PASS \/ \d+ FAIL/, 'the report header must be present')
  assert.match(result.stdout, /退出码：0\s*$/, 'the report tail must survive pipe consumption')
})
