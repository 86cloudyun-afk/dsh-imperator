import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const toolsSrc = readFileSync(fileURLToPath(new URL('../../lib/tools/index.js', import.meta.url)), 'utf8')

/**
 * SQLite「未归类错误」的分类守卫。
 *
 * 背景：`lib/store/sqlite.js` **有意**只把 errcode 5/6（BUSY/LOCKED）归一为
 * `E_STORE_BUSY`，其余（典型：磁盘满 FULL / IO 错误 IOERR / 库损坏 CORRUPT）
 * 原样抛出，`code` 仍是 `'ERR_SQLITE_ERROR'`（该取舍由 `sqlite.test.mjs`
 * "maps only SQLite primary busy or locked errors" 显式锁定）。
 *
 * 因此**分类的终点在工具层**：若不为其登记非参数类 hint，它会落到兜底
 * `HINT_INPUT`（"参数或对象标识有问题：核对 id 与取值后重试"）——把环境类的
 * "磁盘满"提示成可重试的参数问题，与 `lib/store/index.js:144`「模型按码判读」
 * 的契约意图相反。
 */

const MAPPING = /else if \(code === 'ERR_SQLITE_ERROR'\)\s*hint = (HINT_[A-Z_]+)/.exec(toolsSrc)

test('ERR_SQLITE_ERROR 必须有映射（未登记会落到兜底 HINT_INPUT）', () => {
  assert.ok(MAPPING,
    "工具层映射表未为 'ERR_SQLITE_ERROR' 登记 hint：SQLite 环境类错误（磁盘满 / IO / 库损坏）"
    + '会被提示为"参数问题，可重试"')
})

test('该映射不得指向参数类兜底（HINT_INPUT）', () => {
  assert.ok(MAPPING)
  assert.notEqual(MAPPING[1], 'HINT_INPUT',
    `'ERR_SQLITE_ERROR' 被映射到 ${MAPPING[1]}（参数类兜底）：应给"环境问题、不要重试、上报用户"的提示`)
})

test('该 hint 文案须明确"不要重试"且指向环境/数据完整性（防退化成模糊提示）', () => {
  assert.ok(MAPPING, '缺少映射，无法检查文案')
  const name = MAPPING[1]
  const start = toolsSrc.indexOf(`const ${name} = `)
  assert.ok(start > 0, `找不到 ${name} 的定义`)
  const nextConst = toolsSrc.indexOf('\nconst ', start + 1)
  const segment = toolsSrc.slice(start, nextConst > 0 ? nextConst : start + 900)
  assert.match(segment, /不要(反复)?重试/, `${name} 未明确"不要重试"`)
  assert.match(segment, /环境|数据完整/, `${name} 未指明属环境或数据完整性问题`)
})
