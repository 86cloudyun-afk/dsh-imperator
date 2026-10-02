import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const storeSrc = readFileSync(fileURLToPath(new URL('../../lib/store/index.js', import.meta.url)), 'utf8')
const toolsSrc = readFileSync(fileURLToPath(new URL('../../lib/tools/index.js', import.meta.url)), 'utf8')

/**
 * 双向一致性守卫：`lib/store/index.js` 的 `STORE_CODES` 与 `lib/tools/index.js`
 * 的 code→hint 映射表必须**互相覆盖**，否则会出现两类静默缺陷：
 *
 * - 正向缺失：新增 store 码但忘了加映射 → 模型侧落到兜底 `HINT_INPUT`
 *   （"参数问题，可重试"），把状态机/身份/阻塞类拒绝误分类 —— 与
 *   `lib/store/index.js:336` 的用法约束意图相反。
 * - 反向孤儿：映射表里留着一个已不存在的码（改名/删除后的残渣）→
 *   阅读时以为该码仍被使用，实际永不可达。
 *
 * 设计取舍（方案 B，不动架构）：工具层映射**刻意**按字面值对应、保持零耦合
 * （见 `lib/tools/index.js:1095` 注释），因此不引入跨模块单一注册表；
 * 本守卫用静态断言给"双侧注册"提供机械保证。两类例外必须显式登记
 * （带依据），不允许静默累积。
 */

/** 例外一：不从 STORE_CODES 导出的映射键。 */
const NON_STORE_MAPPED_CODES = new Map([
  ['E_STORE_BUSY', 'sqlite.js 层码（写入繁忙），由 normalizeSqliteError 产出，不从 store 门面导出（避免循环依赖）'],
  ['E_NOT_LEAD', 'actor 判据码；在 store 门面注册前由工具层定义（lib/tools/index.js:840）'],
])

/** 例外二：不经映射表、改由 store 侧内联 hint 的码（`Object.assign(refuse(...), { hint })`）。
 *  约束：清单每条都必须在 store 源码里确有对应的内联 hint，否则视为腐烂（见第三条测试）。 */
const INLINE_HINT_CODES = new Map([
  ['E_STORE_INTEGRITY', 'acceptTask 在存储完整性异常时内联给出操作指引（停止重试 / 交由管理员修复），提示需随上下文而定'],
])

/** 提取映射表里的具体映射：`else if (code === 'E_X') hint = HINT_Y`。 */
function mappedHints(src) {
  const map = new Map()
  for (const line of src.split('\n')) {
    const m = /else if \(code === '(E_[A-Z_]+)'\)\s*hint = (HINT_[A-Z_]+)/.exec(line)
    if (m) map.set(m[1], m[2])
  }
  return map
}

/** 提取 STORE_CODES 对象的 `{ 属性名: 'E_X' }` 对与全部码值。 */
function storeCodeEntries(src) {
  const start = src.indexOf('export const STORE_CODES')
  assert.ok(start > 0, 'store 源码里应能找到 STORE_CODES 定义')
  const end = src.indexOf('\n}', start)
  const block = src.slice(start, end)
  const entries = [...block.matchAll(/([A-Za-z_]+):\s*'(E_[A-Z_]+)'/g)].map((m) => ({ prop: m[1], code: m[2] }))
  return { entries, codes: entries.map((e) => e.code) }
}

test('每个 STORE_CODES 码都有具体 hint 覆盖（映射表或显式登记的内联 hint；不得落 HINT_INPUT 兜底）', () => {
  const mapped = mappedHints(toolsSrc)
  const { codes } = storeCodeEntries(storeSrc)
  const missing = []
  const fallback = []
  for (const code of codes) {
    if (mapped.has(code)) {
      if (mapped.get(code) === 'HINT_INPUT') fallback.push(code)
    } else if (!INLINE_HINT_CODES.has(code)) {
      missing.push(code)
    }
  }
  assert.deepEqual(missing, [],
    '以下 store 码既没有映射表条目、也不在 INLINE_HINT_CODES 例外清单（模型侧会落到兜底 HINT_INPUT，'
    + `把状态机/身份/阻塞类拒绝误分类为"参数问题"）：${missing.join(', ')}`)
  assert.deepEqual(fallback, [],
    `以下 store 码被显式映射到兜底 HINT_INPUT（应给具体提示，说明"为什么拒 + 下一步怎么走"）：${fallback.join(', ')}`)
})

test('工具层映射表不得出现孤儿键（每个字面量码须来自 STORE_CODES 或显式豁免清单）', () => {
  const mapped = [...mappedHints(toolsSrc).keys()]
  assert.ok(mapped.length >= 5, `映射表应至少解析出 5 个键，实得 ${mapped.length}`)
  const { codes } = storeCodeEntries(storeSrc)
  const known = new Set([...codes, ...NON_STORE_MAPPED_CODES.keys()])
  const orphans = mapped.filter((code) => !known.has(code))
  assert.deepEqual(orphans, [],
    '以下映射键既不在 STORE_CODES 也不在豁免清单（孤儿键：改名/删除后的残渣，永不可达）—— '
    + `要么删除该映射行，要么在 NON_STORE_MAPPED_CODES 里登记依据：${orphans.join(', ')}`)
})

test('INLINE_HINT_CODES 例外不得腐烂：每条必须在 store 源码里有对应内联 hint，且码仍存在于 STORE_CODES', () => {
  const { entries } = storeCodeEntries(storeSrc)
  for (const [code, reason] of INLINE_HINT_CODES) {
    const entry = entries.find((e) => e.code === code)
    assert.ok(entry, `INLINE_HINT_CODES 里的 ${code} 已不存在于 STORE_CODES（例外腐烂）：${reason}`)
    assert.ok(storeSrc.includes(`Object.assign(refuse(STORE_CODES.${entry.prop}`),
      `${code} 登记为内联 hint 例外，但 store 源码里找不到 Object.assign(refuse(STORE_CODES.${entry.prop}, ...), { hint })。`
      + '要么恢复内联 hint（该码就不需要映射表条目），要么把它并入映射表并从例外清单移除。')
  }
})
