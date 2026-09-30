# TaskForce 0.2：DSH 0.2.0-rc.2 兼容与真实宿主验收

日期：2026-09-30。基线：`f960b9c`，已合并阶段 A 与 B/C 设计。

## 目标

本轮响应“同步任务部队，研究、完善、进化、升级、提交”，在最新 DSH 上修复已复现的现有流程缺陷，并把宿主验收变成可重复运行的命令。保持 host 服务、agent preset、SQLite 事实库结构；调度器和自动开发工作流仍按已有 B/C 规格另行实现。

成功标准：主会话不能绕过执行限制；子代理得到执行者提示词且 spawn/fork 都允许已有的深度 2；原生/PTC 持久事件能正确驱动工作状态与熔断；主会话能把重开的任务转交给新子代理；真实宿主能启动、调用任务工具、卸载重启用并恢复注册失败。

## 已复现的缺陷

| 位置 | 触发与当前结果 | 本轮行为 |
| --- | --- | --- |
| `orchestrator-scope.mjs` / preset | PTC 模式下主会话通过 `run_code` 直接调用文件 API，绕过 bash/write 禁止 | 主会话使用 native 展示；执行 guard 单独拒绝保留传输名 `run_code`，不把该名传给 `restrict()` |
| preset 两个委派行 | 原生 composition 沿父 scope 继承“自己不动手”提示词 | 两行显式提供简短执行者 persona；子代理可使用其已有权限与工具 |
| fork 行 | 缺少 `maxDepth`，实际退回宿主默认 1 | 与 spawn 一样显式为 2 |
| 工作状态与 guard | PTC 内层派发和失败不计数；成功的外层 transport 掩盖内层连续失败 | 读取 `tool/ptc-dispatch-start` 与 `tool/ptc-dispatch`，按 `subCallId` 配对；外层传输成功不清空内层失败链 |
| `claimTask` | lead reject 后 owner 保留，换 child 永远冲突 | 仅 trusted lead 可在 rejected 状态换 owner；状态、decision 与 handoff 同事务 |
| 集成校验器 | 固定 `/opt` 路径与 profile 的普通 Node 解析不适用于 npm 安装和 DSH 0.2 解析快照 | 显式安装 anchor 或 PATH 发现，真实 profile/运行时解析；缺宿主明确 UNVERIFIED 且集成退出非零 |

## 约束与接口

- 生产包保持零新增外部依赖；测试宿主使用官方 `@deepseek-ai/dsh@0.2.0-rc.2`。
- `claimTask(input, runId, actor?)` 向后兼容；省略 actor 保留原 owner 冲突规则。工具层仅从 `exec.agent` 推导 trusted lead，模型不能设置 actor。
- 换 owner 仅在 `rejected` 生效；active claimed、submitted、终态和跨 run 的原有拒绝顺序保持。`recordHandoff` 继续只记历史，单独调用不改 owner。
- PTC 失败/取消不证明创建了子代理；没有结算的开始事件保持 unresolved，不能被当成已完成。原生事件与已有 settlement channel 保持兼容。
- reserved transport 的执行拦截与工具展示分开：展示使主会话保有任务/委派工具，guard 防止运行时改成 PTC 后执行程序。
- 宿主测试不调用模型、不需要 API key，使用临时 DSH_HOME、loopback 与 OS 分配端口，释放原生 agent handles 和 host scope。
- 输出只含验收结果与证据，不含 process token、Authorization、模型密钥或原始敏感诊断。
- 版本升级为 `0.2.0`；验证目标和最低 DSH 声明为 `>=0.2.0-rc.2`。

## 验证与交付

回归覆盖 trusted lead/child 权限、活跃 owner、跨 run、审计回滚与重启；PTC 正常/失败/取消/未完成、内外层配对和传输成功；native presentation、子代理 prompt、fork 深度与实际执行拦截。

`npm test` 仍可在未安装 DSH 时运行，明确区分离线通过与宿主未验证。集成命令在已安装 DSH 时运行真实 boot roster、真实任务工具和生命周期，缺少必要能力或任一失败不得退出 0。CI 同时保留 Node 22/24 离线检查并增加固定版本宿主检查。

所有改动通过独立分支和 PR 提交；验收文档记录精确 DSH、Node、候选代码版本、命令及已验证边界。

## PR #6 后续迭代：事件配对与熔断准确性

PR 已成功创建且 CI 通过；Codex 自动审查任务显示 Failed，没有公开失败原因。
本次在原分支继续修复已复现的事件折叠问题，不改变任务状态机或授权接口。

- 原生委派失败或取消与 PTC 一样撤销在飞占位，不计成功回执；未知原生结果不猜测创建了子代理。
- 同一原生 callId / PTC subCallId 的重复开始或结果在所属 turn/step 内只计一次；宿主允许后续步骤复用 id，必须计为新调用。原生展示替换仍属于原结果的步骤，PTC 与其外层 wrapper 从所处执行上下文取得步骤；无 id 的旧原生调用仍保留近似占位。
- ECHO 的参数签名递归排序 JSON 对象键，保留数组顺序和实际值；不修改原事件。
- ECHO 按真实调用 id 配对、去重；同参并发调用乱序完成也能累计。不同调用或真实成功切断错误链，旧链迟到的错误不得重新触发。
- 原生 tool/result 的 surface replacement 只改变展示，不能把一次失败变成多次失败。
- 用真实 DSH 委派工具的执行前取消及原生 Session 日志验收，不发送模型请求；提交更新到已存在的 PR #6。
