import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const storeSrc = readFileSync(fileURLToPath(new URL('../../lib/store/index.js', import.meta.url)), 'utf8')
const toolsSrc = readFileSync(fileURLToPath(new URL('../../lib/tools/index.js', import.meta.url)), 'utf8')

/**
 * 允许出现裸 `throw new Error(` 的函数（每条附豁免原因）。
 *
 * 规则出处：lib/store/index.js:336 的用法约束 ——「每个新增的拒绝路径都必须用它
 * （refuse(code)），不许 throw new Error('') 了事」。code 由 lib/tools/index.js 的
 * wrap() 映射成模型可读 hint；裸 Error 会落到兜底 HINT_INPUT（"参数问题，重试"），
 * 把状态机 / 身份 / 阻塞类拒绝**误分类**成可重试的输入错误。
 *
 * 只有两类豁免：① 参数校验（输入格式错误 → HINT_INPUT 语义正确）；
 * ② 实例生命周期（已卸载的实例，基础设施错误，不参与 hint 分派）。
 */
const BARE_ERROR_ALLOWED = new Map([
  ['requireText', '参数校验：非空字符串输入检查'],
  ['optionalText', '参数校验：可选字符串归一'],
  ['requireRunId', '参数校验：run_id 形状与长度'],
  ['requireId', '参数校验：正整数 id'],
  ['requireInteger', '参数校验：整数参数'],
  ['requireOneOf', '参数校验：枚举白名单'],
  ['open', '实例生命周期：事实库实例已关闭（基础设施错误，非业务拒绝）'],
  ['adoptUnassigned', '参数校验：接管必须给出具体 run_id'],
])

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'else', 'do'])

/** 向上找最近的函数/方法声明行，返回其名字（找不到返回 null）。 */
function ownerFunctionOf(lines, index) {
  for (let i = index; i >= 0; i--) {
    const decl = /^(?:export )?function ([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i])
      ?? /^\s{2}(#?[A-Za-z_$][\w$]*)\s*\(/.exec(lines[i])
    if (decl && !KEYWORDS.has(decl[1])) return decl[1]
  }
  return null
}

test('store 业务方法体内不得出现裸 throw new Error（必须用 refuse(code)）', () => {
  const lines = storeSrc.split('\n')
  const violations = []
  lines.forEach((line, i) => {
    // 同时捕获 `throw new Error(` 与三元假枝 `: new Error(`（后者曾漏掉 submitTask）。
    if (!/throw new Error\(/.test(line) && !(/throw\b/.test(line) && /:\s*new Error\(/.test(line))) return
    if (/^\s*\*/.test(line) || line.includes('用法约束')) return // 注释里的示例文本
    const owner = ownerFunctionOf(lines, i)
    if (!BARE_ERROR_ALLOWED.has(owner)) {
      violations.push(`L${i + 1} in ${owner ?? '<file scope>'}: ${line.trim().slice(0, 90)}`)
    }
  })
  assert.deepEqual(violations, [],
    '以下裸 throw new Error 位于业务方法（或无归属处）：按 lib/store/index.js:336 的约束改用 refuse(code)，'
    + `否则工具层的 code→hint 映射无法分辨"状态机边界"与"参数错误"：\n${violations.join('\n')}`)
})

test('每个 STORE_CODES 值都在工具层 hint 映射表内登记（防新增码漏映射）', () => {
  const start = storeSrc.indexOf('export const STORE_CODES')
  assert.ok(start > 0, 'store 源码里应能找到 STORE_CODES 定义')
  const end = storeSrc.indexOf('\n}', start)
  const codes = [...storeSrc.slice(start, end).matchAll(/'(E_[A-Z_]+)'/g)].map((m) => m[1])
  assert.ok(codes.length >= 6, `应至少解析出 6 个稳定码，实得 ${codes.length}`)
  const missing = codes.filter((code) => !toolsSrc.includes(`code === '${code}'`))
  assert.deepEqual(missing, [],
    `以下 store 码未在 lib/tools/index.js 的 hint 映射表登记（会落到 HINT_INPUT 兜底）：${missing.join(', ')}`)
})
