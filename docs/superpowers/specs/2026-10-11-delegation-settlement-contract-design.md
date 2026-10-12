# 原生派发模式与跨阶段复用契约设计

用户授权继续深查、修复、升级并在全部验收、整轮审查和额外 PR 审查后合并。前十一项已各自完成 SPEC→QUALITY；2c759319 的四个本地门槛 PASS，但其唯一实际模型样本 FAILED（29 请求，repair 180011ms timeout）。取消前观测为两 Agent idle、pendingIdleWaits=0、requiredNotices=1、deliveredNotices=0。报告没有子代理模式/工具参数，不能据此认定历史样本选择了前台模式。原 main、d389 和 2c759 的失败及原始证据全部保留。

两份独立静态审查确认一个此前未覆盖的真实契约错误：rc.2 的 mounted subagent/subagent_fork 允许 run_in_background:false，产生 one-shot；其真实工具结果在 result 和 dispose 完成后返回，不产生 continuable 的 parent settlement notice。验证器却对所有非 root Agent creation 都增加 notice 义务。alpha.2 的 mounted 工具没有该参数，始终 startActivation(delivery:parent)，不可声称同样支持前台分支。当前精确 web/taskforce surface 没有 workflow caller-delivery 创建工具；本设计不泛化到任意 SDK 组合。

比较保持通用 notice 假设、强制禁止所有前台派发、按权威 SDK 身份区分义务三种方案。前者错等不存在的通知；禁止前台不修通用验证器错误；选择第三种并保留真实前台回归。只修改 tools/verify-model.mjs、tools/model-fixtures.mjs、tools/tests/model-regression.test.mjs、tools/tests/host-boundaries.test.mjs。SDK、生产 preset/persona、工具/数据库/调度器、grader、预算、时间/容量、CLI、report 原九字段 settlement 白名单均保持。

分类只使用 live host 的公开 sessionProjections.snapshot(agent.session, ['subagent']).values.subagent 与 agent.session.isOwnSeq(identity.seq)，不使用 cachedSnapshot、私有 manager、模型参数文本、ancestor header 或已销毁 child scope。严格允许 one-shot/continuable；服务/投影/字段不存在、非法模式/seq、非本 session own seq、读取或调用抛错一律 unknown。one-shot own descriptor 在 pre-step 才写入，不能在 agent/created 缺失时永久缓存；每次真正判断重新读取当前权威状态。fork 的 inherited descriptor 不能作为本子代理身份。未知身份不得因一个现存 notice 或零聚合 missing 而通过；这类阻塞仍处于 waiting-notices，不混淆现有 unknownAgents（Agent status）。

所有 Agent 仍保留在 tracked、原生 whenIdle 原 Promise/原 Promise.all、整树状态和两个稳定 tick 检查中。只有当前自身身份明确 one-shot 的本阶段新 activation 豁免不适用的 continuable notice；continuable 和 unknown 的计数仍按每 parent-child/stage activation delta 计算。unknown 本阶段有新 activation 时额外阻止通过。无本阶段新 activation 的历史子代理不增加 notice 义务，但仍参与原整树 idle/stability。分类在候选稳定窗口末尾再核验，不能在变成 unknown/continuable 或新 activation 后沿用先前豁免。共用一处模式/义务计算给实际判据及 required/delivered/missing 诊断，重复 A notice 不覆盖 B、缺父、nested、cold reuse 基线全部保留。无 classifier 的既有 exported waiter 测试 seam 保持旧全 continuable 兼容；实际 native harness 必须接权威 classifier，服务缺失不能退回兼容假设。

前台成功仍必须经过原生工具的 result/dispose/persistence-close 和父后续 turn；禁止 idle、业务 accepted、subagent/end 或 agent/disposed 单独早退。未知模式或 Promise 错误不转为成功，原取消/清理/失败优先级与原 native Promise identity 保持。one-shot 不能 cold resume；新覆盖必须真实检查 task_child_send/SDK 拒绝，而非换一个 worker 或伪造 notice。

独立审查另确认四阶段 workload 隐藏了不可逆生命周期前提：repair 只要求一人，reuse/strict 才宣布同 childId 不得新建，而合法 one-shot 已不能继续。新 task12 明确修改 repair prompt：首次创建一名可续作 continuable 执行者；后续两个阶段必须经 task_child_send 复用同一 childId，不新建代理。若指导参数，只在派发工具提供 run_in_background 时要求 true，未提供不传。允许正常销毁后 cold reuse，不要求常驻。金额行为、后两阶段 prompt、独立 grader、任务/worker/reuse/owner/严格证据/no-waiver 检查全部原样。此为新 prompt/product 样本，不称原受控性能比较，也不倒改 task10 的 observability-only 承诺。违背前置要求仍应失败。

先保存原 production 字节证明并写真实行为 RED：rc.2 实际 mounted 前台 spawn 和 foreground fork 在 stage 基线之后创建，用本地 llm/stream sentinel，不调用 provider；实际 result/disposal/父完成且无 notice，原 waiter 持续 waiting-notices。至少一个 nested mixed 场景让 continuable 父 fork one-shot 叶，验证 inherited prefix/own seq、本父仍欠 notice、叶不欠；RED/GREEN 可共享真实 mounted 回归，不能只靠缺 export/import 或 fabricated events。持有真实 child stream、前台 dispose 或 JSONL close 的公开生命周期 barrier、父后续 stream，分别证明不能早 settle；最终释放后全树清理。测试观察 deadline 不改变产品 180000ms 门槛。

受控离线 RED/GREEN 验证 delayed descriptor、missing/unsupported/accessor/throw/non-own seq、unknown 即使已有 notice 仍不通过、稳定窗口模式/activation 变化、混合 nested 和正常 cold 两阶段；保持原 Promise 及 observer isolation。原 rc.2/alpha.2 continuable mounted/live/cold/真实 flush→notice→parentwake 测试继续 PASS；alpha 新覆盖使用真实工具 schema，不假装 false 分支。实际前台后续 continuation 拒绝保持 owner/new-agent 规则，记录原 child 不可恢复且未偷换。

所有 gate 原值保持：verifier child 60000ms、native cleanup 12000ms、paid cleanup 两次10000ms、cap80、maxTokens8192、stage180000ms、Node/DSH 双 pins。sole producer 顺序执行 focused、两 pins native 和一次 full npm test；保留全部中间失败、原始日志、完整已测 Git 文件 byte identity；显式四文件提交。fresh 独立 SPEC PASS 保存通知后才 QUALITY；root 再更新 docs/freeze，全新四本地门槛和一次有修复依据的实际模型验收；旧包不重跑。任何实际 gate FAIL 都阻塞 merge，随后仍需整轮审核、实际六 PR CI、额外 fresh PR 审核、expected-head merge 与 actual main 六 CI/树/version 读回。
