# 事实库 · 一页说明（0.3：真实 owner、审计与严格执行回执；v3：工作实例隔离 + 提交/验收分离 + 终态冻结与验收门槛）

`lib/store/index.js`（host 平面插件，发布 `taskforceStore`）
＋ `lib/tools/index.js`（agent 平面插件，注册 11 个模型可见工具：9 个 `task_*` 事实库工具 + `task_child_send` / `task_child_stop` 子代理控制工具，后者见 `docs/CONTROL.md`）
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
| `task` | `id INTEGER PK`, `title TEXT NOT NULL`, `note TEXT`, `status TEXT NOT NULL DEFAULT 'open'`, `owner TEXT`, **`owner_session TEXT`**（nullable，真实执行会话）, **`run_id TEXT`**, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL` |
| `fact` | `id INTEGER PK`, `task_id INTEGER`, `kind TEXT NOT NULL`, `statement TEXT NOT NULL`, `evidence_path TEXT`, `evidence_line INTEGER`, `confidence TEXT NOT NULL`, `created_by TEXT`, **`actor_session TEXT`**（nullable，真实调用者）, **`run_id TEXT`**, **`resolves_fact_id INTEGER`**, `created_at TEXT NOT NULL` |
| `handoff` | `id INTEGER PK`, `task_id INTEGER`, `from_child TEXT`, `to_child TEXT`, `note TEXT NOT NULL`, **`run_id TEXT`**, `created_at TEXT NOT NULL` |

**迁移**（`TaskforceStore.migrate()`）：读 `PRAGMA table_info(<表>)`，缺哪列就 `ALTER TABLE ... ADD COLUMN`
补哪列。**只加列**，不重写表、不改既有行 —— 旧库升级后数据一条不少。

- 旧行的 `owner_session` / `actor_session` 保持 `NULL`，不按历史标签猜填。
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
   非空白 run ID 按完整原字符串存储和比较（包括首尾空白），完整长度上限 200；
   省略、`null` 与空白字符串仍表示未归属。旧版已去空白的历史键无法可靠还原，
   不自动重命名或猜填；宿主访问旧数据须使用库中原有的精确存储键。
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

**`runId` 保持既有位置（输入对象之后；stats 等读取接口为首参），身份是独立的可选位置参数，不接受模型输入字段**（字符串 = run 域；缺省 / `null` = 未归属域）。

工具写入传可信结构化 `actor` / `caller = { sessionId, isRoot }`：真实会话 ID 与布尔角色分开，
子会话的合法 ID `lead` 不获得主会话权限，实际 root ID 为 `lead` 仍按 `isRoot:true` 授权。
结构缺少有效 ID 或布尔角色时拒绝；模型字段不能指定这两个值。结构化调用的审计只取其真实
`sessionId`，不会由显示标签或追加位置参数覆盖。旧宿主字符串 `lead` 位置参数仍代表可信主会话角色；
旧字符串 caller、缺省参数与独立审计 session 位置保持兼容，未提供审计 ID 时不猜填。
旧权限比较保留原始输入：只有逐字 `lead` 是主会话角色，只有实际省略/null 可走未绑定宿主直连；
带空白 caller 与权限 session 不因显示/审计的 trim 取得另一身份或额外权限。
`ownerSessionId` 的非空白真实 ID 同样完整保存，结构化 `sessionId` 与 `actor_session`
逐字匹配；`' worker '` 与 `'worker'` 是不同执行者。显示标签及旧宿主审计格式继续归一化。

| 方法 | 入参 | 返回 |
|---|---|---|
| `openTask` | `({ title, note?, evidence_policy?, verification_files?, verification_command? }, runId, trustedContext?)`（可信 context `{sessionId,cwd,isRoot}`；legacy 旧位置兼容） | `{ task_id, title, status, run_id, created_at }` |
| `verificationTarget` | `(taskId, runId, caller)`；caller 是宿主可信 identity `{sessionId,isRoot}` | 本 run 的 execution 任务、真实 owner 与当前 generation；只有子会话 owner 可取执行目标 |
| `recordExecution` | `(receipt, runId, caller)`；仅可信宿主 API，不是模型工具 | 同数据库先写 pending intent，再完成同一行；日志路径和快照由宿主生成；失败/unknown 不构成验证通过 |
| `claimTask` | `({ task_id, child_id }, runId, actor?, ownerSessionId?)` | `{ task_id, owner, owner_session, status:'claimed', claimed_at, already, warnings[] }` |
| `recordFact` | `({ task_id?, kind, statement, evidence_path?, evidence_line?, confidence?, child_id?, resolves_fact_id? }, runId, caller?, actorSessionId?)` | `{ fact_id, task_id, kind, confidence, resolves_fact_id, created_at, late, late_of_status, next? }`（`late:true` = 落在终态任务上的**晚到阻塞**；终态上非 blocker 一律 `E_TERMINAL`） |
| `recordHandoff` | `({ task_id, from_child, to_child, note }, runId)` | `{ handoff_id, task_id, from_child, to_child, created_at }` |
| `submitTask` | `({ task_id, note? }, runId, caller?, actorSessionId?)` | `{ task_id, status:'submitted', submitted_at, fact_count, blockers, warnings[], next }`；`caller` 由工具层派生为可信 `{sessionId,isRoot}`（旧宿主字符串兼容），**用于绑定任务的真实 owner 权限与提交审计**：主会话代提交写 `lead`，不再被误标成原 owner 自己提交（缺省 = 宿主直连，沿用旧署名） |
| `acceptTask` | `({ task_id, note?, waiver_reason? }, runId, actor, actorSessionId?)`（`actor.isRoot` 必须为 `true`；兼容宿主字符串 `lead`；`waiver_reason` = 显式人工豁免） | `{ task_id, status:'accepted', accepted_at, fact_count, resolved_blockers, evidence_basis{count,fact_ids,with_pointer,unattributed}, waiver, warnings[] }`；缺依据且无豁免 → `E_EVIDENCE_MISSING` |
| `rejectTask` | `({ task_id, reason }, runId, actor, actorSessionId?)`（`reason` 必填） | `submitted` → `{ task_id, status:'rejected', rejected_at, reason, facts_to_fix, owner, reopened:false, previous_status:null, late_blockers:[], next }`；**终态 → 重新复核** `{ …, reopened:true, previous_status:'accepted', late_blockers:[…] }` |
| `closeTask` | `({ task_id, result ∈ done/partial/failed, note? }, runId, caller?, actorSessionId?)` | **兼容别名**：`done`/`partial` → `submitted`（附注转交 `submitTask`，`alias_of:'submitTask'`），`failed` → `cancelled`（有附注时写取消裁决，`alias_of:null` —— 取消不是 submit 别名）；返回体另带 `mapped_status`。**永不产生 `accepted`**；**终态任务一律拒绝**（`E_TERMINAL`，先查原状态）；**取消（`failed`）还要求身份**：只有主会话或该任务**当前 owner** 能取消，同 run 的竞争子代理被 `E_TASK_CONFLICT` 拒绝且不产生任何写入（`caller` 由工具层派生，模型参数不参与；缺省且未绑定 = 宿主直连，沿用只校验 run 的历史语义） |
| `taskOf` | `(task_id \| { task_id }, runId)` | `{ task, fact_count, last_fact_at, blockers, open }` |
| `board` | `({} \| { task_id }, runId)` | 兼容宿主 API，见下 |
| `boardPage` | `({view?,task_id?,limit?,cursor?,page_token?,late_cursor?,late_page_token?}, runId)` | 模型分页入口，见下 |
| `stats` | `(runId)` | `{ run_id, tasks{…}, facts{…}, blockers_open, blockers_late }`；缺省 = 未归属域 |
| `statsAllRuns` | — | **显式命名的跨 run 视图**；返回 `blockers_open/blockers_late`，与单 run 使用同一待办/消解判据，全部统计在同一只读快照内完成；facts 保留原始全局行计数 |
| `unassignedSummary` | — | `{ task, fact, handoff, execution_receipts, execution_waivers }` 未归属行计数（只读诊断） |
| `adoptUnassigned` | `(runId)` | 显式接管未归属任务及匹配记录，返回 tasks/facts/handoffs/execution_receipts/execution_waivers 数量；`runId` 为 `null` 时拒绝 |

`submitted_at` 持久化最近一次实际进入 `submitted` 的时刻。提交后普通事实或消解 decision 只更新 `updated_at`（最近活动时间），幂等 `submitTask` 与 `closeTask(done/partial)` 返回原提交时刻且不写库。reject/claim/终态转移保留上次提交时间；重新实际提交会写入新的时间。只加 nullable TEXT 列，迁移前 submitted 行的未知时刻保持 `null`，不从 `updated_at` 或审计文案推测；`taskOf` 与详情板同样返回该字段。

`acceptTask.resolved_blockers` 是该任务同 run 中已被有效 decision 消解的不同 blocker 数；同一个 blocker 多条有效消解只计一次。REFUTED、错任务或错 run 的 decision 不算有效消解。

`board({}, runId)` 无 `task_id`：`{ scope:'open', run_id, open_tasks, submitted_tasks, tasks[], late_blockers[], late_blocked_tasks, note }`，
范围 = 本 run 的**待办**任务（`open / claimed / submitted / rejected`），每任务带**最近 5 条**事实摘要
（`statement` 截断到 160 字符、`evidence` 合成 `path:line`）；**`submitted` 必在列**（主会话的待办来源）。
库为空返回 `tasks: []`，不报错。
`late_blockers` = **已收口任务上仍未消解的阻塞**（每项 `{ task_id, title, status, owner, blockers:[{fact_id,statement,by,at}] }`）：
包括收口前遗留及收口后新增的阻塞；`recordFact.late` 则记录该次写入时任务是否已终态，两者口径不同。它们不属于待办集合（结论没被自动改写），但**必须可见** —— 这是"晚到阻塞不会回到待办"的修复点。
`board({task_id}, runId)`：`{ scope:'task', task（含 `late`）, counts:{by_kind,by_confidence}, facts[]（≤50，最近在前，不截断）, handoffs[]（≤10）, late_blockers[], validation_warnings[] }`。历史 `accepted` 如缺当前有效依据，返回 `{code:'W_EVIDENCE_REVIEW',message}` 提醒人工核对（可能曾人工豁免）；状态不自动回滚，且不解析验收文案猜测豁免。

`boardPage` 是模型 `task_board` 的入口；旧宿主 `board` 的返回形状、最近5条摘要和全待办列表保持不变。无参数 `boardPage` 使用 `view='tasks'`，默认每页25、最大100；`limit`、`cursor`、`late_cursor`、`task_id` 必须为合法整数，非法/超界参数报 `E_INPUT`。各页按 ID 降序、`id < cursor` keyset 读取；`pagination:{limit,next_cursor,has_more,page_token?}` 的 `limit` 是请求上限，受字节预算影响实际页可更短。待办/晚到阻塞是可变集合：续页必须将上页的 `next_cursor` 和 `page_token` 配对传入（默认晚到区为 `late_cursor/late_page_token`），仅数字游标的旧调用会报 `E_INPUT`，需升级调用方。示例：`task_board({cursor:上页.pagination.next_cursor,page_token:上页.pagination.page_token})`。

token 绑定实际 run、逻辑集合、有效 task 筛选、首轮候选 ID 上界、该上界内的完整成员指纹和实际末行 ID；不绑定 limit。首轮已存在的终态任务重新进入待办、晚到 blocker 进入/离开报警集合（包括新 decision 消解旧 blocker）时，返回 `E_PAGE_CHANGED`，须丢弃该集合的游标/token 从第一页重读，并按 ID 去重；没有静默跳过。待办内部 open/claimed/submitted/rejected 状态变化不改变成员，仍可继续。首轮后插入的更大任务/blocker ID 不混入这轮分页，要看它们从第一页读取。token 是有界校验元数据，不是授权凭据；每页指纹计算流式扫描当前范围成员，内存有界但工作量为 O(成员数)，不保留跨页锁或写入数据库。全域 totals 始终描述当前单页读取事务的完整 run，不是分页 cohort 或当前页长度。

`view` 支持 `tasks`、`summary`、`facts`、`handoffs`、`late_blockers`。`tasks` 返回待办页及每任务最新1条事实，`summary` 返回全域汇总及晚到报警页。`totals` 包含本 run 全量 `tasks/facts/open_tasks/submitted_tasks/late_blockers/late_blocked_tasks`，兼容字段 `open_tasks/submitted_tasks/late_blocked_tasks` 同样是完整计数，不是当前页长度。`facts` 计数排除与父任务 run 不符、父任务不存在的附属行，包含本 run 未挂任务事实。`tasks` 给 task_id 可筛选该任务，但全域 totals 和独立晚到报警区仍看整个 run。所有 task_id 入口先校验父任务归属；所有附属页先校验父任务及附属行 run，异域污染不消耗页额度。

默认 `tasks/summary` 始终包含 `late_blockers[]`、`late_blocked_tasks` 和独立 `late_pagination`，待办为空也保留报警入口。晚到页每项为 `{fact_id,task_id,title,status,owner,statement,by,actor_session,at}`，按 `fact_id` 降序分页；多个 blocker 可来自同一任务。`late_cursor + late_page_token` 仅翻动默认/摘要/详情的晚到区；`view='late_blockers'` 使用 `cursor + page_token`，返回未截断 statement、完整 `total` 与 `pagination`。处理仍须主会话 `task_reject` 重新复核。

`facts/handoffs` 必须指定 `task_id`，按事实/交接 ID 分页，内容未截断，返回各集合完整 `total`。`task_id` 无 `view` 保持兼容详情：事实50条、交接10条、执行 receipts/waivers、统计与警告；新增 `facts_pagination/handoffs_pagination/late_pagination`。继续读取例如 `task_board({view:'facts',task_id, cursor:详情.facts_pagination.next_cursor})`，直到 `has_more=false`，即可取全历史。

`tasks/summary` 的完整模型工具 JSON（包含 `ok/viewer/can_accept`）上限65536 UTF-8 bytes。数据层预算60000 bytes，展示字段截短会标明 `truncated/truncated_fields`，任务带 `detail:{task_id}` 原文入口。超预算可明确减少页尾，返回 `budget_reduced:true` 并将各区游标置于最后实际输出条目，所有略去记录仍可继续读取。可操作 `owner_session/actor_session/viewer` 过长时省略原值并标明省略，不产生截短的伪身份；任务身份原值可通过详情/历史读取；viewer 省略时另给 `viewer_metadata:{role,omitted:true}`。页数有界的详情和显式原文历史页不受摘要字节上限约束。

分页默认/摘要用 `scope_integrity_totals` 报告全域异常，不随当前页消失；保留 mismatched_facts/mismatched_handoffs，执行/恢复审计异常时新增正数 mismatched_receipts/mismatched_waivers/mismatched_events/mismatched_checkpoints/mismatched_controls（缺省按0）。`scope_integrity_note` 指向 task_id 详情的逐任务异常列表，旧宿主 `board.scope_integrity` 同样报告这些审计异常数量。异域回执/豁免原文隐藏，验收在人工豁免和证据路径之前以 `E_STORE_INTEGRITY` 拒绝。

control 归属异常统计按父任务查找；迁移在恢复表建好后增加覆盖索引 `idx_control_task(task_id,run_id)`，避免分页总计与兼容详情对每个任务全扫 control 日志。旧库重开幂等补索引，原行与列不变。它是查询访问路径，doctor 的数据可读 schema 闸门不因缺此性能索引而拒绝旧库；preflight 会在隔离副本实际迁移并记录 schema 变化。

启动、迁移与 `unassignedSummary` 共用五表未归属诊断。迁移同事务补 `idx_execution_receipt_unassigned(run_id)` 与 `idx_execution_waiver_unassigned(run_id)`，两者仅收录 `run_id IS NULL` 行，让审计计数按 NULL 范围查找，避免遍历已归属回执与豁免历史；不改变五表计数、显式领养或异常隔离规则。旧库首次建立索引仍需读取既有表，后续打开幂等复用。它们同样是可选性能索引，doctor 不将缺索引视为数据不可读；preflight 隔离副本实际补索引并记录 schemaHash。规模回归检查真实 SQL 的查找计划及原行/列保留，不设耗时阈值或承诺任意启动延迟。

迁移诊断 `migration.unassigned`、`unassignedSummary()` 与 boot 警告共用 task/fact/handoff/execution_receipts/execution_waivers 五表口径。已归属父任务上的 NULL-run receipt/waiver 也会告警，但继续隔离，`adoptUnassigned` 不会吸收它们；须管理员人工核对归属。

`adoptUnassigned` 在同一写事务中先按原本 `task.run_id IS NULL` 的父任务迁移 NULL-run 执行回执与豁免，再迁移任务及既有事实/交接。它只改变审计归属，不改变 owner、generation、命令、快照、结果或日志；已归属任务上的 NULL/异域审计保留异常，不自动纳入。原本未归属任务如附有已归属的执行审计，接管在任何迁移前以 `E_STORE_INTEGRITY` 拒绝，避免父任务移动让异常审计重新可见；须管理员核对修复。任一步写入失败回滚全部五张表与迁移诊断。人工豁免仍是非验证通过，旧失败、pending 或旧代回执不会因接管而变成有效依据。

`node tools/bench-board.mjs` 默认在临时 SQLite 中分别 seed1000/5000任务、每任务8事实，输出完整工具包 UTF-8 bytes、查询数、返回 JavaScript 的行数和5次预热后30次完整读板的 p50/p95，最后清理临时数据库。可传入其他任务量，例如 `node tools/bench-board.mjs 1000 5000`；p50/p95 采用 nearest-rank（30样本排序下标14/28），计数与 EXPLAIN 在独立非计时读取中采集，行数不是 SQLite 实际访问行数。性能数字只记录，不作为墙钟测试阈值。

`node tools/probe-late-index.mjs 1000 5000` 在同一进程、同一临时数据集比较 baseline/index-only/query-only/both；检查9类原场景、每任务额外1万条普通事实的筛选场景及 NULL/异域/错误消解关系。结果、两个分页 token、查询和返回行数逐字比较；后续高 ID resolver 仍必须让旧游标返回 `E_PAGE_CHANGED`。该工具只操作自己新建的合成库，正常看板不会创建实验索引或改变持久数据。

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
| 只有主会话能 `task_accept` / `task_reject` | 身份判据在**工具层强制**（`identity.isRoot`），数据层再核对可信结构化 `isRoot`；旧宿主字符串仅逐字 `lead` 表示主会话角色 |
| **终态冻结**（v3） | 已收口任务的结论**不被任何普通写入改写**：`closeTask(failed)` 分支**先查原状态**，`claim` / `submit` / `accept` / `close` / 非 blocker 落事实 一律拒绝（`E_TERMINAL` + 可读错误），错误里指路 `task_reject` |
| **取消要证明资格**（本版） | `closeTask(failed)` 在终态闸门之后追加 `requireCancelAuthority`：只有**主会话**或**该任务当前 owner** 能取消（`caller` 由工具层按真实调用者派生，模型参数不参与）；同一 run 的竞争子代理被 `E_TASK_CONFLICT` 拒绝，**任务状态、事实与交接一字未改**。取消是终态且破坏性的动作，不能由竞争方代劳 —— 要停别人的任务就报告主会话。取消审计的 `created_by` 记为**真实调用者**（主会话叫停写 `lead`），不再无条件写成 `row.owner` |
| **提交的署名同样反映真实调用者**（本版） | `submitTask`（含 `task_close(done\|partial)` 别名）落审计时，`created_by` 记**真实调用者**：主会话代提交写 `lead`，子代理写自己的 sessionId（缺省 = 宿主直连，沿用 `row.owner`）。避免"主会话代交"被误记成原 owner 自己提交 |
| **晚到阻塞不静默**（v3） | 终态上**唯一**允许的新写入是 `kind='blocker'`：它**不改状态**（结论不被自动推翻），但立刻进默认看板 `late_blockers` 区、详情板 `late_blockers` 与 `task.late`，并计入 `stats().blockers_late`（与待办任务的 `blockers_open` 分开计） |
| **推翻结论 = 显式重新复核**（v3） | 主会话 `task_reject`（`reason` 必填）对终态任务 = 重新复核：置回 `rejected`、**重新回到默认待办板**、返回体带 `reopened` / `previous_status` / `late_blockers`，原认领者可重新认领。子代理**永远**推不翻结论（结构化 `actor.isRoot` 必须为 true；兼容旧宿主 `lead` 角色） |
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
| `task_open` | `title`(必), `note?`, `evidence_policy?`, `verification_files?`, `verification_command?` | legacy 主/子；execution 仅主 | 开任务，归属 = 调用者的 run；execution 固定可信主会话 cwd |
| `task_verify` | `task_id`, `command`, `timeout_ms?` | 仅真实子会话 owner | 通过 native bash 执行固定命令，await 回执持久化后返回；主会话不可执行 |
| `task_claim` | `task_id`(必), `child_id`(必) | 主/子 | `open`/`rejected` 可认领，同 owner 幂等；仅主控可在 `rejected` 时换 owner，原子写 decision 与 handoff；**终态不可认领** |
| `task_fact` | `task_id`(必), `kind`(必, enum), `statement`(必), `evidence_path?`, `evidence_line?`, `confidence?`(enum), `resolves_fact_id?`, `child_id?` | 主/子 | 落一条事实；**终态任务上只有 `kind=blocker` 允许**（标 `late`，进 `late_blockers`），其余 `E_TERMINAL` |
| `task_submit` | `task_id`(必), `note?` | 主/子 | **提交待验收**：`open`/`claimed` → `submitted`；`submitted` 幂等（`already:true`）；**`rejected` 不可直提（`E_STATUS`，须先 `task_claim`）** |
| `task_accept` | `task_id`(必), `note?`, `waiver_reason?` | **仅主会话** | **验收通过** → `accepted`；有未解 blocker 一律拒绝；**无执行依据也拒绝**（`waiver_reason` = 显式人工豁免） |
| `task_reject` | `task_id`(必), `reason`(必) | **仅主会话** | `submitted` → **打回**（`rejected`）；**终态** → **重新复核**（`reopened:true`，任务回待办板） |
| `task_close` | `task_id`(必), `result`(必, enum), `note?` | 主/子 | 兼容别名：`done`/`partial` 同 `task_submit`（含 `submitted` 幂等；**`rejected` 须先 claim**）；`failed` → `cancelled`；**终态任务一律拒绝（`E_TERMINAL`）** |
| `task_board` | `task_id?/view?/limit?/cursor?/page_token?/late_cursor?/late_page_token?` | 主/子 | 读板（范围恒为本 run；返回体带 `viewer` / `can_accept` / `late_blockers`） |

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
| `E_TASK_CONFLICT` | 任务已有其他认领者、条件状态更新未命中，或取消请求来自非 owner | 先 `task_board` 核对最新 owner 与状态；不要盲目重试认领。换人指引按状态分流：`rejected` → 主会话直接 `task_claim`；`submitted` → 先 `task_reject` 再 `task_claim`；`claimed` → 不可直接 `task_reject`（等当前认领者 `task_submit` 后由主会话驳回并重指派）。**指引不再提供 `task_close(failed)` 这类"竞争方直接取消"的回退**：取消要过 owner 闸门，只有主会话或当前 owner 能做 |
| `E_STORE_BUSY` | SQLite 写锁正忙，写事务未开始 | 稍后有限次数重试；持续繁忙则报告 |

所有写动作的检查与多条写入在同一 `BEGIN IMMEDIATE` 写事务中完成；组合动作使用 savepoint。写入失败时状态、事实、时间戳和 run 归属一起回滚，认领竞争串行化后仅一个 owner 成功。同 owner 重复认领仍是幂等调用。

### 驳回后的重新指派（0.2）

原执行者不可用时，主会话先 `task_reject` 写明原因，再亲自调用 `task_claim` 指定新 `child_id`。
`claimTask(input, runId, actor?, ownerSessionId?)` 的第三个参数只由可信工具层根据真实调用者派生；模型参数里的 `actor` 不生效。
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
4. **核对 = 读板 + 对证据文件**：`task_board()` 分页看本 run 的待办与每任务最新1条摘要；
   `task_board({task_id})` 看详情，用 facts/handoffs 继续读取游标取全历史；对不上就 `task_reject` 或派 fresh 子代理重做。
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

- **真实 owner 与历史兼容分开处理**：`task.owner` 保留显示标签，新增 nullable
  `owner_session`；`fact.created_by` 保留兼容显示，新增 nullable `actor_session`。
  迁移只加列，不丢旧行，不把历史标签猜填成会话。子代理 `task_claim` 只绑定宿主调用者
  自己的真实会话，模型 `child_id` 仅作为显示标签。绑定任务的重复认领、提交（含幂等重试）
  与取消只允许真实 owner 或可信主会话；相同标签的 sibling 被 `E_TASK_CONFLICT` 拒绝。
  状态优先级、跨 run、终态冻结与晚到 blocker 保持原有边界。
- **主会话目标绑定由宿主核验**：`agents.get(child_id)` 解析到实际会话时，核对目标 ID、
  同 run 与主会话后代血缘后才能绑定；跨 run 目标拒绝，血缘无法核验的实际目标拒绝。
  解析不到的代号仅作为未绑定预指派（返回警告），须执行者自行认领后绑定。
  主会话重指派仅在 `rejected`；owner/session 更新、decision 审计与 handoff 同事务，
  新绑定生效后旧 owner 失去提交和取消权限。
- **事实与裁决审计来自宿主**：同 run 协作者可追加事实、报告 blocker，但工具层无视模型
  作者标签，`created_by` 使用真实子会话 ID 或 `lead`，`actor_session` 写实际调用者会话 ID。
  主会话和子会话的提交、取消、验收、打回裁决同样写真实 `actor_session`；主会话重指派
  审计写可信结构化 actor 的实际根会话 ID（旧宿主字符串角色沿用 run）。任务详情和事实摘要返回新身份字段。
- **旧未绑定任务仍兼容**：未绑定提交沿用历史允许路径并返回「未绑定」警告，包括
  `submitted` 幂等重试；旧取消仍按 owner 标签匹配，宿主直连缺省身份仍可取消未绑定任务。
  标签与真实会话不一致的旧任务可由原标签执行者自己认领来绑定，或由主会话处理。
  未绑定宿主直连事实不猜填 actor；新可选位置参数保持旧调用兼容。

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


## execution 编码任务回执（0.3）

`evidence_policy` 默认 `legacy`：原有事实依据门槛和服务 API 位置保持兼容。主会话可以在 `task_open` 声明 `execution`，同时给出非空 `verification_files` 相对文件清单与固定 `verification_command`；工作区来自可信 `exec.agent.session.header.cwd`，模型不能指定 `verification_cwd`。清单不得越界、缺失、指向目录或外部 symlink；它只声明这些文件的验收范围，不覆盖清单外文件。

当前真实子会话 owner 调 `task_verify(task_id, command, timeout_ms?)`。命令必须逐字匹配创建时的固定命令（包括空白）；超时默认 60000，范围 1–120000 ms。工具先同步写入 pending intent，再 await 原生 `agent.ctx.tools.execute({name:'bash',agent,signal,parent:exec.token,rootCallId,...})`。bash 需要的 `description`、唯一 callId 和日志 UUID 均由宿主生成；不直接 spawn，不绕过审批、sandbox 或 guards。缺少 execute/context 或 native bash 不可达返回 `E_VERIFICATION_CAPABILITY`。

`execution_receipt` 与任务在同一 SQLite 数据库，关联 run、task、generation、真实 owner/执行者、固定命令、可信 cwd、开始结束时间、native 调用关联、清单快照与结构化 outcome。stdout/stderr 由宿主写到 `store.root/receipts/<uuid>.<stream>.log`，回执保存 SHA256、实际字节数及完整性；不跟随 native spillPath，也不把渲染文本当原始日志。合计超过 2 MiB 时最多保存 2 MiB 观察内容并标记不完整。数据库完成写入失败会保留最新 pending intent；可能残留未被采信的 UUID 日志，须重新运行才能产生新回执。

严格 `task_accept` 只检查最新回执，要求同 run、本 owner、本代、同命令/cwd/清单，canonical `kind:'foreground'`、实际 exitCode 0、signal=null、timedOut=false、aborted=false、无 sandbox denial/runnerFailed/stopped、完整输出。缺字段不会被默认补成成功。较新的非零、timeout、abort、promotion、拒绝、unknown 或 pending 覆盖旧成功，artifact 自述不能替代回执。

验收时重新读取清单文件和实际日志并核对摘要。文件快照保留 SHA256、resolved path、大小、inode/dev 与 mtime/ctime；执行前后这些信息变化也会判失败，哪怕内容被写后还原。日志缺失/篡改、源码更改/替换或外部 symlink 都拒绝。reject 原子递增 `evidence_generation`；换 owner 后须由新真实执行者重新验证。显式 `waiver_reason` 仍能人工收口，返回 `execution_verified:false` 并写独立 `execution_waiver` 审计与带「人工豁免；非验证通过」的 decision，不能绕过跨 run、数据完整性或未解 blocker。

详情板新增任务 policy/generation/固定命令/cwd/清单，以及最近至多 10 条 `receipts` 与 10 条 `execution_waivers` 元数据；日志内容保留在宿主文件中，不展开到板。错误码 `E_VERIFICATION_POLICY` / `E_VERIFICATION_COMMAND` / `E_VERIFICATION_RECEIPT` / `E_VERIFICATION_CAPABILITY` / `E_VERIFICATION_ROLE` 均有对应工具 hint。

这些是工具接口层的宿主观测证据。相同 UID 的 unrestricted shell 可以物理改写数据库或回执目录；本功能不构成抗恶意物理篡改、进程隔离或全进程树 quiescence 的承诺。原生 timeout promotion 可能留后台工作，回执永远拒绝将它标成成功。

事实计数的可见性口径：`boardPage().totals.facts`、`stats(runId).facts`（含 by_kind/by_confidence）和 `workingState(runId).factCount` 共用同一 SQL 判据。保留本 run 内未挂任务的事实；挂任务的事实必须存在同 run 父任务，错父域或孤儿事实不计入模型可见统计。NULL 未归属域使用相同规则。`statsAllRuns()` 仍是宿主显式调用的原始全局统计。

0.3.2 增加 blocker 专用部分索引，优化候选上界、完整成员指纹和全量计数查询；原 SQL、消解判据和分页协议保持不变。选行查询仍可能使用普通 fact run 索引，耗尽的任务范围续页仍可能读普通事实历史。1k/5k 合成热读对照与范围限制见 [0.3.2 研究记录](superpowers/research/2026-10-09-imperator-0.3.2-recovery.md)。
