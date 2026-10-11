# Imperator 深度迭代与证据记录（2026-10-11）

本轮从真实 main `3b88ba73f65379ca77cde0ff2ad2978638ff199b`、tree `6327af19dc5725bc80536947c2ab4a9c3ea579c1`、0.4.1 开始。隔离 worktree `/workspace/imperator-next`，原始陈旧 checkout 未改。目标版本 0.4.2；实现、独立任务审核、整轮审核、额外合并前审核及实际 main 验证分别记录，不以任务通过替代最终交付。

## 调查范围与确认结果

| 范围 | 实测结果 | 本轮处理 |
| --- | --- | --- |
| 工作流终态 | 取消后的首次批准或迟到审核仍可推进工作流；精确旧键重放应保留 | 在重放后、版本和写入前统一拒绝所有新的普通终态变更 |
| 控制回执 | 效果与 accepted 结果已持久化，未使用的第二次目录查询仍可阻塞回包；明确 stop 拒绝的文案声称已接受 | 删除效果后的无用等待，以独立同步活动表观测；文案依据实际接受结果 |
| fork 观测归属 | 父事件被计为子会话失败、未结算派发及生命周期；两个固定 Session 版本均复现 | 使用持久 inheritedEventCount，仅活动观测取 own 后缀，完整可见上下文和 TODO 保留 |
| H01 身份准备 | 普通 fork 的 seed 血缘被误当委派；运行时深度被忽略 | 按实际 live 委派链和两种声明深度准备身份，adapter 仍关闭 |
| 工作流恢复读取 | 计划和 findings 已存库，但现有 state/board 无法取回内容 | 显式 include_context，完整内容、同一只读快照和总响应字节边界 |
| FIFO 恢复 | 累计额度耗尽会永久堵队首；原 FIFO 行为符合合同 | 可信宿主显式撤回未准入意图，不取消业务任务、不退款、不派发 |
| 原生执行诊断 | foreground 请求也可能 timeout promotion；严格回执正确拒绝，但丢失本次 job 定位 | 本次结果返回白名单诊断，原调用者权限不随任务重分配转移 |
| 每步上下文身份 | 原有解析器遗漏 runtime-only 当前/祖先委派，且拒绝非空 padded ID，隐藏正确 run 的任务/事实 | 追加轻量 resolver 修复，保留身份未知不读 legacy 与现有观察边界 |
| 原生验证资源 | SDK profile shutdown 保留四类进程监听器，native-only 与加载本插件结果相同 | 隔离验证器清理其确切启动回调；不改 SDK、不关闭警告 |
| 结算可观测性 | 旧超时先取消后观察，无法区分 pending idle、通知缺失与稳定性等待 | 增加固定 phase/计数和取消前独立快照，保留原结算条件 |
| 验收成功指引 | legacy 无 pointer 已 accepted，提示却建议当前任务继续补证，而终态拒绝新 fact/artifact | 明确本次验收已完成，建议后续任务在提交/验收前记录指针 |
| 派发结算与复用前提 | rc.2 合法前台 one-shot 不发送 continuable 通知却被验证器要求；首次任务未告知后续同人复用 | 按公开 current-cut own-session 身份计算义务，unknown 阻止通过；首次披露可续作要求，保留全树/通知/grader |
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
| settlement diagnostics | `8cebb8ef72a8609053229dcaf6cd5be1fbf32178` | 原 waiter/report 的 20 个行为失败；补充 inherited thenable/async observer 两个失败 | model 126/126、每 pin boundaries 47/47；full 1695/1675 pass/20 skip/0 fail | fresh spec PASS 07:39:04、quality PASS 07:41:15；全部 198 文件与 21 制品独立核验 |
| acceptance advice | `247a4514509d271082992a9066c2f0f1d526f38b` | real SQLite 17/15 pass/2 旧文字失败，终态拒绝及完整行快照先通过 | focused 109/109；full 1699/1679 pass/20 skip/0 fail；仅一个生产字符串改变 | fresh spec PASS 07:51:54、quality PASS 07:53:55；全部 198 文件与 20 制品独立核验 |
| delegation contract | `e03a2685718b4b5951fb166cbb3ff1ccc6859a12` | unchanged waiter 三条 mounted 原生行为失败，37 个受控旧语义失败 | focused163；rc.2 boundaries50/50，alpha47pass/3不支持前台skip；full1736/1716pass/20offline skip/0fail | fresh SPEC PASS08:44:35→QUALITY PASS08:48:21；200文件/33制品/35SDK字节独立核验 |

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

## 首次冻结包的实际验收与后续遗漏

候选 `d389984425fd092137bd62f769f90b5143bddf9f` / tree `0f06c6a1bde226c3b63932f53e4972be8727a0d4`：完整 Git source 194 文件；npm 包 186 文件、834360 bytes，SHA256 `96f98ef00aef2110475fa43279e62cef98affb3908c6f9f8830151a841405fc2`；产品 fingerprint `d0346a7e8c5ce456f6f4b278d3efc8f6710fb5afbb3af1c92cf749e7499f3082`。独立审查逐字节核对 Git、source tar、npm 声明清单、tgz、解包和原始日志/报告摘要。包权限为 185 个 0600 与唯一 executable 0700，Git 为 0644/0755，执行位一致；之后 CI 归档差异须分别解释文档内容和权限元数据，不能统称文档变化。

本地四道检查实际完成：source offline 1670 tests /1650 pass/20 host skip/0 fail，17.585s；隔离 Git source 单 CPU 同计数，35.177s；同一精确解包在 Node24.19 / rc.2 和 alpha.2 分别 fullchain 59.845s 与 61.026s，packed offline 各 1670/1644/26/0，随后 native 99/99/0skip、HOST17、ISOLATION13。fullchain 总时长不是单 child 超过60000ms。两 native 各保留一条 stripTypeScriptTypes ExperimentalWarning，0 MaxListenersExceededWarning。额外六项 packed repository-only skip 不作为 native coverage。原 TMPDIR 各有 SDK 空 spill root、native loader 和 Node compile cache；实际 taskforce home/workspace 已移除，不能称全部临时目录为空。

同一包唯一真实模型样本 **FAILED**，CLI exit1，186.890s / report186838ms；cap80、输出容量8192、阶段180000ms、rc.2/deepseek-official/deepseek-flash 保持。readonly 3请求5246ms通过；repair 21请求180010ms timeout，虽有1 accepted任务/4依据且closure.ok，独立grader尚未执行（checks0），reuse/strict未执行。总24请求；usage input34810、output19572、cacheRead417280、cacheWrite0；记录的runtime/usage/route错误计数均0，不证明运行树已结束。原始CLI/report/命令与失败退出保留，独立验收checker实际exit1。不能把此样本记为真实模型通过或推定生产崩溃。

只读 SDK 契约审计未找到确定的死锁：真实 notice envelope 匹配现有读取，SDK status=idle还包括maintenance，不能替代whenIdle。取消前无法区分 pending idle、缺结算notice和稳定性变动，timeout先cancel后snapshot使原等待条件无法还原；这是确定的诊断遗漏，尚非timeout因果归属。追加 [结算诊断设计](../specs/2026-10-11-model-settlement-diagnostics-design.md) / [计划](../plans/2026-10-11-model-settlement-diagnostics.md)：仅有界phase/计数和取消前不可变观察，不保存原始转录、不放宽门槛。

整轮 source 审查另确认原main已存在成功回包误导：legacy依据无pointer可合法accepted，warning却建议继续补证，而普通fact/artifact将被终态闸拒绝E_TERMINAL。追加 [验收指引设计](../specs/2026-10-11-acceptance-advice-design.md) / [计划](../plans/2026-10-11-acceptance-advice.md)：仅将建议指向后续任务在提交/验收前补齐指针，保留原policy和terminalguard。实际paid报告未保存warning/with_pointer，不能证明这分支触发或导致timeout。

两项追加任务已实现并分别通过 fresh SPEC→QUALITY 审核，详见下段。产品工具/库字节已改变，首次冻结包验收仅属旧候选；新包必须重新完成 source、oneCPU、两pins native及有明确诊断目的的真实模型样本，再整轮审核、实际最终PR CI和额外复审。以下状态截至 2026-10-11 07:54 UTC，PR69仍草稿、未合并。


## 两项追加实现与新候选冻结准备

结算诊断提交 `8cebb8ef72a8609053229dcaf6cd5be1fbf32178` / tree `3a534dc666e8102b94b928af665b8ce5d1c283d6`，仅 verifier 与两项已有测试文件。每阶段 `progress` 保留最近获准请求的阶段内毫秒数、固定 phase 和八项计数（不可用为 null）；`timeoutProgress` 在取消前复制，不被随后清理与最终用量重写。SDK status=idle 与 pending whenIdle 分开观察，通知按父子对限制再汇总，cold activation 使用真实阶段基线。原 whenIdle Promise、Promise.all、通知要求、两次稳定性检查、grader 和有限额度未改。

真实两 pins 追加路径均由阶段基线之后的原生 root loop 调 mounted subagent / live continuation / cold continuation；每阶段 required=1 的实际 child flush 被持有至 release，真实 parent notice +1 后再持有父流，不能用 notice 或 accepted 提前完成。正常 fixture 每 pin 10 个本地流、0 paid；另一个真实 AbortSignal 流在取消前观察 waiting-idle/running1/pending1，实际 abort/drain 和 Agent/home 清理均检查。中间原生 fixture timeout、卸载后 ctx service 断言失败保留，不能归为生产挂死。最终 model126、每 pin boundaries47 与 full1695/1675/20/0 的实际字节一致。任务独立审核摘要 `eeefb934bf330a9a7102cda1857645e49fb295ceca4b234372a0de6dbbde6667`，SPEC 07:39:04 先于 QUALITY 07:41:15。

验收指引提交 `247a4514509d271082992a9066c2f0f1d526f38b` / tree `387519cc84f8780b08157de1f1378b2d4a0fee50`，只改一个生产 warning 字符串并增加 real SQLite 68 行测试。真实绑定 owner 的 pathless PLAUSIBLE fact 与 artifact 均完成 submit/root accept，当前任务补写两种 evidence 仍 E_TERMINAL，完整 task/fact 行及 generation 不变；pointer、waiver 与既有 strict 控制保留。RED 17/15 pass/2 行为失败发生在生产修改前，GREEN109/109，唯一记录的 full1699/1679 pass/20 host skip/0 fail；六项 scripts382 assertions通过、1 native compiler skip，offline host仍 UNVERIFIED。独立审核摘要 `67903bad8689f5f697721e29c0fcb32224de4070f1889275005d276c56651bc4`，SPEC07:51:54先于QUALITY07:53:55。

全部198 tracked源文件逐字节核对测试、提交与工作树。该提交的产品 fingerprint 为 `266c26208f972b296db1e921d8cb15cb1ce42836a8b4031727ea65b934456553`（111 runtime/verification paths）；`679bf624fec8c1e6fdfc7cfed91bca549c54e46c86a04a5eb0e5dd281f5e72d5` 是不同算法的198文件tested-tree摘要，不能混用。root随后仅更新文档，产品字节须保持同一指纹；最终包及所有后续实际验收另行绑定其完整提交/tree/archive，不以此处任务通过代替。

重新专项审查用户此前提及的 mutable pagination 漏读及事实计数口径：历史修复 `82e3f9ad07706f9812e926f4f8cb5b9b5889d59a`（PR54）已是原 main 的祖先。固定2d8 source的相关store/paging/count代码与main完全相同，未确认新的同类缺陷；本轮task11之后整份store仅上述字符串不同。NULL域、成员变动、晚到/高 resolver、软字节裁剪及分母语义均核对，不把已合入的修复再次计作本轮新修复。独立复查报告摘要 `4bc13f9d4c659e65de0f4439abd4d2d5cac6dd6ff19c582d0d9c7a17abf3e7d4`。

截至该候选冻结准备时，十一项任务通过；原main cap80及首个0.4.2包repair timeout仍FAILED，warning触发与timeout因果未知。后续新不可变包及新增任务状态见下段，不以这里的历史准备状态代替最终交付。

## 第二冻结包结果与派发契约遗漏

候选 `2c7593197467bba611044dbfc7f368e04529f375` / tree `d6df5a9a08412d15596a525af71e06541cd28d74`，source198/npm190，包852229 bytes，SHA256 `2830771837f54ebf40a6c27b54204bb748bb886eab5f3014c4cad019b7f08bec`，产品 fingerprint 仍 `266c26208f972b296db1e921d8cb15cb1ce42836a8b4031727ea65b934456553`。实际 source1699/1679pass/20skip/0fail、17.590s；单 CPU 同计数、wall37.095s/child36.432116s；rc.2/alpha.2 同一解包 fullchain62.238/62.241s，packed offline1699/1673/26/0，实际 native101/101/0skip、HOST17/ISOLATION13。每个 child 保持60000ms上限；总 fullchain 不能等同单 child。全量文件/字节、原日志及包元数据已独立核验；0 MaxListeners，各一条已知 stripTypeScriptTypes ExperimentalWarning。190文件 post-native 未改变；SDK空 spill/loader/compile cache保留，taskforce临时home/workspace移除。

该包唯一实际模型样本仍 **FAILED**：CLI exit1、wall185.743581s/report185695ms，29请求；readonly2/4151ms通过，repair27/180011ms timeout，任务accepted/owner匹配/evidence2/no-waiver/closure.ok但checks0，后两阶段未执行。usage input37844/output14580/cacheRead489856/cacheWrite0；记录的runtime/usage/route错误均0。report SHA256 `fd80fabf549e8df656f1f7fff60045880b75bea683785d39ea60bf5480d5acb2`，原命令、日志、退出码、checker实际FAIL1均保留，cap80/8192/stage180000ms未改。

新不可变 timeoutProgress 为 waiting-notices、tracked2/idle2/running0/unknown0/pendingIdleWaits0、required1/delivered0/missing1，最近获准请求在本阶段83472ms；这只确定取消前等待条件。两份独立源码审查确认此前覆盖遗漏：rc.2 mounted subagent/subagent_fork 允许显式 run_in_background:false，真实 one-shot 完成 result/dispose 后返回前台结果，根本不产生 continuable settlement notice；验证器却对所有 child activation 要求该通知。alpha.2 mounted schema 没有该参数，始终 parent-delivery continuable，不能泛化前台分支。实际付费报告没有模式/工具参数，不能将该源码 bug 直接归为此次或历史生产停止根因。

另一个任务契约遗漏：repair 未预告下一阶段必须复用同一 childId，合法 one-shot 已无法 cold resume，后续却不允许换执行者。新增 [派发结算设计](../specs/2026-10-11-delegation-settlement-contract-design.md) / [计划](../plans/2026-10-11-delegation-settlement-contract.md)：先真实原生 RED，再按公开 current-cut own-session mode 区分通知义务，unknown fail closed，保留全树 idle/dispose/稳定检查；repair 首次披露 continuable 与后两阶段同人要求，参数指导只在工具实际提供时使用。此为新 prompt/product 样本，原 grader、金额要求、后两阶段、安全/额度不变，不称原受控性能比较。截至08:20尚待设计审核、实现、fresh任务SPEC→QUALITY及新完整验收，PR69仍草稿未合并。

## 第十二项实现与最终新包冻结准备

设计先经独立 SPEC PASS（报告摘要 `342ed442ff5abf4a0f9da203ee3f39d951a1877f3979e15e4114af209d545112`），root仅文档提交 `633e0ae8336b9d9b30d22884cf8fc71e4f9e4533` 后由唯一执行者实现。四文件提交 `e03a2685718b4b5951fb166cbb3ff1ccc6859a12` / tree `0959f5253a8e451465f8bc25b3bfa5906465cccc`，+405/-30；产品 fingerprint `f77766a88e52dace40b59f47ae99f40854a25f5cfccf1df0d859b117f50a334e`（111产品路径）。全部200 tracked文件实测/提交/工作树字节及执行位一致，33证据制品与35SDK源摘要独立核对，SDK未改。

三条真实 rc.2 原生 RED 在 verifier/fixture 原字节上复现：前台 spawn/fork 的子代理已完成实际 scope dispose、unregister、前台结果和父 turn，旧判据仍required1/delivered0；continuable父→前台fork叶在真实父notice后仍required2/delivered1。第一轮测试原型的 toolCallId / seed flush 错误保留但不当行为RED。另有37受控旧语义反例；新classifier缺export时使用旧all-continuable语义fallback，原生行为RED不依赖缺import失败。

实现只用 live host 公开同步 sessionProjections.snapshot 与 Session.isOwnSeq，严格读取own data mode/安全seq，缺失/访问器/继承/非法/throw皆unknown并阻止当前新增activation结算，即使有notice也不能通过。mode在creation后及最终稳定窗口动态重读；判据和原九字段诊断共用配对义务。原whenIdle Promise/Promise.all、全树idle、两次tick保留，窗口末另查Agent对象/activation次数及当前义务。仅明确own one-shot豁免SDK不发送的通知，continuable/cold通知原规则仍必须满足。

实际前台测试独立持有child流、公开ctx.effect的异步真实scope dispose、父后续流，释放前绝不结算；混合树另持有continuable父final flush和收到真实notice后的root流。直接spawn/fork随后实际task_child_send同one-shot id返回E_CHILD_SETTLED，未换worker。GREEN model163/163，rc.2完整boundaries50/50/0skip；alpha完整50total/47pass/3明确不支持的rc.2前台skip，实际compiled schema不含background字段，真实continuable/live/cold、两notice、同session不同Agent、flush/parentwake与cancel/cleanup全部通过。0paid；实际本地模型流存在，不能称0model streams。

唯一full npm为1736total/1716pass/20offline宿主skip/0fail，wall16.844919s/node16.178694s，六scripts通过且offline仍UNVERIFIED。未用alpha不存在的分支替代支持功能检查。生产preset、工具/store/scheduler、version/pins、grader、readonly/reuse/strict/shared boundary字节与有限额度保持；只repair upfront说明continuable＋后两阶段同childId/task_child_send/no new Agent，参数指导依实际schema。新prompt/product样本与旧模型失败非受控性能比较。

fresh实现审核先保存SPEC PASS08:44:35（原snapshot摘要 `8dcfc0a9fbe2ff1a0dfb876f5f2a2dabede28187eb143531a346511735b9e55e`），再QUALITY08:45:02开始、08:48:21 PASS；最终报告摘要 `f342dffa51481d672be351a91d00b47fbf300f2c158e12227181ea4bed665148`。独立整轮source预审核对原main至e03的65路径union，无新增actionable问题；此预审不是whole最终PASS。十二项任务审核现全部通过；root文档整合不改111产品字节。新包实际四道本地验收及真实模型结果见下段；随后仍须whole SPEC→QUALITY、实际PR六CI、额外fresh PR审查、match-head merge和actual main六CI/树/version。旧失败与未知历史因果保留，当前未合并。

## 第三冻结包实测：本地通过，模型仍未完成

固定候选 `8237df5eab26074ee86e7bdcc310ed0fe25b6a5a` / tree `1119d8a65025a5a410a57a4710a6b0ad46a8ed1b`，仅文档与上述 e03 不同，111 产品文件及执行位逐一相同，fingerprint `f77766a88e52dace40b59f47ae99f40854a25f5cfccf1df0d859b117f50a334e`。source200/npm192，包866083 bytes，SHA256 `81b61703e761693a1e2422e16aac82ebba1219faf34c32c58673b7ba3480037d`；source archive SHA256 `f9b779031274a18ccd4e4f55c962ae56f29c61747e8701b7bd37f396dec9d3f5`。完整 Git/source/npm 清单与逐字节、解包前后、npm 声明 SHA1/SHA512 均核对；npm 权限191×0600与唯一CLI0700，源归档197×0664与3×0775，字节和执行位等同不表示全权限相同。

四条串行原命令均 exit0：source offline1736/1716pass/20hostskip，wall17.104836s/node16.474274s；隔离 Git source 单 CPU 同计数，wall36.967794s/node36.325339s。同一解包两 pins fullchain61.302296/61.924288s，packed offline均1736/1710pass/26skip；其真实 native rc.2 为104/104pass/0skip、node33.813356s，alpha为104/101pass/3skip、node34.192708s。alpha只跳过实际 mounted schema 不支持的三条前台委派分支；其他 native、HOST17、ISOLATION13 和全部原 phases 成功。每个 child 的60000ms上限未改，不把总链时长当 child。各一条已知 ExperimentalWarning、0 MaxListeners/强退。递归复核所有 taskforce-*（含新foreground前缀）均清理，空SDK spill/loader/compile cache仍存在。两份独立完整local审核无新增问题，报告摘要分别 `6d5df0817f4de26e495b7ab4dce97decd15883fa167ff3dc9d08da6e4af3253f` 与随后独立CI证据审计记录。

该包唯一实际模型样本仍 **FAILED**，08:58:59开始、CLI exit1、wall186.289450s/report186230ms，总49请求；readonly2/4607ms通过，repair47/180021ms timeout。取消前不可变快照为waiting-idle、tracked2/idle1/running1/unknown0/pendingIdleWaits1、required2/delivered1/missing1，最近获准请求179170ms；不能将取消后的idle2/waiting-notices当成取消前阻塞原因。repair任务claimed、owner匹配、evidence3、accepted0，closure失败码task-status，独立checks0；reuse/strict未执行。这次样本没有证明前台通知误等，也没有原始动作/转录可解释47次请求的具体过程。

usage input49479/output38973/cacheRead1346816/cacheWrite0；最终runtime计数missing-message1与stream-error1，其他计数0。它们在取消、排空后收集，尚不能认定是最初停止原因。report SHA256 `b5a402dfb0da2f4fc83d93d4efe35394e185d48bafcce4731fc570b52be17363`，CLI log SHA256 `f3d8262bcf5491e1e037656472c0c19f56e8e309cd112d2736d225ae1f3aa008`。原始命令/退出/报告、原60断言checker实际exit1均保留，rc.2/flash/cap80/8192/stage180000与所有清理限时不变。实际taskforce home/workspace已删除，SDK空spill与loader保留。当前真实模型门槛未通过，PR69仍草稿未合并；继续只读排查可复现工程缺陷或有界诊断遗漏，不盲重跑或放宽门槛。
