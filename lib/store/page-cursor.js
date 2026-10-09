/** Bounded, stateless validation of a mutable keyset cohort. No DB writes. */
import { createHash } from 'node:crypto'

function inputError(message) {
  return Object.assign(new Error('看板分页参数无效：' + message), { code: 'E_INPUT',
    hint: '待办/晚到分页须同时传上页 next_cursor 与 page_token；晚到区用 late_cursor 与 late_page_token。丢弃游标和 token，从第一页重新读取。' })
}
const digest = text => createHash('sha256').update(text).digest('hex')
const hashPattern = /^[0-9a-f]{64}$/

/** Queries/aliases are fixed by internal callers. Member query ends in <= ?. */
export function mutablePageState(db, args, scope, candidates, members) {
  const scopeHash = digest(JSON.stringify(scope))
  let token
  if (args.cursor !== undefined || args.page_token !== undefined) {
    if (args.cursor === undefined || typeof args.page_token !== 'string'
      || args.page_token.length === 0 || args.page_token.length > 1024
      || !/^[A-Za-z0-9_-]+$/.test(args.page_token)) throw inputError('游标缺少合法配对 token')
    try {
      const bytes = Buffer.from(args.page_token, 'base64url')
      if (bytes.toString('base64url') !== args.page_token) throw new Error('noncanonical token')
      token = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw inputError('token 编码无效')
    }
    if (token === null || typeof token !== 'object' || Array.isArray(token)
      || token.v !== 1 || token.s !== scopeHash || !hashPattern.test(token.h)
      || !Number.isSafeInteger(token.u) || token.u < 1
      || !Number.isSafeInteger(token.c) || token.c !== args.cursor || token.c > token.u) {
      throw inputError('token 范围或游标不匹配')
    }
  }
  const upper = token?.u ?? Number(db.prepare(candidates.sql).get(...candidates.params).n)
  const hash = createHash('sha256')
  // Do not materialize all IDs in JavaScript or cap resolver IDs.
  for (const row of db.prepare(members.sql + ' ORDER BY id').iterate(...members.params, upper)) {
    hash.update(String(row.id) + '\n')
  }
  const fingerprint = hash.digest('hex')
  if (token !== undefined && token.h !== fingerprint) {
    throw Object.assign(new Error('看板分页集合已变化，旧游标不能继续'), {
      code: 'E_PAGE_CHANGED',
      hint: '待办或晚到阻塞成员已变化；丢弃此集合的 cursor/page_token（晚到区为 late_cursor/late_page_token），从第一页重新读取并按 ID 去重。',
    })
  }
  return { v: 1, s: scopeHash, u: upper, h: fingerprint }
}

export function cohortPagination(pagination, state) {
  return { ...pagination, page_token: pagination.next_cursor === null ? null
    : Buffer.from(JSON.stringify({ ...state, c: pagination.next_cursor })).toString('base64url') }
}
