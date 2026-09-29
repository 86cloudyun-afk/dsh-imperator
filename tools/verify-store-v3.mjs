#!/usr/bin/env node
/**
 * 事实库 v3 自测：**终态冻结 · 晚到阻塞可见 · 验收门槛**。
 *
 * 跑法：`node tools/verify-store-v3.mjs`（任意 cwd；`--keep` 保留临时目录）
 *
 * 这份自测是**针对独立审计的两条缺陷**的回归：
 *
 *   缺陷 1 —— 验收终态可被旧子代理改写：
 *     ① 主控先验收，子代理随后 `task_close(result="failed")` ⇒ 任务从 accepted 被改成 cancelled；
 *     ② 主控先验收，子代理随后写 `kind="blocker"` ⇒ 任务仍 accepted，且默认待办板**不显示**它。
 *   缺陷 2 —— 零执行证据也能被验收，并自动生成 `CONFIRMED`：
 *     主控 `task_open → task_submit → task_accept`（无认领者 / 无事实 / 无产物 / 无证据）仍得 accepted，
 *     唯一的事实是系统自动写入的 `CONFIRMED`「验收通过：（无附注）」，evidence 为 null。
 *
 * 覆盖六组：
 *   A. 终态冻结：accept 之后 close(failed) / submit / accept / 非 blocker 落事实 逐条被拒（E_TERMINAL）；
 *      cancelled 与三个历史终态（done/partial/failed）同样受保护；未收口任务的 `task_close` 别名语义不变
 *   B. 晚到阻塞：收口后落 blocker **允许**（late=true），任务状态**不被改写**，
 *      但它立刻出现在默认看板 `late_blockers` 区与详情板 —— 不静默隐藏
 *   C. 验收门槛：零依据 / 只有 decision / 只有 blocker+消解 ⇒ 拒绝（E_EVIDENCE_MISSING）；
 *      有真实证据 ⇒ 通过；验收记录 kind=decision、confidence≠CONFIRMED、evidence 如实为空；
 *      `waiver_reason` = 显式人工豁免（记录标「人工豁免」，不混入已验证事实）
 *   D. 重新复核：终态任务由主会话 `task_reject` 推翻（reopened=true）⇒ 任务回到默认待办板 ⇒ 闭环可重走
 *   E. 工具层端到端（真实 handler）：错误码 + hint 可读、late 标记透传、板上可见、豁免透传
 *   F. 卫生：本自测不碰真实库
 *
 * 与既有两份的关系：`verify-store.mjs`（列/闭环/编译等价，35 条）与
 * `verify-store-v2.mjs`（run 隔离 + 提交验收分离，63 条）**都必须继续通过**；
 * 这份只加"终态与门槛"的新判据，不改既有语义。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const KEEP = process.argv.includes('--keep')
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SRC_LIB = join(PKG_ROOT, 'lib')

/** 真实 $DSH_HOME（只用于断言"没被写脏"）。 */
const REAL_DSH_HOME = process.env.DSH_HOME || join(process.env.HOME ?? '', '.dsh')
const REAL_DB = join(REAL_DSH_HOME, 'taskforce', 'taskforce.db')
const realDbBefore = existsSync(REAL_DB)

const TMP = mkdtempSync(join(tmpdir(), 'taskforce-v3-'))
const TMP_HOME = join(TMP, 'home')
mkdirSync(TMP_HOME, { recursive: true })
process.env.DSH_HOME = TMP_HOME

/* ─────────────────────────── 断言收集器 ─────────────────────────── */

const rows = []
let failed = 0

function check(id, title, ok, detail = '') {
  if (!ok) failed += 1
  rows.push({ id, title, ok })
  const tail = ok || detail === '' ? '' : `\n        ↳ ${detail}`
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}  ${title}${tail}`)
}

function section(title) {
  console.log(`\n──── ${title} ────`)
}

/** 捕获同步抛错，**连 `code` 一起取出**（本自测大量按码断言，不按文案）。 */
function thrownOf(fn) {
  try {
    const value = fn()
    return { threw: false, message: '', code: null, value }
  } catch (error) {
    return {
      threw: true,
      message: error instanceof Error ? error.message : String(error),
      code: error?.code ?? null,
      value: undefined,
    }
  }
}

async function thrownAsyncOf(fn) {
  try {
    const value = await fn()
    return { threw: false, message: '', code: null, value }
  } catch (error) {
    return {
      threw: true,
      message: error instanceof Error ? error.message : String(error),
      code: error?.code ?? null,
      value: undefined,
    }
  }
}

/** 源码指纹：证明这份报告对应的确切源码内容（审计可复核）。 */
function hashTree(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) hashTree(full, base, acc)
    else acc.push(`${full.slice(base.length + 1)} ${createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)}`)
  }
  return acc
}

console.log('══════════ 事实库 v3 自测（终态冻结 · 晚到阻塞 · 验收门槛）══════════')
console.log(`临时根        ${TMP}`)
console.log(`被测源码      ${SRC_LIB}`)
console.log(`源码指纹      ${hashTree(SRC_LIB).join('  |  ')}`)
console.log(`DSH_HOME      ${process.env.DSH_HOME}`)

const storeMod = await import(new URL('../lib/store/index.js', import.meta.url).href)
const toolsMod = await import(new URL('../lib/tools/index.js', import.meta.url).href)

/* ─────────────────────────── 测试骨架 ─────────────────────────── */

/** 假 ctx：只实现本插件用到的面（logger / effect / provide / get / tools）。 */
function makeCtx(services = new Map()) {
  const state = { warnings: [], infos: [], disposers: [], tools: [] }
  const ctx = {
    logger: {
      warn: (m) => state.warnings.push(String(m)),
      info: (m) => state.infos.push(String(m)),
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') state.disposers.push(disposer)
      return () => {}
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    get(name) {
      return services.get(name)
    },
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, state }
}

/** 造一个会话头形状的假 Agent（字段取自 SessionHeader / AgentOptions）。 */
function fakeAgent(id, headerExtra = {}, optionsExtra = {}) {
  return { id, options: { ...optionsExtra }, session: { header: { id, isSeeded: false, ...headerExtra } } }
}

const LEAD_A = 'sess-v3-lead'
const CHILD_A = 'sess-v3-child'
const AGENTS = new Map([
  [LEAD_A, fakeAgent(LEAD_A)],
  [CHILD_A, fakeAgent(CHILD_A, { parentSession: LEAD_A, origin: 'subagent', delegationDepth: 1 }, { subagentDepth: 1 })],
])
const LEAD_AGENT = AGENTS.get(LEAD_A)
const CHILD_AGENT = AGENTS.get(CHILD_A)

/* ══════════════ A. 终态冻结（缺陷 1 场景一） ══════════════ */

section('A. 终态冻结 —— 已收口的结论不能被普通写入改写（缺陷 1 场景一）')

const store = new storeMod.TaskforceStore(join(TMP, 'main'))
store.open()

const t1 = store.openTask({ title: 'v3 主任务（走完整闭环）', note: '验收判据：有证据、无未解阻塞' }, LEAD_A)
store.claimTask({ task_id: t1.task_id, child_id: 'child-v3' }, LEAD_A)
const ev1 = store.recordFact({
  task_id: t1.task_id,
  kind: 'fact',
  statement: '实测：bash 5.2.21 在容器内可用，退出码 0',
  evidence_path: '/tmp/v3/run.log',
  evidence_line: 7,
  child_id: 'child-v3',
}, LEAD_A)
store.submitTask({ task_id: t1.task_id }, LEAD_A)
const accepted1 = store.acceptTask({ task_id: t1.task_id, note: '核对了 run.log:7' }, LEAD_A, 'lead')
check('A01', '正常闭环：claim → task_fact(带 evidence_path) → submit → accept 成功 → accepted',
  accepted1.status === 'accepted' && accepted1.evidence_basis.count === 1
    && accepted1.evidence_basis.with_pointer === 1 && ev1.fact_id > 0,
  JSON.stringify(accepted1))

const closeFailed = thrownOf(() => store.closeTask({ task_id: t1.task_id, result: 'failed' }, LEAD_A))
const afterCloseFailed = store.taskOf({ task_id: t1.task_id }, LEAD_A)
check('A02', '★缺陷1-①：accept 之后 task_close(failed) **被拒**（E_TERMINAL），任务仍 accepted（不再被改成 cancelled）',
  closeFailed.threw && closeFailed.code === 'E_TERMINAL'
    && closeFailed.message.includes('已收口') && closeFailed.message.includes('重新复核')
    && afterCloseFailed.task.status === 'accepted',
  JSON.stringify({ threw: closeFailed.threw, code: closeFailed.code, status: afterCloseFailed.task.status,
    message: closeFailed.message.slice(0, 160) }))

const closeDone = thrownOf(() => store.closeTask({ task_id: t1.task_id, result: 'done' }, LEAD_A))
const reSubmit = thrownOf(() => store.submitTask({ task_id: t1.task_id }, LEAD_A))
const reAccept = thrownOf(() => store.acceptTask({ task_id: t1.task_id }, LEAD_A, 'lead'))
const reClaim = thrownOf(() => store.claimTask({ task_id: t1.task_id, child_id: 'child-x' }, LEAD_A))
check('A03', '终态上的 close(done) / submit / accept / claim 同样被拒（状态机单向，收口后不可回头走普通路径）',
  [closeDone, reSubmit, reAccept].every((r) => r.threw && r.code === 'E_TERMINAL')
    && reClaim.threw && reClaim.code === 'E_TERMINAL',
  JSON.stringify([closeDone, reSubmit, reAccept, reClaim].map((r) => ({ code: r.code, msg: r.message.slice(0, 80) }))))

const lateFactReject = thrownOf(() => store.recordFact({
  task_id: t1.task_id, kind: 'fact', statement: '收口后补写的一条"事实"', evidence_path: '/tmp/v3/late.log',
}, LEAD_A))
const lateArtifactReject = thrownOf(() => store.recordFact({
  task_id: t1.task_id, kind: 'artifact', statement: '收口后补写的产物',
}, LEAD_A))
const lateDecisionReject = thrownOf(() => store.recordFact({
  task_id: t1.task_id, kind: 'decision', statement: '收口后补写的决策',
}, LEAD_A))
check('A04', '终态任务拒绝新的 fact / artifact / decision 写入（E_TERMINAL，错误里指路 task_reject 重新复核）',
  [lateFactReject, lateArtifactReject, lateDecisionReject].every((r) => r.threw && r.code === 'E_TERMINAL'
    && r.message.includes('重新复核')),
  JSON.stringify([lateFactReject, lateArtifactReject, lateDecisionReject].map((r) => ({ code: r.code, msg: r.message.slice(0, 90) }))))

/* cancelled 同样按终态处理 */
{
  const tc = store.openTask({ title: 'cancelled 终态' }, LEAD_A)
  const closed = store.closeTask({ task_id: tc.task_id, result: 'failed' }, LEAD_A)
  const again = thrownOf(() => store.closeTask({ task_id: tc.task_id, result: 'failed' }, LEAD_A))
  const claimIt = thrownOf(() => store.claimTask({ task_id: tc.task_id, child_id: 'child-v3' }, LEAD_A))
  const factIt = thrownOf(() => store.recordFact({ task_id: tc.task_id, kind: 'fact', statement: 'x' }, LEAD_A))
  check('A05', 'cancelled 是终态：再次 close(failed) / claim / 非 blocker 落事实 全部被拒（E_TERMINAL）',
    closed.status === 'cancelled' && again.threw && again.code === 'E_TERMINAL'
      && claimIt.threw && claimIt.code === 'E_TERMINAL'
      && factIt.threw && factIt.code === 'E_TERMINAL',
    JSON.stringify({ closed: closed.status, again: again.code, claim: claimIt.code, fact: factIt.code }))
}

/* 历史终态（迁移前的 done/partial/failed）：直接造一行，验证同样受保护 */
{
  const legacyRoot = join(TMP, 'legacy-terminal')
  mkdirSync(legacyRoot, { recursive: true })
  const seed = new DatabaseSync(join(legacyRoot, 'taskforce.db'))
  seed.exec(`
    CREATE TABLE task (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT,
      status TEXT NOT NULL DEFAULT 'open', owner TEXT, run_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  seed.exec(`INSERT INTO task (title, note, status, owner, run_id, created_at, updated_at)
             VALUES ('历史 done 任务', NULL, 'done', 'child-old', '${LEAD_A}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
  seed.close()
  const legacy = new storeMod.TaskforceStore(legacyRoot)
  legacy.open()
  const legacyClose = thrownOf(() => legacy.closeTask({ task_id: 1, result: 'failed' }, LEAD_A))
  const legacyFact = thrownOf(() => legacy.recordFact({ task_id: 1, kind: 'fact', statement: '晚到事实' }, LEAD_A))
  const legacyStatus = legacy.taskOf({ task_id: 1 }, LEAD_A).task.status
  check('A06', '三个历史终态（done）同样受保护：close(failed) / 落事实 被拒，status 原样保留 done',
    legacyClose.threw && legacyClose.code === 'E_TERMINAL'
      && legacyFact.threw && legacyFact.code === 'E_TERMINAL' && legacyStatus === 'done',
    JSON.stringify({ close: legacyClose.code, fact: legacyFact.code, status: legacyStatus }))
  legacy.close()
}

/* 状态表：终态任务的非法动作逐条 */
{
  const actions = [
    ['claim', () => store.claimTask({ task_id: t1.task_id, child_id: 'child-x' }, LEAD_A)],
    ['submit', () => store.submitTask({ task_id: t1.task_id }, LEAD_A)],
    ['accept', () => store.acceptTask({ task_id: t1.task_id }, LEAD_A, 'lead')],
    ['close(failed)', () => store.closeTask({ task_id: t1.task_id, result: 'failed' }, LEAD_A)],
    ['close(done)', () => store.closeTask({ task_id: t1.task_id, result: 'done' }, LEAD_A)],
    ['close(partial)', () => store.closeTask({ task_id: t1.task_id, result: 'partial' }, LEAD_A)],
    ['fact', () => store.recordFact({ task_id: t1.task_id, kind: 'fact', statement: '晚到事实' }, LEAD_A)],
    ['artifact', () => store.recordFact({ task_id: t1.task_id, kind: 'artifact', statement: '晚到产物' }, LEAD_A)],
    ['decision', () => store.recordFact({ task_id: t1.task_id, kind: 'decision', statement: '晚到决策' }, LEAD_A)],
  ]
  const results = actions.map(([name, fn]) => ({ name, ...thrownOf(fn) }))
  check('A07', '状态表：终态任务上 9 种非法动作**逐条**被拒，每条都带 code=E_TERMINAL 与中文可读错误（不静默、不空返回）',
    results.every((r) => r.threw && r.code === 'E_TERMINAL'
      && r.message.length > 40 && /[\u4e00-\u9fff]/.test(r.message)),
    JSON.stringify(results.map((r) => ({ name: r.name, threw: r.threw, code: r.code, len: r.message.length }))))
}

/* 未收口任务上 task_close 的既有别名语义未被破坏 */
{
  const ta = store.openTask({ title: '别名语义回归' }, LEAD_A)
  const alias = store.closeTask({ task_id: ta.task_id, result: 'done' }, LEAD_A)
  check('A08', '兼容性：未收口任务上 task_close(done) 仍是 submitTask 别名（→ submitted，永不产生 accepted）',
    alias.status === 'submitted' && alias.alias_of === 'submitTask' && alias.mapped_status.includes('submitted'),
    JSON.stringify(alias))
}

/* ══════════════ B. 晚到阻塞（缺陷 1 场景二） ══════════════ */

section('B. 晚到阻塞 —— 收口之后发现的问题必须可见（缺陷 1 场景二）')

const late1 = store.recordFact({
  task_id: t1.task_id,
  kind: 'blocker',
  statement: '收口后才发现：证书链缺中间证书，客户端会握手失败',
  child_id: 'child-v3',
}, LEAD_A)
check('B01', '★缺陷1-②：收口后落 kind=blocker **允许**，并如实标注 late=true / late_of_status=accepted',
  late1.late === true && late1.late_of_status === 'accepted' && late1.fact_id > 0
    && typeof late1.next === 'string' && late1.next.includes('重新复核'),
  JSON.stringify(late1))

const t1AfterLate = store.taskOf({ task_id: t1.task_id }, LEAD_A)
check('B02', '晚到阻塞**不自动改变结论**：任务状态仍是 accepted（不被自动推翻，也不被自动隐藏）',
  t1AfterLate.task.status === 'accepted' && t1AfterLate.blockers === 1,
  JSON.stringify({ status: t1AfterLate.task.status, blockers: t1AfterLate.blockers }))

const boardLate = store.board({}, LEAD_A)
const lateRow = boardLate.late_blockers.find((t) => t.task_id === t1.task_id)
check('B03', '★缺陷1-②：默认待办板的 late_blockers 区列出该任务 + 该条阻塞明细（不静默隐藏）',
  lateRow !== undefined && lateRow.status === 'accepted'
    && lateRow.blockers.some((b) => b.fact_id === late1.fact_id && b.statement.includes('证书链')),
  JSON.stringify(boardLate.late_blockers))
check('B04', '默认待办板给出 late_blocked_tasks 计数（=1），主会话一眼能看到有几处收口后被推翻的隐患',
  boardLate.late_blocked_tasks === 1, JSON.stringify({ n: boardLate.late_blocked_tasks }))
check('B05', '晚到任务**不进** tasks 列表（结论没被自动改写），但确实出现在 late_blockers 区（两件事不混淆）',
  boardLate.tasks.every((t) => t.id !== t1.task_id) && lateRow !== undefined,
  JSON.stringify(boardLate.tasks.map((t) => ({ id: t.id, status: t.status }))))

const detailLate = store.board({ task_id: t1.task_id }, LEAD_A)
check('B06', '详情板：task.late=true 且 late_blockers 列出该条（核对入口也能看到）',
  detailLate.task.late === true
    && detailLate.late_blockers.length === 1
    && detailLate.late_blockers[0].blockers[0].fact_id === late1.fact_id,
  JSON.stringify({ late: detailLate.task.late, late_blockers: detailLate.late_blockers }))

const statsLate = store.stats(LEAD_A)
check('B07', 'stats 把两类阻塞分开计：blockers_open（待办任务上）与 blockers_late（已收口任务上）',
  statsLate.blockers_late === 1 && statsLate.blockers_open === 0,
  JSON.stringify({ open: statsLate.blockers_open, late: statsLate.blockers_late }))

/* ══════════════ C. 验收门槛（缺陷 2） ══════════════ */

section('C. 验收门槛 —— 没有执行依据就拒绝验收（缺陷 2）')

const t2 = store.openTask({ title: '零事实验收', note: '审计复现原场景：无认领者 / 无事实 / 无产物 / 无证据' }, LEAD_A)
const submitted2 = store.submitTask({ task_id: t2.task_id }, LEAD_A)
const zeroBasis = thrownOf(() => store.acceptTask({ task_id: t2.task_id }, LEAD_A, 'lead'))
check('C01', '★缺陷2：零事实（task_open → task_submit → task_accept）验收 **被拒**，不是 warning',
  zeroBasis.threw && zeroBasis.code === 'E_EVIDENCE_MISSING'
    && zeroBasis.message.includes('没有任何执行依据') && zeroBasis.message.includes('waiver_reason'),
  JSON.stringify({ code: zeroBasis.code, message: zeroBasis.message.slice(0, 220) }))
const t2After = store.taskOf({ task_id: t2.task_id }, LEAD_A)
check('C02', '被拒后任务保持 submitted（拒绝是原子的：不留下"已验一半"的状态）',
  submitted2.status === 'submitted' && t2After.task.status === 'submitted' && t2After.fact_count === 0,
  JSON.stringify({ status: t2After.task.status, facts: t2After.fact_count }))

const t3 = store.openTask({ title: '只有决策的验收' }, LEAD_A)
store.recordFact({ task_id: t3.task_id, kind: 'decision', statement: '决定采用方案 B（决策，不是证据）', child_id: 'child-v3' }, LEAD_A)
store.submitTask({ task_id: t3.task_id }, LEAD_A)
const decisionOnly = thrownOf(() => store.acceptTask({ task_id: t3.task_id }, LEAD_A, 'lead'))
check('C03', '只有 decision 事实不算依据（决策不是证据）→ 同样被拒（E_EVIDENCE_MISSING）',
  decisionOnly.threw && decisionOnly.code === 'E_EVIDENCE_MISSING',
  JSON.stringify({ code: decisionOnly.code, message: decisionOnly.message.slice(0, 160) }))

const ev3 = store.recordFact({
  task_id: t3.task_id, kind: 'fact', statement: '实测通过：状态机回归全绿',
  evidence_path: '/tmp/v3/proof.log', evidence_line: 12, child_id: 'child-v3',
}, LEAD_A)
const accepted3 = store.acceptTask({ task_id: t3.task_id }, LEAD_A, 'lead')
check('C04', '★有真实证据（子代理 task_fact 带 evidence_path）时 accept **成功**，返回体列出被采信的依据事实',
  accepted3.status === 'accepted' && accepted3.evidence_basis.count === 1
    && accepted3.evidence_basis.fact_ids.includes(ev3.fact_id) && accepted3.evidence_basis.with_pointer === 1,
  JSON.stringify({ accepted: accepted3.status, basis: accepted3.evidence_basis }))

const t4 = store.openTask({ title: '只有阻塞与消解记录' }, LEAD_A)
const b4 = store.recordFact({ task_id: t4.task_id, kind: 'blocker', statement: '依赖缺失' }, LEAD_A)
store.recordFact({ task_id: t4.task_id, kind: 'decision', statement: '依赖已安装', resolves_fact_id: b4.fact_id }, LEAD_A)
store.submitTask({ task_id: t4.task_id }, LEAD_A)
const blockerBasis = thrownOf(() => store.acceptTask({ task_id: t4.task_id }, LEAD_A, 'lead'))
check('C05', 'blocker 与消解它的 decision 都不算依据（解掉阻塞 ≠ 有执行证据）→ 仍被拒',
  blockerBasis.threw && blockerBasis.code === 'E_EVIDENCE_MISSING',
  JSON.stringify({ code: blockerBasis.code, message: blockerBasis.message.slice(0, 160) }))

const rec3 = store.board({ task_id: t3.task_id }, LEAD_A).facts.find((f) => f.statement.startsWith('验收通过'))
check('C06', '★缺陷2：自动写入的验收记录**不是 CONFIRMED**（decision + PLAUSIBLE），evidence 字段如实为空',
  rec3 !== undefined && rec3.kind === 'decision' && rec3.confidence === 'PLAUSIBLE'
    && rec3.confidence !== 'CONFIRMED' && rec3.evidence === null,
  JSON.stringify(rec3))
check('C07', '验收记录如实注明「（无附注）」并列出被采信的依据事实 id（可复核索引，不是伪造的证据指针）',
  rec3 !== undefined && rec3.statement.includes('（无附注）')
    && rec3.statement.includes(`#${ev3.fact_id}`) && rec3.statement.includes('带产物指针 1 条'),
  JSON.stringify(rec3?.statement))

/* 人工豁免：显式、有理由、不混入已验证事实 */
{
  const t5 = store.openTask({ title: '人工豁免路径' }, LEAD_A)
  store.submitTask({ task_id: t5.task_id }, LEAD_A)
  const before = store.stats(LEAD_A).facts.by_confidence.CONFIRMED ?? 0
  const waived = store.acceptTask({
    task_id: t5.task_id, note: '本次只做可行性判断', waiver_reason: '探索性调查，确实无法产出可复核证据',
  }, LEAD_A, 'lead')
  const rec5 = store.board({ task_id: t5.task_id }, LEAD_A).facts.find((f) => f.statement.startsWith('验收通过'))
  const after = store.stats(LEAD_A).facts.by_confidence.CONFIRMED ?? 0
  check('C08', '合法人工豁免：零证据 + waiver_reason → 放行，返回体带 waiver{reason,by,at} 且 warnings 明示走了豁免',
    waived.status === 'accepted' && waived.waiver?.reason === '探索性调查，确实无法产出可复核证据'
      && waived.warnings.some((w) => w.includes('人工豁免')),
    JSON.stringify({ status: waived.status, waiver: waived.waiver, warnings: waived.warnings }))
  check('C09', '★人工豁免有明确类型与理由：验收记录标「（人工豁免）」+ 理由，且**不是** CONFIRMED（不混入已验证事实）',
    rec5 !== undefined && rec5.statement.includes('（人工豁免）')
      && rec5.statement.includes('探索性调查') && rec5.confidence !== 'CONFIRMED',
    JSON.stringify(rec5))
  check('C10', '豁免不会抬高 CONFIRMED 计数（statistics 里不出现"凭空多出的已验证事实"）',
    after === before, `before=${before} after=${after}`)
}

/* ══════════════ D. 显式重新复核 ══════════════ */

section('D. 显式重新复核 —— 推翻已收口结论的唯一通道')

const childReopen = thrownOf(() => store.rejectTask({ task_id: t1.task_id, reason: 'x' }, LEAD_A, 'child'))
check('D01', '纵深防御：actor≠lead 时终态任务的重新复核被拒（子代理不能推翻结论）',
  childReopen.threw && childReopen.message.includes('打回只能由主会话执行'), childReopen.message)

const reopened1 = store.rejectTask({
  task_id: t1.task_id, reason: '收口后出现握手失败阻塞，推翻验收结论重新处理',
}, LEAD_A, 'lead')
check('D02', '主会话 task_reject 对终态任务 = 重新复核：status→rejected、reopened=true、previous_status=accepted，并列出晚到阻塞',
  reopened1.status === 'rejected' && reopened1.reopened === true && reopened1.previous_status === 'accepted'
    && reopened1.late_blockers.length === 1 && reopened1.late_blockers[0].blockers[0].fact_id === late1.fact_id,
  JSON.stringify(reopened1))

const boardReopen = store.board({}, LEAD_A)
const reopenedRow = boardReopen.tasks.find((t) => t.id === t1.task_id)
check('D03', '★重新复核后任务**重新出现在默认待办板**（rejected 属于待办集合），阻塞计数随行走',
  reopenedRow !== undefined && reopenedRow.status === 'rejected' && reopenedRow.blockers === 1,
  JSON.stringify(boardReopen.tasks.map((t) => ({ id: t.id, status: t.status, blockers: t.blockers }))))
check('D04', '复核后 late_blockers 区清空该任务（它已回板，不再是"收口之后的隐患"）',
  boardReopen.late_blocked_tasks === 0
    && boardReopen.late_blockers.every((t) => t.task_id !== t1.task_id),
  JSON.stringify(boardReopen.late_blockers))

store.claimTask({ task_id: t1.task_id, child_id: 'child-v3' }, LEAD_A)
store.submitTask({ task_id: t1.task_id }, LEAD_A)
const stillBlocked = thrownOf(() => store.acceptTask({ task_id: t1.task_id }, LEAD_A, 'lead'))
check('D05', '复核后未解阻塞仍在 → 重新提交也不能直接验过（先解阻塞）',
  stillBlocked.threw && stillBlocked.message.includes('未解 blocker'),
  stillBlocked.message.slice(0, 200))

store.recordFact({
  task_id: t1.task_id, kind: 'decision', statement: '已补中间证书，握手恢复正常',
  resolves_fact_id: late1.fact_id, confidence: 'CONFIRMED', child_id: 'child-v3',
}, LEAD_A)
const reAccepted1 = store.acceptTask({ task_id: t1.task_id, note: '复核后重新验收' }, LEAD_A, 'lead')
check('D06', '闭环可重走：解掉晚到阻塞 → 重新验收成功 → accepted（重新复核不是死路）',
  reAccepted1.status === 'accepted' && store.taskOf({ task_id: t1.task_id }, LEAD_A).blockers === 0,
  JSON.stringify({ status: reAccepted1.status, blockers: store.taskOf({ task_id: t1.task_id }, LEAD_A).blockers }))

const openForReject = store.openTask({ title: '未提交的任务（不应可打回）' }, LEAD_A)
const rejectOpen = thrownOf(() => store.rejectTask({ task_id: openForReject.task_id, reason: 'x' }, LEAD_A, 'lead'))
check('D07', '非终态且非 submitted（open/claimed/rejected）不能"打回"：明确拒绝并说明只有 submitted 可打回、终态可复核',
  rejectOpen.threw && rejectOpen.message.includes('不能打回') && rejectOpen.message.includes('重新复核'),
  rejectOpen.message)

/* ══════════════ E. 工具层端到端（真实 handler） ══════════════ */

section('E. 工具层端到端 —— 错误码 / hint / late 标记 / 板上可见（真实 handler）')

{
  const services = new Map()
  services.set('agents', { get: (id) => AGENTS.get(id) })
  const ctxWithAgents = makeCtx(services)
  storeMod.apply(ctxWithAgents.ctx)
  toolsMod.apply(ctxWithAgents.ctx)
  const toolOf = (n) => ctxWithAgents.state.tools.find((t) => t.name === n)
  const call = async (name, args, agent) => JSON.parse(await toolOf(name).execute(args, { agent }))

  const e1 = await call('task_open', { title: '工具层：零事实验收' }, LEAD_AGENT)
  await call('task_submit', { task_id: e1.task_id }, LEAD_AGENT)
  const zeroAccept = await call('task_accept', { task_id: e1.task_id }, LEAD_AGENT)
  check('E01', '工具层：零证据 accept → ok:false + code=E_EVIDENCE_MISSING + hint 指明"先落证据 / 或写明 waiver_reason"',
    zeroAccept.ok === false && zeroAccept.code === 'E_EVIDENCE_MISSING'
      && zeroAccept.hint.includes('执行依据') && zeroAccept.hint.includes('waiver_reason'),
    JSON.stringify(zeroAccept))

  const e1Fact = await call('task_fact', {
    task_id: e1.task_id, kind: 'fact', statement: '工具层落的证据', evidence_path: '/tmp/v3/tool.log',
  }, LEAD_AGENT)
  const e1Accept = await call('task_accept', { task_id: e1.task_id, note: '核对通过' }, LEAD_AGENT)
  check('E02', '工具层：补一条带 evidence_path 的事实后验收成功，返回体带 evidence_basis 与 verified_by',
    e1Fact.ok === true && e1Accept.ok === true && e1Accept.status === 'accepted'
      && e1Accept.evidence_basis.count === 1 && String(e1Accept.verified_by).startsWith('lead:'),
    JSON.stringify(e1Accept))

  const childClose = await call('task_close', { task_id: e1.task_id, result: 'failed' }, CHILD_AGENT)
  const e1After = await call('task_board', { task_id: e1.task_id }, LEAD_AGENT)
  check('E03', '★工具层复现缺陷1-①：子代理在已验收任务上 task_close(failed) → ok:false + E_TERMINAL + hint 指路重新复核；任务仍 accepted',
    childClose.ok === false && childClose.code === 'E_TERMINAL'
      && childClose.hint.includes('重新复核') && e1After.task.status === 'accepted',
    JSON.stringify(childClose))

  const childLateFact = await call('task_fact', {
    task_id: e1.task_id, kind: 'blocker', statement: '收口后才发现：磁盘配额不足',
  }, CHILD_AGENT)
  check('E04', '★工具层复现缺陷1-②：子代理收口后落 blocker → ok:true + late=true（允许落库并如实标注，不被拒之门外）',
    childLateFact.ok === true && childLateFact.late === true && childLateFact.late_of_status === 'accepted',
    JSON.stringify(childLateFact))

  const boardE = await call('task_board', {}, LEAD_AGENT)
  const lateTasksE = boardE.late_blockers ?? []
  check('E05', '★默认看板（工具层）显示 late_blockers 区，任务在列而 tasks 列表不含它 —— 晚到阻塞不会消失',
    boardE.ok === true && boardE.late_blocked_tasks >= 1
      && lateTasksE.some((t) => t.task_id === e1.task_id && t.blockers.some((b) => b.fact_id === childLateFact.fact_id))
      && boardE.tasks.every((t) => t.id !== e1.task_id),
    JSON.stringify({ late_blocked_tasks: boardE.late_blocked_tasks, tasks: boardE.tasks.map((t) => t.id) }))

  const recheck = await call('task_reject', {
    task_id: e1.task_id, reason: '收口后发现配额阻塞，推翻验收结论',
  }, LEAD_AGENT)
  const boardAfterRecheck = await call('task_board', {}, LEAD_AGENT)
  check('E06', '工具层：主会话 task_reject = 重新复核 → ok:true + reopened=true，任务回到待办板且 late 区清空',
    recheck.ok === true && recheck.reopened === true && recheck.previous_status === 'accepted'
      && boardAfterRecheck.tasks.some((t) => t.id === e1.task_id && t.status === 'rejected')
      && boardAfterRecheck.late_blocked_tasks === 0,
    JSON.stringify(recheck))

  const e2 = await call('task_open', { title: '工具层：人工豁免' }, LEAD_AGENT)
  await call('task_submit', { task_id: e2.task_id }, LEAD_AGENT)
  const waived = await call('task_accept', {
    task_id: e2.task_id, waiver_reason: '探索性调查，确实无法产出可复核证据',
  }, LEAD_AGENT)
  const e2Detail = await call('task_board', { task_id: e2.task_id }, LEAD_AGENT)
  const waiverRecord = e2Detail.facts.find((f) => f.statement.startsWith('验收通过'))
  check('E07', '工具层：waiver_reason 透传到数据层（返回体带 waiver，记录标「人工豁免」且非 CONFIRMED）',
    waived.ok === true && waived.waiver?.reason === '探索性调查，确实无法产出可复核证据'
      && waiverRecord !== undefined && waiverRecord.statement.includes('（人工豁免）')
      && waiverRecord.confidence !== 'CONFIRMED',
    JSON.stringify({ waived, waiverRecord }))

  const e1Detail = await call('task_board', { task_id: e1.task_id }, LEAD_AGENT)
  const e1Record = e1Detail.facts.find((f) => f.statement.startsWith('验收通过'))
  check('E08', '★缺陷2 工具层：正常路径的验收记录也不是 CONFIRMED，evidence 如实为空',
    e1Record !== undefined && e1Record.kind === 'decision' && e1Record.confidence === 'PLAUSIBLE'
      && e1Record.evidence === null,
    JSON.stringify(e1Record))

  const childAcceptTerminal = await call('task_accept', { task_id: e1.task_id }, CHILD_AGENT)
  check('E09', '权限不变：子代理调 task_accept 仍被拒（E_NOT_LEAD），身份判据先于门槛判定',
    childAcceptTerminal.ok === false && childAcceptTerminal.code === 'E_NOT_LEAD',
    JSON.stringify(childAcceptTerminal))

  for (const d of ctxWithAgents.state.disposers) d()
}

store.close()

/* ══════════════ F. 卫生 ══════════════ */

section('F. 卫生')
check('F01', '整个自测没有写脏真实库（' + REAL_DB + '）',
  existsSync(REAL_DB) === realDbBefore, `before=${realDbBefore} after=${existsSync(REAL_DB)}`)

/* ─────────────────────────── 报告 ─────────────────────────── */

const passed = rows.filter((r) => r.ok).length
console.log('\n══════════ 结果 ══════════')
console.log(`断言：${passed} PASS / ${failed} FAIL（共 ${rows.length} 条）`)
console.log(`临时目录：${TMP}${KEEP ? '（--keep：保留）' : '（将清理）'}`)
if (!KEEP) rmSync(TMP, { recursive: true, force: true })
console.log(`退出码：${failed === 0 ? 0 : 1}`)
process.exit(failed === 0 ? 0 : 1)
