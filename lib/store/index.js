/**
 * @local/dsh-taskforce — P2「事实库」（Cordis host 平面插件 + 数据层）
 *
 * 为什么在 host 平面：事实要跨会话、跨子代理共享，服务实例必须进程级唯一。
 * preset 平面会随 agent 作用域被隔离与重建，事实会跟着散掉。
 * 本插件发布的服务名 `taskforceStore`，由 agent 平面的工具行
 * （lib/tools/index.js）消费，两行合成后主会话与子代理读写同一份 SQLite。
 *
 * API 依据（不猜，逐条实测/读源）：
 *   · `ctx.provide(name, value): () => void` —— @deepseek-ai/cordis
 *     lib/types/reflect.d.ts:41-43（同步重载，返回注销 disposer）。
 *   · `ctx.effect(fn)` 立即执行 fn 并把返回值当 fiber 的 disposer
 *     —— 同版本 dsh-redteam-mode lib/store.js:75 实测用法
 *     （`ctx.effect(() => () => store.close())`）。
 *   · `new DatabaseSync(path)` / `.exec(sql)` / `.prepare(sql).run()|get()|all()` /
 *     `.close()` —— node:sqlite，Node 22.23.2 实测（run() 返回
 *     `{ lastInsertRowid, changes }`；get() 返回普通对象或 undefined；
 *     all() 返回普通数组；空结果不抛错）。加载时打印 ExperimentalWarning 属正常。
 *   · `PRAGMA table_info(<表>)` / `ALTER TABLE ... ADD COLUMN` —— SQLite 原生；
 *     node:sqlite 的 `.prepare('PRAGMA table_info(t)').all()` 实测返回列对象数组
 *     （每项含 `name`），是本文件列迁移的判据来源。
 *
 * ── 工作实例归属（缺口 A）────────────────────────────────────────────────
 *
 * 本机同时跑上百个会话，两个主会话各自派活时**不能互相看见、更不能互相关单**。
 * 办法是每条行都带 `run_id`，而 `run_id` 由**宿主从调用者身份推导**（见
 * lib/tools/index.js 的 deriveIdentity），**绝不接受模型传参**。
 *
 * 由此形成**双域模型**：
 *   · **run 域**（`run_id` = 非空字符串）：模型可见工具走的唯一通道，按 run 隔离。
 *   · **未归属域**（`run_id IS NULL`）：`run_id` 列落地之前的历史行，以及宿主侧
 *     直接调服务、不声明 run 的调用（既有消费方 lib/plugins/working-context.mjs
 *     就是这样用的）。**未归属域永远不出现在任何 run 的视图里**，run 域的操作
 *     也永远碰不到它 —— 这是隔离，不是放宽：默认范围没有任何一路会退化成"看全部"。
 *
 * 硬规则：**`runId` 是独立的位置参数，绝不放进入参对象**。
 * 理由：一旦它成为 `input.run_id`，模型就能通过工具参数伪造归属；把它钉在位置
 * 参数上，"谁在调"这件事只能由调用方（宿主）决定。
 *
 * ── 提交 / 验收分离（缺口 B）────────────────────────────────────────────
 *
 * 子代理**不能**自己把任务判为完成 —— 那等于执行者自批。状态机：
 *
 *     open ──claim──▶ claimed ──submit──▶ submitted ──accept──▶ accepted（终态）
 *       ▲                ▲                    │                    │
 *       │                └──────reject────────┘                    │
 *       │                                                          │
 *       └──── cancelled（failed 语义，主动放弃 · 终态）◀───────────┘
 *                    ▲
 *                    └── task_reject 对终态任务 = **重新复核**（置回 rejected，回到待办板）
 *
 * `closeTask` 保留为**兼容别名**，但只产生 `submitted` / `cancelled`，
 * **不存在任何直接产生 `accepted` 的路径**（`accepted` 只能由 `acceptTask`
 * 在 actor = 'lead' 时写入）。
 *
 * ── 状态 × 动作表（v3：终态冻结 + 验收门槛）─────────────────────────────
 *
 * 终态 = `accepted` / `cancelled` / `done` / `partial` / `failed`
 * （后三者是迁移前的历史终态，只读保留）。**终态一旦写入，结论即冻结**：
 *
 * | 状态 | claim | fact(fact/artifact/decision) | fact(blocker) | submit | accept | reject(lead) | close(done/partial) | close(failed) |
 * |---|---|---|---|---|---|---|---|---|
 * | `open` | ✓ | ✓ | ✓ | ✓ → submitted | ✗（非 submitted） | ✗ | ✓ → submitted | ✓ → cancelled |
 * | `claimed` | ✓（同 owner 幂等） | ✓ | ✓ | ✓ → submitted | ✗ | ✗ | ✓ → submitted | ✓ → cancelled |
 * | `submitted` | ✗ | ✓ | ✓ | ✓（幂等） | ✓ → accepted | ✓ → rejected | ✓（幂等） | ✓ → cancelled |
 * | `rejected` | ✓ | ✓ | ✓ | ✗ `E_STATUS`（须先 claim） | ✗ | ✗ | ✗ `E_STATUS`（须先 claim） | ✓ → cancelled |
 * | **终态** | ✗ `E_TERMINAL` | ✗ `E_TERMINAL` | ✓ **晚到阻塞**（不改结论） | ✗ `E_TERMINAL` | ✗ `E_TERMINAL` | ✓ **重新复核** → rejected | ✗ `E_TERMINAL` | ✗ `E_TERMINAL` |
 *
 * 三条硬规则（v3 修复审计缺陷 1 / 2）：
 *
 * 1. **终态拒绝一切改写**：`closeTask(failed)` 必须**先查原状态** —— 已收口的
 *    任务不会因为一条晚到的 `failed` 被改成 `cancelled`。终态上的 `claim` /
 *    `submit` / `accept` / `close` / 非 blocker 的 `recordFact` 一律**可读拒绝**
 *    （`code = E_TERMINAL`），错误里指路 `task_reject`（重新复核）。
 * 2. **晚到阻塞不静默**：终态任务上**唯一**允许的新写入是 `kind='blocker'` ——
 *    它是"收口后才发现的问题"这一事实本身，必须能被记下来。它**不改变任务状态**
 *    （结论不被自动推翻），但会立刻出现在 `board()` 的 `late_blockers` 区里
 *    （以及详情板的 `late` / `late_blockers` 字段），不会被藏起来。
 *    要推翻结论只有一条路：主会话用 `rejectTask` 做**显式重新复核**（reason 必填，
 *    任务置回 `rejected` → 重新出现在默认待办板 → 可重新认领、重做、重验）。
 * 3. **验收门槛 = 有执行依据**：`acceptTask` 要求任务上至少有**一条**属于该任务的
 *    依据事实（`kind ∈ {fact, artifact}`，或带 `evidence_path` 产物指针）。
 *    系统自动写入的记录（提交说明 / 打回理由 / 验收记录）都是 `kind='decision'`
 *    且不带产物指针，**天然不构成依据**（不需要额外标记列）。零依据一律
 *    **抛可读错误**（`code = E_EVIDENCE_MISSING`），不是 warning。
 *    确实无法产出证据时，主会话可给 `waiver_reason` 做**显式人工豁免** ——
 *    豁免会以「人工豁免」字样写进验收记录，**不混入"已验证事实"**。
 *
 * **验收门槛查的是"有没有证据指针"，不是"内容是否正确"**：有路径不等于内容对，
 * 内容仍需人读证据文件复核。本层刻意不解析证据内容，也不自动给验收记录填
 * `evidence_path`（那会把执行者提供的路径伪造成"主会话已核对的证据"）。
 *
 * 零外部依赖：只用 node: 内置模块。不引入任何 npm 包。
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { configureSqlite, normalizeSqliteError, normalizeSqliteOptions, onSqliteConnectionInvalidated, withReadTransaction, withWriteTransaction } from './sqlite.js'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'taskforce-store'

import { pageInput, boardPageSnapshot, hasBasisFact } from './board-page.js'

import { assertResolutionInput, evidenceBasisSql, validResolutionSql } from './evidence.js'
import { EXECUTION_DDL, executionPolicy, executionOutcome, persistExecutionLogs, sourceSnapshot, newReceiptId, receiptRow, latestExecution, strictExecutionEvidence } from './execution.js'

/** 无硬依赖：数据层不需要别的服务即可激活。 */
export const inject = []

/** 事实类型白名单。 */
export const FACT_KINDS = ['fact', 'artifact', 'decision', 'blocker']

/** 置信度白名单：CONFIRMED 能指名证据行 / PLAUSIBLE 机制可信但未复现 / REFUTED 已证伪。 */
export const CONFIDENCE_LEVELS = ['CONFIRMED', 'PLAUSIBLE', 'REFUTED']

/** `closeTask` 兼容别名的 result 白名单（旧调用方可能仍在传这三个值）。 */
export const CLOSE_RESULTS = ['done', 'partial', 'failed']

/**
 * 全状态集合。前六个是当前状态机；后三个（done/partial/failed）是迁移前
 * 落盘的历史终态，**只读保留**：既不参与新写入，也不被自动改写。
 */
export const TASK_STATUSES = [
  'open', 'claimed', 'submitted', 'accepted', 'rejected', 'cancelled',
  'done', 'partial', 'failed',
]

/**
 * **终态**集合 —— 结论冻结，普通写入不能再改写（v3）。
 *
 * 含 `accepted` / `cancelled` 与三个迁移前历史终态 `done` / `partial` / `failed`
 * （历史行只读保留，同样享受终态保护：不会被一条晚到的 `task_close` 改写）。
 * 走出终态只有一条显式通道：主会话 `rejectTask`（= 重新复核，置回 `rejected`）。
 */
export const TERMINAL_STATUSES = ['accepted', 'cancelled', 'done', 'partial', 'failed']

/**
 * 构成**验收依据**的事实 kind：执行者落的证据类事实。
 * 判据还接受有效 confidence、任意 kind + 非空 `evidence_path` 产物指针（见 `#basisFacts`）。
 */
export const EVIDENCE_KINDS = ['fact', 'artifact']

/**
 * 数据层稳定错误码 —— 工具层据此选 `hint`，模型按码判读，**不按文案**。
 *
 * 命名注意：**刻意不以 `E_NO_` 开头**。工具层现用**显式集合** `IDENTITY_CODE_SET`
 * （lib/tools/index.js:211，由 `IDENTITY_CODES` 的值构成）识别"身份不可得"类错误，**不按前缀匹配**；
 * 保留该命名约定是为了防将来改回前缀匹配时，`E_NO_EVIDENCE` 这类码被误判成宿主集成问题。
 */
export const STORE_CODES = {
  /** 其他认领者或竞争中的状态更新赢得写入。 */
  conflict: 'E_TASK_CONFLICT',
  /** Attached facts/handoffs do not match their parent task's run. */
  integrity: 'E_STORE_INTEGRITY',
  /** 终态任务被要求改写结论（claim / submit / accept / close / 非 blocker 落事实）。 */
  terminal: 'E_TERMINAL',
  /** 验收缺执行依据，且没有人工豁免。 */
  evidenceMissing: 'E_EVIDENCE_MISSING',
  resolutionInvalid: 'E_RESOLUTION_INVALID',
  /**
   * 任务归属**别的 run**：跨工作实例的读 / 落事实 / 结任务一律被拒。
   *
   * 三条路径共用同一个归属检查点（`#scopedTask`），所以这里只需一个码；
   * 它表达的是**隔离边界**，与子代理平面的 `E_CHILD_NOT_OWN`（另一种归属错误）不是一回事。
   */
  crossRun: 'E_CROSS_RUN',
  /** 任务状态不允许当前动作（状态机边界：非竞争、非终态）。 */
  status: 'E_STATUS',
  /** 任务上存在未解 blocker，动作被阻塞（需先消解再重试）。 */
  blockers: 'E_BLOCKERS',
  /** 任务 id 不存在。命名刻意不以 `E_NO_` 开头（理由见文件头「命名注意」）。 */
  notFound: 'E_NOT_FOUND',
  /** 只有主会话（lead）能执行该动作；工具层已有 `E_NOT_LEAD` → `HINT_ROLE` 映射。 */
  notLead: 'E_NOT_LEAD',
  verificationPolicy: 'E_VERIFICATION_POLICY',
  verificationCommand: 'E_VERIFICATION_COMMAND',
  verificationReceipt: 'E_VERIFICATION_RECEIPT',
  verificationCapability: 'E_VERIFICATION_CAPABILITY',
  verificationRole: 'E_VERIFICATION_ROLE',
}

/**
 * 「未结」状态集合 —— 默认看板的范围。
 *
 * 刻意包含 `submitted`：**待验收的任务必须继续出现在默认看板里**，
 * 否则主会话就失去了它的待办来源。`rejected` 同理（等子代理重做）。
 * 三个历史终态与 `accepted` / `cancelled` 都不在范围内。
 */
export const PENDING_STATUSES = ['open', 'claimed', 'submitted', 'rejected']

/** 旧名保留（等价别名），避免既有引用断裂。 */
export const OPEN_STATUSES = PENDING_STATUSES

/**
 * 可被认领的状态：`open` 是首次认领，`rejected` 是打回后重认领。
 * `claimed` 由同一 owner 幂等处理，`submitted` 在验收中不可抢。
 */
export const CLAIMABLE_STATUSES = ['open', 'rejected']

/** `acceptTask` 只接受这个 actor。纵深防御：工具层已按身份判过，数据层再判一次。 */
export const LEAD_ACTOR = 'lead'

/** board 无参数时，每个任务带回的最近事实条数。 */
const FACTS_PER_TASK = 5

/** board 带 task_id 时，最多带回的事实条数。 */
const TASK_FACTS_LIMIT = 50

/** board 带 task_id 时，最多带回的 handoff 条数。 */
const TASK_HANDOFFS_LIMIT = 10

/** 摘要里单条 statement 的截断长度（board 要紧凑，不能倒全表）。 */
const STATEMENT_CHARS = 160

/** run_id 的最大长度（防御畸形身份串撑爆索引）。 */
const RUN_ID_MAX = 200

/**
 * 幂等 DDL：表 + 索引 + 视图。
 * 不加 CHECK 约束：白名单在应用层校验（约束一旦落后于白名单会把合法写入打成硬错误）。
 *
 * 新库直接建出带 `run_id` / `resolves_fact_id` 的表；**存量库**靠 `migrate()`
 * 补列（`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，不会加列）。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS task (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  owner      TEXT,
  owner_session TEXT,
  run_id     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fact (
  id               INTEGER PRIMARY KEY,
  task_id          INTEGER,
  kind             TEXT NOT NULL,
  statement        TEXT NOT NULL,
  evidence_path    TEXT,
  evidence_line    INTEGER,
  confidence       TEXT NOT NULL,
  created_by       TEXT,
  actor_session    TEXT,
  run_id           TEXT,
  resolves_fact_id INTEGER,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fact_task_id ON fact (task_id, id);

CREATE TABLE IF NOT EXISTS handoff (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER,
  from_child TEXT,
  to_child   TEXT,
  note       TEXT NOT NULL,
  run_id     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_task_id ON handoff (task_id, id);

/* 旧视图：保持 7 列不变（历史读取方按列名取值），**不参与服务 API**。 */
CREATE VIEW IF NOT EXISTS v_task_board AS
  SELECT t.id AS id,
         t.title AS title,
         t.status AS status,
         t.owner AS owner,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id) AS fact_count,
         (SELECT MAX(f.created_at) FROM fact f WHERE f.task_id = t.id) AS last_fact_at,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id AND f.kind = 'blocker') AS blockers
    FROM task t;
`

/**
 * **后置 DDL**：引用新列（`run_id` / `resolves_fact_id`）的索引与视图。
 *
 * 必须与 `DDL` 分开、在列迁移**之后**执行：旧库的 `task` 表没有 `run_id` 列，
 * 把 `CREATE INDEX ... ON task (run_id, status)` 放进主 DDL 会让整个
 * `handle.exec(DDL)` 在这一句上抛 "no such column: run_id"，
 * 连带把后面的建表语句一起跳过 —— 那是"迁移把库搞坏"的经典写法。
 */
const POST_DDL = `
CREATE INDEX IF NOT EXISTS idx_task_run_status ON task (run_id, status);
CREATE INDEX IF NOT EXISTS idx_fact_run ON fact (run_id, id);
CREATE INDEX IF NOT EXISTS idx_fact_resolves ON fact (resolves_fact_id);
CREATE INDEX IF NOT EXISTS idx_handoff_run ON handoff (run_id, id);

/* 带 run 的人工 SQL 投影（服务 API 之外的只读便利视图）。 */
DROP VIEW IF EXISTS v_run_board;
CREATE VIEW v_run_board AS
  SELECT t.run_id AS run_id,
         t.id AS id,
         t.title AS title,
         t.status AS status,
         t.owner AS owner,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id AND f.run_id IS t.run_id) AS fact_count,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id AND f.run_id IS t.run_id AND f.kind = 'blocker'
            AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'f')})) AS blockers_open
    FROM task t;
`

/**
 * 迁移计划：表 → 需要补的列。
 * 每一项都是 `ALTER TABLE ... ADD COLUMN`，**只加列不改列不删列**，因此不丢数据。
 */
const MIGRATIONS = [
  ['task', 'run_id', 'TEXT'],
  ['task', 'owner_session', 'TEXT'],
  ['task', 'evidence_policy', "TEXT NOT NULL DEFAULT 'legacy'"],
  ['task', 'verification_files', 'TEXT'],
  ['task', 'verification_command', 'TEXT'],
  ['task', 'verification_cwd', 'TEXT'],
  ['task', 'evidence_generation', 'INTEGER NOT NULL DEFAULT 0'],
  ['fact', 'actor_session', 'TEXT'],
  ['fact', 'run_id', 'TEXT'],
  ['fact', 'resolves_fact_id', 'INTEGER'],
  ['handoff', 'run_id', 'TEXT'],
]

/**
 * 未解 blocker 的计数子查询（board 与验收共用同一判据，避免两处漂移）。
 *
 * 未解 = 没有同任务同 run 的有效 decision 指向该 blocker。
 * @param taskRef - 外层任务行的 SQL 引用（如 `t.id`）。
 * @param factAlias - 子查询里 blocker 事实的别名。
 * @returns 计数 SQL 片段。
 */
function unresolvedSql(taskRef, factAlias) {
  return `(SELECT COUNT(*) FROM fact ${factAlias}`
    + ` WHERE ${factAlias}.task_id = ${taskRef} AND ${factAlias}.run_id IS t.run_id AND ${factAlias}.kind = 'blocker'`
    + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', factAlias)}))`
}

/** board 每行用的投影（与 v_run_board 同义，便于带 WHERE 复用）。 */
const BOARD_SELECT = `
  SELECT t.id AS id, t.title AS title, t.status AS status, t.owner AS owner, t.owner_session AS owner_session,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id AND f.run_id IS t.run_id) AS fact_count,
         (SELECT MAX(f.created_at) FROM fact f WHERE f.task_id = t.id AND f.run_id IS t.run_id) AS last_fact_at,
         ${unresolvedSql('t.id', 'f')} AS blockers
    FROM task t`

/** 当前时刻，UTC ISO8601（带毫秒与 Z）。 */
function nowIso() {
  return new Date().toISOString()
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 带稳定 `code` 的可读错误。
 *
 * 用法约束：**每个新增的拒绝路径都必须用它**，不许 `throw new Error('')` 了事。
 * `code` 走工具层（lib/tools/index.js 的 `wrap`）映射成模型可读的 `hint`，
 * 让调用方知道"这是状态机边界，重试无用"，而不是当成参数错误反复试。
 * @param code - {@link STORE_CODES} 里的稳定码。
 * @param message - 中文可读错误（要写清：为什么拒、下一步怎么走）。
 * @returns 带 `code` 的 Error（由调用方抛出）。
 */
function refuse(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 取消（`closeTask(result='failed')`）的 owner 闸门。
 *
 * **它挡的是什么**：`#36` 合并后，owner 冲突指引一度把 `task_close(failed)` 写成
 * 竞争子代理可执行的动作。而 `closeTask` 的 `failed` 分支原先只校验 run ——
 * 同一 run 内任意调用者都能把**别人** `claimed` 的任务推成终态 `cancelled`，
 * 写审计时还会用 `created_by: row.owner` 把账记到原 owner 头上。
 * 取消是破坏性且终态的动作，必须证明调用者有资格：
 * **可信主会话**，或**任务当前的 owner 本人**。
 *
 * **为什么 `caller` 缺省且未绑定时放行**：那是宿主进程内的直连路径（`lib/plugins/*` 等），
 * 不经模型、也本就有直写 SQLite 文件的能力 —— 本闸门只负责挡住**模型可达的工具层
 * 路径**，工具层永远显式传身份（`identity.isRoot ? 'lead' : identity.sessionId`）。
 * 这个取舍与 `docs/STORE.md` §九「run 隔离是接口层隔离，不是文件层安全边界」同源。
 *
 * @param row - 已按 run 取到的任务行。
 * @param taskId - 任务 id（写进错误正文）。
 * @param caller - 可信工具层派生的调用者：`'lead'` 或子代理 sessionId；缺省 = 宿主直连。
 * @throws `E_TASK_CONFLICT`（正文与内联 `hint` 都指路），调用方不得重试。
 */
function requireCancelAuthority(row, taskId, caller, actorSessionId) {
  if (row.owner_session !== null) {
    requireBoundOwner(row, taskId, caller, actorSessionId)
    return
  }
  if (caller === undefined || caller === null) return
  if (caller === LEAD_ACTOR) return
  if (row.owner !== null && caller === row.owner) return
  const ownerText = row.owner === null
    ? `任务 ${taskId} 还没有认领者（status=${row.status}）`
    : `任务 ${taskId} 由 ${row.owner} 认领`
  throw Object.assign(refuse(STORE_CODES.conflict,
    `取消被拒绝：${ownerText}，只有主会话或认领者本人能取消它；当前调用者是 ${caller}。`
    + '取消会把任务推到终态 cancelled，是破坏性动作，不能由同一 run 里的竞争方代为执行；'
    + '别把它当成参数问题重试。要停这条任务就报告主会话，由主会话决定是取消还是驳回重指派。',
  ), { hint: '不是参数问题，重试无用：task_close(failed) 只能取消你自己认领的任务。'
    + '要停别人的任务，先 task_board 核对 owner 与状态，再报告主会话处理。' })
}

/** Bound tasks authorize the real session, never the display label. */
function requireBoundOwner(row, taskId, caller, actorSessionId) {
  if (row.owner_session === null || caller === LEAD_ACTOR) return
  if ((actorSessionId ?? caller) === row.owner_session) return
  throw Object.assign(refuse(STORE_CODES.conflict,
    `任务 ${taskId} 由 ${row.owner}（真实会话 ${row.owner_session}）认领：只有真实 owner 或主会话可提交或取消；请先 task_board 核对并报告主会话。`,
  ), { hint: '真实 owner 不匹配：先 task_board 核对 owner_session 与状态，报告主会话处理；不要用相同标签重试。' })
}

/**
 * 解析数据根目录：显式 config.root > $TASKFORCE_HOME > $DSH_HOME/taskforce >
 * $HOME/.dsh/taskforce。库文件固定叫 taskforce.db。
 * @param config - 插件配置（可选 `{ root?: string }`）。
 * @returns 数据根目录绝对路径。
 */
export function resolveRoot(config) {
  if (config && typeof config.root === 'string' && config.root.length > 0) return config.root
  if (process.env.TASKFORCE_HOME) return process.env.TASKFORCE_HOME
  const home = process.env.DSH_HOME || join(process.env.HOME || homedir(), '.dsh')
  return join(home, 'taskforce')
}

/** 非空字符串必填校验：失败抛可读中文错误。 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必填：需要非空字符串（收到 ${JSON.stringify(value)}）`)
  }
  return value.trim()
}

/** 可选字符串：空串与 undefined 一律归一成 null。 */
function optionalText(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`需要字符串（收到 ${JSON.stringify(value)}）`)
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 归一化 run 归属：`undefined` / `null` / 空串 → `null`（未归属域），
 * 其余必须是字符串。**非字符串一律抛错**（防误把对象或数字当 run 传进来，
 * 那会静默落成一个谁都匹配不上的归属）。
 * @param runId - 位置参数形式的 run 标识。
 * @returns 归一后的 run_id（字符串或 null）。
 */
function requireRunId(runId) {
  if (runId === undefined || runId === null) return null
  if (typeof runId !== 'string') {
    throw new Error(`run_id 必须是字符串或 null（收到 ${JSON.stringify(runId)}）；run 归属由宿主身份推导，不由调用方自由指定`)
  }
  const trimmed = runId.trim()
  if (trimmed === '') return null
  if (trimmed.length > RUN_ID_MAX) {
    throw new Error(`run_id 过长（${trimmed.length} > ${RUN_ID_MAX} 字符）`)
  }
  return trimmed
}

/** 正整数 id 校验。 */
function requireId(value, field) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${field} 必须是正整数（收到 ${JSON.stringify(value)}）`)
  }
  return n
}

/** 整数校验（行号可为 0，不设下限）。 */
function requireInteger(value, field) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n)) {
    throw new Error(`${field} 必须是整数（收到 ${JSON.stringify(value)}）`)
  }
  return n
}

/** 白名单校验。 */
function requireOneOf(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${field} 非法：${JSON.stringify(value)}；允许值 ${allowed.join(' / ')}`)
  }
  return value
}

/** 截断长陈述（board 紧凑性的硬约束）。 */
function clip(statement) {
  if (typeof statement !== 'string') return statement
  return statement.length > STATEMENT_CHARS ? `${statement.slice(0, STATEMENT_CHARS)}…` : statement
}

/** 事实行 → 板上的紧凑摘要。 */
function briefFact(row) {
  return {
    id: row.id,
    kind: row.kind,
    confidence: row.confidence,
    statement: clip(row.statement),
    evidence: row.evidence_path === null
      ? null
      : (row.evidence_line === null ? row.evidence_path : `${row.evidence_path}:${row.evidence_line}`),
    by: row.created_by,
    actor_session: row.actor_session,
    at: row.created_at,
  }
}

/** 域的可读描述（错误信息里给模型看的）。 */
function describeRun(runId) {
  return runId === null ? '未归属域（run_id IS NULL）' : `run "${runId}"`
}

/**
 * 事实库数据层。
 *
 * 打开是惰性的：构造不碰磁盘；`open()` 建目录与库文件并执行幂等 DDL + 列迁移。
 * `open()` 失败不致命（下次调用会重试并抛出可读错误）；`close()` 之后本实例
 * 视为已卸载，任何调用都抛出「已关闭」，避免卸载后还偷偷重开句柄。
 *
 * **所有读写方法的最后一个位置参数都是 `runId`**（字符串 = run 域，缺省/null =
 * 未归属域）。跨域操作**抛可读错误**，绝不静默返回空集。
 */
export class TaskforceStore {
  /**
   * @param root - 数据根目录（`taskforce.db` 落在它下面）。
   */
  constructor(root, options = {}) {
    this.root = root
    this.dbPath = join(root, 'taskforce.db')
    this.sqliteOptions = normalizeSqliteOptions(options)
    /** @type {DatabaseSync | null} */
    this.handle = null
    this.closed = false
    /** 迁移统计（`open()` 时填；未归属行数用于启动告警）。 */
    this.migration = { added_columns: [], unassigned: { task: 0, fact: 0, handoff: 0 } }
  }

  /**
   * 建目录 + 开库 + 幂等建表建视图 + 幂等列迁移。可重复调用（已开则直接返回）。
   * @returns 打开的库句柄。
   */
  open() {
    if (this.closed) throw new Error(`事实库已关闭（${this.dbPath}）：这是已卸载的实例`)
    if (this.handle !== null && this.handle.isOpen) return this.handle
    this.handle = null
    let handle
    try {
      mkdirSync(this.root, { recursive: true })
      handle = new DatabaseSync(this.dbPath)
      onSqliteConnectionInvalidated(handle, () => {
        if (this.handle === handle) this.handle = null
      })
      configureSqlite(handle, this.sqliteOptions)
      const migration = withWriteTransaction(handle, () => {
        handle.exec(DDL)
        return this.migrate(handle, false)
      })
      this.migration = migration
      this.handle = handle
      return handle
    } catch (error) {
      this.handle = null
      try { handle?.close() } catch { /* preserve original failure */ }
      const normalized = normalizeSqliteError(error)
      const failure = new Error(
        `事实库打开失败（${this.dbPath}）：${messageOf(normalized)}；`
        + (normalized.code === 'E_STORE_BUSY'
          ? '数据库正被占用，请稍后有限次数重试'
          : '检查 $DSH_HOME 目录的写权限与磁盘空间'),
        { cause: normalized },
      )
      if (normalized.code) failure.code = normalized.code
      if (normalized.rollbackError !== undefined) failure.rollbackError = normalized.rollbackError
      if (normalized.transactionStateUnknown) failure.transactionStateUnknown = true
      throw failure
    }
  }

  /**
   * 幂等列迁移：缺哪列补哪列，再建引用新列的索引/视图，并统计未归属行数。
   *
   * **安全前提**：只做 `ADD COLUMN`。`ADD COLUMN` 不重写表、不动既有行，
   * 因此旧库升级后数据一条不少，旧行 `run_id` 为 NULL = 未归属。
   * @param handle - 已打开的库句柄。
   */
  migrate(handle, publish = true) {
    const migration = withWriteTransaction(handle, () => {
      const added = []
      for (const [table, column, decl] of MIGRATIONS) {
        const columns = handle.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
        if (!columns.includes(column)) {
          handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
          added.push(`${table}.${column}`)
        }
      }
      handle.exec(POST_DDL)
      handle.exec(EXECUTION_DDL)
      return {
        added_columns: added,
        unassigned: {
          task: Number(handle.prepare('SELECT COUNT(*) AS n FROM task WHERE run_id IS NULL').get()?.n ?? 0),
          fact: Number(handle.prepare('SELECT COUNT(*) AS n FROM fact WHERE run_id IS NULL').get()?.n ?? 0),
          handoff: Number(handle.prepare('SELECT COUNT(*) AS n FROM handoff WHERE run_id IS NULL').get()?.n ?? 0),
        },
      }
    })
    if (publish) this.migration = migration
    return migration
  }

  /** 关闭句柄；之后本实例不可再用。可重复调用。 */
  close() {
    const handle = this.handle
    this.handle = null
    this.closed = true
    if (handle === null) return
    try {
      handle.close()
    } catch {
      /* 关闭失败不阻断卸载 */
    }
  }

  /**
   * 未归属行计数（只读诊断，不返回内容）。
   * @returns `{ task, fact, handoff }`。
   */
  unassignedSummary() {
    const db = this.#db()
    return {
      task: Number(db.prepare('SELECT COUNT(*) AS n FROM task WHERE run_id IS NULL').get()?.n ?? 0),
      fact: Number(db.prepare('SELECT COUNT(*) AS n FROM fact WHERE run_id IS NULL').get()?.n ?? 0),
      handoff: Number(db.prepare('SELECT COUNT(*) AS n FROM handoff WHERE run_id IS NULL').get()?.n ?? 0),
      note: '未归属行 = run_id IS NULL；它们不参与任何 run 的视图。需要纳管用 adoptUnassigned(runId)。',
    }
  }

  /**
   * 显式接管：把**全部未归属行**归属到给定 run。这是跨范围写，必须显式调用。
   * @param runId - 目标 run（必须是非空字符串；`null` 无意义会被拒）。
   * @returns `{ tasks, facts, handoffs, run_id }`。
   */
  adoptUnassigned(runId) {
    const run = requireRunId(runId)
    if (run === null) {
      throw new Error('adoptUnassigned 需要一个具体的 run_id：接管到"未归属"没有意义')
    }
    const db = this.#db()
    const adopted = withWriteTransaction(db, () => {
      // 顺序有意义：先把未归属任务归到本 run，再让挂在它们下面（以及不挂任务）的
      // fact / handoff 跟着归位。三条语句都只碰 `run_id IS NULL` 的行，不会改写
      // 已经属于别的 run 的数据。
      const tasks = db.prepare('UPDATE task SET run_id = ?, updated_at = ? WHERE run_id IS NULL').run(run, nowIso()).changes
      const facts = db.prepare(
        'UPDATE fact SET run_id = ? WHERE run_id IS NULL'
        + ' AND (task_id IS NULL OR task_id IN (SELECT id FROM task WHERE run_id = ?))',
      ).run(run, run).changes
      const handoffs = db.prepare(
        'UPDATE handoff SET run_id = ? WHERE run_id IS NULL'
        + ' AND (task_id IS NULL OR task_id IN (SELECT id FROM task WHERE run_id = ?))',
      ).run(run, run).changes
      const migration = this.migrate(db, false)
      return {
        result: { run_id: run, tasks: Number(tasks), facts: Number(facts), handoffs: Number(handoffs) },
        migration,
      }
    })
    this.migration = adopted.migration
    return adopted.result
  }

  /** 取句柄（必要时惰性打开）。 */
  #db() {
    if (this.handle === null || !this.handle.isOpen) return this.open()
    return this.handle
  }

  /* ─────────────────── 域校验（隔离的唯一闸门） ─────────────────── */

  /**
   * 取本域内的任务行；跨域或不存在一律抛可读错误。
   *
   * 跨域不返回"不存在"而是明说"属于别的 run"：任务要求跨 run 操作被**明确拒绝**，
   * 含糊的"不存在"会让模型反复重试。两个分支的**判定顺序与文案都不变**，
   * 区别只在跨域分支走公共错误构造 `refuse()` ⇒ 带具名码 `E_CROSS_RUN`
   * （工具层据此把它与"参数抄错"分开；此前抛普通 Error，工具层只能回 `code: null`）。
   * 「不存在」仍是无码的普通 Error：那是参数问题，模型该核对 id 后重试。
   * @param taskId - 任务 id。
   * @param runId - 归一后的 run_id。
   * @param action - 触发动作（写进错误信息，便于模型定位）。
   * @returns 任务行。
   */
  #scopedTask(taskId, runId, action) {
    const row = this.#db()
      .prepare('SELECT id, title, note, status, owner, owner_session, run_id, created_at, updated_at, evidence_policy, verification_files, verification_command, verification_cwd, evidence_generation FROM task WHERE id = ?')
      .get(taskId)
    if (row === undefined) {
      throw refuse(STORE_CODES.notFound, `任务 ${taskId} 不存在：${action} 前先用 task_open 建任务，或 task_board 核对 id`)
    }
    if (row.run_id !== runId) {
      throw refuse(
        STORE_CODES.crossRun,
        `任务 ${taskId} 属于 ${describeRun(row.run_id)}，当前调用者属于 ${describeRun(runId)}：`
        + `${action} 只能作用于本 run 的任务（跨 run 隔离，拒绝执行）`,
      )
    }
    return row
  }

  /** Report misattributed attached rows without exposing their contents. */
  #scopeIntegrity(runId, taskId = null) {
    const rows = this.#db().prepare(
      'SELECT t.id AS task_id,'
      + ' (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id AND f.run_id IS NOT t.run_id) AS mismatched_facts,'
      + ' (SELECT COUNT(*) FROM handoff h WHERE h.task_id = t.id AND h.run_id IS NOT t.run_id) AS mismatched_handoffs'
      + ' FROM task t WHERE t.run_id IS ?'
      + (taskId === null ? '' : ' AND t.id = ?')
      + ' ORDER BY t.id',
    ).all(...(taskId === null ? [runId] : [runId, taskId]))
    return rows.filter(row => row.mismatched_facts > 0 || row.mismatched_handoffs > 0)
      .map(row => ({ task_id: row.task_id, mismatched_facts: Number(row.mismatched_facts),
        mismatched_handoffs: Number(row.mismatched_handoffs) }))
  }

  /** 某任务最近 N 条事实（最近在前）。 */
  #factRows(taskId, limit) {
    return this.#db()
      .prepare(
        'SELECT id, task_id, kind, statement, evidence_path, evidence_line, confidence, created_by, actor_session, created_at'
        + ' FROM fact WHERE task_id = ? AND run_id IS (SELECT run_id FROM task WHERE id = fact.task_id) ORDER BY id DESC LIMIT ?',
      )
      .all(taskId, limit)
  }

  /** 某任务的事实计数与**未解**阻塞计数。 */
  #counts(taskId) {
    const db = this.#db()
    const row = db
      .prepare(
        "SELECT COUNT(*) AS fact_count,"
        + ' MAX(created_at) AS last_fact_at'
        + ' FROM fact WHERE task_id = ? AND run_id IS (SELECT run_id FROM task WHERE id = fact.task_id)',
      )
      .get(taskId)
    const blockers = db
      .prepare(
        "SELECT COUNT(*) AS n FROM fact b WHERE b.task_id = ? AND b.run_id IS (SELECT run_id FROM task WHERE id = b.task_id) AND b.kind = 'blocker'"
        + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'b')})`,
      )
      .get(taskId)
    return {
      fact_count: Number(row?.fact_count ?? 0),
      blockers: Number(blockers?.n ?? 0),
      last_fact_at: row?.last_fact_at ?? null,
    }
  }

  /** 终态判据（accepted / cancelled + 三个历史终态）。 */
  #isTerminal(status) {
    return TERMINAL_STATUSES.includes(status)
  }

  /**
   * **验收依据**（v3 验收门槛的唯一判据来源）。
   *
   * 机械定义：属于该任务、confidence 为 CONFIRMED/PLAUSIBLE，且满足 `kind ∈ {fact, artifact}` **或** 带非空 `evidence_path`
   * 的事实。系统自动写入的记录（提交说明 / 打回理由 / 验收记录）都是
   * `kind='decision'` 且不带产物指针，**天然不构成依据** —— 所以不需要给 fact 表
   * 加 `origin` 列，也就不会有"新列让旧库/旧断言失配"的迁移风险。
   *
   * **它只回答"有没有有效依据事实"，不回答"内容是否正确"** —— 判据是"有路径 ≠ 内容对"，
   * 内容仍需人读证据文件复核；本层不解析文件内容，避免过度设计。
   *
   * @param taskId - 任务 id。
   * @returns `{ count, fact_ids, with_pointer, unattributed }`。
   */
  #basisFacts(taskId) {
    const rows = this.#db()
      .prepare(
        'SELECT f.id, f.kind, f.evidence_path, f.created_by FROM fact f'
        + ` WHERE f.task_id = ? AND f.run_id IS (SELECT run_id FROM task WHERE id = f.task_id) AND ${evidenceBasisSql('f')}`
        + ' ORDER BY id',
      )
      .all(taskId)
    return {
      count: rows.length,
      fact_ids: rows.map((row) => Number(row.id)),
      with_pointer: rows.filter((row) => row.evidence_path?.trim()).length,
      unattributed: rows.filter((row) => row.created_by === null).length,
    }
  }

  /**
   * **晚到阻塞**：任务已离开待办集合（= 终态）之后落下的、尚未被消解的 blocker。
   *
   * 之所以是**动态推导**（"状态不在待办集合 + 有未解 blocker"）而不是落一个 `late` 列：
   * ① 不引入新列 ⇒ 旧库零迁移风险、既有列断言不破；② 晚到属性不会与状态漂移
   * （任务被重新复核回 `rejected` 后，它自动不再算晚到）。
   * @param runId - 归一后的 run_id（域隔离照旧）。
   * @param taskId - 可选：只看某一个任务；缺省 = 本 run 全部。
   * @returns 任务数组，每项 `{ task_id, title, status, owner, blockers: [{ fact_id, statement, by, at }] }`。
   */
  #lateBlockersOf(runId, taskId = null) {
    const placeholders = PENDING_STATUSES.map(() => '?').join(', ')
    const scope = taskId === null ? '' : ' AND t.id = ?'
    const params = taskId === null ? [runId, ...PENDING_STATUSES] : [runId, ...PENDING_STATUSES, taskId]
    const rows = this.#db()
      .prepare(
        'SELECT t.id AS task_id, t.title, t.status, t.owner,'
        + ' f.id AS fact_id, f.statement, f.created_by, f.actor_session, f.created_at'
        + ' FROM task t JOIN fact f ON f.task_id = t.id AND f.run_id IS t.run_id'
        + ` WHERE t.run_id IS ? AND t.status NOT IN (${placeholders})`
        + " AND f.kind = 'blocker'"
        + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'f')})`
        + `${scope} ORDER BY f.id`,
      )
      .all(...params)
    const byTask = new Map()
    for (const row of rows) {
      if (!byTask.has(row.task_id)) {
        byTask.set(row.task_id, {
          task_id: Number(row.task_id),
          title: row.title,
          status: row.status,
          owner: row.owner,
          blockers: [],
        })
      }
      byTask.get(row.task_id).blockers.push({
        fact_id: Number(row.fact_id),
        statement: clip(row.statement),
        by: row.created_by,
        actor_session: row.actor_session,
        at: row.created_at,
      })
    }
    return [...byTask.values()]
  }

  /** 未解 blocker 的清单（验收被拒时逐条列出，模型据此知道要解什么）。 */
  #unresolvedBlockers(taskId) {
    return this.#db()
      .prepare(
        'SELECT b.id, b.statement, b.created_by, b.created_at FROM fact b'
        + " WHERE b.task_id = ? AND b.run_id IS (SELECT run_id FROM task WHERE id = b.task_id) AND b.kind = 'blocker'"
        + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'b')})`
        + ' ORDER BY b.id',
      )
      .all(taskId)
      .map((row) => ({ fact_id: row.id, statement: clip(row.statement), by: row.created_by, at: row.created_at }))
  }

  /** 板上的一行（含最近 5 条事实摘要）。 */
  #taskBrief(row, facts) {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      owner: row.owner,
      owner_session: row.owner_session,
      fact_count: Number(row.fact_count ?? 0),
      last_fact_at: row.last_fact_at ?? null,
      blockers: Number(row.blockers ?? 0),
      facts: facts.map(briefFact),
    }
  }

  /* ────────────────────────────── 写 ────────────────────────────── */

  /**
   * 事实行的**唯一**物理写入点（私有）。
   *
   * 为什么不直接让 `acceptTask` 复用 `recordFact`：验收记录是在任务**已经进入终态**
   * （`status='accepted'`）之后写的，走公开通道会被终态闸门拦下 —— 而那条记录恰恰是
   * "谁在何时、基于什么验收了"的唯一凭证，必须能写。系统记录走这条内部通道，
   * 与外部调用共用同一条 INSERT，避免两份 SQL 漂移。
   * @param row - 已归一化的列值（`created_at` 缺省 = 此刻）。
   * @returns `{ fact_id, created_at }`。
   */
  #insertFact(row) {
    const ts = row.created_at ?? nowIso()
    const info = this.#db()
      .prepare(
        'INSERT INTO fact (task_id, kind, statement, evidence_path, evidence_line, confidence, created_by, actor_session, run_id, resolves_fact_id, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.task_id ?? null, row.kind, row.statement, row.evidence_path ?? null,
        row.evidence_line ?? null, row.confidence, row.created_by ?? null, row.actor_session ?? null,
        row.run_id ?? null, row.resolves_fact_id ?? null, ts,
      )
    if (row.task_id !== null && row.task_id !== undefined) {
      const changed = this.#db()
        .prepare('UPDATE task SET updated_at = ? WHERE id = ? AND run_id IS ?')
        .run(ts, row.task_id, row.run_id ?? null).changes
      if (changed !== 1) {
        throw refuse(STORE_CODES.conflict,
          `任务 ${row.task_id} 的归属或状态已变化，事实未写入：请先 task_board 核对`)
      }
    }
    return { fact_id: Number(info.lastInsertRowid), created_at: ts }
  }

  /** 按写锁下观察到的原状态做条件更新，失配即拒绝。 */
  #transitionTask(row, status, ts, owner = row.owner, ownerSession = row.owner_session) {
    const changed = this.#db()
      .prepare('UPDATE task SET status = ?, owner = ?, owner_session = ?, updated_at = ?'
        + ' WHERE id = ? AND run_id IS ? AND status = ? AND owner IS ? AND owner_session IS ?')
      .run(status, owner, ownerSession, ts, row.id, row.run_id, row.status, row.owner, row.owner_session).changes
    if (changed !== 1) {
      throw refuse(STORE_CODES.conflict,
        `任务 ${row.id} 的状态或认领者已被其他调用者更改：请先 task_board 核对最新状态，再决定是否继续`)
    }
  }

  /**
   * 开一个任务（归属调用者的 run）。
   * @param input - `{ title, note? }`（也接受裸 title 字符串）。
   * @param runId - 调用者的 run 归属；缺省 = 未归属域。
   * @returns `{ task_id, title, status, created_at, run_id }`。
   */
  openTask(input = {}, runId, trustedContext) {
    const args = typeof input === 'string' ? { title: input } : (input ?? {})
    const title = requireText(args.title, 'title')
    const note = optionalText(args.note)
    const run = requireRunId(runId)
    const policy = executionPolicy(args, trustedContext)
    return withWriteTransaction(this.#db(), () => {
      const ts = nowIso()
      const info = this.#db()
        .prepare(
          'INSERT INTO task (title, note, status, owner, run_id, created_at, updated_at, evidence_policy, verification_files, verification_command, verification_cwd)'
          + ' VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(title, note, 'open', run, ts, ts, policy.evidence_policy, policy.verification_files, policy.verification_command, policy.verification_cwd)
      return { task_id: Number(info.lastInsertRowid), title, status: 'open', run_id: run, created_at: ts }
    })
  }

  /** Host-only target lookup. Caller identity is separate from model arguments. */
  verificationTarget(taskId, runId, caller) {
    const id = requireId(taskId, 'task_id')
    const run = requireRunId(runId)
    return withReadTransaction(this.#db(), () => {
      const row = this.#scopedTask(id, run, '验证执行')
      if (this.#isTerminal(row.status)) throw refuse(STORE_CODES.terminal, '终态任务不能执行 task_verify；先由主会话 task_reject 重新复核')
      if (row.evidence_policy !== 'execution') throw refuse(STORE_CODES.verificationPolicy, 'task_verify 只用于 execution policy 任务；legacy 任务继续使用事实依据')
      if (!['claimed', 'submitted'].includes(row.status)) throw refuse(STORE_CODES.status, '验证执行前须先 task_claim 绑定真实 owner')
      if (caller?.isRoot !== false) throw refuse(STORE_CODES.verificationRole, 'task_verify 仅允许真实子会话 owner，主会话不可执行命令')
      if (!row.owner_session || row.owner_session !== caller.sessionId) throw refuse(STORE_CODES.conflict, 'task_verify 需要当前真实 owner_session；昵称不能替代会话绑定')
      return { ...row, verification_files: JSON.parse(row.verification_files) }
    })
  }

  /** Trusted host API, never exposed as a model tool. Pending and completion
   * update the same row; stale completions remain observations of their origin. */
  recordExecution(receipt, runId, caller) {
    const taskId = requireId(receipt?.task_id, 'task_id')
    const run = requireRunId(runId)
    return withWriteTransaction(this.#db(), () => {
      const db = this.#db()
      if (receipt.status === 'pending') {
        const target = this.verificationTarget(taskId, run, caller)
        if (receipt.command !== target.verification_command) throw refuse(STORE_CODES.verificationCommand, '执行命令须逐字匹配固定 verification_command')
        if (typeof receipt.call_id !== 'string' || !receipt.call_id || typeof receipt.root_call_id !== 'string' || !receipt.root_call_id) {
          throw refuse(STORE_CODES.verificationCapability, '回执缺可信宿主调用关联')
        }
        if (!Number.isInteger(receipt.timeout_ms) || receipt.timeout_ms < 1 || receipt.timeout_ms > 120000) throw refuse(STORE_CODES.verificationPolicy, '回执超时必须为 1–120000 的整数')
        const snapshot = sourceSnapshot(target.verification_cwd, target.verification_files)
        const receiptId = newReceiptId()
        db.prepare('INSERT INTO execution_receipt (receipt_id, task_id, run_id, evidence_generation, owner_session, actor_session, command, cwd, verification_files, status, started_at, call_id, root_call_id, parent_call_id, timeout_ms, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(receiptId, taskId, run, target.evidence_generation, target.owner_session, caller.sessionId,
            target.verification_command, target.verification_cwd, JSON.stringify(target.verification_files),
            'pending', nowIso(), receipt.call_id, receipt.root_call_id, receipt.parent_call_id ?? null, receipt.timeout_ms, JSON.stringify(snapshot))
        return { task_id: taskId, receipt_id: receiptId, status: 'pending', verified: false }
      }
      const task = this.#scopedTask(taskId, run, '记录执行回执')
      const row = db.prepare('SELECT * FROM execution_receipt WHERE receipt_id = ? AND task_id = ? AND run_id IS ?')
        .get(receipt.receipt_id, taskId, run)
      if (!row || row.status !== 'pending' || caller?.isRoot !== false || caller.sessionId !== row.actor_session) {
        throw refuse(STORE_CODES.verificationReceipt, '回执不存在、已结束或不属于本真实执行者；不能替换别人的回执')
      }
      const outcome = executionOutcome(receipt.native_result, receipt.signal_aborted === true)
      let sourceChanged = true
      try { sourceChanged = JSON.stringify(sourceSnapshot(row.cwd, JSON.parse(row.verification_files))) !== row.snapshot } catch { /* invalid source fails closed */ }
      const logs = persistExecutionLogs(this.root, row.receipt_id, outcome)
      const { stdout, stderr, status, ...details } = outcome
      const changed = db.prepare('UPDATE execution_receipt SET status = ?, ended_at = ?, outcome = ?, logs = ? WHERE receipt_id = ? AND status = ?')
        .run(status, nowIso(), JSON.stringify({ ...details, source_changed: sourceChanged }), JSON.stringify(logs), row.receipt_id, 'pending').changes
      if (changed !== 1) throw refuse(STORE_CODES.verificationReceipt, '回执完成写入未生效；pending intent 保持未验证，请核对宿主存储后重新执行')
      let verified = false
      try { verified = strictExecutionEvidence(db, this.root, task).receipt_id === row.receipt_id } catch { /* persisted failure/unknown/stale observation */ }
      return { task_id: taskId, receipt_id: row.receipt_id, status, verified,
        exit_code: details.exit_code, output_complete: details.output_complete,
        source_changed: sourceChanged, native_error: details.native_error, native_error_code: details.native_error_code }
    })
  }

  /**
   * 认领任务：status → claimed，owner → child_id。
   * 允许认领的状态 = `open`（首次）与 `rejected`（打回后重做）。
   * 同一 child 重复认领幂等（`already: true`）；被别的 child 占用则拒绝。
   * 仅可信主控可在 rejected 状态换 owner，状态、decision、handoff 原子落库。
   * @param input - `{ task_id, child_id }`。
   * @param runId - 调用者的 run 归属。
   * @param actor - 可信工具层提供的 lead 角色或实际调用者会话；模型字段无效。
   * @param ownerSessionId - 宿主核验的执行者会话；缺省为未绑定标签兼容路径。
   * @returns `{ task_id, owner, status, claimed_at, already }`。
   */
  claimTask(input = {}, runId, actor, ownerSessionId) {
    const args = input ?? {}
    const taskId = requireId(args.task_id, 'task_id')
    const childId = requireText(args.child_id, 'child_id')
    const targetSession = optionalText(ownerSessionId)
    const run = requireRunId(runId)
    return withWriteTransaction(this.#db(), () => {
      const row = this.#scopedTask(taskId, run, '认领')
      // **终态优先于 owner 冲突**：已收口的任务不论原 owner 是谁都不能再认领，
      // 报"状态不允许"比报"已被某人认领"更准确（后者会诱导调用方去找原认领者转手，
      // 而终态任务的正确出路是主会话 task_reject 重新复核）。
      if (this.#isTerminal(row.status)) {
        throw refuse(
          STORE_CODES.terminal,
          `任务 ${taskId} 已收口（status=${row.status}），不能再认领：`
          + '终态结论不可再改写。需要继续做就开新任务；'
          + '若这条结论确实错了（例如收口后又出现了阻塞），由主会话 task_reject 做显式重新复核，'
          + '任务会置回 rejected 并回到待办板，届时再认领。',
        )
      }
      // owner 冲突次判：这样才能报出"已被谁认领"，而不是含糊的状态错误。
      const bindingConflict = row.owner_session !== null && (
        (actor !== LEAD_ACTOR && actor !== row.owner_session)
        || (targetSession !== null && targetSession !== row.owner_session)
      )
      // A bound executor keeps its authority even when it supplies another display label.
      // Preserve the stored label rather than turn an authorized retry into a reassignment.
      const sameSession = row.owner_session !== null && !bindingConflict
        && (actor === row.owner_session || targetSession === row.owner_session)
      const ownerConflict = row.owner !== null && ((row.owner !== childId && !sameSession) || bindingConflict)
      const reassign = ownerConflict && actor === LEAD_ACTOR && row.status === 'rejected'
      if (ownerConflict && !reassign) {
        // 换人通道只在 rejected + lead；错误指引必须按当前状态分流，
        // 否则模型在 claimed 上会去调 task_reject（E_STATUS），在已是 rejected
        // 时又被要求再 reject 一次（同样 E_STATUS）。
        let nextStep
        if (row.status === 'rejected') {
          nextStep = '任务已是 rejected：换 owner 只能由主会话直接 task_claim 指定新的 child_id'
            + '（子代理不能换人）；不要再调 task_reject'
        } else if (row.status === 'submitted') {
          nextStep = '当前为 submitted：由主会话先 task_reject 打回，再由主会话 task_claim 指定新的 child_id'
        } else if (row.status === 'claimed') {
          // 这里**不得**给竞争方任何"你可以直接取消"的回退：取消会把任务推成终态，
          // 是 owner 与主会话的动作，不是竞争方的动作（见 requireCancelAuthority）。
          nextStep = '当前为 claimed：不能直接 task_reject（reject 只接受 submitted / 终态重新复核）；'
            + '可等当前认领者 task_submit 后由主会话 task_reject，再由主会话 task_claim 指定新 child_id'
        } else {
          nextStep = '按当前状态由主会话走 reject→claim 换人通道'
        }
        // 内联 hint 让状态分流真的透出去：工具层 wrap() 见到 error.hint 会原样采用，
        // 否则调用方只会拿到固定的 HINT_TASK_CONFLICT（读板文案），看不到本状态专属指路。
        const hint = '这是认领竞争：先 task_board 核对最新 owner 与状态；' + nextStep
        throw Object.assign(refuse(STORE_CODES.conflict,
          `任务 ${taskId} 已被 ${row.owner} 认领，${childId} 不能重复认领；` + hint,
        ), { hint })
      }
      // 同一 child 在 claimed 状态下重复认领是幂等的（派单重试很常见）。
      const already = row.owner !== null && !ownerConflict && row.status === 'claimed'
      if (!CLAIMABLE_STATUSES.includes(row.status) && !already) {
        const terminal = this.#isTerminal(row.status)
        const message = `任务 ${taskId} 当前 status=${row.status}，不能再认领；`
          + `可认领的状态是 ${CLAIMABLE_STATUSES.join(' / ')}`
          + (row.status === 'submitted' ? '（已提交待验收：等主会话 task_accept 或 task_reject）' : '')
          + (terminal
            ? '（已收口：终态不可再改写。需要继续做就开新任务；若这条结论确实错了 —— '
              + '例如收口之后又出现了阻塞 —— 由主会话 task_reject 做显式重新复核，任务会置回 rejected 再重新认领）'
            : '')
        throw terminal ? refuse(STORE_CODES.terminal, message) : refuse(STORE_CODES.status, message)
      }
      const ts = nowIso()
      const ownerSession = reassign ? targetSession : (targetSession ?? row.owner_session)
      const owner = sameSession ? row.owner : childId
      this.#transitionTask(row, 'claimed', ts, owner, ownerSession)
      if (reassign) {
        const note = `主控重新指派：${row.owner} → ${childId}（任务已显式驳回）`
        this.#insertFact({ task_id: taskId, kind: 'decision', statement: note,
          confidence: 'PLAUSIBLE', created_by: LEAD_ACTOR, actor_session: run, run_id: run })
        this.#db().prepare('INSERT INTO handoff (task_id, from_child, to_child, note, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(taskId, row.owner, childId, note, run, ts)
      }
      return { task_id: taskId, owner, owner_session: ownerSession, status: 'claimed', claimed_at: ts, already,
        warnings: ownerSession === null ? ['任务未绑定真实 owner_session：仅标签预指派，执行者须自行 task_claim 绑定；历史提交路径仍兼容'] : [],
        ...(reassign ? { reassigned: true } : {}) }
    })
  }

  /**
   * 落一条事实。这是子代理唯一可信的产出通道（消息只保证「已接受」）。
   *
   * **v3 终态闸门**：任务已收口（终态）时，只有 `kind='blocker'`（晚到阻塞）允许写入 ——
   * 它不改结论，只让"收口后才发现的问题"可见；其余 kind 一律 `E_TERMINAL` 拒绝。
   * @param input - `{ task_id?, kind, statement, evidence_path?, evidence_line?, confidence?, child_id?, resolves_fact_id? }`。
   * @param runId - 调用者的 run 归属。
   * @param caller - 独立可信显示署名；工具层用 lead 或调用者真实会话。
   * @param actorSessionId - 独立可信审计会话；未提供时不猜填。
   * @returns `{ fact_id, task_id, kind, confidence, resolves_fact_id, created_at, late, late_of_status, next? }`
   *   （`late: true` = 这条是落在终态任务上的晚到阻塞）。
   */
  recordFact(input = {}, runId, caller, actorSessionId) {
    const args = input ?? {}
    const kind = args.kind === undefined ? 'fact' : requireOneOf(args.kind, FACT_KINDS, 'kind')
    const statement = requireText(args.statement, 'statement')
    const confidence = args.confidence === undefined
      ? 'PLAUSIBLE'
      : requireOneOf(args.confidence, CONFIDENCE_LEVELS, 'confidence')
    const run = requireRunId(runId)
    const taskId = args.task_id === undefined || args.task_id === null
      ? null
      : requireId(args.task_id, 'task_id')
    return withWriteTransaction(this.#db(), () => {
      /** 本域任务行：终态闸门与「晚到」标记都要用它（跨 run 仍由 #scopedTask 先拒）。 */
      const taskRow = taskId === null ? null : this.#scopedTask(taskId, run, '落事实')
      const late = taskRow !== null && this.#isTerminal(taskRow.status)
      if (late && kind !== 'blocker') {
        throw refuse(
          STORE_CODES.terminal,
          `任务 ${taskId} 已收口（status=${taskRow.status}），不能再落 ${kind} 事实：`
          + '终态结论不会被任何新写入自动改写，这是刻意的（你写的是"当时的证据"，'
          + '而结论已经签发；两者混在一起就再也说不清谁改了结论）。'
          + '要推翻结论只有一条路：主会话 task_reject 做**显式重新复核**（reason 必填，'
          + '任务置回 rejected、重新出现在待办板），复核之后再落这条事实。'
          + '例外：kind=blocker（晚到阻塞）允许落库 —— 它不改结论、会标注 late，'
          + '并立刻出现在默认看板的 late_blockers 区，用于让"收口后才发现的问题"不被藏起来。',
        )
      }
      const evidencePath = optionalText(args.evidence_path)
      const evidenceLine = args.evidence_line === undefined || args.evidence_line === null
        ? null
        : requireInteger(args.evidence_line, 'evidence_line')
      const createdBy = optionalText(caller ?? args.child_id ?? args.created_by)
      const resolves = args.resolves_fact_id === undefined || args.resolves_fact_id === null
        ? null
        : requireId(args.resolves_fact_id, 'resolves_fact_id')
      assertResolutionInput({ kind, confidence, resolves_fact_id: resolves })
      if (resolves !== null) {
        if (taskId === null) {
          throw refuse(STORE_CODES.resolutionInvalid, `resolves_fact_id=${resolves} 需要同时给 task_id：消解阻塞必须挂在同一个任务上`)
        }
        const target = this.#db()
          .prepare('SELECT id, task_id, kind, run_id FROM fact WHERE id = ?')
          .get(resolves)
        if (target === undefined || target.task_id !== taskId) {
          throw refuse(STORE_CODES.resolutionInvalid, `resolves_fact_id=${resolves} 不是任务 ${taskId} 上的事实：只能消解本任务的事实`)
        }
        if (target.kind !== 'blocker') {
          throw refuse(STORE_CODES.resolutionInvalid, `resolves_fact_id=${resolves} 的 kind=${target.kind} 不是 blocker：只能消解 blocker 事实`)
        }
        if (target.run_id !== run) {
          throw refuse(STORE_CODES.resolutionInvalid,
            `resolves_fact_id=${resolves} 属于别的 run：只能消解同任务、同 run 的 blocker`)
        }
      }
      const inserted = this.#insertFact({
        task_id: taskId,
        kind,
        statement,
        evidence_path: evidencePath,
        evidence_line: evidenceLine,
        confidence,
        created_by: createdBy,
        actor_session: optionalText(actorSessionId),
        run_id: run,
        resolves_fact_id: resolves,
      })
      const result = {
        fact_id: inserted.fact_id,
        task_id: taskId,
        kind,
        confidence,
        resolves_fact_id: resolves,
        created_at: inserted.created_at,
        /** 是否落在终态任务上的「晚到阻塞」。 */
        late,
        /** 晚到时的原结论状态（`accepted` / `cancelled` / 历史终态）；否则 null。 */
        late_of_status: late ? taskRow.status : null,
      }
      if (late) {
        result.next = '这条是**晚到阻塞**：任务状态没有被改写（结论不变），但它已经出现在默认看板的 '
          + 'late_blockers 区与详情板的 late_blockers 字段里，不会被藏起来。'
          + `下一步由主会话定：用 task_reject（reason 必填）对任务 ${taskId} 做**显式重新复核** —— `
          + '任务会置回 rejected、重新出现在默认待办板，之后才能正常消解这条阻塞或重做。'
      }
      return result
    })
  }

  /**
   * 记一次交接（两个子代理之间的任务转移）。
   * @param input - `{ task_id, from_child, to_child, note }`。
   * @param runId - 调用者的 run 归属。
   * @returns `{ handoff_id, task_id, from_child, to_child, created_at }`。
   */
  recordHandoff(input = {}, runId) {
    const args = input ?? {}
    const taskId = requireId(args.task_id, 'task_id')
    const fromChild = requireText(args.from_child, 'from_child')
    const toChild = requireText(args.to_child, 'to_child')
    const note = requireText(args.note, 'note')
    const run = requireRunId(runId)
    return withWriteTransaction(this.#db(), () => {
      this.#scopedTask(taskId, run, '记交接')
      const ts = nowIso()
      const info = this.#db()
        .prepare('INSERT INTO handoff (task_id, from_child, to_child, note, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(taskId, fromChild, toChild, note, run, ts)
      return {
        handoff_id: Number(info.lastInsertRowid),
        task_id: taskId,
        from_child: fromChild,
        to_child: toChild,
        created_at: ts,
      }
    })
  }

  /**
   * **提交待验收**（子代理的收口动作）：status → `submitted`。
   *
   * 这是执行者的终点，不是任务的终点 —— 最终 `accepted` 只能由主会话
   * 用 `acceptTask` 写入。允许从 `open`（未认领就交）与 `claimed` 提交；
   * 重复提交幂等（`already: true`）。
   * 已绑定任务由真实 owner 或 lead 提交；未绑定任务保留历史提交并返回兼容警告。
   * 状态/终态拒绝优先于权限冲突；submitted 的幂等重试同样检查真实 owner。
   * @param input - `{ task_id, note? }`。
   * @param runId - 调用者的 run 归属。
   * @param caller - 可信角色/会话（lead 或子代理 sessionId）；缺省保留未绑定宿主直连。
   * @param actorSessionId - 独立可信真实调用者会话，用于权限与事实审计。
   * @returns `{ task_id, status, submitted_at, fact_count, blockers, warnings, already }`。
   */
  submitTask(input = {}, runId, caller, actorSessionId) {
    const args = input ?? {}
    const taskId = requireId(args.task_id, 'task_id')
    const note = optionalText(args.note)
    const run = requireRunId(runId)
    return withWriteTransaction(this.#db(), () => {
      const row = this.#scopedTask(taskId, run, '提交')
      const ts = nowIso()
      const counts = this.#counts(taskId)
      const warnings = row.owner_session === null
        ? ['任务未绑定真实 owner_session：沿用历史提交兼容路径，无法据标签核验提交者'] : []
      if (row.status === 'submitted') {
        requireBoundOwner(row, taskId, caller, actorSessionId)
        return {
          task_id: taskId, status: 'submitted', submitted_at: row.updated_at, already: true,
          fact_count: counts.fact_count, blockers: counts.blockers, warnings,
        }
      }
      if (row.status !== 'open' && row.status !== 'claimed') {
        const terminal = this.#isTerminal(row.status)
        const message = `任务 ${taskId} 当前 status=${row.status}，不能提交验收；`
          + '只有 open / claimed 的任务可提交（rejected 需先 task_claim 重做）'
          + (terminal
            ? '；该任务已收口（终态）：终态结论不会被一条晚到的提交改写。'
              + '若结论确实需要推翻，由主会话 task_reject 做显式重新复核（置回 rejected）'
            : '')
        throw terminal ? refuse(STORE_CODES.terminal, message) : refuse(STORE_CODES.status, message)
      }
      requireBoundOwner(row, taskId, caller, actorSessionId)
      if (row.owner === null) {
        warnings.push(`任务 ${taskId} 没有认领者就直接提交：仍接受，但主会话无法核对该由谁交付，建议派单时先 task_claim`)
      }
      if (counts.fact_count === 0) {
        warnings.push(`任务 ${taskId} 没有任何事实落库就提交：提交缺少证据支撑，主会话核对时会被发现`)
      }
      if (counts.blockers > 0) {
        warnings.push(
          `任务 ${taskId} 有 ${counts.blockers} 条未解 blocker：此时主会话 task_accept 会被拒，`
          + '先解掉（落一条 decision 事实并带 resolves_fact_id）再提交',
        )
      }
      this.#transitionTask(row, 'submitted', ts)
      if (note !== null) {
        this.recordFact({
          task_id: taskId, kind: 'decision', statement: `提交验收：${note}`,
          // 署名反映**真实调用者**：主会话代交写 lead，认领者自己交写它自己。
          // 无条件用 row.owner 会把主会话的代交误记成"原 owner 自己提交"。
          child_id: caller === undefined || caller === null
            ? row.owner
            : (caller === LEAD_ACTOR ? LEAD_ACTOR : caller),
        }, run, caller, actorSessionId)
      }
      return {
        task_id: taskId, status: 'submitted', submitted_at: ts, already: false,
        fact_count: this.#counts(taskId).fact_count, blockers: counts.blockers, warnings,
        next: '等主会话核对；子代理不能自行把任务判为完成（task_accept 只有主会话能调）',
      }
    })
  }

  /**
   * **验收通过**（只有主会话能调）：status → `accepted`（**终态**）。
   *
   * v3 三道硬闸（全部是**可读错误**，不是 warning）：
   * ① `actor` 必须是 `'lead'`（身份判据在工具层，本层是纵深防御）；
   * ② **存在未解 blocker 一律拒绝**；
   * ③ **必须有执行依据**（任务上至少一条 `kind ∈ {fact, artifact}` 或带
   *    `evidence_path` 的事实）—— 没有执行依据时拒绝，除非给了 `waiver_reason`
   *    做**显式人工豁免**（豁免会以「人工豁免」字样写进验收记录，留痕可查）。
   *
   * 验收记录是**系统写入的裁决记录**，不是"已验证事实"：
   * `kind='decision'`、**`confidence='PLAUSIBLE'`**（无 evidence 不得标 `CONFIRMED`，
   * 那是"能指名证据行"的专属语义）、`evidence_path` 如实为空。
   *
   * @param input - `{ task_id, note?, waiver_reason? }`。
   * @param runId - 调用者的 run 归属。
   * @param actor - 调用者角色（`'lead'` 才放行）。
   * @returns `{ task_id, status, accepted_at, fact_count, resolved_blockers, evidence_basis, waiver, warnings }`。
   */
  acceptTask(input = {}, runId, actor, actorSessionId) {
    const args = input ?? {}
    const taskId = requireId(args.task_id, 'task_id')
    const note = optionalText(args.note)
    const waiverReason = optionalText(args.waiver_reason)
    const run = requireRunId(runId)
    if (actor !== LEAD_ACTOR) {
      throw refuse(STORE_CODES.notLead, 
        `验收只能由主会话执行（actor=${LEAD_ACTOR}），当前调用者角色是 ${JSON.stringify(actor)}：`
        + '子代理只能 task_submit 提交待验收，不能自行验收',
      )
    }
    return withWriteTransaction(this.#db(), () => {
      const row = this.#scopedTask(taskId, run, '验收')
      if (row.status !== 'submitted') {
        const terminal = this.#isTerminal(row.status)
        const message = `任务 ${taskId} 当前 status=${row.status}，不能验收；`
          + '必须先由执行者 task_submit 变成 submitted'
          + (terminal
            ? '；该任务已收口（终态）：验收不可重复，终态结论也不会被改写。'
              + '需要推翻结论（例如收口后出现了新的阻塞）时，由主会话 task_reject 做显式重新复核（reason 必填）'
            : '')
        throw terminal ? refuse(STORE_CODES.terminal, message) : refuse(STORE_CODES.status, message)
      }
      if (this.#scopeIntegrity(run, taskId).length > 0) {
        throw Object.assign(refuse(STORE_CODES.integrity,
          `任务 ${taskId} 存在归属不一致的事实或交接记录，拒绝验收；人工豁免不能绕过数据隔离。`), {
          hint: '停止自动重试与验收；先由管理员备份、核对并显式修复记录归属。task_board 的 scope_integrity 只报告异常数量，不返回其他 run 的内容。',
        })
      }
      const blockers = this.#unresolvedBlockers(taskId)
      if (blockers.length > 0) {
        const lines = blockers.map((b) => `#${b.fact_id} ${b.statement}`).join(' ； ')
        throw refuse(STORE_CODES.blockers, 
          `任务 ${taskId} 有 ${blockers.length} 条未解 blocker，拒绝验收：${lines}；`
          + '先解掉（落一条 decision 事实并带 resolves_fact_id=<blocker 的 fact_id>）再验收',
        )
      }

      // 验收门槛：有效 confidence 的 fact/artifact，或有效 confidence + 非空路径。
      // 判据不查内容是否正确（后者要人读证据文件）。
      const basis = this.#basisFacts(taskId)
      const strict = row.evidence_policy === 'execution'
      const executionReceipt = strict && waiverReason === null ? strictExecutionEvidence(this.#db(), this.root, row) : null
      if (!strict && basis.count === 0 && waiverReason === null) {
        throw refuse(
          STORE_CODES.evidenceMissing,
          `任务 ${taskId} 没有任何执行依据，拒绝验收：`
          + '验收要求任务上至少有一条 CONFIRMED/PLAUSIBLE 的证据事实（kind=fact / artifact，或带非空 evidence_path 的产物指针）；REFUTED 不计；'
          + '提交说明、打回理由、验收记录这些系统写入的 decision 记录都不算依据。'
          + '下一步：让执行者 task_fact 落证据（带 evidence_path[:line]）后再 task_submit，然后重新验收；'
          + '确实无法产出证据时（例如任务本身就是探索性调查、或被外部条件阻塞），'
          + '由主会话在 task_accept 里写明 waiver_reason 做**显式人工豁免** —— '
          + '豁免会以「人工豁免」字样落进验收记录，板上可查，不混入"已验证事实"。',
        )
      }

      const ts = nowIso()
      const counts = this.#counts(taskId)
      this.#transitionTask(row, 'accepted', ts)
      const shown = basis.fact_ids.slice(0, 8).map((id) => `#${id}`).join(', ')
      const basisLine = strict
        ? (waiverReason !== null ? `人工豁免：${waiverReason}；非验证通过` : `宿主执行回执 ${executionReceipt.receipt_id}（本代 ${row.evidence_generation}，真实 owner ${row.owner_session}）`)
        : `${waiverReason !== null ? `人工豁免：${waiverReason}；` : ''}`
        + `依据事实 ${basis.count} 条${shown ? `（${shown}${basis.fact_ids.length > 8 ? ' 等' : ''}；带产物指针 ${basis.with_pointer} 条）` : ''}`
      // 系统裁决记录走内部写入通道：此刻任务已是终态，公开通道会被终态闸门拦下。
      // confidence 固定 PLAUSIBLE：它没有 evidence，不该冒充"已验证事实"。
      this.#insertFact({
        task_id: taskId,
        kind: 'decision',
        statement: `验收通过${waiverReason !== null ? '（人工豁免）' : ''}：${note ?? '（无附注）'}；${basisLine}`,
        confidence: 'PLAUSIBLE',
        created_by: LEAD_ACTOR,
        actor_session: optionalText(actorSessionId),
        run_id: run,
      })
      if (strict && waiverReason !== null) {
        this.#db().prepare('INSERT INTO execution_waiver (task_id, run_id, evidence_generation, actor_session, reason, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(taskId, run, row.evidence_generation, optionalText(actorSessionId), waiverReason, latestExecution(this.#db(), row)?.receipt_id ?? null, ts)
      }
      const warnings = []
      if (!strict && counts.fact_count === 0) {
        warnings.push(`任务 ${taskId} 在零事实的情况下被验收通过：验收缺少证据基础`)
      }
      if (waiverReason !== null) {
        warnings.push(
          `任务 ${taskId} 走了**人工豁免**（waiver_reason=${JSON.stringify(waiverReason)}）：`
          + '这是例外通道，记录里已标明「人工豁免」，不构成"已验证事实"',
        )
      } else if (!strict && basis.with_pointer === 0) {
        warnings.push(
          `任务 ${taskId} 的依据事实（${basis.count} 条）都没有 evidence_path 产物指针：`
          + '满足门槛但可核查性弱，建议补一条带路径/行号的证据',
        )
      }
      if (basis.unattributed > 0) {
        warnings.push(
          `任务 ${taskId} 有 ${basis.unattributed} 条依据事实没有署名的 created_by（child_id）：`
          + '不影响验收（署名是标签不是权限），但不利于回溯是谁落的',
        )
      }
      return {
        task_id: taskId,
        status: 'accepted',
        accepted_at: ts,
        fact_count: counts.fact_count,
        resolved_blockers: 0,
        /** 被采信的依据事实（可复核索引：主会话据此回读那些事实与证据文件）。 */
        evidence_basis: basis,
        ...(strict ? { execution_verified: executionReceipt !== null, execution_receipt: executionReceipt?.receipt_id ?? null } : {}),
        /** `null` = 正常路径；有值 = 显式人工豁免（记录里同样标了「人工豁免」）。 */
        waiver: waiverReason === null ? null : { reason: waiverReason, by: LEAD_ACTOR, at: ts },
        warnings,
      }
    })
  }

  /**
   * **主会话的否决权**（只有主会话能调），`reason` 必填。两种语义，一条通道：
   *
   * · 任务 `submitted` → **打回**：status → `rejected`，退回执行者重做；
   * · 任务处于**终态**（`accepted` / `cancelled` / 历史终态）→ **显式重新复核**：
   *   把已签发的结论推翻，status → `rejected`，任务**重新回到默认待办板**
   *   （`rejected ∈ PENDING_STATUSES`），原认领者可以重新认领。
   *
   * 为什么复用同一条命令而不新增 `task_reopen`：语义一致（都是"主会话否决当前结论、
   * 退回重做"），且**不改变工具数量**（工具目录是模型侧可见契约，加一个名字要动的
   * 面比加一个分支大得多）。代价是描述必须写清，见 lib/tools/index.js 的 `task_reject`。
   *
   * 记录：落一条 `kind='decision'` 的裁决事实（**不是 blocker** —— 打回本身不该把任务
   * 卡死，否则重做后重新提交会因自造阻塞永远验不过）。它同样是**系统裁决记录**，
   * `confidence` 固定 `PLAUSIBLE`，不冒充"已验证事实"。
   * @param input - `{ task_id, reason }`。
   * @param runId - 调用者的 run 归属。
   * @param actor - 调用者角色（`'lead'` 才放行）。
   * @returns `{ task_id, status, rejected_at, reason, facts_to_fix, owner, next, reopened?, previous_status?, late_blockers? }`。
   */
  rejectTask(input = {}, runId, actor, actorSessionId) {
    const args = input ?? {}
    const taskId = requireId(args.task_id, 'task_id')
    const reason = requireText(args.reason, 'reason')
    const run = requireRunId(runId)
    if (actor !== LEAD_ACTOR) {
      throw refuse(STORE_CODES.notLead, 
        `打回只能由主会话执行（actor=${LEAD_ACTOR}），当前调用者角色是 ${JSON.stringify(actor)}：`
        + '子代理不能替主会话驳回自己的提交',
      )
    }
    return withWriteTransaction(this.#db(), () => {
      const row = this.#scopedTask(taskId, run, '打回')
      const reopened = this.#isTerminal(row.status)
      if (row.status !== 'submitted' && !reopened) {
        throw refuse(STORE_CODES.status, 
          `任务 ${taskId} 当前 status=${row.status}，不能打回；只有 submitted（待验收）的任务可被打回，`
          + '终态任务（accepted / cancelled / done / partial / failed）可由同一命令做**显式重新复核**',
        )
      }
      const counts = this.#counts(taskId)
      const lateBlockers = reopened ? this.#lateBlockersOf(run, taskId) : []
      const ts = nowIso()
      this.#transitionTask(row, 'rejected', ts)
      this.#db().prepare('UPDATE task SET evidence_generation = evidence_generation + 1 WHERE id = ? AND run_id IS ?').run(taskId, run)
      this.recordFact(
        {
          task_id: taskId,
          kind: 'decision',
          statement: reopened
            ? `重新复核（推翻 ${row.status} 结论）：${reason}`
              + (lateBlockers.length > 0
                ? `；同时挂起 ${lateBlockers.reduce((n, t) => n + t.blockers.length, 0)} 条未解晚到阻塞，需逐条处理`
                : '')
            : `验收打回：${reason}`,
          confidence: 'PLAUSIBLE',
          child_id: LEAD_ACTOR,
        },
        run, LEAD_ACTOR, actorSessionId,
      )
      return {
        task_id: taskId,
        status: 'rejected',
        rejected_at: ts,
        reason,
        facts_to_fix: counts.fact_count,
        owner: row.owner,
        /** `true` = 这次是推翻已收口结论的重新复核（任务已回到待办板）。 */
        reopened,
        /** 被推翻的原结论状态（仅 `reopened` 时有值）。 */
        previous_status: reopened ? row.status : null,
        /** 复核时任务上挂着的未解晚到阻塞（逐条列出，别让它再被藏起来）。 */
        late_blockers: lateBlockers,
        next: reopened
          ? '重新复核已生效：任务回到默认待办板（rejected），原认领者 task_claim 后可继续；'
            + '注意未解 blocker 必须先消解（落 decision + resolves_fact_id）才能再次 task_accept'
          : '让原认领者 task_claim 重做，或由主会话 task_claim 指派新 child_id；补事实后再 task_submit',
      }
    })
  }

  /**
   * **兼容别名**（旧调用方还在用 `closeTask`）。
   *
   * 语义映射：`done` / `partial` → `submitted`（提交待验收），
   * `failed` → `cancelled`（主动放弃）。**绝不产生 `accepted`**：
   * 验收通过只有 `acceptTask` 一条路。
   *
   * **v3 终态闸门（先查原状态）**：任务已收口时，`failed` 分支**不再**把
   * `accepted` 改写成 `cancelled` —— 这正是审计缺陷 1 的原始形态（主控先验收、
   * 子代理随后 `task_close(failed)`，任务被旧调用方改写）。终态一律拒绝并指路
   * `task_reject`（重新复核）。
   *
   * **取消闸门（本版新增）**：`failed` 分支在终态闸门之后追加
   * {@link requireCancelAuthority} —— 只有**主会话**或**任务当前 owner** 能取消，
   * 同 run 的竞争子代理会被 `E_TASK_CONFLICT` 拒绝且不产生任何写入。
   * `done`/`partial` 走 `submitTask`，`caller` 与真实会话**透传给提交用于权限和审计署名** ——
   * 已绑定任务校验真实 owner；未绑定任务保留历史兼容。
   * @param input - `{ task_id, result, note? }`。
   * @param runId - 调用者的 run 归属。
   * @param caller - 可信工具层派生的调用者（`'lead'` 或子代理 sessionId）；
   *   缺省且未绑定 = 宿主进程直连，沿用"只校验 run"的历史语义（见 requireCancelAuthority）。
   * @returns `done`/`partial`：与 `submitTask` 同形，另带 `alias_of:'submitTask'` 与 `mapped_status`；
   *   `failed`：`status:'cancelled'`，`alias_of:null`（取消路径**不是** submit 别名）与 `mapped_status`。
   */
  closeTask(input = {}, runId, caller, actorSessionId) {
    const args = input ?? {}
    const taskId = requireId(args.task_id, 'task_id')
    const result = requireOneOf(args.result, CLOSE_RESULTS, 'result')
    const run = requireRunId(runId)
    return withWriteTransaction(this.#db(), () => {
      const row = this.#scopedTask(taskId, run, '结任务')
      if (this.#isTerminal(row.status)) {
        throw refuse(
          STORE_CODES.terminal,
          `任务 ${taskId} 已收口（status=${row.status}），task_close 不能改写终态结论：`
          + `task_close 只是兼容别名（done/partial → submitted，failed → cancelled），对已收口的任务一律拒绝。`
          + '这是刻意的：终态一旦签发，旧调用方（可能是一个已经过期的子代理）不得再改写它。'
          + '需要继续做就开新任务；若这条结论确实错了（例如收口后又发现了阻塞），'
          + '由主会话 task_reject 做显式重新复核（reason 必填，任务会置回 rejected 并回到待办板）。',
        )
      }
      const ts = nowIso()
      if (result === 'failed') {
        // 终态闸门之后、任何写入之前：取消是破坏性动作，先证明调用者有资格。
        requireCancelAuthority(row, taskId, caller, actorSessionId)
        this.#transitionTask(row, 'cancelled', ts)
        const note = optionalText(args.note)
        if (note !== null) {
          this.#insertFact({
            task_id: taskId, kind: 'decision', statement: `取消任务：${note}`,
            confidence: 'PLAUSIBLE',
            // 署名必须反映**真实调用者**：主会话叫停写 lead，认领者自己放弃写它自己。
            // 无条件用 row.owner 会把主会话的取消误记成"原 owner 自己取消"。
            created_by: caller === undefined || caller === null
              ? row.owner
              : (caller === LEAD_ACTOR ? LEAD_ACTOR : caller),
            actor_session: optionalText(actorSessionId),
            run_id: run,
          })
        }
        const counts = this.#counts(taskId)
        return {
          task_id: taskId,
          status: 'cancelled',
          closed_at: ts,
          fact_count: counts.fact_count,
          blockers: counts.blockers,
          warnings: [],
          // failed → cancelled 是放弃，不是 submit 别名；自称 submitTask 会误导模型去等验收。
          alias_of: null,
          mapped_status: 'failed → cancelled（主动放弃，不可再验收）',
        }
      }
      // 别名路径同样带上 caller：署名要与真实调用者一致（绑定任务同样检查真实 owner）。
      const submitted = this.submitTask({ task_id: taskId, note: args.note }, run, caller, actorSessionId)
      return {
        ...submitted,
        closed_at: ts,
        alias_of: 'submitTask',
        mapped_status: `${result} → submitted（提交待验收；最终完成只能由主会话 task_accept）`,
      }
    })
  }

  /* ────────────────────────────── 读 ────────────────────────────── */

  /**
   * 读单个任务（行 + 计数）。任务不存在或跨 run 时抛可读错误。
   * @param input - task_id 数字或 `{ task_id }`。
   * @param runId - 调用者的 run 归属。
   * @returns `{ task, fact_count, last_fact_at, blockers, open }`。
   */
  taskOf(input = {}, runId) {
    return withReadTransaction(this.#db(), () => this.#taskOfSnapshot(input, runId))
  }

  #taskOfSnapshot(input = {}, runId) {
    const args = typeof input === 'number' ? { task_id: input } : (input ?? {})
    const taskId = requireId(args.task_id, 'task_id')
    const run = requireRunId(runId)
    const row = this.#scopedTask(taskId, run, '读取任务')
    const counts = this.#counts(taskId)
    return {
      task: row,
      fact_count: counts.fact_count,
      last_fact_at: counts.last_fact_at,
      blockers: counts.blockers,
      open: PENDING_STATUSES.includes(row.status),
    }
  }

  /**
   * 读板 —— 主会话核对的入口。
   *
   * **范围恒为本 run**（`runId` 缺省 = 未归属域，绝不等于"全部"）：
   * 无参数：返回本 run 的**待办任务**（`open / claimed / submitted / rejected`），
   * 每任务带最近 5 条事实摘要（紧凑，不倒全表）。**待验收任务必在列**。
   * 另带 `late_blockers` / `late_blocked_tasks`：已收口任务上仍未消解的**晚到阻塞**
   * （它们属于终态任务，不在 `tasks` 里，但必须可见 —— 主会话据此决定是否重新复核）。
   * 带 task_id：返回该任务详情（事实最多 50 条、handoff 最多 10 条；带 `task.late`
   * 与 `late_blockers`）。
   * 库为空不是错误：返回 `tasks: []`。
   * @param input - 空 / task_id 数字 / `{ task_id }`。
   * @param runId - 调用者的 run 归属。
   * @returns 板对象（scope = `open` 或 `task`）。
   */
  board(input = {}, runId) {
    return withReadTransaction(this.#db(), () => this.#boardSnapshot(input, runId))
  }

  /** Bounded model-facing board; the old board remains a host compatibility API. */
  boardPage(input = {}, runId) {
    const args = pageInput(input)
    const run = requireRunId(runId)
    return withReadTransaction(this.#db(), () => {
      if (args.task_id !== undefined) this.#scopedTask(args.task_id, run, '读取分页看板')
      return boardPageSnapshot(this.#db(), args, run, PENDING_STATUSES,
        () => this.#boardSnapshot({ task_id: args.task_id }, run, true))
    })
  }

  #boardSnapshot(input = {}, runId, pagedDetail = false) {
    const args = typeof input === 'number' ? { task_id: input } : (input ?? {})
    const run = requireRunId(runId)
    if (args.task_id !== undefined && args.task_id !== null) {
      const detail = this.#taskOfSnapshot({ task_id: args.task_id }, run)
      const byKind = {}
      const byConfidence = {}
      const all = this.#db()
        .prepare('SELECT kind, confidence, COUNT(*) AS n FROM fact WHERE task_id = ?'
          + ' AND run_id IS (SELECT run_id FROM task WHERE id = fact.task_id) GROUP BY kind, confidence')
        .all(detail.task.id)
      for (const row of all) {
        byKind[row.kind] = (byKind[row.kind] ?? 0) + Number(row.n)
        byConfidence[row.confidence] = (byConfidence[row.confidence] ?? 0) + Number(row.n)
      }
      return {
        scope: 'task',
        scope_integrity: this.#scopeIntegrity(run, detail.task.id),
        task: {
          id: detail.task.id,
          title: detail.task.title,
          note: detail.task.note,
          status: detail.task.status,
          owner: detail.task.owner,
          owner_session: detail.task.owner_session,
          evidence_policy: detail.task.evidence_policy,
          evidence_generation: detail.task.evidence_generation,
          verification_files: detail.task.verification_files ? JSON.parse(detail.task.verification_files) : null,
          verification_command: detail.task.verification_command,
          verification_cwd: detail.task.verification_cwd,
          run_id: detail.task.run_id,
          created_at: detail.task.created_at,
          updated_at: detail.task.updated_at,
          open: detail.open,
          /** 终态：结论已签发，普通写入不能再改写（要推翻走主会话 task_reject 重新复核）。 */
          late: this.#isTerminal(detail.task.status),
          fact_count: detail.fact_count,
          last_fact_at: detail.last_fact_at,
          blockers: detail.blockers,
        },
        receipts: this.#db().prepare('SELECT * FROM execution_receipt WHERE task_id = ? AND run_id IS ? ORDER BY id DESC LIMIT 10').all(detail.task.id, run).map(receiptRow),
        execution_waivers: this.#db().prepare('SELECT * FROM execution_waiver WHERE task_id = ? AND run_id IS ? ORDER BY id DESC LIMIT 10').all(detail.task.id, run),
        counts: { by_kind: byKind, by_confidence: byConfidence },
        facts: this.#factRows(detail.task.id, TASK_FACTS_LIMIT).map((row) => ({
          id: row.id,
          kind: row.kind,
          confidence: row.confidence,
          statement: row.statement,
          evidence: row.evidence_path === null
            ? null
            : (row.evidence_line === null ? row.evidence_path : `${row.evidence_path}:${row.evidence_line}`),
          by: row.created_by,
          actor_session: row.actor_session,
          at: row.created_at,
        })),
        handoffs: this.#db()
          .prepare(
            'SELECT id, task_id, from_child, to_child, note, created_at FROM handoff'
            + ' WHERE task_id = ? AND run_id IS (SELECT run_id FROM task WHERE id = handoff.task_id) ORDER BY id DESC LIMIT ?',
          )
          .all(detail.task.id, TASK_HANDOFFS_LIMIT),
        /** 该任务上的未解晚到阻塞（终态任务的 blocker，不会被静默隐藏）。 */
        late_blockers: pagedDetail ? [] : this.#lateBlockersOf(run, detail.task.id),
        validation_warnings: detail.task.status === 'accepted' && detail.task.evidence_policy === 'legacy'
          && (pagedDetail ? !hasBasisFact(this.#db(), detail.task.id, run) : this.#basisFacts(detail.task.id).count === 0)
          ? [{ code: 'W_EVIDENCE_REVIEW', message: '历史验收缺少当前有效依据，请人工核对；可能存在人工豁免，原验收状态保持不变。' }]
          : [],
        note: 'facts 最近在前，statement 未截断（最多 ' + TASK_FACTS_LIMIT + ' 条）。'
          + 'blockers = **未解** blocker 计数（同任务同 run 的有效 decision 指向后才算解决）。'
          + 'task.late=true 表示该任务已收口；late_blockers 列出收口之后落下、尚未消解的阻塞。',
      }
    }

    const placeholders = PENDING_STATUSES.map(() => '?').join(', ')
    const rows = this.#db()
      .prepare(
        `${BOARD_SELECT} WHERE t.run_id IS ? AND t.status IN (${placeholders})`
        + ' ORDER BY t.updated_at DESC, t.id DESC',
      )
      .all(run, ...PENDING_STATUSES)
    // Fetch at most FACTS_PER_TASK rows per task in one query. Partition only
    // after both parent and fact run checks, so corrupt rows cannot consume a
    // scoped task's summary allowance. No per-task round trips or ID bind list.
    const factsByTask = new Map()
    if (rows.length > 0) {
      const summaries = this.#db().prepare(
        'WITH ranked AS (SELECT f.id, f.task_id,'
        + ' ROW_NUMBER() OVER (PARTITION BY f.task_id ORDER BY f.id DESC) AS fact_rank'
        + ' FROM fact f JOIN task t ON t.id = f.task_id AND f.run_id IS t.run_id'
        + ` WHERE t.run_id IS ? AND t.status IN (${placeholders}))`
        + ' SELECT f.id, f.task_id, f.kind, f.statement, f.evidence_path, f.evidence_line,'
        + ' f.confidence, f.created_by, f.actor_session, f.created_at FROM ranked r JOIN fact f ON f.id = r.id'
        + ' WHERE r.fact_rank <= ? ORDER BY f.task_id, f.id DESC',
      ).all(run, ...PENDING_STATUSES, FACTS_PER_TASK)
      for (const fact of summaries) {
        if (!factsByTask.has(fact.task_id)) factsByTask.set(fact.task_id, [])
        factsByTask.get(fact.task_id).push(fact)
      }
    }
    const tasks = rows.map(row => this.#taskBrief(row, factsByTask.get(row.id) ?? []))
    const submitted = tasks.filter((t) => t.status === 'submitted').length
    // 终态任务上的未解「晚到阻塞」：它们不属于待办集合，但**绝不能因此消失** ——
    // 单独成区列在板上（v3 修复审计缺陷 1 的第二个场景："晚到阻塞不会回到待办"）。
    const lateBlockers = this.#lateBlockersOf(run)
    return {
      scope: 'open',
      run_id: run,
      scope_integrity: this.#scopeIntegrity(run),
      open_tasks: tasks.length,
      submitted_tasks: submitted,
      tasks,
      late_blockers: lateBlockers,
      late_blocked_tasks: lateBlockers.length,
      note: `本 run（${describeRun(run)}）的待办任务（${PENDING_STATUSES.join('/')}），`
        + `每任务 facts 为该任务最近 ${FACTS_PER_TASK} 条摘要（statement 截断到 ${STATEMENT_CHARS} 字符）。`
        + `其中 ${submitted} 个待验收（submitted）—— 那是主会话的待办来源。`
        + `late_blockers = 已收口任务上仍未消解的晚到阻塞（${lateBlockers.length} 个任务）：`
        + '它们不改变结论，但需要主会话 task_reject 重新复核后才能处理。'
        + '核对请用 task_id 读详情并对证据文件。',
    }
  }

  /** One read snapshot for the per-step projection; never expands board facts. */
  workingState(runId) {
    const run = requireRunId(runId)
    const placeholders = PENDING_STATUSES.map(() => '?').join(', ')
    const row = this.#db().prepare(
      'SELECT (SELECT COUNT(*) FROM fact WHERE run_id IS ?) AS fact_count,'
      + ` (SELECT COUNT(*) FROM task WHERE run_id IS ? AND status IN (${placeholders})) AS active_tasks,`
      + ' current.id AS task_id, current.title AS task_title FROM (SELECT 1) AS seed'
      + ' LEFT JOIN (SELECT id, title FROM task WHERE run_id IS ?'
      + ` AND status IN (${placeholders})`
      + " ORDER BY CASE WHEN status = 'claimed' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1) AS current ON 1 = 1",
    ).get(run, run, ...PENDING_STATUSES, run, ...PENDING_STATUSES)
    const state = { activeTasks: Number(row.active_tasks), factCount: Number(row.fact_count) }
    if (row.task_id !== null) state.task = { id: row.task_id, title: row.task_title }
    return state
  }

  /**
   * 本域计数。
   * @param runId - 调用者的 run 归属（缺省 = 未归属域）。
   * @returns `{ run_id, tasks, facts, blockers_open, blockers_late }`
   *   （`blockers_open` = 待办任务上的未解 blocker；`blockers_late` = 已收口任务上的未解晚到阻塞）。
   */
  stats(runId) {
    return withReadTransaction(this.#db(), () => this.#statsSnapshot(runId))
  }

  #statsSnapshot(runId) {
    const run = requireRunId(runId)
    const db = this.#db()
    const tasks = { total: 0, open: 0, claimed: 0, submitted: 0, accepted: 0, rejected: 0, cancelled: 0, done: 0, partial: 0, failed: 0 }
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM task WHERE run_id IS ? GROUP BY status').all(run)) {
      tasks[row.status] = Number(row.n)
      tasks.total += Number(row.n)
    }
    const facts = { total: 0, by_kind: {}, by_confidence: {} }
    for (const row of db.prepare('SELECT kind, COUNT(*) AS n FROM fact WHERE run_id IS ? GROUP BY kind').all(run)) {
      facts.by_kind[row.kind] = Number(row.n)
      facts.total += Number(row.n)
    }
    for (const row of db.prepare('SELECT confidence, COUNT(*) AS n FROM fact WHERE run_id IS ? GROUP BY confidence').all(run)) {
      facts.by_confidence[row.confidence] = Number(row.n)
    }
    // 与 board 共用同一判据（PENDING_STATUSES），避免"待办集合"在两处漂移。
    const pendingPlaceholders = PENDING_STATUSES.map(() => '?').join(', ')
    const open = db
      .prepare(
        "SELECT COUNT(*) AS n FROM fact b JOIN task t ON t.id = b.task_id AND b.run_id IS t.run_id"
        + ` WHERE b.kind = 'blocker' AND t.run_id IS ? AND t.status IN (${pendingPlaceholders})`
        + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'b')})`,
      )
      .get(run, ...PENDING_STATUSES)
    const late = db
      .prepare(
        "SELECT COUNT(*) AS n FROM fact b JOIN task t ON t.id = b.task_id AND b.run_id IS t.run_id"
        + ` WHERE b.kind = 'blocker' AND t.run_id IS ? AND t.status NOT IN (${pendingPlaceholders})`
        + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'b')})`,
      )
      .get(run, ...PENDING_STATUSES)
    return {
      run_id: run,
      tasks,
      facts,
      blockers_open: Number(open?.n ?? 0),
      blockers_late: Number(late?.n ?? 0),
    }
  }

  /**
   * **显式命名的跨 run 统计**（唯一会跨过隔离边界读全局的方法）。
   *
   * 刻意不叫 `stats()`：默认范围绝不放宽，需要全局就必须写出这个名字。
   * @returns `{ runs, unassigned, tasks, facts, blockers_open }`。
   */
  statsAllRuns() {
    const db = this.#db()
    const tasks = { total: 0 }
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM task GROUP BY status').all()) {
      tasks[row.status] = Number(row.n)
      tasks.total += Number(row.n)
    }
    const facts = { total: Number(db.prepare('SELECT COUNT(*) AS n FROM fact').get()?.n ?? 0) }
    const runs = db
      .prepare("SELECT COUNT(DISTINCT run_id) AS n FROM task WHERE run_id IS NOT NULL")
      .get()
    const open = db
      .prepare(
        "SELECT COUNT(*) AS n FROM fact b JOIN task t ON t.id = b.task_id AND b.run_id IS t.run_id"
        + " WHERE b.kind = 'blocker' AND t.status IN ('open', 'claimed', 'submitted', 'rejected')"
        + ` AND NOT EXISTS (SELECT 1 FROM fact r WHERE ${validResolutionSql('r', 'b')})`,
      )
      .get()
    return {
      scope: 'all_runs',
      runs: Number(runs?.n ?? 0),
      unassigned: this.unassignedSummary(),
      tasks,
      facts,
      blockers_open: Number(open?.n ?? 0),
      note: '这是显式跨 run 视图：默认的 board()/stats() 都只看单个 run，不会走到这里。',
    }
  }
}

/** 告警永不阻断激活。 */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`taskforce-store: ${message}`)
  } catch {
    /* 诊断失败不影响功能 */
  }
}

/**
 * Cordis 入口：建实例、绑生命周期、发布服务。
 * @param ctx - host 插件上下文。
 * @param config - `{ root?: string }`。
 */
export function apply(ctx, config = {}) {
  const store = new TaskforceStore(resolveRoot(config), {
    busyTimeoutMs: config.busyTimeoutMs,
    journalMode: config.journalMode,
  })

  // effect 立即执行回调；返回值即 fiber 的 disposer（卸载时关句柄）。
  ctx.effect(() => {
    try {
      store.open()
      const { added_columns: added, unassigned } = store.migration
      if (added.length > 0) {
        ctx.logger?.info?.(`taskforce-store: 已迁移列 ${added.join(', ')}（旧行 run_id 为 NULL = 未归属，数据未动）`)
      }
      const orphans = unassigned.task + unassigned.fact + unassigned.handoff
      if (orphans > 0) {
        warn(
          ctx,
          `有 ${orphans} 行未归属历史数据（task=${unassigned.task} fact=${unassigned.fact} handoff=${unassigned.handoff}）：`
          + '它们不参与任何 run 的视图；需要纳管时由宿主调用 adoptUnassigned(runId) 接管',
        )
      }
    } catch (error) {
      // 打开失败不拖垮 boot：服务照常发布，首次调用会重试并抛出可读错误。
      warn(ctx, `${messageOf(error)}（将在首次调用时重试）`)
    }
    return () => {
      store.close()
    }
  })

  // 同步发布：返回的 disposer 由 fiber 拥有，卸载时自动注销。
  ctx.provide('taskforceStore', store)

  try {
    ctx.logger?.info?.(`taskforce-store: 事实库就绪 → ${store.dbPath}`)
  } catch {
    /* logging 可选 */
  }
}
