import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * 测试清单一致性守卫（D-2）。
 *
 * `tools/verify-all.mjs` 的测试清单是**硬编码且双轨制**：`const TESTS = [...]` 是主清单，
 * `native boundaries` 分组又**另行显式**列出 4 个文件名。两条清单并存，此前**没有任何机械校验**
 * ⇒ 新增测试文件时漏登记不会被任何检查发现；审计时也无法判断"目录与清单是否一致"
 * （本会话曾因此产生一轮假阳性与一轮计数错误，两轮返工）。本文件把这个不变量变成可验的三条断言。
 *
 * 解析纪律：`TESTS` 数组的结束行是**行首单独的 `]`**（不是 `];`）—— 用 `sed '/const TESTS/,/];/'`
 * 这类区间正则会把紧随其后的 `native boundaries` 分组内容一并吃进来（实测会把 56 项误读成 60 项）。
 * 因此这里用带锚点的正则 `const TESTS = \[([\s\S]*?)\n\]`，并在断言前先做解析规模自检。
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const testsDir = join(root, 'tools', 'tests')
const verifySource = readFileSync(join(root, 'tools', 'verify-all.mjs'), 'utf8')

// 主清单：`const TESTS = [` … 行首 `]` 止（**刻意不用 `];`**，见文件头解析纪律）。
const listBlock = /const TESTS = \[([\s\S]*?)\n\]/.exec(verifySource)
const TESTS = [...(listBlock?.[1] ?? '').matchAll(/'([^']+\.test\.mjs)'/g)].map(match => match[1])

// 分组清单：`run('native boundaries', [ ... ])`；组内只有 `join(HERE, 'tests/x.test.mjs')` 形态，
// 无嵌套方括号，故取到首个 `]` 即为该数组结束。
const groupBlock = /run\('native boundaries',\s*\[([^\]]*)\]/.exec(verifySource)
const NATIVE = [...(groupBlock?.[1] ?? '').matchAll(/'tests\/([^']+\.test\.mjs)'/g)].map(match => match[1])

// 目录真值：`tools/tests/` 下的全部 `*.test.mjs`。
const FILES = readdirSync(testsDir).filter(file => file.endsWith('.test.mjs')).sort()

/**
 * 双轨重叠白名单：**同时**出现在 `TESTS` 与 `native boundaries` 中的条目。
 * 这是**刻意的双轨制，不是疏漏** —— `TESTS` 决定 offline 模式跑什么，`native boundaries` 决定
 * 需要安装锚点（`DSH_INSTALL_ANCHOR`）的宿主边界组跑什么，两者重叠是设计意图，不是重复登记。
 * `host-boundaries.test.mjs` **只**在 `native boundaries` 组（它需要安装锚点、不进 offline 主清单），
 * 因此**不在**本白名单内。新增/移除重叠必须显式改这一行，否则守卫会响。
 */
const INTENTIONAL_OVERLAP = ['host-runtime.test.mjs', 'host-api-contract.test.mjs', 'scheduler-native.test.mjs']

test('目录 → 清单：tools/tests/ 下每个 *.test.mjs 都必须在 TESTS 或 native boundaries 中登记', t => {
  t.diagnostic(`清单解析：TESTS ${TESTS.length} 项 / native boundaries ${NATIVE.length} 项；目录实有 ${FILES.length} 个 *.test.mjs`)
  // 解析规模自检：正则锚点若失配会得到空清单，从而让"全覆盖"空过 —— 先让它响。
  assert.ok(TESTS.length >= 10,
    `清单解析异常：TESTS 仅解析到 ${TESTS.length} 项（预期 ≥ 10）；解析锚点可能失效，不得让空清单假通过`)
  assert.ok(NATIVE.length >= 1,
    `清单解析异常：native boundaries 仅解析到 ${NATIVE.length} 项（预期 ≥ 1）；解析锚点可能失效`)
  const listed = new Set([...TESTS, ...NATIVE])
  const unlisted = FILES.filter(file => !listed.has(file))
  assert.deepEqual(unlisted, [],
    `目录 → 清单 覆盖不全：tools/tests/ 实有 ${FILES.length} 个 *.test.mjs（TESTS ${TESTS.length} 项 + native boundaries ${NATIVE.length} 项），`
    + `其中 ${unlisted.length} 个未登记任何清单 ⇒ ${unlisted.join(', ')}`)
})

test('清单 → 目录：两条清单的每个条目都必须在 tools/tests/ 中真实存在', () => {
  const present = new Set(FILES)
  const entries = [...new Set([...TESTS, ...NATIVE])]
  const ghosts = entries.filter(file => !present.has(file)).sort()
  assert.deepEqual(ghosts, [],
    `清单 → 目录 存在性失败：清单共 ${entries.length} 个去重条目（TESTS ${TESTS.length} + native boundaries ${NATIVE.length}），`
    + `其中 ${ghosts.length} 个在 tools/tests/ 中不存在（幽灵条目）⇒ ${ghosts.join(', ')}`)
})

test('双清单重叠必须与显式白名单一致（刻意的双轨制，不是疏漏）', () => {
  const overlap = [...new Set(TESTS.filter(file => NATIVE.includes(file)))].sort()
  const expected = [...INTENTIONAL_OVERLAP].sort()
  assert.deepEqual(overlap, expected,
    `双清单重叠与白名单不一致：实际 = [${overlap.join(', ')}]，白名单 = [${expected.join(', ')}]；`
    + '新增或消失的重叠项都必须显式登记到 INTENTIONAL_OVERLAP（该双轨制是设计意图，不是重复登记）')
})
