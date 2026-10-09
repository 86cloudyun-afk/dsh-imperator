/** Scoped keyset board reads. Authorization and read snapshots belong to the store. */
import { validResolutionSql, evidenceBasisSql } from './evidence.js'
import { mutablePageState, cohortPagination } from './page-cursor.js'
import { visibleFactsFrom } from './visible-facts.js'

export const BOARD_PAGE_BYTES = 60_000 // reserve room for model-tool envelope and viewer metadata
const VIEWS = ['tasks', 'summary', 'facts', 'handoffs', 'late_blockers']
function inputError(message) {
  return Object.assign(new Error(`看板分页参数无效：${message}`), { code: 'E_INPUT' })
}
export function pageInput(input = {}) {
  if (typeof input === 'number') input = { task_id: input }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw inputError('需要参数对象')
  const args = { ...input, limit: input.limit === undefined ? 25 : input.limit }
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) throw inputError('limit 必须为 1–100 整数')
  for (const field of ['cursor', 'late_cursor', 'task_id']) {
    if (args[field] !== undefined && (!Number.isSafeInteger(args[field]) || args[field] < 1)) throw inputError(`${field} 必须为正整数`)
  }
  for (const field of ['page_token', 'late_page_token']) {
    if (args[field] !== undefined && (typeof args[field] !== 'string' || args[field].length === 0 || args[field].length > 1024)) throw inputError(field + ' 必须为有界 token 字符串')
  }
  if (['facts', 'handoffs'].includes(args.view) && (args.page_token !== undefined || args.late_page_token !== undefined)) throw inputError('历史页只使用数字 cursor')
  if (args.view === undefined && args.task_id !== undefined && (args.cursor !== undefined || args.page_token !== undefined)) throw inputError('兼容详情不接受待办 cursor/token；请显式指定 view')
  if (args.view === 'late_blockers' && (args.late_cursor !== undefined || args.late_page_token !== undefined)) throw inputError('专用晚到页使用 cursor/page_token')

  if (args.view !== undefined && !VIEWS.includes(args.view)) throw inputError('view 不在允许集合')
  if (['facts', 'handoffs'].includes(args.view) && args.task_id === undefined) throw inputError('facts/handoffs 必须指定 task_id')
  return args
}
export function pagination(rows, limit, more, id = 'id') {
  return { limit, next_cursor: more && rows.length ? rows.at(-1)[id] : null, has_more: more }
}
function page(rows, limit, id = 'id') {
  const more = rows.length > limit
  rows = rows.slice(0, limit)
  return { rows, pagination: pagination(rows, limit, more, id) }
}
function clipFields(row, fields) {
  const truncatedFields = []
  for (const [key, size, identity] of fields) {
    if (typeof row[key] !== 'string' || row[key].length <= size) continue
    row[key] = identity ? null : row[key].slice(0, size) + '…'
    truncatedFields.push(key)
  }
  if (truncatedFields.length) { row.truncated = true; row.truncated_fields = truncatedFields }
  return row
}
function factRow(row) {
  return { id: row.id, kind: row.kind, confidence: row.confidence, statement: row.statement,
    evidence: row.evidence_path === null ? null : (row.evidence_line === null ? row.evidence_path : `${row.evidence_path}:${row.evidence_line}`),
    by: row.created_by, actor_session: row.actor_session, at: row.created_at }
}
const DISPLAY_FACT = [['statement', 160], ['evidence', 100], ['by', 64], ['actor_session', 256, true], ['at', 40]]
const DISPLAY_TASK = [['title', 80], ['owner', 64], ['owner_session', 256, true], ['last_fact_at', 40]]

export function historyPage(db, args, run) {
  const table = args.view === 'facts' ? 'fact' : 'handoff'
  const where = ` FROM ${table} f JOIN task t ON t.id=f.task_id AND f.run_id IS t.run_id WHERE t.run_id IS ? AND t.id=?`
  const total = Number(db.prepare('SELECT COUNT(*) AS n' + where).get(run, args.task_id).n)
  const rows = db.prepare('SELECT f.*' + where + (args.cursor === undefined ? '' : ' AND f.id < ?') + ' ORDER BY f.id DESC LIMIT ?')
    .all(run, args.task_id, ...(args.cursor === undefined ? [] : [args.cursor]), args.limit + 1)
  const result = page(rows, args.limit)
  return { scope: 'task', view: args.view, task_id: args.task_id, total,
    [args.view]: args.view === 'facts' ? result.rows.map(row => ({ ...row, ...factRow(row) })) : result.rows, pagination: result.pagination, truncated: false }
}
function lateWhere(pending, scoped) {
  return ' FROM fact b JOIN task t ON t.id=b.task_id AND b.run_id IS t.run_id WHERE t.run_id IS ?'
    + ` AND t.status NOT IN (${pending.map(() => '?').join(',')}) AND b.kind='blocker'`
    + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'b')})`
    + (scoped ? ' AND t.id=?' : '')
}
export function latePage(db, args, run, pending, display = false) {
  const where = lateWhere(pending, args.task_id !== undefined)
  const params = [run, ...pending, ...(args.task_id === undefined ? [] : [args.task_id])]
  const candidates = ' FROM fact b JOIN task t ON t.id=b.task_id AND b.run_id IS t.run_id'
    + " WHERE t.run_id IS ? AND b.kind='blocker'" + (args.task_id === undefined ? '' : ' AND t.id=?')
  const state = mutablePageState(db, args, ['late_blockers', run, args.task_id ?? null],
    { sql: 'SELECT COALESCE(MAX(b.id),0) AS n' + candidates, params: [run, ...(args.task_id === undefined ? [] : [args.task_id])] },
    { sql: 'SELECT b.id AS id' + where + ' AND b.id <= ?', params })
  const counts = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT t.id) AS tasks' + where).get(...params)
  const rows = db.prepare('SELECT b.id AS fact_id, t.id AS task_id, t.title, t.status, t.owner, b.statement,'
    + ' b.created_by AS by, b.actor_session, b.created_at AS at' + where
    + ' AND b.id <= ?' + (args.cursor === undefined ? '' : ' AND b.id < ?') + ' ORDER BY b.id DESC LIMIT ?')
    .all(...params, state.u, ...(args.cursor === undefined ? [] : [args.cursor]), args.limit + 1)
  const result = page(rows, args.limit, 'fact_id')
  return { rows: display ? result.rows.map(row => clipFields(row, [['title', 80], ['owner', 64], ...DISPLAY_FACT])) : result.rows,
    pagination: cohortPagination(result.pagination, state), state, total: Number(counts.n), tasks: Number(counts.tasks) }
}
function integrity(db, run, taskId) {
  const where = ' FROM task t WHERE t.run_id IS ?' + (taskId === undefined ? '' : ' AND t.id=?')
  const params = [run, ...(taskId === undefined ? [] : [taskId])]
  const counts = db.prepare('SELECT COALESCE(SUM((SELECT COUNT(*) FROM fact f WHERE f.task_id=t.id AND f.run_id IS NOT t.run_id)),0) AS mismatched_facts,'
    + ' COALESCE(SUM((SELECT COUNT(*) FROM handoff h WHERE h.task_id=t.id AND h.run_id IS NOT t.run_id)),0) AS mismatched_handoffs,'
    + ' COALESCE(SUM((SELECT COUNT(*) FROM execution_receipt e WHERE e.task_id=t.id AND e.run_id IS NOT t.run_id)),0) AS mismatched_receipts,'
    + ' COALESCE(SUM((SELECT COUNT(*) FROM execution_waiver w WHERE w.task_id=t.id AND w.run_id IS NOT t.run_id)),0) AS mismatched_waivers' + where).get(...params)
  // Keep healthy legacy shapes; audit anomalies add explicit counts.
  if (counts.mismatched_receipts === 0) delete counts.mismatched_receipts
  if (counts.mismatched_waivers === 0) delete counts.mismatched_waivers
  return counts
}

/** Detail only needs existence for its legacy review warning, not every basis row. */
export function hasBasisFact(db, taskId, run) {
  return db.prepare('SELECT 1 FROM fact f JOIN task t ON t.id=f.task_id AND f.run_id IS t.run_id'
    + ` WHERE t.run_id IS ? AND t.id=? AND ${evidenceBasisSql('f')} LIMIT 1`).get(run, taskId) !== undefined
}

export function boardPageSnapshot(db, args, run, pending, detail) {
  if (args.view === undefined && args.task_id !== undefined) {
    const result = detail()
    const facts = historyPage(db, { view: 'facts', task_id: args.task_id, limit: 50 }, run)
    const handoffs = historyPage(db, { view: 'handoffs', task_id: args.task_id, limit: 10 }, run)
    const late = latePage(db, { ...args, cursor: args.late_cursor, page_token: args.late_page_token }, run, pending)
    return { ...result, facts: facts.facts, handoffs: handoffs.handoffs,
      facts_pagination: facts.pagination, handoffs_pagination: handoffs.pagination,
      late_blockers: late.rows, late_blocked_tasks: late.tasks, late_blockers_total: late.total, late_pagination: late.pagination }
  }
  const view = args.view ?? 'tasks'
  if (view === 'facts' || view === 'handoffs') return historyPage(db, args, run)
  if (view === 'late_blockers') {
    const late = latePage(db, args, run, pending)
    return { scope: args.task_id === undefined ? 'open' : 'task', view, late_blockers: late.rows,
      total: late.total, late_blocked_tasks: late.tasks, pagination: late.pagination, truncated: false }
  }
  const marks = pending.map(() => '?').join(',')
  const counts = db.prepare(`SELECT COUNT(*) AS tasks, COALESCE(SUM(status IN (${marks})),0) AS open_tasks,`
    + " COALESCE(SUM(status='submitted'),0) AS submitted_tasks FROM task WHERE run_id IS ?").get(...pending, run)
  const facts = db.prepare('SELECT COUNT(*) AS n' + visibleFactsFrom).get(run)
  const late = latePage(db, { ...args, task_id: undefined, cursor: args.late_cursor, page_token: args.late_page_token }, run, pending, true)
  let tasks = [], taskPagination = pagination([], args.limit, false), taskState
  const selectTasks = view === 'tasks' && Number(counts.open_tasks) > 0
  if (view === 'tasks') taskPagination.page_token = null
  // Fresh empty pages need no cohort or row query. Supplied continuations must
  // still validate their token even when the cohort has become empty.
  if (selectTasks || args.cursor !== undefined || args.page_token !== undefined) {
    const where = ' FROM task WHERE run_id IS ?' + (args.task_id === undefined ? '' : ' AND id=?')
    const params = [run, ...(args.task_id === undefined ? [] : [args.task_id])]
    taskState = mutablePageState(db, args, ['tasks', run, args.task_id ?? null],
      { sql: 'SELECT COALESCE(MAX(id),0) AS n' + where, params },
      { sql: 'SELECT id' + where + ` AND status IN (${marks}) AND id <= ?`, params: [...params, ...pending] })
  }
  if (selectTasks) {
    const rows = db.prepare('WITH selected AS MATERIALIZED (SELECT id,title,status,owner,owner_session,run_id FROM task'
      + ` WHERE run_id IS ? AND status IN (${marks})`
      + (args.task_id === undefined ? '' : ' AND id=?')
      + ' AND id <= ?' + (args.cursor === undefined ? '' : ' AND id < ?') + ' ORDER BY id DESC LIMIT ?)'
      + ' SELECT t.id,t.title,t.status,t.owner,t.owner_session,'
      + ' (SELECT COUNT(*) FROM fact f INDEXED BY idx_fact_task_id WHERE f.task_id=t.id AND f.run_id IS t.run_id) AS fact_count,'
      + ' (SELECT MAX(f.created_at) FROM fact f INDEXED BY idx_fact_task_id WHERE f.task_id=t.id AND f.run_id IS t.run_id) AS last_fact_at,'
      + " (SELECT COUNT(*) FROM fact b INDEXED BY idx_fact_task_id WHERE b.task_id=t.id AND b.run_id IS t.run_id AND b.kind='blocker'"
      + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'b')})) AS blockers`
      + ' FROM selected t ORDER BY t.id DESC')
      .all(run, ...pending, ...(args.task_id === undefined ? [] : [args.task_id]), taskState.u, ...(args.cursor === undefined ? [] : [args.cursor]), args.limit + 1)
    const selected = page(rows, args.limit)
    taskPagination = cohortPagination(selected.pagination, taskState)
    // Restrict the latest-fact work to selected IDs, never rank the entire run.
    const summaries = selected.rows.length ? db.prepare('SELECT f.* FROM fact f JOIN task t ON t.id=f.task_id AND f.run_id IS t.run_id'
      + ` WHERE t.run_id IS ? AND t.id IN (${selected.rows.map(() => '?').join(',')})`
      + ' AND f.id=(SELECT MAX(b.id) FROM fact b WHERE b.task_id=t.id AND b.run_id IS t.run_id)').all(run, ...selected.rows.map(row => row.id)) : []
    const byTask = new Map(summaries.map(row => [row.task_id, clipFields(factRow(row), DISPLAY_FACT)]))
    tasks = selected.rows.map(row => ({ ...clipFields(row, DISPLAY_TASK), detail: { task_id: row.id }, facts: byTask.has(row.id) ? [byTask.get(row.id)] : [] }))
  }
  const result = { scope: 'open', view, run_id: run, open_tasks: Number(counts.open_tasks), submitted_tasks: Number(counts.submitted_tasks),
    totals: { tasks: Number(counts.tasks), facts: Number(facts.n), open_tasks: Number(counts.open_tasks), submitted_tasks: Number(counts.submitted_tasks),
      late_blockers: late.total, late_blocked_tasks: late.tasks },
    scope_integrity_totals: integrity(db, run),
    scope_integrity_note: '全域归属异常仅计数；指定 task_id 详情查看该任务的异常。',
    tasks, pagination: taskPagination, late_blockers: late.rows, late_blocked_tasks: late.tasks, late_pagination: late.pagination,
    truncated: tasks.some(row => row.truncated || row.facts.some(f => f.truncated)) || late.rows.some(row => row.truncated),
    note: '展示字段如截短会标记 truncated_fields；原文见 task_id 详情或 facts 页。late_blockers 按 fact_id 分页，完整历史按 id 降序读取。' }
  // Drop only page tails and move the corresponding independent cursor to the
  // last emitted row, ensuring every omitted row remains reachable.
  while (Buffer.byteLength(JSON.stringify(result)) > BOARD_PAGE_BYTES) {
    const key = result.tasks.length > result.late_blockers.length ? 'tasks' : 'late_blockers'
    if (result[key].length <= 1) throw inputError('单项元数据超过输出预算，请检查宿主标识')
    result[key].pop()
    result[key === 'tasks' ? 'pagination' : 'late_pagination'] = cohortPagination(
      pagination(result[key], args.limit, true, key === 'tasks' ? 'id' : 'fact_id'), key === 'tasks' ? taskState : late.state)
    result.truncated = true
    result.budget_reduced = true
  }
  return result
}
