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

在包根目录运行 `npm test`，它顺序执行六套独立脚本和明确列出的五个 `node:test` 文件；输出中的 `host integration: UNVERIFIED` 表示宿主没有参与，独立项全通过时进程退出 0。`npm run test:integration` 仅运行宿主预设验证；`npm run test:all` 同时要求两层成功。每个子进程最多 60 秒，独立失败仍会继续收集剩余结果。集成模式缺 profile、registry、`entryListProblem` 或任何必需模块时必须退出非零。需要自定义宿主路径时直接执行：

```bash
node tools/verify-all.mjs --mode=all --profile-dir /opt/dsh/home/profiles/web --install-dir /opt/dsh/install/node_modules
```

CI 在 Ubuntu 24.04 的 Node 22.23.2 和 24.19.0 上运行离线检查；它不代替真实 DSH 宿主验收。仅在可控真实宿主中完成以下步骤，并将本包提交 SHA、DSH 版本、Node 版本、执行时间、命令和原始日志路径记录在验收记录中：

1. 运行 `npm run test:integration`，确认结构、模块解析与插件形状三层均通过；记录完整 stdout/stderr 与退出码。
2. 安装候选包并重启 DSH web，读取实际 boot roster，确认本包 host 插件和 preset 均已挂载，所有行的 `broken` 为空；记录 roster 与 boot 日志。离线脚本不验证 Config schema 的必填字段。
3. 在该实例创建任务、提交带有效依据的事实并由主会话验收；核对看板状态与数据库审计行一致，非法证据或未解决 blocker 被拒绝。记录匿名化任务 ID、动作结果和相关日志。
4. 卸载插件后重新启用，确认注册一次、无残留占位或重复声明；人为使下一次注册失败并确认能在再次启用时恢复。分别记录 unload、失败、重启用和 boot 日志。

当前工作环境没有必需的真实宿主文件：上述 boot roster、提交验收、重启用和注册失败恢复仍是**未验证**，不能用模拟测试替代。
