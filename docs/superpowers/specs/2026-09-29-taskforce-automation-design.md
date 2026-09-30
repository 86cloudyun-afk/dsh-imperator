# TaskForce 阶段 C：自动开发工作流详细设计

初稿：2026-09-29。修订：2026-09-30（DSH 0.2 契约对齐）。状态：**草案，待用户审阅；尚未实现**。
既有“推进”确认覆盖总体范围和 A → B → C 顺序，不等于批准本详细规格或其实施。
依据：`2026-09-29-taskforce-strengthening-design.md` 第 6、7 节；前置为阶段 A 可靠性和 `2026-09-29-taskforce-scheduler-design.md` 定义的阶段 B 持久调度。
本文件确定架构、契约与验收标准，不是实施计划；不授权未来 PR 自动合并。
当前代码依据：PR #6 `19238ea539de8dd6d4e8f97f037ee4eda4a9f255`，精确宿主验证目标为 `@deepseek-ai/dsh@0.2.0-rc.2`。

## 1. 目标与边界

交付一条可恢复、可追溯的六阶段流程：计划 → 实现 → 测试 → 独立审查 → 主代理验收 → 交付。
每个工作流关联一个任务；普通任务继续使用阶段 A 的基础证据规则。
工作流阶段、任务状态和调度执行状态分别存储、分别展示，不复用一个 status 字段。
严格验收绑定规范仓库、完整 commit SHA、计划版本与实现修订；工作区路径和分支名只是定位信息。
模型提交的是候选产物、审查判断或执行请求；测试执行与 PR 发布结果必须来自可信宿主适配器。
能力缺失阻塞依赖该能力的阶段，不能退化成提示词约束后宣称自动开发已生效。
阶段 C 交付目标为可审查 PR，自动合并不纳入执行接口；分支就绪可以单独报告，但不算 PR 交付完成。

## 2. 现有实现依据与方案选择

| 已有证据 | 设计结论 |
|---|---|
| `lib/store/evidence.js:9-20`；`lib/store/index.js:682-708` | 基础依据允许 PLAUSIBLE 和无路径 fact；不能直接充当严格测试证明。 |
| `lib/tools/index.js:1118-1141`；`lib/store/index.js:950` | child_id/created_by 是输入标签，不能判定实现者与审查者身份。 |
| `lib/tools/index.js:381-469,831-840` | 可从 exec.agent 获取实际会话和根 run；深层祖先缺席时须依赖 B 的持久身份恢复。 |
| `lib/store/index.js:1114-1197` | acceptTask 已原子化，但基础依据和 waiver 能通过；必须在这条公共路径加入严格工作流闸门。 |
| `lib/store/index.js:934-943,1215-1289` | 已验收历史不自动重写；晚到问题记录 blocker，显式 reject 才重新复核。 |
| `lib/store/sqlite.js:53-85` | 已有 BEGIN IMMEDIATE/savepoint，拒绝异步事务；外部操作必须在事务外执行。 |
| `tools/verify-all.mjs:18-54` | 验证 CLI 能真实启动进程并区分宿主未验证，但尚不是持久、SHA 绑定的工作流执行服务。 |

以上行号对应阶段 A 本地 `f488ade`，其已发布等价树为 `a75a899`，仅保留作历史定位。本轮以 PR #6 的当前代码与原生验收为依据，新增契约/覆盖证据按下述 0.2 研究定位；不能将历史行号当当前源码行号。
目标验证版本固定为官方 `@deepseek-ai/dsh@0.2.0-rc.2`；最低版本 `>=0.2.0-rc.2` 不表示所有后续版本均通过。旧 [0.1.7 宿主研究](../research/2026-09-29-dsh-host-contracts.md)仅为历史背景；新 [0.2 B/C 宿主研究](../research/2026-09-30-dsh-0.2-bc-host-contracts.md)是本规格的核对材料，需区分实测、源码候选与实施前原生 spike。

PR #6 [已记录的原生验收](../research/2026-09-30-dsh-0.2-acceptance.md)只覆盖基础 agents.create/setup/parent meta 与 composition、root PTC guard、persona、spawn/fork 配置和 depth helper 的 2/3 边界、现有任务工具、handle 释放、插件卸载重启用与注册恢复。没有模型请求，没有 B/C 产品代码或真实长时多层执行、崩溃恢复、严格 flush、后代 jobs 回收或 target ingress 验收。本轮没有重跑该宿主验收。

已核实的 0.2.0-rc.2 源码契约：`CreateAgentOptions`、`AgentSetupCommit`、`AgentHandle` 类型与 0.1.7 相同；公开 delegation helpers 与基本 drain 也已在旧版存在，均不得表述为 0.2 新增。`SessionStore.flush` 在两版均存在，0.2 实现无 listener 返回 false、所有 listener settle 后返回 true、失败则 reject；使用方须检查 true 并确认 listener 连接预期持久 backend。create 的 setup commit 之后仍异步 appendUnstoredSuffix，再 publication，所以 commit 不是最终发布/投递 fence。

0.2 新增失败 step 的共享 `ToolCallRecovery` 路径，在 step 异常时给缺结果调用补记保守 tool/result 再关闭 step，补记到 Session 事件流仍需严格 flush。`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 在旧版已存在，是恢复状态，不是成功证明、child 创建证明或外部进程停止证明。`readColdSessionLog` 通过 persistence `open(id, 'read')`、read、close 获取日志，并在返回的内存 events 中追加 `interruptedTurnClosers`；合成闭合不得冒充持久事件或终态证明，原始证据应直接只读打开 persistence handle、read、finally close。以上为 13 个已取证官方包的源码证据；PR #6 未覆盖的实际 backend 持久保证、进程终止与 B/C 接线仍需关键 API/生命周期 spike。比较不构成全包/provider 兼容性结论。长时多层运行属于上线集成验收，不是开始核心实现的前置条件。
比较三种方案：普通 fact 编码阶段改动小但身份和验收旁路难封闭；独立通用 DAG 引擎重复调度职责；同库类型化工作流可复用事务和生命周期。
**采用同库类型化工作流 + 宿主适配端口**。普通 fact 只保存可读摘要，不是严格工作流的事实源。

## 3. 与阶段 B 的职责契约

B 唯一拥有 `execution_attempt`、run/generation/实际 session 身份、原子资源占用、准入与子代理派发。
C 的 assignment 只引用 B 的 attempt，并绑定“这次执行承担哪个阶段和修订”，不复制调度器。
B 每次受管 attempt 目标为用 `ctx.agents.create` 创建全新实际子会话，使用预留 id、meta.cwd、setup 和原生 disposal。delegation helper 输出/权限及 composition 版本在首次 await 前快照，异步准备或创建期间父策略/配置变化则停止该次投递。setup commit 后仍有异步 appendUnstoredSuffix 与 publication；必须等 create 发布完成并复核持久 fence，才能投递初始输入。活会话 flush 必须严格返回 true 且验证实际 backend writer/checkpoint；按子到父 dispose，并只读核对最终持久结果和作业/进程静止。具体回收效果仍须 spike 验证。
受管范围不重启 continuable 旧会话；返工和失败重试分别创建新 attempt、新 session，历史身份永久保留。
保留实际父链和 `maxDepth: 2`，不将孙会话压平为主会话子代；深度不足时返回明确阻塞。
父会话、兄弟会话及非受管旧原生工具保持独立兼容边界；C 不凭标签接管它们，也不宣称约束整个宿主所有 shell。
C 独立拥有 `workflow_effect`，记录测试/PR 等外部操作；该表不能用来重复调度子代理。
所有运行代码或更新仓库/远端的 effect 必须经 B host 服务预约所需资源；未知执行能力按写处理。
B 为 effect 创建通用 execution_request/attempt（kind=effect），与代理 attempt 共用每 run 6 活动/2 写额度及全局资源占用。
C 引用返回的 attemptId/generation；B 的 holds 是唯一持有事实源，C 不能自行以超时释放锁。
同一 task 的代理/effect attempt 顺序运行；仅经 workflow 验证的 delivery effect 可在业务 task accepted 后申请，普通 enqueue 不可。
默认每 attempt 独立 clone，不共享对象库、不使用 hardlink；无限制 shell 下的 worktree 不能视为 Git 元数据隔离。
仅经验证的受限执行 profile 或保守的 git-common 写串行允许 opt-in worktree；测试同样使用独占快照。

## 4. 持久模型

表采用增量、版本化迁移；所有子记录经 workflow 归属当前 run，跨 run 统一拒绝。
JSON 只存已校验的结构化载荷；核心状态、关联 id、完整 SHA、版本和唯一性键使用明确列。

| 表 | 必需字段与约束 |
|---|---|
| `workflow` | id、唯一 task_id、run_id、stage、phase_state、row_version、current_plan_id、current_revision_id、rework_count、max_auto_reworks=2、policy_hash、lead_session_id、blocked_reason、时间。 |
| `workflow_plan` | id、workflow_id、version、目标、范围、边界、自包含任务说明、command_specs、必需检查、repo_id、目标 base_ref/base_sha、policy、author_session、approved_by_session、时间；版本不可变。 |
| `workflow_revision` | id、workflow_id、plan_id、repo_id、object_format、完整 commit_sha、诊断 tree_sha、base_sha、delivery_ref、snapshot_id、实现 assignment、可信 commit_receipt、时间；记录不可变。 |
| `workflow_assignment` | id、workflow_id、stage、plan_id/revision_id、scheduler_task_id、execution_attempt_id、时间；实际 session/generation 由 B 记录关联读取；一条 assignment 对应一次 attempt。 |
| `workflow_evidence` | id、workflow_id、plan_id、revision_id、类型、producer_kind、assignment/effect_id、实际提交 session、唯一 event_id、result、载荷、产物定位/digest、时间；追加不可变。 |
| `workflow_decision` | id、workflow_id、plan_id/revision_id、kind、实际 actor_session/host_service、采信 evidence_ids、原因、前后 row_version、request_key、时间；同 workflow/request_key 唯一。 |
| `workflow_effect` | id、workflow_id、kind、plan_id/revision_id、request_hash、operation_key、expected_version、state、execution_request_id、execution_attempt_id、generation、adapter_job/PR_id、receipt、时间；operation_key 唯一。 |

`stage` 固定为 `plan|implement|test|review|lead_acceptance|delivery`。
`phase_state` 为 `ready|waiting|blocked|completed|cancelled`；完成时 stage 保持 delivery。
`effect.state` 为 `pending|dispatched|succeeded|failed|unknown`；unknown 必须对账，不表示可重试。
`evidence.producer_kind` 为 `host_execution|agent_claim|agent_review`；后两者不能伪装执行回执。
`evidence.result` 为 `pass|fail|unverified`；未运行、缺日志、无法确认版本均是 unverified。
原生/PTC 工具事件去重键须关联所属执行上下文（实际 session/turn/step）及可核验的 session-log seq、surfaceOp/原始事件引用（如实际提供 `sourceEventSeqs`），不能仅用 callId/subCallId。展示 replacement 的新 seq 归回原始逻辑调用，不得记作新调用；缺乏可靠来源关联时能力不明、不可采信。service、runner、PR 事件绑定 operation_key、attempt/generation 与 adapter receipt 身份。`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 只能作为保守恢复状态，不得转为 pass、成功 receipt 或 quiescence 证明。
accept 决策冻结采信证据集和 SHA；之后追加新证据不能悄悄改写旧决定。

## 5. 六阶段转换

### 5.1 计划

主会话创建工作流，明确目标、允许改动范围、非目标、验收命令、必要宿主检查、时间盒和产物要求。
命令定义包含 command_id、executable/argv 或显式 shell、cwd 规则、超时与资源声明；实际执行受宿主权限约束。
计划由实际根会话明确批准后进入 implement；批准和首个派发意图在同一短事务提交。
修改验收命令、目标基线或范围产生新 plan_id，旧测试和审查不能直接套用。

### 5.2 实现

B 准入后派发全新实际子会话；任务说明必须自包含并携带 workflow、plan、attempt、generation 和真实工作区。
执行者提交候选 commit；宿主仓库适配器核实规范 repo_id、完整 commit 对象及隔离快照后生成 revision。
未提交变更、无效 SHA、错误仓库或无法确认快照只能作为 agent_claim 保存，不能进入测试合格路径。
当前修订的所有参与代码写入会话纳入实现者集合，包括二次委派写入者；集合来自受管 attempt 记录。

### 5.3 测试

C 写入测试 effect 意图，B 原子预约资源，runner 在指定修订的隔离快照执行已批准命令。
可信回执记录实际命令、snapshot/cwd、完整 SHA、退出码/信号/超时、起止时间、日志定位和 digest。
仅当全部必需检查有当前修订的成功回执，且 B 已可信结算相关 attempt 及实现后代并确认 quiescence，才进入 review；顶层命令退出 0 不覆盖其中“宿主未验证”。
执行者口头通过、上传日志或 task_fact 的 CONFIRMED 均不替代 host_execution 回执。
失败进入有界返工；不能运行或效果未知进入 blocked/对账，不记成测试通过。

### 5.4 独立审查

B 分配全新实际审查会话，其 session 不得出现在当前修订实现者集合；同会话换 persona/轮次不构成独立。B 的 agent scope guard 只保护发送者，不能单独封闭外部会话、UI、API、messages 或 resume 的 target ingress；C 的验收资格依赖 B 与宿主入口封锁能力已被核实。
审查只读当前完整 SHA 的快照，分别提交需求符合性、代码质量结论和逐项 findings，并保留可定位审查产物。
两个结论都通过且为已确认审查结论才能进入 lead_acceptance；host 身份戳证明提交者，不保证模型判断正确。
审查者若写入修复即成为实现者，产生新 revision 并重新测试、另派独立审查；不能先改后自批。

### 5.5 主代理验收

沿用 `task_submit` 后 `task_accept`；工作流阶段未达到 lead_acceptance 时，不允许通过既有 accept 旁路验收。
共享 store accept 路径同事务校验：实际根身份、expected_version、当前 plan/revision/SHA、必要测试和独立审查、产物可核验、零未解 blocker，以及相关 attempt/实现后代均已由 B 可信 settled 且 quiescent。
`waiver_reason` 只保留普通任务行为，不能绕过开发工作流严格门槛；直接调用 store 也受同一闸门限制。
原子写入 task accepted、workflow accept 决策、采信证据 id、实际 lead session 和 delivery 意图；任何审计失败全部回滚。
验收需要的外部产物检查先在事务外完成并存可信回执，事务内核对对应版本；不持 SQLite 锁等待文件/网络。

### 5.6 交付

交付 effect 在授权仓库内推送/验证分支并创建或查回 PR，必须使用已验收 SHA 和计划目标仓库/base_ref。
只有可信 provider 回执确认 PR head SHA 等于 accepted_sha、目标 repo/base_ref 正确时，workflow 才为 completed。
`task.status=accepted` 与 `workflow=delivery/blocked` 可以同时存在；界面分别报告代码验收和 PR 交付。
PR 超时或结果不明先 lookup 对账，不能重复创建；只有分支没有 PR 时显示 branch_ready，保持交付未完成。
验收后分支移动保留历史验收，标记 delivery_current=false 并阻塞；显式 reject/reopen 后才接受新修订。

## 6. 版本、证据与权限

验收资格键为 `(workflow_id, plan_id, revision_id, repo_id, full_commit_sha, policy_hash)`，不只比较 SHA 字符串。
短 SHA 不合格；按仓库 object_format 校验完整对象。相同树的 amend/cherry-pick/rebase 仍是不同提交。
A → B → A 或计划变化均产生新 revision，不能复活此前证据；旧证据保留并显示 stale 原因。
迟到回执记录其真实历史结果，但旧 attempt/generation、旧 revision 不能推进当前流程。
成功回执先于可信结算到达时仅保留为 pending 资格；所有执行阶段推进、最终验收和交付完成都等待 B 的 settled/quiescence 及相关实现后代静止，不能凭 receipt 推断已停止。
测试前后 HEAD 相同不能证明中途文件未变；必须隔离工作区、预约资源并限制其他写入者，诚实声明隔离边界。
允许受控构建产物写入；跟踪源码意外变更、快照身份漂移或日志缺失使回执 unverified。
证据日志由宿主持久保存并记录 digest；脱敏后的存储对象与原始日志不能混淆，禁止把任意模型路径当可信产物。
身份仅取 host exec.agent 与 B 持久 attempt；拒绝模型提供的 run_id/session_id/provenance 越权。
新主会话不能凭名称接管旧 run；恢复保留原会话身份或走 B 明确授权迁移，不重解释历史身份。
普通 task_claim/child_id 标签兼容保留，但不授权工作流提交、审查或验收。

## 7. 模型工具与宿主端口

新增三个模型可见工具，输出沿用 ok/code/hint 结构；内部状态不各自新增工具。

| 工具 | 参数与权限 |
|---|---|
| `task_workflow_create` | task_id、plan、policy；仅根会话；创建严格工作流并返回能力缺口，不隐含批准计划。 |
| `task_workflow_submit` | workflow_id、stage、action、expected_version、request_key、payload；action 固定 approve_plan/submit_revision/request_tests/submit_review/request_delivery/resume；按角色和 assignment 校验。 |
| `task_workflow_state` | workflow_id 或 task_id；同 run 读取阶段、任务/调度状态、证据资格、返工额度、能力缺口和 PR 观测。 |

`task_accept`、`task_reject` 对工作流任务增加 expected_version/request_key；普通任务旧参数保持兼容。
approve_plan、request_tests、request_delivery、resume、accept/reject 的模型调用只允许根会话；submit_revision/review 要求当前已授权 assignment。
宿主可按已批准工作流策略自动 request_tests，只能选择计划内固定 command_id；实现者不得选择或触发任意命令执行。
模型不能写 host receipt、实际 exit_code、producer_kind 或认证身份；诊断性自述保存为 agent_claim。
所有写入使用请求键与 request_hash；同键同内容返回原结果，同键不同内容返回冲突。

| host 端口 | 明确契约 |
|---|---|
| `workflow.submitStage(auth,input)` | 校验阶段、身份、版本并原子追加候选/判断/意图；不在事务内执行外部操作。 |
| `workflow.recordReceipt(adapter,operationId,receipt)` | 只接受注册宿主适配器，去重、记录回执；推进/返工须再核验 B 可信结算，早到回执保留 pending。 |
| `workflow.acceptTask(auth,input)` | 共享 task_accept store 闸门；原子记录工作流和任务裁决，拒绝严格模式 waiver。 |
| `repository.observeCandidate/prepareSnapshot/inspectSnapshot` | 验证规范仓库/完整对象、准备隔离快照、返回可信身份和内容状态。 |
| `testRunner.start/lookup` | 按 operation_key 启动或查回持久 job；返回 running/settled/unknown 和真实命令/退出/日志回执。 |
| `delivery.publishOrFind/lookup` | 按 operation_key 发布或对账 PR，核对目标仓库、base/head ref 和 expectedHeadSha；不提供 merge。 |
| `scheduler.reserveEffect(auth,{effectId,taskId,requestKey,profile,resources})` | B 创建/查回 kind=effect 的 request/attempt；返回 requestId/attemptId/generation，未获准入时仅 requestId，排队不得执行。 |
| `scheduler.settleAttempt(adapterContext,{attemptId,generation,outcome,proof})` | 仅宿主凭持久结果和可信 quiescence 证明结算并释放 holds；C 保存效果结果不能直接释放，unknown 保留占用。 |

上述为待实现内部端口名，不宣称 DSH 已原生提供这些方法；真实适配器须按 `@deepseek-ai/dsh@0.2.0-rc.2` 契约验证。工作流 receipt、runner 和 PR 适配器仍待实现；B capability blocker 与新会话均是 C 的前置接口条件。不能要求尚未实现的整个 B 已通过全部上线验收才能开始 C 核心实现，但开始前必须明确稳定端口和阻断能力清单；端口未具备时将依赖该能力的集成阶段标记 blocked。
子代理实现/审查派发仅使用 B host 服务；workflow 不再暴露 create-child/send-message 执行路径。
错误码固定含 E_WORKFLOW_CONFLICT、E_WORKFLOW_STAGE、E_WORKFLOW_CAPABILITY、E_REVISION_STALE、E_EVIDENCE_UNTRUSTED、E_REVIEW_NOT_INDEPENDENT、E_REWORK_LIMIT、E_EFFECT_UNKNOWN。
继续复用既有身份、跨 run、SQLite busy/transaction 错误码；任何错误都不降低证据门槛。

## 8. 返工、重试与重启

初始实现为第 0 轮；测试/审查明确失败后进入下一自动实现周期才增加 rework_count。
默认允许返工第 1、2 轮；仍需第 3 轮时 blocked，由主代理汇报、调整计划或显式授权新额度。
同一失败修订的多条 finding、重复事件只消耗一轮；重启、claim、消息重发不能清零计数。
能力缺失、进程状态未知、取消和基础设施失败不消耗代码返工轮次；基础设施确定可重试时另设最多 2 次自动重试。
更改返工额度/重试策略必须由根会话明确提交理由并落审计，不能由执行者扩大预算。
B/C 共用同一 SQLite；阶段转换、C effect 意图、B reserveEffect 创建的资源预约/request 及 C request 引用在同一写事务提交，不存在两次提交之间的关联缺口。
立即准入时 attempt 引用也在该事务写入；排队后的异步准入按稳定 effectId 在同一准入事务补齐 C attemptId/generation，关联完成后才可派发。
外部 runner/PR 调用在数据库提交后进行；数据库与外部系统仍不承诺 exactly-once。
C 只在 B 返回当前有效准入后驱动 effect 适配器；回执同时绑定 effect、attemptId/generation，旧回执不能结算新 attempt。原生/PTC 工具事件的 source_event_key 绑定实际 session/turn/step 及可核验的 session-log seq、surfaceOp/原始事件引用（如实际提供 `sourceEventSeqs`），不能仅依赖 callId/subCallId；展示 replacement 的新 seq 归回原始逻辑调用，不得触发新执行/effect。缺少可靠来源关联时能力不明、不可采信。service/runner/PR 事件绑定 operation_key、attempt/generation 与 adapter receipt 身份。单个失败/取消观察事件不能结算或释放 holds，但持久结果和 quiescence 证明齐备时可结算 failed/cancelled 并释放，否则保持 unknown 与占用。
恢复先读取 workflow/effect，再对账 B attempt/资源、runner job 和 PR；已落盘成功回执只折叠一次。
unknown 不自动重发、不提前释放资源；没有可靠 lookup 时阻塞并交主代理确认外部状态。
PR 对账同时使用操作标记、仓库、base/head 身份；仅分支同名不足以证明是同一次发布。
卸载停止新派发并保留持久意图；发出 interrupt 不等于旧执行者已停，释放资源沿用 B 的确认规则。
旧写者确认停止前不得复用其工作区；代际检查保护数据库提交，不被描述成文件系统写隔离。
显式 reject/reopen 与工作流失效/新周期同事务更新；保留历史 accept 快照及晚到 blocker。

## 9. 验收与集成门槛

| 编号 | 必须验证的结果 |
|---|---|
| C01 | 迁移可重复且失败回滚；普通任务与历史 accepted 不改写；新代码拒绝未知未来 schema；运维禁止旧程序写升级库，成对备份恢复演练通过。 |
| C02 | 同 session 换标签仍不能自审；嵌套实现者也被排除；实际不同授权 session 可审查；伪造身份和跨 run 拒绝。 |
| C03 | task_fact CONFIRMED、模型 exit=0、假日志、假 provider 回执均不能满足 host_execution 门槛。 |
| C04 | 脏代码、错误 repo、短/不存在 SHA、运行期源码漂移、日志缺失、超时/信号退出均不能验收。 |
| C05 | SHA/计划/policy 变化及 A→B→A 使旧证据失效；等价树不同提交不复用；迟到 attempt 不能推进。 |
| C06 | task_accept、waiver、task_close、直接 store 路径都不能绕过严格模式；注入审计失败，任务/工作流全回滚。 |
| C07 | 双审查结论、必需检查、零 blocker 及相关 attempt/实现后代可信静止才可验收；早到成功回执不能推进，顶层退出 0 不能覆盖未验证。 |
| C08 | 重复失败只计一次返工；两轮后阻塞；基础设施独立重试预算有界，重启不重置预算。 |
| C09 | effect 意图/request/引用同事务回滚；延后准入关联完成才派发；在启动、回执、验收、push、PR 前后崩溃，恢复不盲重派且 unknown 保留占用。 |
| C10 | PR head/base/repo 与接受版本一致才交付；分支移动显示漂移；无自动 merge 调用或隐含授权。 |
| C11 | 缺适配器返回能力错误；实现者 request_tests/任意命令被拒；父链/maxDepth2、每 attempt 新会话、非受管原生工具兼容分别验证。 |
| C12 | 真宿主重启/卸载重启用、深度 2 身份恢复、日志持久化、授权测试仓库 PR 发布闭环可追溯。 |

独立状态机/假适配器测试与真实 DSH 集成分别报告；前者通过不能表述为自动执行/交付已完成。
实施前接口阻断项及解除证据见 [0.2 宿主复核第 4 节](../research/2026-09-30-dsh-0.2-bc-host-contracts.md#4-实施前阻断项与解除条件) H01–H06、C01–C02：创建/setup 身份关联、持久事件与 flush、输入封锁、子树回收、冷恢复、隔离资源，以及 B 端口和可信 runner/PR 协议。未解除时阻断对应适配器/部署方案定稿，离线核心可先实现；相应集成阶段保持 blocked。B 的完整真实上线验收与 C 的生产启用验收仍是独立门槛。工作流 receipt/runner/PR 适配器实现和端到端授权测试仓库验收均尚未完成。
生产启用需要已验证 B 适配器、身份恢复、隔离仓库快照、持久 runner 回执、产物存储和 PR provider 适配器。
先在数据库副本验证迁移与读写兼容，准备应用/数据库成对恢复；运行升级库后运维禁止旧程序继续写入。
新代码拒绝未知未来 schema；不能声称新增迁移会使历史旧二进制自动拒绝新库，回滚必须恢复匹配的旧应用与旧数据库备份。
本规格审阅通过后再形成实施计划；接口限制变化先更新规格，不猜宿主接口或放宽验收标准。
