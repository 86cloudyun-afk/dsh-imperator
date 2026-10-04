# 事实库 · 一页说明（v3：工作实例隔离 + 提交/验收分离 + 终态冻结与验收门槛）

`lib/store/index.js`（host 平面插件，发布 `taskforceStore`）
＋ `lib/tools/index.js`（agent 平面插件，注册 10 个模型可见工具：8 个 `task_*` 事实库工具 + `task_child_send` / `task_child_stop` 子代理控制工具，后者见 `docs/CONTROL.md`）
＋ `tools/verify-store.mjs`（P2 既有自测：列 / 闭环 / 编译器等价）
＋ `tools/verify-store-v2.mjs`（v2 自测：run 隔离 / 权限 / 迁移）
＋ `tools/verify-store-v3.mjs`（v3 自测：终态冻结 / 晚到阻塞 / 验收门槛）

**它解决什么**：消息只保证「已接受」、结算通知只投一次、`inactive ≠ 有结果`，
**只有共享状态持久**。所以子代理必须把事实落库，主会话**读库核对**，而不是听自述。

**v2 补上的两个缺口**：

| 缺口 | 症状 | 修法 |
|---|---|---|
| A 工作实例隔离 | 本机上百个会话并行，两个主会话会互相看到甚至互相关单 | 每行带 `run_id`，由**宿主按调用者身份推导**，查询/写入恒按本 run 过滤 |
| B 提交与验收分离 | 子代理能自己 `task_close(done)` = 执行者自批 | 状态机加 `submitted` / `accepted` / `rejected`；`task_accept` / `task_reject` **只有主会话能调** |

**v3 补上的两个生命周期缺陷**（来自独立交付审计）：

| 缺陷 | 审计复现 | 修法（本版） |
|---|---|---|
| C 验收终态可被旧子代理改写 | 主控先验收，子代理随后 `task_close(result="failed")` ⇒ 返回 `ok:true`，任务从 `accepted` **被改成 `cancelled`** | `accepted` / `cancelled` / 历史终态 = **冻结**：`closeTask` 的 `failed` 分支**先查原状态**，终态一律拒绝（`E_TERMINAL`）；终态上除 `kind=blocker` 外**拒绝新事实** |
| D 晚到阻塞不回到待办 | 主控先验收，子代理随后写 `kind="blocker"` ⇒ 任务仍 `accepted`，默认待办板**不显示**它 | 晚到阻塞**允许落库**并标 `late`，**不自动改结论**，但立刻出现在默认看板 `late_blockers` 区；要推翻结论走主会话 `task_reject` = **显式重新复核**（置回 `rejected`，回板） |
| E 零执行证据也能验收 | `task_open → task_submit → task_accept`（无认领者 / 无事实 / 无产物 / 无证据）仍得 `accepted` | **验收门槛**：至少一条属于该任务的 `fact` / `artifact`（或带 `evidence_path` 的产物指针），否则**拒绝**（`E_EVIDENCE_MISSING`）；无法产出证据时走 `waiver_reason` 显式人工豁免 |
| F 系统记录冒充已验证事实 | 自动写入的「验收通过：（无附注）」是 `CONFIRMED`，`evidence` 为 null | 验收 / 打回记录统一为 **`decision` + `PLAUSIBLE`**，`evidence` 如实为空，并列出被采信的依据事实 id；豁免记录标「人工豁免」 |

## 归属一致性补充（2026-09-30）

任务详情、事实摘要、交接记录、计数、证据筛选、晚到阻塞与 `v_run_board` 同时校验附属行和任务的 run。`NULL` 与具体 run 不混用。默认看板和详情板新增 `scope_integrity`，只列本 run 任务 ID 及归属异常行数，不暴露异域内容；包括已验收任务的异常，不会因任务离开待办而隐去。原始数据和历史结论不自动修改。验收遇到异常报 `E_STORE_INTEGRITY`，`waiver_reason` 不能绕过。应先备份并人工核对数据归属，不能自动重试。旧 `v_task_board` 保留历史形状与口径，不是 run 隔离接口。

`workingState(runId)` 是供每步投影使用的只读服务方法（不是新增模型工具）：单个 SQL 快照返回 `factCount`、全部待办状态的 `activeTasks` 和可选的 `{id,title}` 当前任务，不展开事实正文。详见 [整仓补强](PROJECT_HARDENING.md)。

## 一、数据位置与时序

| 项 | 值 |
|---|---|
| 库文件 | `$DSH_HOME/taskforce/taskforce.db`（目录不存在自动建） |
| 回退顺序 | `config.root` → `$TASKFORCE_HOME` → `$DSH_HOME/taskforce` → `$HOME/.dsh/taskforce` |
| 时间戳 | 一律 UTC ISO8601（`new Date().toISOString()`，带毫秒与 `Z`） |
| 驱动 | `node:sqlite` 的 `DatabaseSync`（Node 22.23 实测；加载时的 ExperimentalWarning 属正常） |
| 依赖 | 零外部依赖，只用 `node:` 内置模块 |

## 二、表结构（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` 幂等迁移）

| 表 | 列 |
|---|---|
| `task` | `id INTEGER PK`, `title TEXT NOT NULL`, `note TEXT`, `status TEXT NOT NULL DEFAULT 'open'`, `owner TEXT`, **`run_id TEXT`**, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL` |
| `fact` | `id INTEGER PK`, `task_id INTEGER`, `kind TEXT NOT NULL`, `statement TEXT NOT NULL`, `evidence_path TEXT`, `evidence_line INTEGER`, `confidence TEXT NOT NULL`, `created_by TEXT`, **`run_id TEXT`**, **`resolves_fact_id INTEGER`**, `created_at TEXT NOT NULL` |
| `handoff` | `id INTEGER PK`, `task_id INTEGER`, `from_child TEXT`, `to_child TEXT`, `note TEXT NOT NULL`, **`run_id TEXT`**, `created_at TEXT NOT NULL` |

**迁移**（`TaskforceStore.migrate()`）：读 `PRAGMA table_info(<表>)`，缺哪列就 `ALTER TABLE ... ADD COLUMN`
补哪列。**只加列**，不重写表、不改既有行 —— 旧库升级后数据一条不少。

- 旧行的 `run_id` 为 `NULL` = **未归属**（不是被塞进某个 run）。
- 引用新列的索引与 `v_run_board` 视图放在**后置 DDL**里、在列迁移之后执行：
  旧库没有 `run_id` 列，若把它们写进主 DDL，`exec(DDL)` 会在这一句上抛
  `no such column: run_id`，连带跳过后面所有建表语句。
- 迁移幂等：重复 `open()` 不会重复加列。

索引：`idx_fact_task_id` / `idx_handoff_task_id` / `idx_task_run_status` / `idx_fact_run` / `idx_fact_resolves` / `idx_handoff_run`。
视图：`v_task_board`（**7 列，保持 v1 形状及历史总 blocker 计数不变**，不参与服务 API）与 `v_run_board`（带 `run_id` 与当前有效决策判据下的未解 blocker 计数，供人工 SQL；迁移时在同一事务中重建，列形状不变）。

白名单（应用层校验，不写 CHECK 约束，避免约束落后把合法写入打成硬错误）：

- `kind ∈ {fact, artifact, decision, blocker}`
- `confidence ∈ {CONFIRMED, PLAUSIBLE, REFUTED}`
- 状态：`open`（= 设计稿的 `pending`）/ `claimed` / `submitted` / `accepted` / `rejected` / `cancelled`，
  另有三个**只读历史终态** `done` / `partial` / `failed`（迁移前的旧行保留原值，不自动改写）
- **待办集合** `PENDING_STATUSES = open | claimed | submitted | rejected` —— 默认看板的范围
- **终态集合** `TERMINAL_STATUSES = accepted | cancelled | done | partial | failed` —— 结论冻结，普通写入不得改写（见第五节）
- 可认领集合 `CLAIMABLE_STATUSES = open | rejected`（打回后可再认领；终态不可认领）

## 三、工作实例归属（run）与双域模型

作用域一切以 `run_id` 为准，而 `run_id` **只能来自宿主**：

```
exec.agent  (宿主在 agent 循环里塞进每次工具执行)
  └─ agent.session.header
       ├─ 非子代理（无 origin='subagent' 且 depth=0，含手工 fork 的主会话） ⇒ run = 自身 sessionId
       └─ 子代理 ⇒ 沿 header.parentSession 用 ctx.agents.get(id) 上溯到第一个非子代理祖先
                   ⇒ run = 该根会话 id（同一棵树共享一个 run）
```

**祖先解析不到的两种情况**（主会话重启后父已不在活动表是常态）：

| 情况 | 处理 | 依据 |
|---|---|---|
| `depth === 1`（父不在活动表） | **直接把父 id 当 run** | `delegationDepth` 语义是"父 depth + 1"（`dsh-subagent/lib/types/child-agent.js:33`），所以 depth=1 的会话其父 depth 必然是 0 = 顶层 = 本树的根；`parentSession` 由宿主在 `childSessionMeta()` 落盘，模型无法伪造 |
| `depth > 1`（中间层不在活动表） | **拒绝服务**（`E_BROKEN_CHAIN`） | 无法断定中间层是不是子代理，宁可不服务也不串 run |

> 实测（本机 96 个真实落盘会话的头元数据）：40 个主会话 + 56 个子代理**全部推导成功、
> 零链断**，合并出 48 个 run，其中 11 棵树含多个会话（最大一棵 13 个会话共享同一 run），
> 同一 session 重复推导结果完全一致。

**硬规则**：

1. **`runId` 是独立的位置参数，绝不放进入参对象**（`openTask(input, runId)`）。
   一旦它成为 `input.run_id`，模型就能伪造归属。
2. 子代理判据 = `header.origin === 'subagent'` 或 `delegationDepth > 0`。
   **`parentSession` 单独存在不算子代理** —— 它同时表达 fork 血缘，手工 fork 出来的主会话
   不应因此丢掉验收权。
3. **身份推不出来时拒绝服务**（`ok:false` + `code`），绝不退化成"看全部"，也绝不落到未归属域兜底。
4. 跨 run 操作**明确拒绝**并给可读错误（"任务 N 属于 run X，当前调用者属于 run Y"），
   而不是含糊的"不存在"。

由此形成双域：

| 域 | `run_id` | 谁在用 |
|---|---|---|
| **run 域** | 非空字符串 | 模型可见工具走的唯一通道，按 run 隔离 |
| **未归属域** | `NULL` | 迁移前的历史行；宿主侧直接调服务、不声明 run 的调用 |

**未归属域永远不出现在任何 run 的视图里**（`WHERE t.run_id IS ?` 用 SQLite 的 NULL 安全比较），
run 域的操作也永远碰不到它。默认范围没有任何一路会退化成"看全部"。

## 四、服务 API（`ctx.provide('taskforceStore', store)`，host 平面）

**所有读写方法的最后一个位置参数都是 `runId`**（字符串 = run 域；缺省 / `null` = 未归属域）。

| 方法 | 入参 | 返回 |
|---|---|---|
| `openTask` | `({ title, note? }, runId)` | `{ task_id, title, status, run_id, created_at }` |
| `claimTask` | `({ task_id, child_id }, runId)` | `{ task_id, owner, status:'claimed', claimed_at, already }` |
| `recordFact` | `({ task_id?, kind, statement, evidence_path?, evidence_line?, confidence?, child_id?, resolves_fact_id? }, runId)` | `{ fact_id, task_id, kind, confidence, resolves_fact_id, created_at, late, late_of_status, next? }`（`late:true` = 落在终态任务上的**晚到阻塞**；终态上非 blocker 一律 `E_TERMINAL`） |
| `recordHandoff` | `({ task_id, from_child, to_child, note }, runId)` | `{ handoff_id, task_id, from_child, to_child, created_at }` |
| `submitTask` | `({ task_id, note? }, runId)` | `{ task_id, status:'submitted', submitted_at, fact_count, blockers, warnings[], next }` |
| `acceptTask` | `({ task_id, note?, waiver_reason? }, runId, actor)`（`actor` 必须 `'lead'`；`waiver_reason` = 显式人工豁免） | `{ task_id, status:'accepted', accepted_at, fact_count, resolved_blockers, evidence_basis{count,fact_ids,with_pointer,unattributed}, waiver, warnings[] }`；缺依据且无豁免 → `E_EVIDENCE_MISSING` |
| `rejectTask` | `({ task_id, reason }, runId, actor)`（`reason` 必填） | `submitted` → `{ task_id, status:'rejected', rejected_at, reason, facts_to_fix, owner, reopened:false, previous_status:null, late_blockers:[], next }`；**终态 → 重新复核** `{ …, reopened:true, previous_status:'accepted', late_blockers:[…] }` |
| `closeTask` | `({ task_id, result ∈ done/partial/failed, note? }, runId)` | **兼容别名**：`done`/`partial` → `submitted`（附注转交 `submitTask`，`alias_of:'submitTask'`），`failed` → `cancelled`（有附注时写取消裁决，`alias_of:null` —— 取消不是 submit 别名）；返回体另带 `mapped_status`。**永不产生 `accepted`**；**终态任务一律拒绝**（`E_TERMINAL`，先查原状态） |
| `taskOf` | `(task_id \| { task_id }, runId)` | `{ task, fact_count, last_fact_at, blockers, open }` |
| `board` | `({} \| { task_id }, runId)` | 见下 |
| `stats` | `(runId)` | `{ run_id, tasks{…}, facts{…}, blockers_open, blockers_late }`；缺省 = 未归属域 |
| `statsAllRuns` | — | **显式命名的跨 run 视图**（唯一会跨过隔离边界的读方法） |
| `unassignedSummary` | — | `{ task, fact, handoff }` 未归属行计数（只读诊断） |
| `adoptUnassigned` | `(runId)` | 把全部未归属行显式接管到该 run；`runId` 为 `null` 时拒绝 |

`board({}, runId)` 无 `task_id`：`{ scope:'open', run_id, open_tasks, submitted_tasks, tasks[], late_blockers[], late_blocked_tasks, note }`，
范围 = 本 run 的**待办**任务（`open / claimed / submitted / rejected`），每任务带**最近 5 条**事实摘要
（`statement` 截断到 160 字符、`evidence` 合成 `path:line`）；**`submitted` 必在列**（主会话的待办来源）。
库为空返回 `tasks: []`，不报错。
`late_blockers` = **已收口任务上仍未消解的阻塞**（每项 `{ task_id, title, status, owner, blockers:[{fact_id,statement,by,at}] }`）：
它们不属于待办集合（结论没被自动改写），但**必须可见** —— 这是"晚到阻塞不会回到待办"的修复点。
`board({task_id}, runId)`：`{ scope:'task', task（含 `late`）, counts:{by_kind,by_confidence}, facts[]（≤50，最近在前，不截断）, handoffs[]（≤10）, late_blockers[], validation_warnings[] }`。历史 `accepted` 如缺当前有效依据，返回 `{code:'W_EVIDENCE_REVIEW',message}` 提醒人工核对（可能曾人工豁免）；状态不自动回滚，且不解析验收文案猜测豁免。

`blockers` 字段是**未解** blocker 计数：只有一条**同任务、同 run（包括双方 NULL）、`kind='decision'` 且 `confidence ∈ {CONFIRMED,PLAUSIBLE}`** 的事实以 `resolves_fact_id` 指向 blocker，才算消解。旧库畸形、REFUTED、跨任务或跨 run 的伪关联不消解；`v_task_board.blockers` 仍是历史总数，不能据此推断未解数量。

## 五、状态机（子代理不能自批；终态冻结）

```
open ──claim──▶ claimed ──submit──▶ submitted ──accept──▶ accepted（终态）
  ▲                ▲                    │                    │
  │                └──────reject────────┘                    │
  │                                                          │
  └──── cancelled（task_close(failed) 的语义 · 终态）◀────────┘
                   ▲
                   └── task_reject 对终态任务 = 重新复核（置回 rejected，回到待办板）
```

### 5.1 每种状态允许的动作（代码同款表在 `lib/store/index.js` 头注释）

| 状态 | `claim` | `fact`(fact/artifact/decision) | `fact`(blocker) | `submit` | `accept` | `reject`(lead) | `close`(done/partial) | `close`(failed) |
|---|---|---|---|---|---|---|---|---|
| `open` | ✓ | ✓ | ✓ | ✓ → submitted | ✗（非 submitted） | ✗ | ✓ → submitted | ✓ → cancelled |
| `claimed` | ✓（同 owner 幂等） | ✓ | ✓ | ✓ → submitted | ✗ | ✗ | ✓ → submitted | ✓ → cancelled |
| `submitted` | ✗ | ✓ | ✓ | ✓（幂等） | ✓ → accepted | ✓ → rejected | ✓（幂等） | ✓ → cancelled |
| `rejected` | ✓ | ✓ | ✓ | ✗ `E_STATUS`（须先 claim） | ✗ | ✗ | ✗ `E_STATUS`（须先 claim） | ✓ → cancelled |
| **终态** | ✗ `E_TERMINAL` | ✗ `E_TERMINAL` | ✓ **晚到阻塞**（不改结论） | ✗ `E_TERMINAL` | ✗ `E_TERMINAL` | ✓ **重新复核** → rejected | ✗ `E_TERMINAL` | ✗ `E_TERMINAL` |

终态 = `accepted` / `cancelled` / `done` / `partial` / `failed`。终态任务上 `claim` **先判状态再判 owner**：
报"已收口"比报"已被某人认领"更准确 —— 后者会诱导调用方去找原认领者转手，而终态的正确出路是重新复核。

### 5.2 硬规则

| 规则 | 判据 |
|---|---|
| 子代理只能 `task_submit` | 提交后进 `submitted`，**不是完成**；仍出现在默认看板 |
| 只有主会话能 `task_accept` / `task_reject` | 身份判据在**工具层强制**（`identity.isRoot`），数据层再用 `actor === 'lead'` 二次校验（纵深防御） |
| **终态冻结**（v3） | 已收口任务的结论**不被任何普通写入改写**：`closeTask(failed)` 分支**先查原状态**，`claim` / `submit` / `accept` / `close` / 非 blocker 落事实 一律拒绝（`E_TERMINAL` + 可读错误），错误里指路 `task_reject` |
| **晚到阻塞不静默**（v3） | 终态上**唯一**允许的新写入是 `kind='blocker'`：它**不改状态**（结论不被自动推翻），但立刻进默认看板 `late_blockers` 区、详情板 `late_blockers` 与 `task.late`，并计入 `stats().blockers_late`（与待办任务的 `blockers_open` 分开计） |
| **推翻结论 = 显式重新复核**（v3） | 主会话 `task_reject`（`reason` 必填）对终态任务 = 重新复核：置回 `rejected`、**重新回到默认待办板**、返回体带 `reopened` / `previous_status` / `late_blockers`，原认领者可重新认领。子代理**永远**推不翻结论（`actor` 必须是 `lead`） |
| **验收门槛**（阶段 A） | `acceptTask` 要求至少一条**依据事实**：属于该任务、`confidence ∈ {CONFIRMED,PLAUSIBLE}`，且（`kind ∈ {fact, artifact}` **或**带非空白 `evidence_path` 产物指针）。`REFUTED` 和畸形历史置信度均不算；零依据**拒绝**（`E_EVIDENCE_MISSING`）。已确认的反证结论作为独立 fact 仍可算依据；无路径的 decision / blocker 不算依据。无证据路径的有效基础任务给 warning，不在本阶段强制 SHA 审查 |
| **人工豁免显式且留痕**（v3） | 确实无法产出证据时，主会话可给 `waiver_reason`：验收记录写「验收通过（人工豁免）：…」，`confidence` 仍是 `PLAUSIBLE`，**不混入"已验证事实"**，返回体带 `waiver{reason,by,at}` 且 `warnings` 明示 |
| 未解 blocker 不得验收 | `acceptTask` **抛可读错误**并逐条列出 blocker 的 `fact_id` + 陈述，**不是 warning** |
| 打回必须给理由 | `rejectTask` 的 `reason` 必填；打回/复核落的是 **decision** 事实（不是 blocker），否则重做后重新提交会被自造阻塞卡死 |
| `task_close` 不产生 `accepted` | `done`/`partial` → `submitted`；`failed` → `cancelled`。**没有任何直接产生 `accepted` 的路径**，且**对终态任务一律拒绝** |

### 5.3 门槛查的是"有没有有效依据事实"，不是"内容是否正确"

门槛只回答"任务上有没有符合条件的依据事实"；有效的 fact / artifact 无证据路径也可通过，但会提示警告。**依据事实或文件路径不等于内容正确** —— 内容仍需主会话复核。
本层刻意不解析证据内容，也**不**把执行者给的路径自动填进验收记录的 `evidence_path`
（那会把"别人提供的路径"伪造成"主会话已核对的证据"）；验收记录只列**被采信的依据事实 id**（`#3, #7` 形式）供回读。
系统写的记录（提交说明 / 打回理由 / 验收记录 / 复核记录）统一是 `kind='decision'` + `confidence='PLAUSIBLE'`：
它们没有 `evidence_path`，因此**天然不构成验收依据**（不需要给 `fact` 表加 `origin` 列，也就没有新列迁移风险）。

## 六、模型可见工具（agent 平面，中文描述）

每个工具的描述都写明**谁能调、调了会怎样**；权限差异由身份判据在工具层强制，提示词只做说明。

| 工具 | 参数 | 谁能调 | 行为 |
|---|---|---|---|
| `task_open` | `title`(必), `note?` | 主/子 | 开任务，归属 = 调用者的 run |
| `task_claim` | `task_id`(必), `child_id`(必) | 主/子 | `open`/`rejected` 可认领，同 owner 幂等；仅主控可在 `rejected` 时换 owner，原子写 decision 与 handoff；**终态不可认领** |
| `task_fact` | `task_id`(必), `kind`(必, enum), `statement`(必), `evidence_path?`, `evidence_line?`, `confidence?`(enum), `resolves_fact_id?`, `child_id?` | 主/子 | 落一条事实；**终态任务上只有 `kind=blocker` 允许**（标 `late`，进 `late_blockers`），其余 `E_TERMINAL` |
| `task_submit` | `task_id`(必), `note?` | 主/子 | **提交待验收**：`open`/`claimed` → `submitted`；`submitted` 幂等（`already:true`）；**`rejected` 不可直提（`E_STATUS`，须先 `task_claim`）** |
| `task_accept` | `task_id`(必), `note?`, `waiver_reason?` | **仅主会话** | **验收通过** → `accepted`；有未解 blocker 一律拒绝；**无执行依据也拒绝**（`waiver_reason` = 显式人工豁免） |
| `task_reject` | `task_id`(必), `reason`(必) | **仅主会话** | `submitted` → **打回**（`rejected`）；**终态** → **重新复核**（`reopened:true`，任务回待办板） |
| `task_close` | `task_id`(必), `result`(必, enum), `note?` | 主/子 | 兼容别名：`done`/`partial` 同 `task_submit`（含 `submitted` 幂等；**`rejected` 须先 claim**）；`failed` → `cancelled`；**终态任务一律拒绝（`E_TERMINAL`）** |
| `task_board` | `task_id?` | 主/子 | 读板（范围恒为本 run；返回体带 `viewer` / `can_accept` / `late_blockers`） |

参数经 `defineTool` 编译成 raw JSON Schema（`required` 与 `enum` 都进 schema）；
返回值统一是**紧凑 JSON 字符串**：成功 `{ ok:true, ... }`，失败 `{ ok:false, error, code, hint }`。

### 稳定错误码（模型与日志都按码判读，不按文案）

| code | 含义 | 提示（`hint`） |
|---|---|---|
| `E_NO_AGENT` | 执行上下文里没有 agent / session | `hint` 指向"宿主集成问题，不要重试" |
| `E_BROKEN_CHAIN` | `depth > 1` 且祖先链上溯断掉（中间层不在活动表 / `agents` 服务不可得） | 同上；**拒绝服务而不是降级** |
| `E_CYCLE` | 祖先链成环 | 同上 |
| `E_NOT_LEAD` | 子代理调了 `task_accept` / `task_reject` | `hint` 指向"提交与验收分离" |
| `E_TERMINAL`（v3） | 终态任务被要求改写结论（`claim` / `submit` / `accept` / `close` / 非 blocker 落事实） | `hint` 指向"终态冻结"：重试无用；要推翻结论由主会话 `task_reject` 重新复核；收口后发现的阻塞直接 `task_fact(kind=blocker)` |
| `E_EVIDENCE_MISSING`（v3） | 验收缺执行依据（且没有 `waiver_reason`） | `hint` 指向"先落 fact/artifact（带 `evidence_path`）"或"写明 `waiver_reason` 做人工豁免" |
| `E_RESOLUTION_INVALID`（阶段 A） | 携带 `resolves_fact_id` 却不是 `decision` + `CONFIRMED/PLAUSIBLE` | 拒绝写入，`hint` 要求核对同任务同 run 的 blocker 后落有效 decision |
| `E_CROSS_RUN` | 跨 run 访问别的**工作实例**的任务（读 / 落事实 / 结任务三条路径共用同一拒绝点） | `hint` 指向"这是**隔离边界**，不是参数问题"：不要重试、不要换 id 试探。⚠️ 与子代理平面的 `E_CHILD_NOT_OWN`（跨会话操作别人的子代理）**不是同一回事**，两者都保留、不合并 |
| `E_TASK_CONFLICT` | 任务已有其他认领者，或条件状态更新未命中 | 先 `task_board` 核对最新 owner 与状态；不要盲目重试认领 |
| `E_STORE_BUSY` | SQLite 写锁正忙，写事务未开始 | 稍后有限次数重试；持续繁忙则报告 |

所有写动作的检查与多条写入在同一 `BEGIN IMMEDIATE` 写事务中完成；组合动作使用 savepoint。写入失败时状态、事实、时间戳和 run 归属一起回滚，认领竞争串行化后仅一个 owner 成功。同 owner 重复认领仍是幂等调用。

### 驳回后的重新指派（0.2）

原执行者不可用时，主会话先 `task_reject` 写明原因，再亲自调用 `task_claim` 指定新 `child_id`。
`claimTask(input, runId, actor?)` 的第三个参数只由可信工具层根据真实调用者派生；模型参数里的 `actor` 不生效。
只有同一 run 的 `rejected` 任务允许主控换 owner，`claimed`/`submitted` 和终态仍拒绝换人。
换人会同时写入主控 decision 和 old→new handoff；任一写入失败整笔回滚。重复认领不会重复写审计。
原来的两参数调用仍禁止换 owner，`recordHandoff` 仍只记录交接，不改变任务认领者。

`code` 的命名**刻意避开 `E_NO_` 前缀**：工具层把 `E_NO_*` 一律当作"身份不可得"（宿主集成问题），
用 `E_NO_EVIDENCE` 会把模型引到错误方向。

## 七、落库契约（谁写、写什么、怎么核对）

1. **写 = 子代理的产出通道**：派单时把 `task_id` 与「落什么事实」写进描述；子代理干活过程中
   每完成一步就 `task_fact`，完成时 `task_submit` 交到验收队列。**口头汇报不算产出**。
2. **`confidence` 是硬判据**：`CONFIRMED` 必须能指名 `evidence_path[:line]`；
   `PLAUSIBLE` 写清「什么能确认它」；`REFUTED` 引用反驳行。缺省 `PLAUSIBLE`（保守）。
3. **`kind=blocker` 不是终局**：提交时报 warnings，验收时**直接拒绝**。
   解掉它 = 落一条 decision 事实并带上 `resolves_fact_id`。
4. **核对 = 读板 + 对证据文件**：`task_board()` 看本 run 的待办与每任务最近 5 条；
   `task_board({task_id})` 看全量事实与交接；对不上就 `task_reject` 或派 fresh 子代理重做。
5. **识别符纪律**：`task_id` 必须已存在且**属于本 run**（不存在与跨 run 给不同错误，都不静默）；
   已收口（`accepted` / `cancelled` / 历史终态 `done` / `partial` / `failed`）的任务拒绝再认领。
6. **错误语义**：任何写库失败**抛出中文可读错误**（含字段名、收到的值、允许值或原因）；
   经工具调用时被收敛成 `{ok:false}` + `code` + `hint`，**不静默跳过**。读板绝不因空库报错。
7. **服务不可用不静默**：工具行激活时探测一次、调用时惰性重解析；服务缺席会 `logger.warn`
   并把调用变成 `{ok:false, error:'…服务不可用…'}`。
8. **身份不可得也不静默**：首次身份失败会 `logger.warn` 一次。

## 八、自测与集成注意

从**仓库根**直接执行（无需切换目录）：

```bash
node tools/verify-store.mjs     # P2 既有：35 条
node tools/verify-store-v2.mjs  # v2：68 条
node tools/verify-store-v3.mjs  # v3：42 条（终态 / 晚到阻塞 / 验收门槛）
```

全 PASS = 退出码 0；三份都必须通过（v3 只加新判据，不改既有语义）。

v2 覆盖：两个 run 互不可见、跨 run 的 accept/reject/close/submit/claim/fact/handoff 全部被拒、
子代理 `task_accept` 被拒（`E_NOT_LEAD`）、`submitted` 仍在默认看板、未解 blocker 拒绝验收、
解掉 blocker 后可验收、旧库自动迁移且不丢数据、未归属行处理与显式接管、身份链断时拒绝服务、
`stats(runId)` 与 `statsAllRuns()` 的范围区分。（默认退出码：全 PASS = 0。）

v3 覆盖（逐条对应审计缺陷，断言 id 里带 ★）：
`accepted` 之后 `close(failed)` / `close(done|partial)` / `submit` / `accept` / `claim` / 非 blocker 落事实
**逐条**被拒（`E_TERMINAL` + 中文可读错误）；`cancelled` 与历史终态（`done`）同样受保护；
收口后落 `blocker` **允许**并标 `late=true`、**不改状态**、立刻出现在默认看板 `late_blockers` 区与详情板
（`tasks` 里不出现，两件事不混淆）；`stats().blockers_open` 与 `blockers_late` 分开计；
零事实验收被拒（`E_EVIDENCE_MISSING`）、只有 decision / 只有 blocker+消解记录也被拒、
有真实证据时通过并按 `evidence_basis` 列出依据 fact_id；验收记录 `kind=decision` + `confidence=PLAUSIBLE`
（**不是** `CONFIRMED`）、`evidence` 如实为空、如实注明「（无附注）」；
`waiver_reason` 人工豁免成功且记录标「人工豁免」、不抬高 `CONFIRMED` 计数；
主会话 `task_reject` 对终态任务 = 重新复核（`reopened:true`）→ 任务回待办板 → 解阻塞后可重新验收成功；
工具层端到端校验 `code` + `hint` 可读（`E_TERMINAL` → 指引重新复核；`E_EVIDENCE_MISSING` → 指引落证据或豁免）。

集成注意（写给接线方）：

- 本包是 **linked 包**（profile 的 `node_modules/@local/dsh-taskforce` → 本目录）。裸 specifier
  `@deepseek-ai/dsh-tools` 由 DSH 的 profile resolver 路由，因此**静态 import 可用**；
  `lib/tools/index.js` 仍用动态 import + 本地兜底编译，独立环境下也能活着（`usingNativeDefineTool`
  可查实际走了哪条路）。
- `lib/store/index.js` 是 host 平面行、`lib/tools/index.js` 是 preset 平面行；
  两者都要在合成里出现，且 **store 行必须先挂载**（工具行只软依赖它，顺序不对只会告警不会崩）。
- **工具行的身份推导依赖 `ctx.agents`**（host 平面服务，`mountPreset` 用 `ctx.extend` 而非
  `isolate`，同一服务表可见）。取不到时：**主会话照常可用**（自身即根，不需要上溯）；
  `depth=1` 的子代理也照常可用（父 id 兜底）；只有 `depth>1` 且中间层缺失才拒绝服务
  （`E_BROKEN_CHAIN`）—— 这是刻意的失败方向。
- **宿主直连消费方注意**：`board()` / `stats()` **无参时读的是未归属域**，不是"全部"。
  `lib/plugins/working-context.mjs` **已按 run 查询**：它在 `agent/pre-step` 里先推导 `runId` 再显式传入
  （`store.stats(runId)` / `store.board({}, runId)`）。
  **身份不可解析时它直接不传 store**（而不是传 `undefined`）—— 因为 `undefined` 在 store 里指向
  「未归属域」= 迁移前的遗留行，那会把旧任务标题与旧事实计数注入当前会话。
  契约：**身份未知 ≠ 可以查 legacy**；此时该插件只保留本会话的 todo/flow 折叠。
  身份本身由 `agent.session.header` 推导：主会话直接用 `header.id`；子代理沿 `parentSession`
  逐级上溯到根，父不在活动表时 `delegationDepth === 1` 直接认 `parentSession` 为根，
  更深则返回 `undefined`（**不把"树中间"当根**，否则会串 run）；根会话 id 即 `runId`。
  详见 v2 回报的「未决项」。
- `handoff` 表有服务方法 `recordHandoff`，未开模型可见工具（视需要再加）。

## 九、已知边界（诚实声明）

- **run 隔离是接口层隔离，不是文件层安全边界**：库是本地 SQLite 文件，
  任何能在本机执行代码的 agent 都可以绕过服务 API 直接读整个文件（`v_task_board` 视图
  与 `v_run_board` 视图都不做 run 过滤）。隔离保证的是"**服务与工具这一路不会串**"。
- **祖先链断时 `depth>1` 的子代理会被拒服务**：取舍是"宁可某个会话拿不到工具，也不能让两个
  工作实例互相看见 / 互相关单"。主会话与 `depth=1` 子代理都不受影响（实测零链断）。
- **`done` / `partial` / `failed` 三个历史终态保留可读**，不参与新写入，也不会被自动改写；
  v3 起它们与 `accepted` / `cancelled` 一样属于**终态集合**，同样拒绝改写（`E_TERMINAL`）；
  统计里 `stats(runId).tasks` 仍带这三个键（恒为 0，除非该 run 里有迁移前的旧行）。
- **终态冻结是服务层保证，不是文件层**：与 run 隔离同理 —— 能直接写 SQLite 文件的 agent 可以绕过
  服务 API 改任何一行。它保证的是"**服务与工具这一路**不会让晚到的旧调用方改写已签发的结论"。
- **晚到阻塞不会自动回板**（显式取舍）：终态任务上的 `blocker` 只落库 + 上榜，**不自动**把任务从
  `accepted` 拽回待办集合 —— 审计已证实"自动改写结论"本身就是缺陷。回到待办板的唯一通道是
  主会话 `task_reject` 显式重新复核（`reason` 必填）。代价是：主会话如果不看板，晚到阻塞会停在
  `late_blockers` 区而不推进；换来的是"**结论永远不会在无人决策时被改写**"。
- **验收门槛只查有效依据事实**：`confidence ∈ {CONFIRMED,PLAUSIBLE}` 且（`kind ∈ {fact, artifact}` 或带非空白 `evidence_path`）即算依据，
  本层**不校验证据内容**（有路径 ≠ 内容正确）。内容是主会话的核对责任：
  读 `board({task_id})` 的事实与 `evidence`，必要时打开文件对行 —— 门槛只是把"零依据验收"挡在门外，
  它不能替代复核。同理，`evidence_basis` 只列 fact_id，不会把执行者给的路径写成"已核对的证据"。
