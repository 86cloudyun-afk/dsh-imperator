#!/usr/bin/env node
/**
 * 事实库 v2 自测：**工作实例隔离（run）** 与 **提交/验收分离** 的闭环验证。
 *
 * 跑法：`node tools/verify-store-v2.mjs`（任意 cwd；`--keep` 保留临时目录）
 *
 * 它覆盖六组：
 *   A. 两个不同 run 的任务互不可见；A run 不能 accept/reject/close/submit/claim B run 的任务
 *   B. 提交/验收状态机：submitted 仍在默认看板、未解 blocker 拒绝验收、close 不产生 accepted
 *   C. 工具层身份推导：主会话 = 自身 sessionId、子代理 = 根会话 id、子代理不能 accept、
 *      身份链断时**拒绝服务**（不放宽隔离）；
 *      C24–C28：跨 run 的**读 / 落事实 / close** 三条路径在工具层回**具名码** `E_CROSS_RUN`
 *      （此前是 `code: null`）、文案保留、失败后数据不变，且子代理平面的 `E_CHILD_NOT_OWN` 不受影响
 *   D. 旧库（无 run_id 列）自动迁移且不丢数据；旧行按「未归属」处理
 *   E. 范围命名：stats(runId) 只算本 run，跨 run 必须显式 statsAllRuns()
 *   F. 卫生：本自测不碰真实库
 *
 * 与 `verify-store.mjs`（P2 既有自测）的关系：那份测的是列/闭环/编译等价，
 * 这份测的是**隔离与权限**。两份都必须通过。
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

const TMP = mkdtempSync(join(tmpdir(), 'taskforce-v2-'))
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

function thrownOf(fn) {
  try {
    const value = fn()
    return { threw: false, message: '', value }
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) }
  }
}

async function thrownAsyncOf(fn) {
  try {
    const value = await fn()
    return { threw: false, message: '', value }
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) }
  }
}

function hashTree(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) hashTree(full, base, acc)
    else acc.push(`${full.slice(base.length + 1)} ${createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)}`)
  }
  return acc
}

console.log('══════════ 事实库 v2 自测（run 隔离 + 提交/验收分离）══════════')
console.log(`临时根        ${TMP}`)
console.log(`被测源码      ${SRC_LIB}`)
console.log(`源码指纹      ${hashTree(SRC_LIB).join('  |  ')}`)
console.log(`DSH_HOME      ${process.env.DSH_HOME}`)

const storeMod = await import(new URL('../lib/store/index.js', import.meta.url).href)
const toolsMod = await import(new URL('../lib/tools/index.js', import.meta.url).href)

/* ─────────────────────────── 测试骨架 ─────────────────────────── */

/** 假 ctx：只实现本插件用到的四个面（logger / effect / provide / get / tools）。 */
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

const LEAD_A = 'sess-lead-a'
const LEAD_B = 'sess-lead-b'
const CHILD = 'sess-child-1'
const GRAND = 'sess-grand-1'
const ORPHAN = 'sess-orphan-1'
const LOST2 = 'sess-lost2-1'
/** depth=1 且父不在活动表时，父 id 就是 run（见 deriveIdentity 的深度推论）。 */
const GONE_ROOT = 'sess-gone'

const AGENTS = new Map([
  [LEAD_A, fakeAgent(LEAD_A)],
  [LEAD_B, fakeAgent(LEAD_B)],
  [CHILD, fakeAgent(CHILD, { parentSession: LEAD_A, origin: 'subagent', delegationDepth: 1 }, { subagentDepth: 1 })],
  [GRAND, fakeAgent(GRAND, { parentSession: CHILD, origin: 'subagent', delegationDepth: 2 }, { subagentDepth: 2 })],
  // ORPHAN：depth=1 但父会话不在活动表（主会话重启过）⇒ 可安全推到父。
  [ORPHAN, fakeAgent(ORPHAN, { parentSession: GONE_ROOT, origin: 'subagent', delegationDepth: 1 }, { subagentDepth: 1 })],
  // LOST2：depth=2 且中间层不在活动表 ⇒ 无法断定祖先是根，必须拒绝。
  [LOST2, fakeAgent(LOST2, { parentSession: 'sess-mid-gone', origin: 'subagent', delegationDepth: 2 }, { subagentDepth: 2 })],
])

const LEAD_AGENT = AGENTS.get(LEAD_A)
const LEAD_B_AGENT = AGENTS.get(LEAD_B)
const CHILD_AGENT = AGENTS.get(CHILD)
const GRAND_AGENT = AGENTS.get(GRAND)
const ORPHAN_AGENT = AGENTS.get(ORPHAN)
const LOST2_AGENT = AGENTS.get(LOST2)

/* ══════════════ A. run 隔离（store 层） ══════════════ */

section('A. 工作实例（run）隔离 —— store 层')
{
  const arenaDir = join(TMP, 'arena')
  const store = new storeMod.TaskforceStore(arenaDir)
  store.open()

  const a1 = store.openTask({ title: 'A-run 的任务', note: 'run=A' }, LEAD_A)
  const a2 = store.openTask({ title: 'A-run 的第二个任务' }, LEAD_A)
  const b1 = store.openTask({ title: 'B-run 的任务' }, LEAD_B)

  check('A01', 'openTask 把 run 归属写进行（run_id = 调用者的 run）',
    a1.run_id === LEAD_A && b1.run_id === LEAD_B, JSON.stringify({ a1, b1 }))

  const boardA = store.board({}, LEAD_A)
  const boardB = store.board({}, LEAD_B)
  check('A02', 'A run 的看板只含 A run 的任务（互不可见）',
    boardA.open_tasks === 2 && boardA.tasks.every((t) => [a1.task_id, a2.task_id].includes(t.id))
      && boardA.run_id === LEAD_A,
    JSON.stringify({ a: boardA.tasks.map((t) => t.id), b: boardB.tasks.map((t) => t.id) }))
  check('A03', 'B run 的看板只含 B run 的任务（互不可见）',
    boardB.open_tasks === 1 && boardB.tasks[0].id === b1.task_id && boardB.run_id === LEAD_B,
    JSON.stringify(boardB.tasks.map((t) => t.id)))

  const unassignedBoard = store.board()
  check('A04', '无 run 参数 = 未归属域，**不是**全部：run 域任务一个都不出现',
    unassignedBoard.open_tasks === 0 && unassignedBoard.tasks.length === 0,
    JSON.stringify(unassignedBoard.tasks.map((t) => t.id)))

  const crossRead = thrownOf(() => store.taskOf({ task_id: a1.task_id }, LEAD_B))
  check('A05', 'B run 读 A run 任务详情被拒（可读错误，点明跨 run）',
    crossRead.threw && crossRead.message.includes('属于') && crossRead.message.includes('隔离'),
    crossRead.message)

  const crossClaim = thrownOf(() => store.claimTask({ task_id: a1.task_id, child_id: 'child-x' }, LEAD_B))
  check('A06', 'B run claim A run 任务被拒',
    crossClaim.threw && crossClaim.message.includes('隔离'), crossClaim.message)

  store.submitTask({ task_id: a1.task_id }, LEAD_A)
  const crossAccept = thrownOf(() => store.acceptTask({ task_id: a1.task_id }, LEAD_B, 'lead'))
  const crossReject = thrownOf(() => store.rejectTask({ task_id: a1.task_id, reason: 'x' }, LEAD_B, 'lead'))
  check('A07', 'B run accept A run 任务被拒（跨 run 明确拒绝）',
    crossAccept.threw && crossAccept.message.includes('隔离'), crossAccept.message)
  check('A08', 'B run reject A run 任务被拒',
    crossReject.threw && crossReject.message.includes('隔离'), crossReject.message)

  {
    // 一个"存在但不是本 run"的 task_id 与一个"根本不存在"的 task_id，错误必须不同。
    const absent = thrownOf(() => store.taskOf({ task_id: 99999 }, LEAD_B))
    check('A09', '「跨 run」与「不存在」给不同错误（不静默返回空）',
      absent.threw && absent.message.includes('不存在') && !absent.message.includes('隔离'),
      absent.message)
  }

  const crossClose = thrownOf(() => store.closeTask({ task_id: a2.task_id, result: 'done' }, LEAD_B))
  const crossSubmit = thrownOf(() => store.submitTask({ task_id: a2.task_id }, LEAD_B))
  const crossFact = thrownOf(() => store.recordFact({ task_id: a2.task_id, kind: 'fact', statement: 'x' }, LEAD_B))
  const crossHandoff = thrownOf(() => store.recordHandoff(
    { task_id: a2.task_id, from_child: 'a', to_child: 'b', note: 'n' }, LEAD_B))
  check('A10', 'B run 对 A run 任务的 close/submit/fact/handoff 全部被拒',
    crossClose.threw && crossSubmit.threw && crossFact.threw && crossHandoff.threw,
    [crossClose.message, crossSubmit.message, crossFact.message, crossHandoff.message].join(' || '))

  const aFacts = store.recordFact({ task_id: a1.task_id, kind: 'fact', statement: 'A-ONLY-事实串' }, LEAD_A)
  const bBytes = JSON.stringify(store.board({ task_id: b1.task_id }, LEAD_B))
  const aBytes = JSON.stringify(store.board({ task_id: a1.task_id }, LEAD_A))
  check('A11', 'B run 的任务详情里读不到 A run 的事实内容',
    !bBytes.includes('A-ONLY-事实串') && aBytes.includes('A-ONLY-事实串'),
    `B=${bBytes.slice(0, 200)} | A包含=${aBytes.includes('A-ONLY-事实串')}`)

  /* ───────── B. 提交 / 验收分离 ───────── */

  section('B. 提交 / 验收分离 —— store 层')

  const submittedBoard = store.board({}, LEAD_A)
  const submittedRow = submittedBoard.tasks.find((t) => t.id === a1.task_id)
  check('B01', 'submitted 的任务**仍在**默认看板里（主会话的待办来源）',
    submittedRow !== undefined && submittedRow.status === 'submitted' && submittedBoard.submitted_tasks === 1,
    JSON.stringify({ status: submittedRow?.status, submitted_tasks: submittedBoard.submitted_tasks }))

  const childAccept = thrownOf(() => store.acceptTask({ task_id: a1.task_id }, LEAD_A, 'child'))
  check('B02', 'store 层纵深防御：actor≠lead 时 accept 被拒',
    childAccept.threw && childAccept.message.includes('验收只能由主会话执行'), childAccept.message)

  const blocked = store.recordFact(
    { task_id: a1.task_id, kind: 'blocker', statement: '等上层确认 DDL 是否需要 WAL' }, LEAD_A)
  const acceptBlocked = thrownOf(() => store.acceptTask({ task_id: a1.task_id }, LEAD_A, 'lead'))
  check('B03', '存在未解 blocker 时 accept **被拒**（不是 warning），错误里列出 blocker 的 fact_id',
    acceptBlocked.threw && acceptBlocked.message.includes('未解 blocker')
      && acceptBlocked.message.includes(`#${blocked.fact_id}`) && acceptBlocked.message.includes('resolves_fact_id'),
    acceptBlocked.message)

  const resolved = store.recordFact({
    task_id: a1.task_id,
    kind: 'decision',
    statement: '确认不需要 WAL，默认 journal 即可',
    resolves_fact_id: blocked.fact_id,
    confidence: 'CONFIRMED',
  }, LEAD_A)
  const accepted = store.acceptTask({ task_id: a1.task_id, note: '核对了证据' }, LEAD_A, 'lead')
  check('B04', '解掉 blocker（decision + resolves_fact_id）后 accept 成功 → accepted',
    resolved.resolves_fact_id === blocked.fact_id && accepted.status === 'accepted',
    JSON.stringify({ resolved, accepted }))

  const boardAfterAccept = store.board({}, LEAD_A)
  check('B05', 'accepted 的任务从默认看板消失',
    boardAfterAccept.tasks.every((t) => t.id !== a1.task_id),
    JSON.stringify(boardAfterAccept.tasks.map((t) => ({ id: t.id, status: t.status }))))

  const reAccept = thrownOf(() => store.acceptTask({ task_id: a1.task_id }, LEAD_A, 'lead'))
  check('B06', '重复 accept 被拒（只能验一次）',
    reAccept.threw && reAccept.message.includes('submitted'), reAccept.message)

  const skipSubmit = thrownOf(() => store.acceptTask({ task_id: a2.task_id }, LEAD_A, 'lead'))
  check('B07', '跳过提交直接 accept 被拒（a2 还是 open）',
    skipSubmit.threw && skipSubmit.message.includes('status=open'), skipSubmit.message)

  const closeDone = store.closeTask({ task_id: a2.task_id, result: 'done' }, LEAD_A)
  check('B08', 'task_close(done) 只产生 submitted，**不产生 accepted**',
    closeDone.status === 'submitted' && closeDone.alias_of === 'submitTask'
      && store.taskOf({ task_id: a2.task_id }, LEAD_A).task.status === 'submitted',
    JSON.stringify(closeDone))

  const a3 = store.openTask({ title: 'A-run 的第三任务' }, LEAD_A)
  const closeFailed = store.closeTask({ task_id: a3.task_id, result: 'failed' }, LEAD_A)
  check('B09', 'task_close(failed) → cancelled（主动放弃，不可再验收）',
    closeFailed.status === 'cancelled' && closeFailed.mapped_status.includes('cancelled'),
    JSON.stringify(closeFailed))

  const badReason = thrownOf(() => store.rejectTask({ task_id: a2.task_id }, LEAD_A, 'lead'))
  check('B10', 'reject 缺 reason 被拒（reason 必填）',
    badReason.threw && badReason.message.includes('reason 必填'), badReason.message)

  const rejected = store.rejectTask({ task_id: a2.task_id, reason: '缺证据行号' }, LEAD_A, 'lead')
  const boardRejected = store.board({}, LEAD_A)
  const rejectedRow = boardRejected.tasks.find((t) => t.id === a2.task_id)
  check('B11', '打回后 rejected 仍在默认看板（等子代理重做），且打回不制造 blocker',
    rejected.status === 'rejected' && rejectedRow !== undefined
      && rejectedRow.status === 'rejected' && rejectedRow.blockers === 0,
    JSON.stringify({ rejected, blockers: rejectedRow?.blockers }))

  store.claimTask({ task_id: a2.task_id, child_id: 'child-a' }, LEAD_A)
  // v3 验收门槛（补夹具，非放宽断言）：重做后的任务同样要有执行依据 ——
  // 真实流程里"补齐证据"就是补一条带产物指针的事实，这里如实落一条。
  const reworkEvidence = store.recordFact({
    task_id: a2.task_id,
    kind: 'fact',
    statement: '重做后补的证据行号',
    evidence_path: '/tmp/v2-rework/run.log',
    evidence_line: 88,
    child_id: 'child-a',
  }, LEAD_A)
  const resubmitted = store.submitTask({ task_id: a2.task_id, note: '补齐证据行号' }, LEAD_A)
  const reAccepted = store.acceptTask({ task_id: a2.task_id }, LEAD_A, 'lead')
  check('B12', '打回 → 重认领 → 补证据 → 重新提交 → 验收通过（闭环可走通）',
    resubmitted.status === 'submitted' && reAccepted.status === 'accepted'
      && reworkEvidence.fact_id > 0
      && store.board({}, LEAD_A).tasks.every((t) => t.id !== a2.task_id),
    JSON.stringify({ resubmitted: resubmitted.status, reAccepted: reAccepted.status }))

  const dupSubmit = thrownOf(() => store.submitTask({ task_id: a2.task_id }, LEAD_A))
  check('B13', '已 accepted 的任务不能再提交（状态机单向）',
    dupSubmit.threw && dupSubmit.message.includes('不能提交验收'), dupSubmit.message)

  /* ───────── E. 范围命名 ───────── */

  section('E. 范围命名：默认只看本 run，跨 run 必须显式')

  const statsA = store.stats(LEAD_A)
  const statsB = store.stats(LEAD_B)
  const statsUnassigned = store.stats()
  const statsAll = store.statsAllRuns()
  check('E01', 'stats(runId) 只算本 run（A=3 任务，B=1 任务，互不串）',
    statsA.tasks.total === 3 && statsB.tasks.total === 1
      && statsA.tasks.accepted === 2 && statsB.tasks.accepted === 0,
    JSON.stringify({ a: statsA.tasks, b: statsB.tasks }))
  check('E02', 'statsAllRuns() 是显式命名的跨 run 视图（≥ 各 run 之和 + 未归属）',
    statsAll.scope === 'all_runs' && statsAll.tasks.total >= statsA.tasks.total + statsB.tasks.total,
    JSON.stringify({ all: statsAll.tasks.total, a: statsA.tasks.total, b: statsB.tasks.total }))
  check('E03', 'stats() 无参 = 未归属域（不是全局）',
    statsUnassigned.run_id === null && statsUnassigned.tasks.total === 0,
    JSON.stringify(statsUnassigned))
  check('E04', 'statsAllRuns() 带 unassigned 明细（未归属行数可查）',
    statsAll.unassigned !== undefined && typeof statsAll.unassigned.task === 'number',
    JSON.stringify(statsAll.unassigned))

  store.close()

  /* ───────── D. 迁移（旧库无 run_id 列） ───────── */

  section('D. 旧库自动迁移（无 run_id 列）')

  const legacyRoot = join(TMP, 'legacy')
  mkdirSync(legacyRoot, { recursive: true })
  const legacyPath = join(legacyRoot, 'taskforce.db')
  {
    // 手工造一个**旧版**库：列清单 = 迁移前的 DDL，且带存量数据。
    const old = new DatabaseSync(legacyPath)
    old.exec(`
      CREATE TABLE task (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT,
        status TEXT NOT NULL DEFAULT 'open', owner TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE fact (
        id INTEGER PRIMARY KEY, task_id INTEGER, kind TEXT NOT NULL, statement TEXT NOT NULL,
        evidence_path TEXT, evidence_line INTEGER, confidence TEXT NOT NULL,
        created_by TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_fact_task_id ON fact (task_id, id);
      CREATE TABLE handoff (
        id INTEGER PRIMARY KEY, task_id INTEGER, from_child TEXT, to_child TEXT,
        note TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_handoff_task_id ON handoff (task_id, id);
    `)
    old.exec("INSERT INTO task (title, note, status, owner, created_at, updated_at) VALUES ('旧任务一', 'legacy note', 'open', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
    old.exec("INSERT INTO task (title, note, status, owner, created_at, updated_at) VALUES ('旧任务二', NULL, 'claimed', 'child-old', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')")
    old.exec("INSERT INTO fact (task_id, kind, statement, confidence, created_by, created_at) VALUES (1, 'fact', '旧事实', 'CONFIRMED', 'child-old', '2026-01-03T00:00:00.000Z')")
    old.exec("INSERT INTO handoff (task_id, from_child, to_child, note, created_at) VALUES (1, 'a', 'b', '旧交接', '2026-01-04T00:00:00.000Z')")
    old.close()
  }

  const legacyColsBefore = (() => {
    const probe = new DatabaseSync(legacyPath)
    const cols = probe.prepare('PRAGMA table_info(task)').all().map((r) => r.name)
    probe.close()
    return cols
  })()

  const legacy = new storeMod.TaskforceStore(legacyRoot)
  const opened = thrownOf(() => legacy.open())
  check('D01', '旧库（task 无 run_id 列）能被 open() 打开并自动迁移，不抛错',
    !opened.threw && !legacyColsBefore.includes('run_id'),
    `before=${legacyColsBefore.join(',')} throw=${opened.message}`)

  const legacyCols = (() => {
    const probe = new DatabaseSync(legacyPath)
    const cols = {
      task: probe.prepare('PRAGMA table_info(task)').all().map((r) => r.name),
      fact: probe.prepare('PRAGMA table_info(fact)').all().map((r) => r.name),
      handoff: probe.prepare('PRAGMA table_info(handoff)').all().map((r) => r.name),
    }
    probe.close()
    return cols
  })()
  check('D02', '迁移补出 task.run_id / fact.run_id / fact.resolves_fact_id / handoff.run_id',
    legacyCols.task.includes('run_id') && legacyCols.fact.includes('run_id')
      && legacyCols.fact.includes('resolves_fact_id') && legacyCols.handoff.includes('run_id'),
    JSON.stringify(legacyCols))
  check('D03', '迁移是 ADD COLUMN：只加列，原有列一个不少',
    ['id', 'title', 'note', 'status', 'owner', 'created_at', 'updated_at'].every((c) => legacyCols.task.includes(c)),
    legacyCols.task.join(','))

  const legacyCounts = (() => {
    const probe = new DatabaseSync(legacyPath)
    const counts = {
      task: probe.prepare('SELECT COUNT(*) AS n FROM task').get().n,
      fact: probe.prepare('SELECT COUNT(*) AS n FROM fact').get().n,
      handoff: probe.prepare('SELECT COUNT(*) AS n FROM handoff').get().n,
      nullRun: probe.prepare('SELECT COUNT(*) AS n FROM task WHERE run_id IS NULL').get().n,
      title: probe.prepare('SELECT title FROM task WHERE id = 1').get().title,
    }
    probe.close()
    return counts
  })()
  check('D04', '旧数据一条不丢（task=2 / fact=1 / handoff=1），内容原样',
    legacyCounts.task === 2 && legacyCounts.fact === 1 && legacyCounts.handoff === 1
      && legacyCounts.title === '旧任务一',
    JSON.stringify(legacyCounts))
  check('D05', '旧行 run_id 为 NULL = 未归属（不是被塞进某个 run）',
    legacyCounts.nullRun === 2, JSON.stringify(legacyCounts))

  const legacyBoardAnyRun = legacy.board({}, LEAD_A)
  const legacyBoardUnassigned = legacy.board()
  check('D06', '未归属行不出现在任何 run 的看板里',
    legacyBoardAnyRun.open_tasks === 0 && legacyBoardAnyRun.tasks.length === 0,
    JSON.stringify(legacyBoardAnyRun.tasks.map((t) => t.id)))
  check('D07', '未归属行在未归属域视图里可见（旧数据没被"迁移丢")',
    legacyBoardUnassigned.open_tasks === 2
      && legacyBoardUnassigned.tasks.map((t) => t.title).sort().join(',') === '旧任务一,旧任务二',
    JSON.stringify(legacyBoardUnassigned.tasks.map((t) => t.title)))

  const orphanSummary = legacy.unassignedSummary()
  check('D08', 'unassignedSummary() 报出未归属行数（诊断可读）',
    orphanSummary.task === 2 && orphanSummary.fact === 1 && orphanSummary.handoff === 1,
    JSON.stringify(orphanSummary))

  const adopted = legacy.adoptUnassigned(LEAD_A)
  const legacyBoardAfterAdopt = legacy.board({}, LEAD_A)
  check('D09', 'adoptUnassigned(runId) 显式接管后旧数据进入该 run 视图',
    adopted.tasks === 2 && adopted.facts === 1 && adopted.handoffs === 1
      && legacyBoardAfterAdopt.open_tasks === 2,
    JSON.stringify({ adopted, open: legacyBoardAfterAdopt.open_tasks }))

  const adoptNull = thrownOf(() => legacy.adoptUnassigned(null))
  check('D10', 'adoptUnassigned(null) 被拒（接管到"未归属"没有意义）',
    adoptNull.threw && adoptNull.message.includes('具体'), adoptNull.message)

  const reopen = thrownOf(() => legacy.migrate(legacy.open()))
  check('D11', '迁移幂等：重复执行不再加列、不报错',
    !reopen.threw && legacy.migration.added_columns.length === 0
      && legacy.migration.unassigned.task === 0,
    JSON.stringify(legacy.migration))

  legacy.close()
}

/* ══════════════ C. 工具层身份与权限 ══════════════ */

section('C. 工具层：身份推导与提交/验收权限')

const main = makeCtx()
{
  const services = new Map()
  services.set('agents', { get: (id) => AGENTS.get(id) })
  // 子代理平面最小夹具：目录为空 = 「这个 id 不是本会话派出的」。
  // 只用于在**同一份报告**里证明 `E_CHILD_NOT_OWN` 仍然活着、且没有被 `E_CROSS_RUN` 顶掉（C28）。
  services.set('subagents', {
    listChildren: async () => [],
    sendMessage: async () => 'msg-stub',
    interrupt: () => {},
  })
  const ctxWithAgents = makeCtx(services)
  storeMod.apply(ctxWithAgents.ctx)
  toolsMod.apply(ctxWithAgents.ctx)
  const toolOf = (n) => ctxWithAgents.state.tools.find((t) => t.name === n)
  const call = async (name, args, agent) => JSON.parse(await toolOf(name).execute(args, { agent }))

  // 2026-09-29 定向更新（非放宽）：本包新增两个子代理控制工具 task_child_send / task_child_stop。
  // 既有 8 个工具一个都没改名/删除，所以期望集合由 8 扩到 10；下方对 submit/accept/reject
  // 仍是逐个显式点名，漏注册任何一个照样 FAIL。
  check('C01', 'agent 平面注册 10 个模型可见工具（含 task_submit / task_accept / task_reject）',
    ctxWithAgents.state.tools.length === 10
      && ['task_submit', 'task_accept', 'task_reject'].every((n) => toolOf(n) !== undefined)
      && ['task_child_send', 'task_child_stop'].every((n) => toolOf(n) !== undefined),
    `实际=${ctxWithAgents.state.tools.map((t) => t.name).sort().join(',')}`)

  const leadOpen = await call('task_open', { title: '主会话 A 的任务' }, LEAD_AGENT)
  check('C02', '主会话开的任务归属 = 自身 sessionId',
    leadOpen.ok === true && leadOpen.run_id === LEAD_A && leadOpen.claimer === 'lead', JSON.stringify(leadOpen))

  const childBoardSeesIt = await call('task_board', {}, CHILD_AGENT)
  check('C03', '子代理与主会话共享同一 run（同树可见）',
    childBoardSeesIt.ok === true && childBoardSeesIt.tasks.some((t) => t.id === leadOpen.task_id)
      && childBoardSeesIt.run_id === LEAD_A,
    JSON.stringify({ run: childBoardSeesIt.run_id, ids: childBoardSeesIt.tasks.map((t) => t.id) }))

  const grandBoard = await call('task_board', {}, GRAND_AGENT)
  check('C04', '孙代理上溯两跳也归到**根会话**的 run（同一棵树一个 run）',
    grandBoard.ok === true && grandBoard.run_id === LEAD_A, JSON.stringify({ run: grandBoard.run_id }))

  const otherLeadBoard = await call('task_board', {}, LEAD_B_AGENT)
  check('C05', '另一个主会话看不到第一个主会话的任务（工具层也隔离）',
    otherLeadBoard.ok === true && otherLeadBoard.tasks.length === 0 && otherLeadBoard.run_id === LEAD_B,
    JSON.stringify({ run: otherLeadBoard.run_id, ids: otherLeadBoard.tasks.map((t) => t.id) }))

  const otherLeadDetail = await call('task_board', { task_id: leadOpen.task_id }, LEAD_B_AGENT)
  check('C06', '另一个主会话读不到别的 run 的任务详情（明确拒绝，不返回空）',
    otherLeadDetail.ok === false && otherLeadDetail.error.includes('隔离'),
    JSON.stringify(otherLeadDetail))

  /* 子代理全流程 + 权限边界 */
  const claim = await call('task_claim', { task_id: leadOpen.task_id, child_id: 'child-1' }, CHILD_AGENT)
  const fact = await call('task_fact', {
    task_id: leadOpen.task_id, kind: 'fact', statement: '子代理落的一条事实', evidence_path: '/tmp/v2.log',
  }, CHILD_AGENT)
  const childAccept = await call('task_accept', { task_id: leadOpen.task_id }, CHILD_AGENT)
  check('C07', '子代理 task_accept 被拒，且错误可读（code=E_NOT_LEAD，hint 指向提交/验收分离）',
    childAccept.ok === false && childAccept.code === 'E_NOT_LEAD'
      && childAccept.error.includes('只有主会话能调') && childAccept.hint.includes('提交与验收'),
    JSON.stringify(childAccept))

  const childReject = await call('task_reject', { task_id: leadOpen.task_id, reason: 'x' }, CHILD_AGENT)
  check('C08', '子代理 task_reject 同样被拒（身份判据，不靠提示词）',
    childReject.ok === false && childReject.code === 'E_NOT_LEAD', JSON.stringify(childReject))

  const submit = await call('task_submit', { task_id: leadOpen.task_id, note: '都做完了' }, CHILD_AGENT)
  check('C09', '子代理 task_submit 成功 → submitted（执行者的终点）',
    submit.ok === true && submit.status === 'submitted', JSON.stringify(submit))

  const boardWithSubmitted = await call('task_board', {}, LEAD_AGENT)
  check('C10', '提交后仍在主会话默认看板里，且 submitted_tasks 计数 = 1',
    boardWithSubmitted.ok === true && boardWithSubmitted.submitted_tasks === 1
      && boardWithSubmitted.can_accept === true,
    JSON.stringify({ submitted: boardWithSubmitted.submitted_tasks, can_accept: boardWithSubmitted.can_accept }))
  check('C11', '主会话看板带 can_accept=true；子代理看板带 can_accept=false（权限可见）',
    childBoardSeesIt.can_accept === false, JSON.stringify({ child: childBoardSeesIt.can_accept }))

  const leadAccept = await call('task_accept', { task_id: leadOpen.task_id, note: '核对通过' }, LEAD_AGENT)
  check('C12', '主会话 task_accept 成功 → accepted（全流程闭环）',
    leadAccept.ok === true && leadAccept.status === 'accepted' && claim.ok === true && fact.ok === true,
    JSON.stringify(leadAccept))

  const boardAfter = await call('task_board', {}, LEAD_AGENT)
  check('C13', '验收后任务从默认看板消失（看板只剩待办）',
    boardAfter.ok === true && boardAfter.tasks.every((t) => t.id !== leadOpen.task_id)
      && boardAfter.submitted_tasks === 0,
    JSON.stringify(boardAfter.tasks.map((t) => ({ id: t.id, status: t.status }))))

  /* 未解 blocker 的端到端拒绝 */
  const t2 = await call('task_open', { title: '带阻塞的任务' }, LEAD_AGENT)
  await call('task_fact', { task_id: t2.task_id, kind: 'blocker', statement: '磁盘只剩 2G' }, CHILD_AGENT)
  await call('task_submit', { task_id: t2.task_id }, CHILD_AGENT)
  const blockedAccept = await call('task_accept', { task_id: t2.task_id }, LEAD_AGENT)
  check('C14', '端到端：未解 blocker 时主会话 task_accept 被拒（可读错误）',
    blockedAccept.ok === false && blockedAccept.error.includes('未解 blocker'), JSON.stringify(blockedAccept))

  const blockerFactId = (await call('task_board', { task_id: t2.task_id }, LEAD_AGENT))
    .facts.find((f) => f.kind === 'blocker').id
  await call('task_fact', {
    task_id: t2.task_id, kind: 'decision', statement: '已扩容到 20G', resolves_fact_id: blockerFactId,
  }, CHILD_AGENT)
  // v3 验收门槛（补夹具，非放宽断言）：解掉阻塞 ≠ 有执行依据，验收仍要求一条证据事实。
  await call('task_fact', {
    task_id: t2.task_id, kind: 'fact', statement: '扩容后 /data 可用 19G',
    evidence_path: '/tmp/v2-df.log', evidence_line: 3,
  }, CHILD_AGENT)
  const unblockedAccept = await call('task_accept', { task_id: t2.task_id }, LEAD_AGENT)
  check('C15', '端到端：解掉 blocker 后同一任务可以验收',
    unblockedAccept.ok === true && unblockedAccept.status === 'accepted', JSON.stringify(unblockedAccept))

  /* 身份失败方向：宁可拒绝，也不串 run */
  const orphanCall = await call('task_board', {}, ORPHAN_AGENT)
  check('C16', 'depth=1 且父不在活动表 → 安全推到父 id 当 run（delegationDepth 语义：父必然 depth=0）',
    orphanCall.ok === true && orphanCall.run_id === GONE_ROOT,
    JSON.stringify({ run: orphanCall.run_id, error: orphanCall.error }))

  const lost2Call = await call('task_board', {}, LOST2_AGENT)
  check('C17', 'depth>1 且中间层缺失 → **拒绝服务**（无法断定祖先是根，不放宽隔离）',
    lost2Call.ok === false && lost2Call.code === 'E_BROKEN_CHAIN'
      && lost2Call.error.includes('上溯') && lost2Call.hint.includes('身份不可得'),
    JSON.stringify(lost2Call))

  const noAgentCall = JSON.parse(await toolOf('task_board').execute({}, {}))
  check('C18', 'exec 无 agent → 拒绝服务（E_NO_AGENT）',
    noAgentCall.ok === false && noAgentCall.code === 'E_NO_AGENT', JSON.stringify(noAgentCall))

  const noAgentOpen = JSON.parse(await toolOf('task_open').execute({ title: 'x' }, {}))
  check('C19', '身份不可得时**写操作同样被拒**（不落到未归属域兜底）',
    noAgentOpen.ok === false && noAgentOpen.code === 'E_NO_AGENT', JSON.stringify(noAgentOpen))

  /* ── C24–C28：跨 run 三条路径的**具名码**要透传到工具层（第六轮复审回归，非阻断项） ──
     跨 run 归属检查是**一个公共拒绝点**（数据层 `#scopedTask`，读 / 落事实 / 结任务共用），
     此前该分支抛普通 Error ⇒ 工具层只能回 `code: null`，模型分不清「隔离边界」与「参数抄错」。
     这里只验三层：**码 / 文案 / 失败后行为不变**（不把"源码里出现过这个字符串"当验收）。 */

  const probe = await call('task_open', {
    title: '跨 run 探针任务（工具层）', note: '本任务只用于被另一个 run 拒绝',
  }, LEAD_AGENT)
  const probeBefore = await call('task_board', { task_id: probe.task_id }, LEAD_AGENT)
  const PROBE_STATEMENT = 'CROSS-RUN-探针事实串（不应落库）'

  const crossReadTool = await call('task_board', { task_id: probe.task_id }, LEAD_B_AGENT)
  const crossWriteTool = await call('task_fact', {
    task_id: probe.task_id, kind: 'fact', statement: PROBE_STATEMENT, evidence_path: '/tmp/v2-cross-run.log',
  }, LEAD_B_AGENT)
  const crossCloseTool = await call('task_close', { task_id: probe.task_id, result: 'done' }, LEAD_B_AGENT)

  check('C24', '跨 run **读**（B run 带 A run 的 task_id）：ok:false + code=E_CROSS_RUN（不再是 null）+ 专属 hint',
    crossReadTool.ok === false && crossReadTool.code === 'E_CROSS_RUN'
      && typeof crossReadTool.hint === 'string'
      && !crossReadTool.hint.includes('参数或对象标识有问题'),
    JSON.stringify(crossReadTool))

  check('C25', '跨 run **写（task_fact 落事实）**与 **task_close 结任务**：同一个具名码 E_CROSS_RUN 透传到工具层',
    crossWriteTool.ok === false && crossWriteTool.code === 'E_CROSS_RUN'
      && crossCloseTool.ok === false && crossCloseTool.code === 'E_CROSS_RUN',
    JSON.stringify({ write: crossWriteTool.code, close: crossCloseTool.code,
      writeErr: crossWriteTool.error?.slice(0, 120), closeErr: crossCloseTool.error?.slice(0, 120) }))

  check('C26', '跨 run 拒绝的可读文案保留：三条路径都点名**双方 run**、"隔离"，且不与"不存在"混淆',
    [crossReadTool, crossWriteTool, crossCloseTool].every((r) => typeof r.error === 'string'
      && r.error.includes('属于') && r.error.includes(`run "${LEAD_A}"`) && r.error.includes(`run "${LEAD_B}"`)
      && r.error.includes('隔离') && !r.error.includes('不存在')),
    crossWriteTool.error)

  const probeAfter = await call('task_board', { task_id: probe.task_id }, LEAD_AGENT)
  const boardBAfter = await call('task_board', {}, LEAD_B_AGENT)
  check('C27', '跨 run 失败后**数据不变**：探针事实没落库、任务状态未变、B run 域也没多出东西',
    probeAfter.task.status === 'open' && probeAfter.task.status === probeBefore.task.status
      && probeAfter.facts.length === probeBefore.facts.length
      && !JSON.stringify(probeAfter.facts).includes(PROBE_STATEMENT)
      && boardBAfter.tasks.every((t) => t.id !== probe.task_id),
    JSON.stringify({ before: { status: probeBefore.task.status, facts: probeBefore.facts.length },
      after: { status: probeAfter.task.status, facts: probeAfter.facts.length },
      bRunIds: boardBAfter.tasks.map((t) => t.id) }))

  // 子代理平面真实触发一次：目录里没有这个 id ⇒ 别人的子代理。
  const notMyChild = await call('task_child_send', {
    target_id: 'sess-not-mine-child', message: '这条不该被投递',
  }, CHILD_AGENT)
  check('C28', '码空间不混：跨 run 是 E_CROSS_RUN，子代理归属仍是 E_CHILD_NOT_OWN（同报告内真实触发，语义与提示均未变）',
    notMyChild.ok === false && notMyChild.code === 'E_CHILD_NOT_OWN'
      && notMyChild.error.includes('不是会话')
      && notMyChild.code !== crossReadTool.code
      && notMyChild.hint !== crossWriteTool.hint,
    JSON.stringify({ crossRunCode: crossReadTool.code, childCode: notMyChild.code, childErr: notMyChild.error }))
}

/* 没有 agents 服务时：主会话仍可用，子代理拒绝（不给子代理兜底） */
{
  const services = new Map()
  const ctxNoAgents = makeCtx(services)
  storeMod.apply(ctxNoAgents.ctx)
  toolsMod.apply(ctxNoAgents.ctx)
  const call = async (name, args, agent) =>
    JSON.parse(await ctxNoAgents.state.tools.find((t) => t.name === name).execute(args, { agent }))

  const leadOk = await call('task_board', {}, LEAD_AGENT)
  check('C20', 'agents 服务缺失时主会话仍可用（自身即根，不需要上溯）',
    leadOk.ok === true && leadOk.run_id === LEAD_A, JSON.stringify(leadOk))

  const childOk = await call('task_board', {}, CHILD_AGENT)
  check('C21', 'agents 服务缺失时 depth=1 子代理仍可用，run = parentSession（父 id，宿主落盘不可伪造）',
    childOk.ok === true && childOk.run_id === LEAD_A,
    JSON.stringify({ run: childOk.run_id, error: childOk.error }))

  const lost2Fail = await call('task_board', {}, LOST2_AGENT)
  check('C22', 'agents 服务缺失时 depth>1 子代理拒绝服务（不降级成自身 run）',
    lost2Fail.ok === false && lost2Fail.code === 'E_BROKEN_CHAIN'
      && (lost2Fail.error.includes('agents') || lost2Fail.error.includes('取不到')),
    JSON.stringify(lost2Fail))

  check('C23', '身份失败已落 logger.warn 告警（不静默）',
    ctxNoAgents.state.warnings.some((w) => w.includes('身份推导失败')),
    JSON.stringify(ctxNoAgents.state.warnings))

  for (const d of ctxNoAgents.state.disposers) d()
}

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
