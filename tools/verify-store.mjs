#!/usr/bin/env node
/**
 * P2 事实库自测：在**临时目录**跑一遍完整闭环，绝不碰真实库。
 *
 * 跑法：`node tools/verify-store.mjs`（任意 cwd 都可；`--keep` 保留临时目录供检查；
 *       `--install-anchor <dsh/package.json>` 或 `DSH_INSTALL_ANCHOR` 让 S33 真身交叉验证必跑）
 *
 * 它测什么：
 *   1. 两个插件行（store=host 平面、tools=agent 平面）用 fake ctx 真实 apply，
 *      服务经 provide → ctx.get 发布与消费；
 *   2. SQLite 表/列/视图与规格逐字段一致（PRAGMA table_info 实测，不是读源码）；
 *   3. 闭环：task_open → task_claim → 3 条不同 kind 的 task_fact → task_close → task_board；
 *   4. 失败路径：非法 kind/confidence/result、不存在的 task_id 都抛**可读**错误；
 *   5. 工具层：8 个工具注册到位；服务缺失时明确降级 + 告警（不静默）；
 *   6. 兜底编译器与真身 defineTool 的编译结果**逐字段等价**（S31）；
 *   7. dispose 后句柄关闭。
 *
 * 为了不污染真实数据：DSH_HOME 指向临时目录；被测源码**复制**到临时目录后再 import
 * （副本 hash 会打印，确保测的是当前源码），并在临时根建
 * node_modules/@deepseek-ai/dsh-tools 软链，让被测模块能解析到真身。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { resolveInstallAnchor } from './host-runtime.mjs'

const KEEP = process.argv.includes('--keep')
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SRC_LIB = join(PKG_ROOT, 'lib')

/** 真实 $DSH_HOME（只用于断言"没被写脏"）。 */
const REAL_DSH_HOME = process.env.DSH_HOME || join(process.env.HOME ?? '', '.dsh')
const REAL_DB = join(REAL_DSH_HOME, 'taskforce', 'taskforce.db')
const realDbBefore = existsSync(REAL_DB)

/* ─────────────────────────── 断言收集器 ─────────────────────────── */

const rows = []
let failed = 0

function check(id, title, ok, detail = '') {
  if (!ok) failed += 1
  rows.push({ id, title, ok })
  const tail = ok || detail === '' ? '' : `\n        ↳ ${detail}`
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}  ${title}${tail}`)
}

function checkSkip(id, title, why) {
  rows.push({ id, title, ok: true, skipped: true })
  console.log(`[SKIP] ${id}  ${title}  （${why}）`)
}

/** 捕获同步抛错，返回 { threw, message }。 */
function thrownOf(fn) {
  try {
    fn()
    return { threw: false, message: '' }
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 键排序后的规范 JSON（比较 schema 时忽略键顺序）。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/* ─────────────────────────── 临时工作区 ─────────────────────────── */

const TMP = mkdtempSync(join(tmpdir(), 'taskforce-verify-'))
const TMP_PKG = join(TMP, 'pkg')
const TMP_LIB = join(TMP_PKG, 'lib')
const TMP_HOME = join(TMP, 'home')

cpSync(SRC_LIB, TMP_LIB, { recursive: true })
mkdirSync(TMP_HOME, { recursive: true })

/** 被测源码副本的 hash（证明测的就是当前实现）。 */
function hashTree(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) hashTree(full, base, acc)
    else acc.push(`${full.slice(base.length + 1)} ${createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)}`)
  }
  return acc
}

const SOURCE_HASHES = hashTree(TMP_LIB)

/**
 * 显式 DSH 安装锚点：`--install-anchor <dsh/package.json>` 或 `DSH_INSTALL_ANCHOR`，
 * 与 verify-all / verify-host 同一解析（host-runtime.resolveInstallAnchor）。
 * 只认显式来源，不做 PATH 发现：离线 `npm test` 行为不变。显式锚点无效时失败，
 * 不悄悄回退成 SKIP。
 */
function explicitAnchorArg(args) {
  const inline = args.find((arg) => arg.startsWith('--install-anchor='))
  const index = args.indexOf('--install-anchor')
  return inline ? inline.slice('--install-anchor='.length) : index < 0 ? undefined : args[index + 1]
}
const EXPLICIT_ANCHOR = explicitAnchorArg(process.argv.slice(2)) ?? process.env.DSH_INSTALL_ANCHOR
/** 有显式锚点时，S33 必须真跑：缺真身或兜底被启用都算 FAIL，而不是 SKIP。 */
const NATIVE_REQUIRED = EXPLICIT_ANCHOR !== undefined && EXPLICIT_ANCHOR !== ''
let anchorProblem
let anchorToolsDir
if (NATIVE_REQUIRED) {
  try {
    const anchor = resolveInstallAnchor({ installAnchor: EXPLICIT_ANCHOR })
    // 官方安装把 dsh-tools 放在 dsh 自身依赖树里；从锚点解析，得到包根目录。
    const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-tools')
    let dir = dirname(entry)
    while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir)
    anchorToolsDir = dir
  } catch (error) {
    anchorProblem = error instanceof Error ? error.message : String(error)
  }
}

/** 真身 dsh-tools 的位置：让被测模块能解析到它。锚点优先，其次旧的固定部署路径。 */
const NATIVE_CANDIDATES = [
  ...(anchorToolsDir === undefined ? [] : [anchorToolsDir]),
  '/opt/dsh/install/node_modules/@deepseek-ai/dsh-tools',
  join(REAL_DSH_HOME, '..', 'install', 'node_modules', '@deepseek-ai', 'dsh-tools'),
]
let nativeDir
for (const candidate of NATIVE_CANDIDATES) {
  if (existsSync(join(candidate, 'package.json'))) { nativeDir = candidate; break }
}
if (NATIVE_REQUIRED && anchorToolsDir === undefined) nativeDir = undefined
if (nativeDir !== undefined) {
  mkdirSync(join(TMP, 'node_modules', '@deepseek-ai'), { recursive: true })
  try {
    symlinkSync(nativeDir, join(TMP, 'node_modules', '@deepseek-ai', 'dsh-tools'), 'dir')
  } catch { /* 已存在则忽略 */ }
}

// 关键：测试库落在临时 HOME 下。
process.env.DSH_HOME = TMP_HOME

console.log('══════════ P2 事实库自测（临时目录闭环）══════════')
console.log(`临时根        ${TMP}`)
console.log(`被测源码      ${SRC_LIB}  →  副本 ${TMP_LIB}`)
console.log(`源码指纹      ${SOURCE_HASHES.join('  |  ')}`)
console.log(`DSH_HOME      ${process.env.DSH_HOME}`)
console.log(`真身 dsh-tools ${nativeDir ?? '未找到（跳过真身交叉验证）'}`)
console.log('')

const storeMod = await import(pathToFileURL(join(TMP_LIB, 'store', 'index.js')).href)
const toolsMod = await import(pathToFileURL(join(TMP_LIB, 'tools', 'index.js')).href)

/* ─────────────────────────── fake ctx ─────────────────────────── */

function makeCtx(services = new Map()) {
  const state = { warnings: [], infos: [], disposers: [], tools: [], services }
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

const main = makeCtx()
storeMod.apply(main.ctx) // host 平面
toolsMod.apply(main.ctx) // agent 平面，同一服务表 ⇒ 跨平面共享
const store = main.state.services.get('taskforceStore')

/* ─────────────────────────── 主闭环 ─────────────────────────── */

check(
  'S01',
  'host 插件 apply 后通过 ctx.provide 发布了 taskforceStore 服务',
  store !== undefined && typeof store.openTask === 'function' && typeof store.board === 'function',
  `services=[${[...main.state.services.keys()].join(',')}]`,
)

if (store === undefined) {
  console.log('\n服务未发布，后续断言无法进行。')
  throw new Error('taskforceStore service was not published (S01 failed)')
}

const DB_PATH = store.dbPath
check(
  'S02',
  '库文件落在 $DSH_HOME/taskforce/taskforce.db（临时 HOME 下）',
  DB_PATH === join(TMP_HOME, 'taskforce', 'taskforce.db') && existsSync(DB_PATH),
  `dbPath=${DB_PATH} exists=${existsSync(DB_PATH)}`,
)

const inspect = new DatabaseSync(DB_PATH)
const objects = inspect.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view')").all()
const objectNames = objects.map((r) => r.name)
check(
  'S03',
  '幂等 DDL 建出 task / fact / handoff 三表与 v_task_board 视图',
  ['task', 'fact', 'handoff', 'v_task_board'].every((n) => objectNames.includes(n)),
  `实际对象=${objectNames.join(',')}`,
)

const colsOf = (table) => inspect.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
/* v2 起三表各多出 run 归属列；fact 另有 resolves_fact_id（未解 blocker 的机械判据）。 */
const COLS_TASK = ['id', 'title', 'note', 'status', 'owner', 'run_id', 'created_at', 'updated_at']
const COLS_FACT = ['id', 'task_id', 'kind', 'statement', 'evidence_path', 'evidence_line', 'confidence', 'created_by', 'run_id', 'resolves_fact_id', 'created_at']
const COLS_HANDOFF = ['id', 'task_id', 'from_child', 'to_child', 'note', 'run_id', 'created_at']

check('S04', 'task 表列名与规格一致', same(colsOf('task'), COLS_TASK), `实际=${colsOf('task').join(',')}`)
check('S05', 'fact 表列名与规格一致', same(colsOf('fact'), COLS_FACT), `实际=${colsOf('fact').join(',')}`)
check('S06', 'handoff 表列名与规格一致', same(colsOf('handoff'), COLS_HANDOFF), `实际=${colsOf('handoff').join(',')}`)

const open1 = store.openTask({ title: 'P2 闭环任务', note: '验收判据：板上 3 条事实 + 1 条 blocker' })
check(
  'S07',
  'task_open 落库并返回 task_id',
  open1.task_id === 1 && open1.status === 'open' && typeof open1.created_at === 'string' && open1.created_at.endsWith('Z'),
  JSON.stringify(open1),
)

const claim1 = store.claimTask({ task_id: 1, child_id: 'child-a' })
check(
  'S08',
  'task_claim 认领成功（status=claimed, owner=child-a）',
  claim1.status === 'claimed' && claim1.owner === 'child-a' && claim1.already === false,
  JSON.stringify(claim1),
)

const claimAgain = store.claimTask({ task_id: 1, child_id: 'child-a' })
check(
  'S09',
  '同一 child 重复认领幂等（already=true，不抛错）',
  claimAgain.already === true && claimAgain.owner === 'child-a',
  JSON.stringify(claimAgain),
)

const claimOther = thrownOf(() => store.claimTask({ task_id: 1, child_id: 'child-b' }))
check(
  'S10',
  '别的 child 认领被拒（可读错误，含 owner）',
  claimOther.threw && claimOther.message.includes('child-a') && claimOther.message.includes('已被'),
  claimOther.message,
)

const claimGhost = thrownOf(() => store.claimTask({ task_id: 999, child_id: 'child-a' }))
check('S11', '认领不存在的任务被拒（可读错误）', claimGhost.threw && claimGhost.message.includes('不存在'), claimGhost.message)

const factA = store.recordFact({
  task_id: 1,
  kind: 'fact',
  statement: 'bash 5.2.21 在容器内实测可用，退出码 0',
  evidence_path: '/tmp/x/run.log',
  evidence_line: 12,
  child_id: 'child-a',
})
const factB = store.recordFact({
  task_id: 1,
  kind: 'artifact',
  statement: '产出物已落盘 lib/store/index.js',
  evidence_path: '/root/Hack/packages/dsh-taskforce/lib/store/index.js',
  confidence: 'CONFIRMED',
  child_id: 'child-a',
})
const factC = store.recordFact({
  task_id: 1,
  kind: 'blocker',
  statement: '等待上层确认 DDL 是否需要 WAL 模式',
  child_id: 'child-a',
})
check(
  'S12',
  '3 条不同 kind 的 task_fact 落库（confidence 缺省 = PLAUSIBLE）',
  factA.confidence === 'PLAUSIBLE' && factC.confidence === 'PLAUSIBLE' && factB.confidence === 'CONFIRMED'
    && factA.fact_id === 1 && factB.fact_id === 2 && factC.fact_id === 3,
  JSON.stringify({ factA, factB, factC }),
)

const badKind = thrownOf(() => store.recordFact({ task_id: 1, kind: 'guess', statement: 'x' }))
check(
  'S13',
  '非法 kind 被拒（可读错误列出白名单）',
  badKind.threw && badKind.message.includes('kind 非法') && badKind.message.includes('blocker'),
  badKind.message,
)

const badConf = thrownOf(() => store.recordFact({ task_id: 1, kind: 'fact', statement: 'x', confidence: 'MAYBE' }))
check(
  'S14',
  '非法 confidence 被拒（可读错误列出白名单）',
  badConf.threw && badConf.message.includes('confidence 非法') && badConf.message.includes('REFUTED'),
  badConf.message,
)

const ghostFact = thrownOf(() => store.recordFact({ task_id: 404, kind: 'fact', statement: 'x' }))
check('S15', '给不存在的 task_id 落事实被拒（可读错误）', ghostFact.threw && ghostFact.message.includes('404'), ghostFact.message)

const viewRow = inspect.prepare('SELECT * FROM v_task_board WHERE id = 1').get()
check(
  'S16',
  'v_task_board 每任务一行：7 列 + fact_count=3 + blockers=1',
  same(Object.keys(viewRow), ['id', 'title', 'status', 'owner', 'fact_count', 'last_fact_at', 'blockers'])
    && viewRow.fact_count === 3 && viewRow.blockers === 1 && typeof viewRow.last_fact_at === 'string',
  JSON.stringify(viewRow),
)

const closed1 = store.closeTask({ task_id: 1, result: 'done' })
check(
  'S17',
  'task_close(done) 是 task_submit 的别名：只产生 submitted，绝不产生 accepted；带 blocker 时返回 warnings',
  closed1.status === 'submitted' && closed1.blockers === 1 && closed1.warnings.length === 1
    && closed1.alias_of === 'submitTask' && closed1.mapped_status.includes('submitted'),
  JSON.stringify(closed1),
)

const badResult = thrownOf(() => store.closeTask({ task_id: 1, result: 'finished' }))
check('S18', '非法 result 被拒（可读错误列出白名单）', badResult.threw && badResult.message.includes('result 非法'), badResult.message)

const boardAfterClose = store.board()
check(
  'S19',
  '无参 board 仍列出 submitted（待验收）任务 —— 它是主会话的待办来源，不会因为"已提交"而消失',
  boardAfterClose.scope === 'open'
    && boardAfterClose.tasks.some((t) => t.id === 1 && t.status === 'submitted')
    && boardAfterClose.submitted_tasks === 1,
  JSON.stringify(boardAfterClose.tasks.map((t) => ({ id: t.id, status: t.status }))),
)

/* 第二个任务：验证 board 摘要、截断、handoff、详情 */
const LONG_STATEMENT = `S20 长陈述：${'细节'.repeat(90)}`  // 远超 160 字符
const open2 = store.openTask({ title: 'P2 第二个任务', note: '验证摘要截断' })
store.claimTask({ task_id: open2.task_id, child_id: 'child-b' })
const factD = store.recordFact({ task_id: open2.task_id, kind: 'fact', statement: LONG_STATEMENT, child_id: 'child-b' })

const boardOpen = store.board()
const brief = boardOpen.tasks.find((t) => t.id === open2.task_id)
check(
  'S20',
  '无参 board 列出全部待办任务（含上一步的 submitted），事实摘要被截断（≤161 字符，原文 ' + LONG_STATEMENT.length + '）',
  boardOpen.tasks.length === 2 && brief !== undefined && brief.facts.length === 1
    && brief.facts[0].statement.length <= 161 && brief.facts[0].statement.endsWith('…')
    && brief.facts[0].id === factD.fact_id,
  JSON.stringify(brief),
)

const handoff = store.recordHandoff({
  task_id: open2.task_id,
  from_child: 'child-b',
  to_child: 'child-c',
  note: '交接原因：child-b 需要换方向',
})
const detail = store.board({ task_id: open2.task_id })
check(
  'S21',
  '带 task_id 的 board 返回完整事实（不截断）+ 交接记录 + 分类计数',
  detail.scope === 'task' && detail.facts[0].statement === LONG_STATEMENT
    && detail.handoffs.length === 1 && detail.handoffs[0].id === handoff.handoff_id
    && detail.counts.by_kind.fact === 1 && detail.task.owner === 'child-b',
  JSON.stringify({ facts: detail.facts.length, handoffs: detail.handoffs.length, counts: detail.counts }),
)

const taskOf1 = store.taskOf({ task_id: 1 })
check(
  'S22',
  'taskOf 返回单任务行 + 计数（submitted 仍算未结 open=true：它等验收）',
  taskOf1.task.id === 1 && taskOf1.fact_count === 3 && taskOf1.blockers === 1
    && taskOf1.open === true && taskOf1.task.status === 'submitted',
  JSON.stringify({ id: taskOf1.task.id, status: taskOf1.task.status, fact_count: taskOf1.fact_count, open: taskOf1.open }),
)

const stats = store.stats()
check(
  'S23',
  'stats 计数正确（2 任务 / 4 事实 / blocker 分布；submitted 上的未解 blocker 计入 blockers_open）',
  stats.tasks.total === 2 && stats.tasks.submitted === 1 && stats.tasks.claimed === 1
    && stats.facts.total === 4 && stats.facts.by_kind.fact === 2 && stats.facts.by_kind.blocker === 1
    && stats.facts.by_confidence.CONFIRMED === 1 && stats.facts.by_confidence.PLAUSIBLE === 3
    && stats.blockers_open === 1,
  JSON.stringify(stats),
)

/* 空库不是错误 */
const emptyRoot = join(TMP, 'empty-home')
const emptyStore = new storeMod.TaskforceStore(emptyRoot)
const emptyBoard = emptyStore.board()
check(
  'S24',
  '空库读板返回空数组而不是报错',
  emptyBoard.scope === 'open' && Array.isArray(emptyBoard.tasks) && emptyBoard.tasks.length === 0,
  JSON.stringify(emptyBoard),
)
emptyStore.close()

/* ─────────────────────────── 工具层 ─────────────────────────── */

const toolNames = main.state.tools.map((t) => t.name).sort()
// 2026-09-29 定向更新（非放宽）：本包新增两个子代理控制工具
// `task_child_send` / `task_child_stop`（见 docs/CONTROL.md）。
// 它们是**新增注册**，既不改名也不删除既有 8 个工具；因此这里把期望集合扩到 10 个，
// 并保留对既有 8 个工具逐个显式列名 —— 漏注册任何一个仍会 FAIL。
const expectedNames = [
  'task_accept', 'task_board', 'task_child_send', 'task_child_stop', 'task_claim',
  'task_close', 'task_fact', 'task_open', 'task_reject', 'task_submit',
]
check(
  'S25',
  'agent 平面注册 10 个模型可见工具（既有 8 个 + 新增 task_child_send / task_child_stop）',
  same(toolNames, expectedNames),
  `实际=${toolNames.join(',')}`,
)

check(
  'S26',
  '工具参数被编译成 raw JSON Schema（task_fact.kind 有 enum 白名单）',
  (() => {
    const def = main.state.tools.find((t) => t.name === 'task_fact')
    const p = def?.parameters
    return p?.type === 'object' && same(p.required, ['task_id', 'kind', 'statement'])
      && same(p.properties.kind.enum, ['fact', 'artifact', 'decision', 'blocker'])
      && p.properties.evidence_line.type === 'integer'
  })(),
  JSON.stringify(main.state.tools.find((t) => t.name === 'task_fact')?.parameters),
)

/**
 * 工具调用必须带调用者身份：`exec.agent` 是唯一的 run 归属来源
 * （宿主在 agent 循环里塞进去，模型无法伪造）。这里用主会话身份。
 */
const LEAD_AGENT = { id: 'session-verify-lead', options: {}, session: { header: { id: 'session-verify-lead', isSeeded: false } } }

const callTool = async (toolName, args, agent = LEAD_AGENT) => {
  const def = main.state.tools.find((t) => t.name === toolName)
  return JSON.parse(await def.execute(args, { agent }))
}

const tOpen = await callTool('task_open', { title: '工具闭环任务', note: '经 task_* 工具走一遍' })
const tClaim = await callTool('task_claim', { task_id: tOpen.task_id, child_id: 'child-tool' })
const tFact1 = await callTool('task_fact', {
  task_id: tOpen.task_id,
  kind: 'fact',
  statement: '工具层落的第一条事实（不带 confidence）',
  evidence_path: '/tmp/tool.log',
})
const tFact2 = await callTool('task_fact', {
  task_id: tOpen.task_id,
  kind: 'blocker',
  statement: '工具层落的阻塞事实',
  confidence: 'PLAUSIBLE',
})
check(
  'S27',
  '工具闭环上半段：task_open → task_claim → task_fact×2 全 ok',
  tOpen.ok === true && tClaim.ok === true && tClaim.owner === 'child-tool' && tFact1.ok === true && tFact2.ok === true
    && tFact1.confidence === 'PLAUSIBLE' && tFact2.kind === 'blocker',
  JSON.stringify({ tOpen, tClaim, tFact1, tFact2 }),
)

const tBoard = await callTool('task_board', {})
const tBoardText = JSON.stringify(tBoard)
const tBoardTask = tBoard.tasks.find((t) => t.id === tOpen.task_id)
check(
  'S28',
  '无参 task_board 紧凑：只列**本工作实例**的待办任务 + 每任务 ≤5 条摘要（整包 ' + tBoardText.length + ' 字符）',
  tBoard.ok === true && tBoard.scope === 'open' && tBoard.open_tasks === 1
    && tBoard.run_id === LEAD_AGENT.id && tBoard.can_accept === true
    && tBoard.tasks.every((t) => t.facts.length <= 5)
    && tBoardTask !== undefined && tBoardTask.facts.length === 2 && tBoardTask.blockers === 1
    && tBoardText.length < 1600,
  tBoardText.slice(0, 500),
)

const tClose = await callTool('task_close', { task_id: tOpen.task_id, result: 'partial' })
const tDetail = await callTool('task_board', { task_id: tOpen.task_id })
check(
  'S29',
  '工具闭环下半段：task_close(partial) 只产生 submitted（含未解 blocker 告警），详情板读到 2 条完整事实 + 阻塞计数',
  tClose.ok === true && tClose.status === 'submitted' && tClose.alias_of === 'submitTask'
    && tClose.warnings.length === 1 && tClose.warnings[0].includes('未解 blocker')
    && tDetail.ok === true && tDetail.scope === 'task' && tDetail.task.status === 'submitted'
    && tDetail.task.owner === 'child-tool' && tDetail.facts.length === 2 && tDetail.task.blockers === 1
    && tDetail.counts.by_kind.blocker === 1,
  JSON.stringify({ tClose, detail: { status: tDetail.task?.status, facts: tDetail.facts?.length } }),
)

const badTool = await callTool('task_fact', { task_id: 9999, kind: 'fact', statement: 'x' })
check(
  'S30',
  '工具层把数据层错误转成结构化 ok:false（含 hint，不静默）',
  badTool.ok === false && typeof badTool.error === 'string' && badTool.error.includes('9999') && typeof badTool.hint === 'string',
  JSON.stringify(badTool),
)

/* 服务缺失时必须明确降级 + 告警（身份照给，才走到服务那一层） */
const orphan = makeCtx(new Map())
toolsMod.apply(orphan.ctx)
const orphanDef = orphan.state.tools.find((t) => t.name === 'task_board')
const orphanResult = JSON.parse(await orphanDef.execute({}, { agent: LEAD_AGENT }))
check(
  'S31',
  '服务未挂载时：工具仍注册（10 个）、调用返回 ok:false 且 logger.warn 有告警（不静默）',
  // 口径与 S25 一致：10 = 既有 8 个 + 新增两个子代理控制工具；仍要求逐个名字都在
  // （只比数量会漏掉「注册了但换了名字」这类破坏）。
  orphan.state.tools.length === toolNames.length
    && toolNames.every((n) => orphan.state.tools.some((t) => t.name === n))
    && orphanResult.ok === false && orphanResult.error.includes('服务不可用')
    && orphanResult.hint.includes('部署问题') && orphan.state.warnings.length >= 1,
  JSON.stringify({ warnings: orphan.state.warnings, result: orphanResult }),
)

/* ─────────────────────────── 生命周期与等价性 ─────────────────────────── */

check(
  'S32',
  'ctx.effect 的 disposer 关闭库句柄（卸载后调用抛「已关闭」）',
  (() => {
    for (const disposer of main.state.disposers) disposer()
    const after = thrownOf(() => store.board())
    return store.closed === true && after.threw && after.message.includes('已关闭')
  })(),
  thrownOf(() => store.board()).message,
)

if (nativeDir !== undefined && toolsMod.usingNativeDefineTool) {
  const native = await import(pathToFileURL(join(nativeDir, 'lib', 'index.js')).href)
  const mismatches = []
  for (const [toolName, spec] of Object.entries(toolsMod.TOOL_SPECS)) {
    const nativeSchema = native.parameterSchemaSpecToJsonSchema(spec.parameters)
    const fallbackSchema = toolsMod.compileParameters(spec.parameters)
    const registeredSchema = main.state.tools.find((t) => t.name === toolName)?.parameters
    if (!same(nativeSchema, fallbackSchema)) {
      mismatches.push(`${toolName}: 兜底≠真身 ${JSON.stringify(fallbackSchema)} vs ${JSON.stringify(nativeSchema)}`)
      continue
    }
    if (registeredSchema !== undefined && !same(registeredSchema, nativeSchema)) {
      mismatches.push(`${toolName}: 注册结果≠真身 ${JSON.stringify(registeredSchema)}`)
    }
  }
  check(
    'S33',
    '兜底编译器 ≡ 真身 parameterSchemaSpecToJsonSchema（' + Object.keys(toolsMod.TOOL_SPECS).length + ' 个工具逐字段比对）',
    mismatches.length === 0,
    mismatches.join(' ; '),
  )
} else if (NATIVE_REQUIRED) {
  check('S33', '兜底编译 ≡ 真身编译（已提供 install anchor，必须真跑）', false,
    anchorProblem ?? (nativeDir === undefined ? '锚点下未解析到 @deepseek-ai/dsh-tools' : '被测模块未加载真身 defineTool（兜底被启用）'))
} else {
  checkSkip('S33', '兜底编译 ≡ 真身编译', '本机没有真身 dsh-tools 或兜底被启用；传 --install-anchor 或 DSH_INSTALL_ANCHOR 以真跑')
}

check(
  'S34',
  'DSH_HOME 缺省回退到 $HOME/.dsh/taskforce；config.root 优先',
  (() => {
    const savedHome = process.env.HOME
    const savedDsh = process.env.DSH_HOME
    let ok = false
    try {
      delete process.env.DSH_HOME
      process.env.HOME = join(TMP, 'fallback-home')
      ok = storeMod.resolveRoot({}) === join(TMP, 'fallback-home', '.dsh', 'taskforce')
        && storeMod.resolveRoot({ root: '/explicit/root' }) === '/explicit/root'
        && storeMod.resolveRoot() === join(TMP, 'fallback-home', '.dsh', 'taskforce')
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
      if (savedDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDsh
    }
    return ok
  })(),
  `fallback=${join(TMP, 'fallback-home', '.dsh', 'taskforce')}`,
)

check(
  'S35',
  '整个自测没有写脏真实库（' + REAL_DB + '）',
  existsSync(REAL_DB) === realDbBefore,
  `before=${realDbBefore} after=${existsSync(REAL_DB)}`,
)

/* ─────────────────────────── 报告 ─────────────────────────── */

const boardJson = JSON.stringify(boardOpen, null, 2)
const detailJson = JSON.stringify(detail, null, 2)
console.log('\n══════════ board（无参数：全部未结任务 + 每任务最近 5 条事实摘要）══════════')
console.log(boardJson)
console.log('\n══════════ board(task_id=' + open2.task_id + ')（单任务详情）══════════')
console.log(detailJson)

const passed = rows.filter((r) => r.ok && !r.skipped).length
const skipped = rows.filter((r) => r.skipped).length
console.log('\n══════════ 结果 ══════════')
console.log(`断言：${passed} PASS / ${failed} FAIL${skipped > 0 ? ` / ${skipped} SKIP` : ''}`)
console.log(`临时目录：${TMP}${KEEP ? '（--keep：保留）' : '（将清理）'}`)

inspect.close()
if (!KEEP) rmSync(TMP, { recursive: true, force: true })

console.log(`退出码：${failed === 0 ? 0 : 1}`)
process.exitCode = failed === 0 ? 0 : 1
