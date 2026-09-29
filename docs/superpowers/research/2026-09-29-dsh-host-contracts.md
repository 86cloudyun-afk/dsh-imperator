# DSH 0.1.7-rc.2：并发调度与自动化宿主契约研究

日期：2026-09-29。性质：**发布包源码研究，非真实宿主运行验收**。
对应 TaskForce 基线：`a75a89902de1c569330e12d55456dfb38d2f752b`。

## 1. 可复核来源

研究使用官方 `@deepseek-ai` scope 的 13 个 npm `0.1.7-rc.2` 包，逐个校验 registry `dist.integrity` 的 SHA512，再解包检查 JS 与类型声明，没有安装到用户项目。
精确包名、下载地址、完整性值及所读文件 SHA256 见 [包证据清单](2026-09-29-dsh-package-evidence.json)。清单不依赖临时路径。

官方源码仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
研究时取到的 master 提交为 `639ed015397290b3745d163aafe02ffee4aa3f84`，已属于 0.2 发布线；仅供定位，**不作为 rc.2 接口证明**。
复核应下载清单中的版本化 tarball，校验完整性和文件 hash，然后按下表查阅；不使用可漂移的 latest 标签。

## 2. 影响架构的发现

下列路径均相对该包 tarball 解出的 `package/`。

| 契约 | 目标包与证据位置 | 对设计的影响 |
|---|---|---|
| `subagent/start/end` 是观察事件 | `dsh-subagent`，`lib/types/index.d.ts`、`lib/types/lifecycle.js` | start 在公开运行后发出，监听失败被隔离；不能用它阻止派发。 |
| continuable 支持预留 childId | `dsh-subagent`，`lib/types/types.d.ts`、`lib/types/continuation.js` | 可提前关联身份，但不构成跨 SQLite/宿主的原子启动。 |
| continuable prepare 仅提供 seed | 同上；`lib/types/child-agent.js` | 不能通过该 hook 覆盖 cwd/setup；默认 cwd 继承父会话。 |
| stock one-shot driver 自建 UUID、固定继承 cwd | `dsh-subagent-in-process-driver`，`lib/index.js:157-254`、`lib/types/index.d.ts` | 不能假设 start options 接受 childId/cwd；包装 stock driver 不足以提供隔离工作区。 |
| 创建接口支持预留身份、cwd、未发布 setup | `dsh-agent`，`lib/types/index.d.ts:48-144` | 可消费现有 AgentFactory，通过可信 host driver 创建一次受管执行。 |
| delegation helper 公开导出 | `dsh-subagent`，`lib/types/child-agent.js` 及 `.d.ts` | 复用 depth、agent options、composition、sandbox/approval 继承，不自行放宽权限。 |
| tools.guard 是最终同步拒绝约束 | `dsh-tools`，`lib/types/index.d.ts` 的 ToolGuard/guard | 受管范围需阻断所有旁路派发/消息；只改 persona/tool 名单不足。 |
| `whenIdle()` 不对应特定消息 | `dsh-agent`，`lib/types/runtime-types.d.ts:157-164` | 每 attempt 全新会话、单次输入，记录消息/turn；不能把任意最后一句回复视为该任务结果。 |
| turn/end 不等待持久化 | `dsh-session`，`lib/types/types.d.ts:264-272`；`lib/types/index.d.ts:427-439` | 必须要求 flush 有监听器参与且成功；continuable best-effort flush 不能充当严格证明。 |
| 原生 handle 提供回收能力 | `dsh-agent-loop`，`lib/index.js:1640-1754` | await cancel/idle/scope dispose/持久句柄关闭等；保留 AggregateError，不以 registry 消失替代清理成功。 |
| 真实父链不等于结构化所有权 | 同上；`dsh-agent`，`lib/types/index.js:238-266,355-362` | parentAgent 用于实际关系；create 的 ownerCtx effect 持有回收。TaskForce 必须明确保管子树 handles。 |
| setup 后、publish 前写 session suffix | `dsh-agent-loop`，`lib/index.js:1804-1828,1858-1898` | setup 可写 typed correlation/policy；commit 之后仍有异步 append，所以派发初始输入前还需 fence 检查。 |
| 原生 continuable 后代有专门 drain | `dsh-subagent`，`lib/types/index.d.ts:189-198`；`lib/types/continuation-activation.js:224-266,604-666` | 需 exact live Agent，关闭准入、等待物化、子到父回收。仅销毁父 handle 不证明这类后代停止。 |
| 冷会话查询会补内存闭合事件 | `dsh-session-query`，`lib/index.js:34-54,1079-1087` | readSession 不运行代理，但不能把合成 interrupted 事件视为磁盘原始终态。 |
| 可只读取得原始日志 | `dsh-session-query` 的 readColdSessionLog；`dsh-session-persistence-jsonl`，`lib/index.js:2454-2485` | open(read) → read → close；不为对账调用 agents.resume/open(write)。 |
| JSONL 有无超时的内核写锁 | `dsh-session-persistence-jsonl`，`lib/index.js:614-731,2486-2504`；`lib/types/lease.d.ts` | 只保护同一个日志文件；不能替代调度进程锁，也不证明旧 shell 后代停止。 |
| shell/jobs 是能力接口，不是通用停止证明 | `dsh-shell`、`dsh-jobs`，`lib/types/index.d.ts` 和相关 types | cwd 不等于沙箱；作业 cancel 抛错可能只让登记失败。具体执行器需真实集成验证。 |

## 3. 推荐集成方式

TaskForce 拥有持久队列、调度准入和 attempt；通过薄 host adapter 调用现有 `ctx.agents.create()`，保留原生 agent loop、工具执行和持久化实现。
输入为可信预留 sessionId、真实 parentAgent、由 helper 生成的元数据/策略及可信 cwd。
未发布 setup 注入 attempt 身份和 guard；一个新会话只接受一次初始输入；结果须关联输入/turn、完成严格 flush 和回收，再结算释放资源。

这种直接创建不会自动写入原生 subagent catalog、continuable manager 或 subagent 观察事件。
TaskForce 需展示自己的持久任务/执行视图，不能宣称完全兼容原生 continuation。
标准会话历史仍可按实际 session id 查询；不伪造 descriptor，也不把不存在的 adapter 参数塞进 agentOptions。

### 父子与并发

原生 continuation 容量默认 8，但只覆盖特定连续原生 activation 树，等待父代理也占槽；它不是 TaskForce 的 6/2 全树持久预算。
深度和真实父链仍由公开 delegation helper 维护。受管嵌套只通过自己的调度器；父 attempt 在子树结束前保留 native handle 和 holds。
若不能立即给予子任务完整额度/资源，则拒绝该嵌套请求并交回主代理，避免所有父任务持锁等待。
未验证的嵌套/取消能力必须关闭并报错，不能凭原生 idle 判断安全；完整 B 验收仍包括真实深度 2。

### 恢复与真实性

预留 id 有助于对账，不保证 exactly-once。旧派发进程可能仍活着，日志不存在也不能立即重派。
协调域要求独占派发进程；原始持久日志、attempt 记录、进程/工作区回收证据共同决定是否可结算。
宿主重启后没有可用的真实授权父会话时暂停新派发；不得为恢复而假造父链，或自动 resume 带未知 pending input 的会话。
无法证明停止的执行进入 unknown，保留 holds；数据库代际不被描述成阻止 OS 写入的沙箱。

## 4. 自动化依赖

C 在 B attempt 基础上增加六阶段 workflow 和 immutable revision/evidence/decision。
测试和 PR 发布必须有可信 adapter 回执；模型 fact、日志路径或“测试通过”文本只能是声明。
测试通过、审查通过与完整 commit SHA、plan、revision 一起绑定，旧证据不能覆盖新版本。
不同实际 session 才能满足最低独立审查要求；所有实现后代也属于实现者集合。
外部 effect 与调度资源同库建立意图，但外部操作不在 SQLite 事务里执行；unknown 必须对账。

## 5. 已证明与未证明

**已完成：** 阶段 A 代码阅读；目标版本发布包完整性与源码检查；三路独立调度、工作流、宿主研究；可实现端口及失败边界设计。

**尚未完成：** B/C 产品代码；安装后的 rc.2 启动；具体 edit/bash/sandbox 工具约束；嵌套和进程清理实测；宿主重启对账；可信 runner 与授权测试仓库 PR 发布闭环。

源码表明薄 adapter 有支持入口，不等于当前 TaskForce 已拥有这些功能，也不等于 deployment 中任意 provider 都能安全回收。
后续实施必须分别报告离线核心、模拟适配器、真实宿主结果；能力缺失时明确阻塞，不放宽准入或验收。

## 6. 规格审查记录

三路研究完成后，由独立代理检查 B/C 跨文档契约。发现的阻塞项为父权限快照取得晚于异步工作区准备；已改为实际准入时、首次异步操作前同步捕获并持久化，投递前检测策略变化。补充了发送者 scope guard 无法阻止外部投递的问题，要求 host 按受管目标检查所有输入路线。
限范围复核确认上述问题已修正，没有新增契约矛盾。此审查只覆盖规格；具体锁、进程清理、沙箱和真实 runner/PR 适配仍须实施与集成测试证明。
