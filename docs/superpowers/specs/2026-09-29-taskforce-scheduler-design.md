# TaskForce 阶段 B：持久化并发调度详细设计

日期：2026-09-29。状态：**待用户审阅；尚未实现**。

依赖：阶段 A，远端提交 `a75a89902de1c569330e12d55456dfb38d2f752b`（PR #2）。
上位设计：[双线强化设计](2026-09-29-taskforce-strengthening-design.md)。
配套：[自动开发设计](2026-09-29-taskforce-automation-design.md)、[目标宿主研究](../research/2026-09-29-dsh-host-contracts.md)。

## 1. 已确认目标与本次需要审阅的决定

用户已确认可靠性和自动开发两方面、A → B → C 顺序及多代理执行。B 的目标是让整棵受管任务树服从持久化额度、资源互斥和恢复规则，而非依靠提示词遵守限制。

本详细设计选定以下实现方向；总体范围获批不等于这些新增接口已获批：

- 每个 run 默认最多 6 个活动执行，其中最多 2 个写执行，所有后代共用预算。
- 单个数据库协调域内采用有界、可解释的队列；使用“可准入任务 FIFO + 较早写请求屏障”。
- 受管执行使用一个 attempt 对应一个全新原生会话、一次初始输入；不复用 continuable 会话。
- 使用现有 `ctx.agents.create()` 和原生 handle 回收，不重写模型、工具或 agent loop。
- 写任务默认使用独立 clone；共享 git 元数据的 worktree 需受限能力配置，否则串行。
- 保留真实父子关系和 `maxDepth: 2`。嵌套请求必须可以立即准入；无法准入时明确拒绝，避免父任务占着额度等待子任务。
- 缺少必要宿主能力时阻止相应派发，保留可检查状态；离线核心通过不代表真实宿主接入通过。

## 2. 方案比较

| 方案 | 结论 |
|---|---|
| 在原生 subagent/start 事件里限流 | 拒绝：该事件发生在启动后，监听器错误不阻止执行。 |
| 包装现有 continuable provider | 不选作初版：可指定 childId，但 prepare 只支持 seed，不能注入独立 cwd/setup，结束事件也不是单条消息结果。 |
| TaskForce 准入 + 原生 Agent 创建/回收 | 采用：保留原生生命周期和权限继承，TaskForce 拥有持久意图、工作区和结算。需要自有任务视图和真实集成验收。 |

这是 TaskForce 内部的受管执行模式。普通任务和原生 continuable 功能仍可在非受管模式使用；不能把两种模式混合后仍宣称额度完整。

## 3. 服务边界与接入

调度器是 host 服务，复用现有单例事实库和 `lib/store/sqlite.js` 的同步事务。agent 工具仅传意图，不能提供可信 run、代际、会话身份、规范资源键或执行权限。首次启用为显式 opt-in；历史任务不自动变成受管任务。

计划模块边界（TaskForce 新接口，非 DSH 已有 API）：

| 模块 | 单一职责 |
|---|---|
| `lib/scheduler/schema.js`、`store.js` | 迁移、队列、依赖、attempt、额度、资源持有、事件及事务不变量。 |
| `lib/scheduler/resources.js` | 可信资源规范化及执行配置校验，不做派发。 |
| `lib/scheduler/service.js` | 唤醒、准入、派发、对账和卸载；不在事务中等待外部调用。 |
| `lib/scheduler/host-adapter.js` | 封装目标 DSH 的创建、身份绑定、终止、持久化和回收。 |
| `lib/scheduler/guard.js` | 对受管会话安装不可由普通工具钩子撤销的派发/变更约束。 |
| 现有 store/tools/preset/插件入口 | 接入统一身份和业务门禁，展示任务状态与执行状态。 |

新模型工具限定为三个：

1. `task_schedule({task_id, request_key, profile, dependencies?, resources?, brief})`：排队或明确拒绝，返回请求凭据；永不等待任务完成。资源和 profile 是请求，宿主决定有效权限。
2. `task_schedule_state({task_id?})`：只返回当前 run 的队列、attempt、额度和阻塞原因。
3. `task_schedule_control({task_id, action, expected_generation, request_key, reason?})`：root 的取消、暂停、恢复或明确重试。重试不覆盖原 attempt。

受管入口使用 host 的 `ToolGuard`，覆盖原生 spawn/fork、`task_child_send`、相邻代理消息等重新激活入口。不能仅隐藏工具或拦截一个名称。未能封闭已安装的派发路线时返回 `E_SCHEDULER_CAPABILITY`。受管执行不支持任意 followup；需要继续工作时提交新的受管请求。

agent scope 的 guard 只约束该发送者，不能阻止其他会话向受管 child 投递。独占输入还需要 host 范围按目标 session 检查的 guard，以及已安装工具/插件的完整输入路线清单；针对受管目标拒绝未获准的消息与恢复入口。无法检查的路线必须禁用或阻止受管模式启用，不能把 child setup 中装一个 guard 当成完整边界。

`task_child_list/status` 在受管模式读 TaskForce 的持久执行视图，标明 `managed_once`；原生目录不能被当成该视图。停止动作交由调度器保留 holds 后回收。混合子代理显示来源，不向原生 continuable manager 伪造 descriptor。

## 4. 持久数据模型

业务 `task.status` 与调度状态分离。提交、接受或取消业务任务都不能单独证明执行者已停止。

| 表 | 关键字段与约束 |
|---|---|
| `scheduler_meta` | schema_version、coordination_domain、policy_revision；同一共享工作区域必须共用该 DB。 |
| `scheduler_run` | run_id、root_session_id、enabled、max_active、max_write、queue_capacity、policy_revision。 |
| `scheduler_session` | session_id、run_id、parent_session_id、depth、attempt_id、generation；只由可信创建/恢复证据写入。 |
| `execution_request` | request_id、run_id、task_id、kind(agent/effect)、request_key、spec_digest、profile_snapshot、enqueue_seq、state、parent_attempt_id；同 run/request_key 唯一。 |
| `task_dependency` | task_id、prerequisite_task_id、run_id；同 run、无自环/环；活动期间不可修改。 |
| `request_resource` | request_id、canonical_key、mode、normalization_version；同键合并为更强权限。 |
| `execution_attempt` | attempt_id、request_id、task_id、run_id、generation、state、owner_epoch、reserved_child_id、workspace_id、prompt_digest、outcome、proof_ref、timestamps。task/generation 唯一；同任务最多一个未释放 attempt。 |
| `resource_hold` | attempt_id、canonical_key、mode、acquired_at、released_at；所有未释放行参与跨 run 冲突。 |
| `scheduler_event` | event_id、run_id、attempt_id、source、source_event_key、payload_digest、timestamp；与状态变化一同提交，重复来源事件不重复生效。 |

kind=effect 的 attempt 没有 child_id，用于 C 的测试进程或交付资源预约；它仍占用相同预算。C 的 `workflow_effect` 只引用该 attempt，不另建资源锁或子代理调度器。

默认每 run 排队上限 100，协调域总排队上限 1000；资源最多 32 项、依赖最多 64 项、序列化 brief/spec 最多 64 KiB。上述数值是本次建议的可配置默认值；整数范围、长度上限和修改审计必须验证。活动上限不能大于 host 配置，write 上限不能大于 active 上限；降低额度不抢占已有任务，而是停止超额期间的新准入。

host 可另外设置协调域全局 active/write 上限，默认不额外设置全局数值上限；每 run 的 6/2 和跨 run 资源互斥始终生效。额度策略由可信 host 配置或 root 的已授权控制动作修改，子代理不能通过请求 profile 提高额度。

新表使用 CHECK、唯一约束和索引；同 run、引用关系在现有写事务中强制检查。不能假设 SQLite 外键已经启用。schema_version 最后写入，失败回滚并关闭失败句柄。旧 task/fact/handoff 不重写；运行新 schema 后禁止用旧版本程序继续写库，回滚使用匹配的程序和数据库备份。

## 5. 准入与公平性

入队在一次短写事务中验证可信身份、任务资格、幂等键、容量、依赖及规范资源。相同 request_key + 相同内容返回原凭据，内容不同返回冲突。显式重试进入队尾并产生新 request；旧记录不覆盖。

同一 `BEGIN IMMEDIATE` 准入事务完成：

1. 按 enqueue_seq 选择依赖已 accepted 的最早可准入请求。
2. 重新核对该 run 与 host 全局 active/write 额度。
3. 核对所有资源：read/read 共享，任何 write 与同键其他 hold 冲突，不加 run 过滤。
4. 较早且依赖就绪的写请求阻止后来的冲突读/写超车；无关资源可以继续。
5. 原子分配递增 generation、attempt、全部 holds、派发意图及审计；不允许部分资源领取。

reserved、dispatching、running、stopping、reconciling 均占额度，只有经过可信结算的 settled 才释放。计数从持久未释放 attempt 推导，不依赖内存计数。多个进程竞争由同一 SQLite 事务约束；外部派发仍需独立的进程所有权规则。

依赖失败或取消只阻塞下游，不隐式取消。依赖被重新打开后，尚未准入的任务停止派发；已活动的下游进入 dependency_invalidated、请求停止并保留 holds，不能以旧依赖状态通过验收。重新满足依赖后仍需显式新 attempt，旧执行不会自行恢复。

## 6. 嵌套任务与死锁边界

真实父代理、持久 parentSession 和 depth 必须一致，不把孙代理改挂 root 来绕过原生限制。root 编排会话不执行用户任务，不占执行额度；执行中的父 attempt 仍占额度和资源。

嵌套派发采用**立即准入或拒绝**：在同一事务内检查 FIFO 屏障、总/写额度、深度、祖先资源和真实父会话可用性。没有全部条件则不留下等待父任务的子请求，返回 `E_NESTED_CAPACITY`、`E_NESTED_RESOURCE` 或 `E_NESTED_LIFECYCLE`。执行者把未完成拆分建议交回主代理，由主代理明确决定后续安排。

成功嵌套后，父 attempt 即使模型回到 idle，也保留自身额度、holds 和 native handle，直到子树已结算。宿主适配器在子树清空前不得销毁父 handle。父子同一物理资源有写冲突时不能同时执行。此策略支持预算内、资源不冲突的深度 2 委派；不承诺自动挂起持锁父代理以等待将来额度。

parent teardown、取消或插件卸载时先关闭子树新派发，再按子到父顺序停止/回收。原生 parentAgent 是真实关系，不自动承担递归回收；TaskForce 的 host/attempt scope 拥有各 handle。受管嵌套只能经本调度器创建，不允许混入原生 continuable；如发现此类后代，先调用已验证的 `drainContinuableDescendants([exactAgent])` 并记录边界违规，不能只销毁父 handle。任何不能证明回收完成的 attempt 进入 reconciling，保留占用。实际目标宿主无法维持此生命周期时，只阻止嵌套模式并报告能力缺失，不能悄悄将 maxDepth 改为 1 后称 B 验收完成。

## 7. 工作区和资源隔离

规范键由宿主生成，模型不得直接提交 canonical_key。必须包含物理工作区键；git 操作还需仓库 common-dir 和分支/远端更新键。实际 profile 决定 read/write；存在不受限 shell 或未知写能力时按 write。

- 路径按可信 workspace 元数据、realpath 和 git 解析结果规范化；已有路径别名不能逃逸资源冲突。不存在路径通过可信父目录和受限后缀建立，创建后再次验证。
- realpath 不被描述为 bind mount、所有硬链接或跨容器的全局身份；无法确定别名的部署需提供稳定 workspace identity，否则拒绝并发保证。
- 默认每个代码写 attempt 建立独立 clone：独立目录、git 元数据与对象存储，不使用 alternates/共享对象库/硬链接。清理和重用必须等待 quiescence 证明。
- worktree 模式可显式选择。若执行者能任意修改共享 Git 元数据，必须对 common-dir 持 write 锁，可能使同仓库写任务串行。只有经过验证的受限工具配置才允许更细粒度并发。
- 分支发布使用单独 host effect，按规范 repository/remote/ref 资源串行；独立工作区不直接竞写公共交付分支。
- cwd 是工作目录，不是文件系统沙箱。执行工具必须遵守已验证的宿主权限/沙箱配置；超出工作区的操作需申请相应资源或被拒绝。

跨 run 只暴露 `resource_busy` 及调用者自身资源描述，不返回其他 run 的标题、会话、任务或持有者标识。不同 DB/DSH home 之间没有本规格声称的互斥保证。

## 8. 原生适配与可信身份

目标初次验证版本为 `@deepseek-ai/*@0.1.7-rc.2`；不把 upstream master 0.2 的接口当成 rc.2。能力检测和集成测试决定支持范围，包声明的最低版本不等于所有新版兼容。

建议原生派发序列：

1. 排队时只保存请求意图。实际准入/启动时，在任何异步准备之前同步捕获真实父代理的 delegated policy 和执行配置；随后在同一同步流程的 SQLite 事务中预留 child session UUID、attempt/generation、owner_epoch、工作区身份、初始输入摘要及该不可变策略快照/摘要。
2. 在外部创建工作区并验证；未知创建结果保留 intent 进入对账。
3. 用公开 delegation helper 计算真实 depth、agent options 和 composition；setup 始终使用步骤 1 的策略快照，不在异步准备后重新取得更宽权限替换它。
4. 调用现有 `ctx.agents.create({sessionId, parentAgent, meta, setup, ...})`；meta 从 `childSessionMeta` 导出，只将 cwd 改为可信工作区。
5. 未发布 setup 安装 inherited policy、composition、TaskForce guard 和实际 session → attempt 绑定；同步 setup commit 再核对 owner fence/工作区。任一步失败不得运行初始输入。
6. 创建返回后重新核对持久 fence 和父策略/配置摘要；父身份失效或可观察策略发生变化（包括变得更严格）时不投递，回收后以新 attempt 重新准入。关闭其他输入路线，仅投递一次初始输入。实际 session/输入/turn 与 attempt 分别记录，不能用 label 关联。
7. 等原生会话和受管子树静止，检查输入确实被消费、turn 结果和失败状态；`whenIdle()` 本身不表示成功。
8. 对活会话执行 `ctx.sessions.flush(session)`，要求确有持久化监听器且成功；再 await 原生 handle.dispose 及受管作业回收。
9. 将结果、持久 checkpoint 和回收证明 CAS 写入当前 attempt 后释放 holds。任何未知/失败清理均不能作为成功结算。

使用原生 factory 的消费者，不注册替代 factory、不改 agent loop。TaskForce 自己持有创建返回的 handle；`ctx.agents.get()` 不能恢复 disposer。原生 subagent 的观察事件只用于诊断，不是准入或持久结算凭据。为保持真实策略继承，派发需要实际可用的授权父会话；父会话退出按取消/回收规则处理，重启后父会话未恢复则暂停新派发，不伪造 root 或自动恢复可能带有 pending input 的会话。

所有受管 task 变更，包括旧 `task_claim`、fact、submit、close 等，均经过共享 store 的身份/代际门禁。模型提供的 owner、created_by、child_id 仅作标签，不能授权。当前 attempt 执行者仅操作获分配任务；root 做控制/验收。过期代际不能修改任务、提供可晋级证据或自行解锁。非受管任务保持 A 行为。

## 9. 恢复、取消和外部副作用

状态为 `reserved → dispatching → running → stopping → settled`，其中任一步结果不明可进入 `reconciling`。终态 outcome 为 succeeded/failed/cancelled/never_started，和业务 accepted 分离。重复事件只折叠一次。

数据库与创建会话、执行 shell、发布 PR 不是同一个事务。dispatching 写入后、真正创建前崩溃也视为不确定。心跳超时、UI idle、注册表中没有 agent、收到 interrupt 回执均不是停止证明。

初版每个协调域只允许一个具有**不依赖超时失效**的进程派发所有者。独占锁必须由操作系统进程持有并在进程退出时释放；无法提供这种锁的部署返回 capability error。租约/时间戳只供诊断，不能在旧进程仍可能恢复时抢占。跨机器/网络文件系统锁和多活派发不在初版支持范围。

接管后先只读查询持久会话/TaskForce intent/工作区，禁止为“查看状态”调用 `agents.resume()`。`sessionQuery.readSession()` 的冷读会添加内存中的 interrupted 闭合事件，不能将其当作已持久化成功；需要原始证据时使用 `sessionPersistence.open(id, 'read')`、reader.read 和 finally close。找到可验证终态和回收证据可幂等结算；只有明确证明未启动且旧发送者不可能再发送，才能记 never_started。其余进入 unknown，保留资源和证据，等待有依据的人工/宿主对账。操作员点击重试也不能把未知旧写进程当成已停止。

插件卸载关闭新准入、停止后台 wakeup、等待所属原生 handles 和进程回收；无法回收时留持久诊断，不宣称卸载完成或释放所有资源。重新启用恢复同一数据库的 intents；不能凭内存空白创建重复执行。

## 10. C 阶段共享端口

以下为 host-only TaskForce 接口，不提供可伪造 host receipt 的模型工具：

- `enqueue(auth, request)` / `state(auth, query)` / `control(auth, action)`：可信身份来自实际宿主。
- `reserveEffect(auth, {effectId, taskId, requestKey, profile, resources})`：排队并原子产生 kind=effect 的 attempt，返回 requestId/attemptId/generation（未获准入时仅 requestId）。
- `bindEffect(auth, attemptId, generation, externalId)`：写入可信外部关联。
- `settleAttempt(adapterContext, {attemptId, generation, outcome, proof})`：只接受持久结果及 quiescence 证明，释放一次。
- `reconcileAttempt(adapterContext, attemptId)`：产生 running/settled/never_started/unknown 的可信观察，不自动重放。

普通模型不能对 accepted 任务排队；C 已验收后的交付 effect 由 workflow policy 专门授权。每次测试/交付 effect 的资源预约与 C effect intent 在同一 SQLite 事务中建立，外部执行在提交后进行。

## 11. 验收与交付顺序

| 验收组 | 必须证明 |
|---|---|
| 数据与竞争 | 迁移失败回滚；双连接/多进程同时领取不超 6/2；同任务不双派；审计失败整体回滚。 |
| 队列与依赖 | 容量上限、幂等冲突、同 run 校验、环检测、FIFO 写屏障、取消/重开依赖行为。 |
| 资源 | 路径别名、read/read、read/write、跨 run 互斥与隐私；独立 clone；worktree 共享元数据保守串行。 |
| 身份与树 | 实际会话绑定先于第一工具；异步准备期间父策略变化不升级权限；发送端和目标端输入约束；祖孙共预算；伪造 child_id 无效；所有旧入口不能绕过；嵌套额度/资源不足立即明确拒绝。 |
| 生命周期 | 创建/setup/flush/dispose 各阶段故障；重复回调；父会话退出；插件卸载重启用；背景作业未停时不释放。 |
| 崩溃恢复 | intent 前后、创建返回前后、输入后、结算前后崩溃；单进程所有权；只读对账不执行 pending input；未知不盲目重派。 |
| 自动化协作 | effect 与 agent 共用预算；旧代际回执仅审计；交付资源互斥；accepted 例外只能由 workflow host policy 发起。 |

实施分为可独立审查的持久核心、原生适配、模型工具/旧入口约束三部分；C 随后消费稳定端口。具体 TDD 任务及提交拆分在本规格获审阅后写入实施计划，沿用用户已选择的多代理执行方式。

离线 fake adapter 验证与真实 rc.2 boot、工具权限、嵌套、作业清理、重启测试分别报告。没有后者只能称“核心通过、宿主未验证”，不能称并发调度已经完整上线。
