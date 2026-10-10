import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { TESTS, NATIVE_BOUNDARY_TESTS } from '../verify-all.mjs'

/**
 * 测试清单一致性守卫（D-2）。
 *
 * `tools/verify-all.mjs` 的测试清单是**硬编码且双轨制**：`TESTS` 是主清单，`native boundaries`
 * 分组又**另行显式**列出 4 个文件名。两条清单并存，此前**没有任何机械校验** ⇒ 新增测试文件时
 * 漏登记不会被任何检查发现；审计时也无法判断"目录与清单是否一致"（本会话曾因此产生一轮假阳性
 * 与一轮计数错误，两轮返工）。本文件把这个不变量变成可验的三条断言。
 *
 * **取值纪律（#68 P2 修复）：本守卫 import 真实导出的清单常量，不解析源文本。**
 * 早期实现用正则匹配 `verify-all.mjs` 的字面量，会命中**注释里的文件名**：把 native 组里某个
 * `join(...)` 注释掉后，该条目实际不再执行（其离线用例会因缺安装锚点而 skip），可正则仍把它算作
 * 已登记 ⇒ 三条断言全部**假通过**（Codex P2，已实测复现：注释掉 scheduler-native 后旧实现仍
 * 3 pass / 0 fail）。改为 import 后，条目一旦被注释或删除，数组本身就少一项，而目录里文件仍在
 * ⇒ `目录 → 清单` 必然失败。副作用：`];` 终止符陷阱、每行多字面量陷阱一并消失（不再解析文本）。
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const testsDir = join(root, 'tools', 'tests')

/** 目录真值：`tools/tests/` 下的全部 `*.test.mjs`（排序后比较，避免顺序造成的伪差异）。 */
const FILES = readdirSync(testsDir).filter(file => file.endsWith('.test.mjs')).sort()

// 导入即可失败：若 `verify-all.mjs` 把常量改名/移走，这里当场响，而不是让下面的断言空过。
for (const [name, value] of [['TESTS', TESTS], ['NATIVE_BOUNDARY_TESTS', NATIVE_BOUNDARY_TESTS]]) {
  assert.ok(Array.isArray(value) && value.length > 0,
    `verify-all.mjs 的导出 \`${name}\` 不是非空数组（实得 ${JSON.stringify(value)}）：清单常量可能被改名或移走，本守卫需同步更新`)
}

/**
 * 双轨重叠白名单：**同时**出现在 `TESTS` 与 `NATIVE_BOUNDARY_TESTS` 中的条目。
 * 这是**刻意的双轨制，不是疏漏** —— `TESTS` 决定 offline 模式跑什么，`native boundaries` 决定
 * 需要安装锚点（`DSH_INSTALL_ANCHOR`）的宿主边界组跑什么，两者重叠是设计意图，不是重复登记。
 * `host-boundaries.test.mjs` **只**在 `native boundaries` 组（它需要安装锚点、不进 offline 主清单），
 * 因此**不在**本白名单内。新增/移除重叠必须显式改这一行，否则守卫会响。
 */
const INTENTIONAL_OVERLAP = ['host-runtime.test.mjs', 'host-api-contract.test.mjs', 'scheduler-native.test.mjs']

test('目录 → 清单：tools/tests/ 下每个 *.test.mjs 都必须在 TESTS 或 NATIVE_BOUNDARY_TESTS 中登记', t => {
  t.diagnostic(`真实清单：TESTS ${TESTS.length} 项 / NATIVE_BOUNDARY_TESTS ${NATIVE_BOUNDARY_TESTS.length} 项；目录实有 ${FILES.length} 个 *.test.mjs`)
  const listed = new Set([...TESTS, ...NATIVE_BOUNDARY_TESTS])
  const unlisted = FILES.filter(file => !listed.has(file))
  assert.deepEqual(unlisted, [],
    `目录 → 清单 覆盖不全：tools/tests/ 实有 ${FILES.length} 个 *.test.mjs（TESTS ${TESTS.length} 项 + native boundaries ${NATIVE_BOUNDARY_TESTS.length} 项），`
    + `其中 ${unlisted.length} 个未登记任何清单 ⇒ ${unlisted.join(', ')}`)
})

test('清单 → 目录：两条清单的每个条目都必须在 tools/tests/ 中真实存在', () => {
  const present = new Set(FILES)
  const entries = [...new Set([...TESTS, ...NATIVE_BOUNDARY_TESTS])]
  const ghosts = entries.filter(file => !present.has(file)).sort()
  assert.deepEqual(ghosts, [],
    `清单 → 目录 存在性失败：清单共 ${entries.length} 个去重条目（TESTS ${TESTS.length} + native boundaries ${NATIVE_BOUNDARY_TESTS.length}），`
    + `其中 ${ghosts.length} 个在 tools/tests/ 中不存在（幽灵条目）⇒ ${ghosts.join(', ')}`)
})

test('双清单重叠必须与显式白名单一致（刻意的双轨制，不是疏漏）', () => {
  const overlap = [...new Set(TESTS.filter(file => NATIVE_BOUNDARY_TESTS.includes(file)))].sort()
  const expected = [...INTENTIONAL_OVERLAP].sort()
  // 诊断直指具体条目：退出重叠 = 该文件已从某条清单里消失（例如被注释掉，则其锚点组执行随之消失）；
  // 新增重叠 = 出现了未登记的双轨条目。
  const left = expected.filter(file => !overlap.includes(file))
  const entered = overlap.filter(file => !expected.includes(file))
  assert.deepEqual(overlap, expected,
    `双清单重叠与白名单不一致：实际 = [${overlap.join(', ')}]，白名单 = [${expected.join(', ')}]；`
    + `退出重叠的条目 ⇒ ${left.length === 0 ? '（无）' : left.join(', ')}；`
    + `新增重叠的条目 ⇒ ${entered.length === 0 ? '（无）' : entered.join(', ')}。`
    + '退出即意味着该文件不再同时被两条清单有效登记（例如 native 组里的条目被注释掉后，它就不再获得锚点组执行）；'
    + '新增或消失的重叠项都必须显式登记到 INTENTIONAL_OVERLAP（该双轨制是设计意图，不是重复登记）')
})
