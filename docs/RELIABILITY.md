# SQLite 可靠性配置与事务

宿主配置可选 `busyTimeoutMs`（整数，0–5000，默认 1000）和 `journalMode`（`preserve` 或 `wal`，默认 `preserve`）。例如：

```js
{ root: '/path/to/taskforce', busyTimeoutMs: 1000, journalMode: 'wal' }
```

默认模式保留库当前的日志模式，已有 WAL 库不会被切回其他模式。显式 `wal` 会核对 SQLite 实际返回的模式；无法启用时报 `E_STORE_JOURNAL_MODE`。超出范围的配置报 `E_STORE_CONFIG`。配置只来自宿主，不由模型工具参数提供。

开库时建表、补列和创建后置视图共用一次 `BEGIN IMMEDIATE` 写事务；中途失败会回滚并关闭临时连接，下次调用可重新尝试打开。最外层同步事务使用 `BEGIN IMMEDIATE`，嵌套事务使用 savepoint。事务内不要安排网络、模型调用、文件处理或异步写入；返回 thenable 会回滚并报 `E_STORE_ASYNC_TRANSACTION`。辅助层不重试事务。写锁冲突按 SQLite 主错误码 5/6 归类为 `E_STORE_BUSY`，调用方可选择何时重试。回滚本身失败时错误会带 `rollbackError` 和 `transactionStateUnknown: true`；该连接会关闭，下一次访问重新开库。

## 预设挂载生命周期

`@local/dsh-taskforce` 通过独立的进程级所有权 Map 防止多个模块副本重复声明预设，同时尊重宿主旧有 `dsh-web.mounted-plugins` Set 中的占位，不替换或清空该 Set。`ctx.effect` 的清理函数返回 Promise，宿主应等待它完成；注册尚未完成时卸载，会等待注册返回后再撤销声明。只有确认注册失败且没有有效声明，或成功执行了注册返回的 disposer，才释放当前挂载的所有权。随后重新启用可以显式再次尝试注册；不会在后台无限重试。

注册返回值不是函数，或 disposer 执行失败时，可能仍有有效声明，因此保留占位并输出诊断，避免下一次启用造成重复声明。重复卸载不会释放后续实例的占位。模拟测试验证这些事件顺序；真实 DSH 宿主的重启用验收仍待执行。

## 验证与真实宿主验收

当前入口与交付边界以 [DELIVERY.md](DELIVERY.md) 为准。离线运行保留六套脚本与全部回归；原生阶段运行 Config/解析、真实执行守卫、子提示词、两种委派深度、web boot、任务验收、审计换人、事件重放和清理失败检查。

验证器仍使用主分支的 deadline/exitCode/signal 分离逻辑；超时后即使退出 0 也失败，SIGTERM 宽限 500ms 后可强制结束直接子进程。宿主缺失不得冒称成功；退出/清理失败不得报告 HOST_VERIFIED。CI 原生阶段对打包再解压的候选执行 `test:all`，而不是仅验证源码工作目录。

当前版本的验收以对应 commit/tree 的 CI 制品为证；历史报告中的旧版本 UNVERIFIED/FAILED 不表示已验证新的版本。所有原生检查都运行在临时 DSH_HOME，不修改已有 profile、事实库或服务，不调用模型。

## 长任务与子代理停止的诊断边界

连续任务工具失败现在参与 ECHO：例如同参数 `task_child_send` 六次返回完整 `ok:false` 错误回执，即使 DSH 的 `isError=false`（文本传输成功），也会提示停止重复调用。判定绑定真实 callId/turn/step 和已注册工具名，同时支持 native 与 PTC。ECHO 不执行子代理取消；preset 的 STALL 仍只观察，reasoning effort 保持路由选择。该回归修复的是失败检测，不能据此断言所有进程退出或子代理停止均已修复。

另有宿主条件性风险：官方 DSH 0.2.0-rc.2 的 headless 入口在 root 空闲后直接退出，没有等待后代；退出清理可以中断仍运行的子代理。当前官方主线已加入 `waitForChildren` 与 root 再检查（见 [headless 源码](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/bundle/headless/src/index.ts)）。截至 2026-10-09 已发布的 0.2.1-alpha.2 是预发布版；本修复保持现有 rc.2 宿主验收基线，没有自动替换宿主。此问题只在实际采用该 headless 生命周期时适用，不能推断 Web/TUI/SDK 用户遇到的停止原因。

排查实际停止时保留宿主入口/版本、最后 turn/end 的 reason.kind、agent/error 的稳定 code、父会话是否仍存活及退出时间。区分 completed、error、aborted、max-tokens 和 refusal；不要把活动表缺失或 inactive 单独当作崩溃证据。现有离线与原生宿主验收不发送模型请求，也不等价于数小时真实并发稳定性验收。
