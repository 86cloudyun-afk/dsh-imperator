# Imperator 深度迭代与证据记录（2026-10-11）

本轮从真实 main `3b88ba73f65379ca77cde0ff2ad2978638ff199b`、tree `6327af19dc5725bc80536947c2ab4a9c3ea579c1`、0.4.1 开始。隔离 worktree `/workspace/imperator-next`，原始陈旧 checkout 未改。目标版本 0.4.2；实现、独立任务审核、整轮审核、额外合并前审核及实际 main 验证分别记录，不以任务通过替代最终交付。

## 调查范围与确认结果

| 范围 | 实测结果 | 本轮处理 |
| --- | --- | --- |
| 工作流终态 | 取消等终态仍可被新批准、产物或审核操作推进；精确旧键重放应保留 | 在重放后、版本和写入前拒绝新终态操作 |
| 控制回执 | 效果与 accepted 结果已持久化，未使用的第二次目录查询仍可阻塞回包；明确 stop 拒绝的文案声称已接受 | 删除效果后的无用等待，以独立同步活动表观测；文案依据实际接受结果 |
| fork 观测归属 | 父事件被计为子会话失败、未结算派发及生命周期；两个固定 Session 版本均复现 | 使用持久 inheritedEventCount，仅活动观测取 own 后缀，完整可见上下文和 TODO 保留 |
| H01 身份准备 | 普通 fork 的 seed 血缘被误当委派；运行时深度被忽略 | 按实际 live 委派链和两种声明深度准备身份，adapter 仍关闭 |
| 工作流恢复读取 | 计划和 findings 已存库，但现有 state/board 无法取回内容 | 显式 include_context，完整内容、同一只读快照和总响应字节边界 |
| FIFO 恢复 | 累计额度耗尽会永久堵队首；原 FIFO 行为符合合同 | 可信宿主显式撤回未准入意图，不取消业务任务、不退款、不派发 |
| 原生执行诊断 | foreground 请求也可能 timeout promotion；严格回执正确拒绝，但丢失本次 job 定位 | 本次结果返回白名单诊断，原调用者权限不随任务重分配转移 |
| 每步上下文身份 | 原有解析器遗漏 runtime-only 当前/祖先委派，且拒绝非空 padded ID，隐藏正确 run 的任务/事实 | 追加轻量 resolver 修复，保留身份未知不读 legacy 与现有观察边界 |
| 原生验证资源 | SDK profile shutdown 保留四类进程监听器，native-only 与加载本插件结果相同 | 隔离验证器清理其确切启动回调；不改 SDK、不关闭警告 |
| store / governor | 定向事务、读写及故障对照未确认其他新缺陷 | 保留正反控制，不宣称全面无缺陷 |

fork 的复现使用真实固定 SDK Session、纯 fork 历史准备、实际插件 hook 和 SQLite，加显式 preset scope fixture，没有运行完整 agent loop。错误 ECHO 是指导消息，不能解释为已复现实际中止；旧错误归属 audit 行保留，不猜测迁移。native-only 四组监听器对照各 12 次启动、共 192 个注册堆栈均来自 SDK；Session/Agent/插件构造未增加其他监听器。这也不证明历史长任务停止的原因。

## 基线实测

Node 24.19.0，四 CPU 配额。离线 `npm test`：1326 项，1315 pass、11 skip、0 fail，14.281s。实际原包 166 文件，SHA256 `e73312744ceb8d148af4f933f2dc7dbd0f64031d1e0ed8443044aa80a09d80f9`，产品 fingerprint `f6e34e05346667d493e1a11839cb3e23bb01e55aba1d85e87accb438a2129822`。standalone `--trace-warnings` 原生 host 验证 HOST 17，通过且未出现 listener warning。

原包真实四阶段模型样本失败，固定 cap 80、输出容量 8192、每阶段 180000ms 均未放宽：readonly/repair/reuse 通过，strict 在任务已 verified/submitted 但主控未 accepted 时耗尽请求。四阶段请求 3/32/31/14，总 223579ms；usage input 70049、output 40006、cacheRead 2406016、cacheWrite 0。前三阶段 runtime/usage/route 诊断为零；cap 后受控取消的诊断保留。该结果是有界验收未完成，不能称为生产崩溃，也不能作为真实模型通过证据。

模型报告仅保留白名单计数、固定失败码和产品来源，没有保存凭据、reasoning、原始对话或任意工具内容。历史 0.3/0.4 的报告仍按其候选来源解读。

## 逐任务来源与审核

| 任务 | 实现 commit | RED | GREEN | 独立审核 |
| --- | --- | --- | --- | --- |
| 终态 | `336baaf8c6c02ee299f3a114b9620a013a34cec7` | 9 个预期失败 | focused 109；full 1337/1326 pass/11 skip/0 fail | spec PASS、quality PASS |
| 控制回执 | `3819880c9edb3e2b65755969f6d6777174335386` | 5 个预期失败 | focused 13、recovery 394、verifier 73；full 1350/1339/11/0 | spec PASS、quality PASS |
| fork 观测 | `f4f536d7d9e93aecc064ce65715f207100980424` | unit 8、每 pin native 3 | unit 28、每 pin native 4；full 1360/1349/11/0 | spec PASS、quality PASS；额外 Proxy/accessor/mutable probe 通过 |
| H01 | `444f956a983efdd6c5ccd5ab67702d8d00515dc3` | pure 38、每 pin native 7（六子例及父项） | pure 127、每 pin native 13；full 1452/1441/11/0 | spec PASS、quality PASS；durable -0 更保守拒绝成本已记录 |
| context | `272a1fe0fbe32bdc8a8253aaa0149469a21bba78` | 18 个预期失败；补充包络开销 mutant 被抓住 | focused 135；full 1470/1459/11/0；精确 65536 bytes 与 1-byte overflow | spec PASS、quality PASS；源码和全部日志独立核验 |
| withdraw | `5c4482bbb80552f9f14d810dba6abce5b5f0481a` | 22 个 missing API 失败 | focused 285；full 1492/1481/11/0；真实双进程、恢复和回滚 | spec PASS、quality PASS；保留中间 3 个测试原型误差 |
| context identity | `2a2800c3233822829fbe7a36178bfa48a30fbeaf` | unit 69、每 pin native 8（七子例及父项） | unit 135、每 pin native 27；full 1608/1597/11/0，22.394s | spec PASS、quality PASS；全部来源与七个原始日志独立核验 |
| promotion | `78e1581fdf5a7528378ec34331c09c53a9d85f71` | unit 38、每 pin native 1；保留早期 harness 修正样本 | unit 92、每 pin native 6；full 1656/1645/11/0，17.445s | spec PASS、quality PASS；193 个源码文件及日志独立核验 |
| fixture cleanup | `8e1f8e7…` + `1ba2ebb6d2dd597812fc58eb762d20f1227df374` | 两 pins 各 12 次真实启动回调残留；失败启动、竞争、强制退出、close/错误保留及 boot continuation 均复现；追加三类 scheduler setup RED | 每 pin runtime 15、boundaries 45、scheduler 31、HOST 17、ISOLATION 13；followup full 1670/1650 pass/20 skip/0 fail，17.741s | 原 quality FAIL 保留；修正提交 fresh spec PASS、quality PASS |

控制回执独立审核另以真实 SQL commit 后立即同步 abort 的六个场景核对 accepted 结果、原键重放和 effects=1；没有把已提交测试的迟到取消等同于暂停修复后的同步 handler。fork native GREEN 保留真实 child seq `[3,4]`、cut 2、restore firstLiveSeq 5，40,000 个继承槽未被扫描为活动；scope/ACK/unknown/reset/可变历史和完整可见状态均有对照。

只读设计审核在实现前补足：推广 job 的 owner 指本次原生调用者；无效字段采用 null，其他 union 内容省略；worker 不得撤回 captured owner 为 null 的意图；竞态必须使用分进程连接；fixture 独占 token 覆盖环境生命周期；新清理诊断不能吞掉原始错误或跳过 exit hook/exitCode 恢复。

## CI 与交付门槛

PR [69](https://github.com/86cloudyun-afk/dsh-imperator/pull/69) 当前为迭代草稿。早期来源 `336baaf…` 的 PR run `38111904008` 六个完整日志和六个制品已独立核对：实际 checkout `9f4b95c8c1203933ba8b2d9bae5b8e5158996f2e` 的父提交为原 main 与该 source，tree 完全相同。所有 source 和 packed 文件逐字节匹配；四包 SHA256 `8d9bea64a8652b7ae054d470a440e330b94759e8b85d7a259aab6d76bf83a85f`。

两 offline jobs 为 1337/1326/11；四 native jobs 的 packed offline 为 1337/1320/17，随后 native boundaries 53/53/0、HOST 17、ISOLATION 13。packed 额外六个 repo-only skip 有明确原因，实际 native 阶段无 skip。原生流边界测试使用本地 llm/stream fixture，可产生本地 request events，但没有付费 provider calls；这不是真实模型验收。

上述 CI 只证明早期 tree。四个 native jobs 各出现四个真实 listener warnings，已追溯并保留。最终仍须完整功能集的不可变包、实际模型样本、最终六作业源码/归档核验、整轮与额外合并前审核、expected-head merge 及实际 main 读回；本记录不预宣告其完成。

固定 names/DB、Node/DSH pins、无新增依赖/schema、60000ms 验收与 12000ms cleanup、原额度和关闭的 native full-tree adapter 保持。生产部署、生产失败 run/child 日志、历史警告/旧 VM timeout 根因及普遍长期稳定性不在本轮有界证据之内。

补充只读验收审计未发现确定的请求计数或严格验收缺陷，166 个基线归档文件与原 main 逐字节匹配；保留失败样本与缺少原始模型转录的判断限制。最终模型包摘要须独立计算，产品指纹不含文档，Git 归档摘要也可能因提交元数据不同而变化；实际 tree、完整文件清单和字节核验分别记录。

前五项交叉检查另确认上述 P2 每步上下文身份遗漏，原 main 已存在，不能归为 H01/fork 新回归。基于真实原生 runtime-only Agent 形状和 source trace，后续先做独立规格设计核验，再 RED/GREEN/原生两 pins 与独立任务审核。

每步身份修复的两 pins 原生检查沿用真实注册 Agent/options/registry，加受控 hook、scope、next 与独立 SQLite fixture；不是完整 native loop。每轮 16 handles 全部 dispose、live Agents 0、provider requests 0、profile 已移除；原 H01 断言保留。观察解析保留 32 次父查找、缺失父的 depth-one 兼容，不把 H01 更严格的 live-parent/64-node 政策挪入读投影。RED 和 GREEN 测试逐字节一致。

验证工具调用方预检确认：paid harness 缺少 forced native exit 的临时 home 同步清理 hook；scheduler 测试先 close SQLite，异常时跳过实际 app shutdown。已纳入同一八文件 fixture 设计。两段 paid deadline 原始 Promise 分别跟踪，不用后段完成冒充前段已结算。此为隔离工具资源与错误路径问题，不是历史生产崩溃归因。

fixture 首轮 GREEN 暴露新增 async boot 包装层的真实顺序回归：旧路径的原生 fiber dispose 可结算，新路径触发 SDK 5 秒强退。先补 continuation RED，再保留原始 boot Promise 及其结算观察顺序；早期失败与短暂重叠尝试保留，不作为最终通过证据。调用方 exit 检查依据实际 SDK 清理后的无关回调，避免误要求保留 SDK 自行撤销的回调。冻结串行验收及独立审核待记录。

fixture 最终串行记录绑定 `8e1f8e7…` / tree `f97d2fdf4ce902a307a4362ebe55873c2b1c3f46`，193 个 tracked 源文件与实际测试字节相同。两 pins 各 12 次启动按 raw 引用和重复数恢复基线，0 request/stream、0 MaxListeners warning；17 项离线 skip 均为宿主条件，实际定向 native 阶段无 skip。producer 的完整 RED、故障与中间失败保留；其 Node 24 结果不代替最终 Node 22/24 CI 或真实模型验收。

独立整轮 source 交叉审查与第九项 quality 审核共同确认新 C2 的 boot/store.open 位于清理 try 之前，setup reject 会跳过 app / fixture 清理；main 还保留原有 fixture 创建前的 timer 无失败清理路径。原 spec PASS 与后续 quality FAIL 均保留。仅 scheduler 测试路径追加 focused RED/GREEN 修复，不把原提交当最终可合并版本。

第九项追加修正 `1ba2ebb6d2dd597812fc58eb762d20f1227df374` / tree `7f6c7132400303409ec4cdf7bf37cf8beaf5f163`，仅 scheduler-native 测试变更。三条真实 setup 故障先 RED，再两 pins 各 31/31；必要 followup full 1670 项、1650 pass、20 host skip、0 fail，17.741s。193 个提交文件与新 scheduler / npm 字节相同，另 192 个文件与原 native 测试来源相同。首轮 GREEN 的 SDK wrapper/cause 身份断言失败及诊断保留；新断言同时核对原生 wrapper、其精确 cause 与次级 fixture 错误。修正提交 fresh spec PASS（06:53:10 UTC）、quality PASS（06:54:41 UTC），无未解决 actionable finding；全轮与额外合并前审核仍待最终候选。

## 0.4.2 集成候选

九项任务已分别通过独立 spec 与 quality 审核；第九项原 quality FAIL 保留，修正后由新角色重审。版本更新为 0.4.2，README 与交付指南采用当前版本，同时保留历史迁移、模型样本和失败范围。本轮没有新增 DDL / runtime 依赖；队列撤回仍要求同库调度写入者协调使用同版本。最终候选身份、不可变包、单 CPU、两 pins 全量 native 和真实模型结果将在实际执行后追加。PR 尚为草稿、未合并。
