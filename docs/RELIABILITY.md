# SQLite 可靠性配置与事务

宿主配置可选 `busyTimeoutMs`（整数，0–5000，默认 1000）和 `journalMode`（`preserve` 或 `wal`，默认 `preserve`）。例如：

```js
{ root: '/path/to/taskforce', busyTimeoutMs: 1000, journalMode: 'wal' }
```

默认模式保留库当前的日志模式，已有 WAL 库不会被切回其他模式。显式 `wal` 会核对 SQLite 实际返回的模式；无法启用时报 `E_STORE_JOURNAL_MODE`。超出范围的配置报 `E_STORE_CONFIG`。配置只来自宿主，不由模型工具参数提供。

开库时建表、补列和创建后置视图共用一次 `BEGIN IMMEDIATE` 写事务；中途失败会回滚并关闭临时连接，下次调用可重新尝试打开。最外层同步事务使用 `BEGIN IMMEDIATE`，嵌套事务使用 savepoint。事务内不要安排网络、模型调用、文件处理或异步写入；返回 thenable 会回滚并报 `E_STORE_ASYNC_TRANSACTION`。辅助层不重试事务。写锁冲突按 SQLite 主错误码 5/6 归类为 `E_STORE_BUSY`，调用方可选择何时重试。回滚本身失败时错误会带 `rollbackError` 和 `transactionStateUnknown: true`；该连接会关闭，下一次访问重新开库。

## 预设挂载生命周期

`@local/dsh-taskforce` 通过独立的进程级所有权 Map 防止多个模块副本重复声明预设，同时尊重宿主旧有 `dsh-web.mounted-plugins` Set 中的占位，不替换或清空该 Set。`ctx.effect` 的清理函数返回 Promise，宿主应等待它完成；注册尚未完成时卸载，会等待注册返回后再撤销声明。只有确认注册失败且没有有效声明，或成功执行了注册返回的 disposer，才释放当前挂载的所有权。随后重新启用可以显式再次尝试注册；不会在后台无限重试。

注册返回值不是函数，或 disposer 执行失败时，可能仍有有效声明，因此保留占位并输出诊断，避免下一次启用造成重复声明。重复卸载不会释放后续实例的占位。模拟测试覆盖事件顺序；真实 DSH 0.2 宿主也已验证卸载、重新启用和注册冲突后的恢复。

## 验证与真实宿主验收

`npm test` 顺序运行六套独立脚本和八个 node:test 文件。离线结果中的
`host integration: UNVERIFIED` 表示完整宿主未参与；不能据此宣称可启动。
`npm run test:integration` 运行原生预设契约、执行边界与完整 boot；`test:all` 同时要求离线成功。
独立失败仍继续收集剩余结果，每个子进程的截止时间是 60 秒，超时独立判失败；另给 1 秒终止宽限，必要时强制终止。

```bash
npm run test:all -- --install-anchor /path/to/@deepseek-ai/dsh/package.json
```

不提供安装路径时，从 PATH 的 dsh 可执行文件解析真实 npm 安装，支持版本目录与全局符号链接。
保留旧 `--install-dir` 和 `--profile-dir`：显式路径缺失不会被其他安装覆盖；指定 profile 只参与预设契约检查。
缺少原生安装、结构校验器、模块、必填 Config 或 boot 失败均退出非零。

完整验收使用临时 DSH_HOME 和 profile，加载本包 bundle，并以回环地址、随机临时端口、关闭浏览器及 URL 输出的方式启动实际 web 宿主。
验证真实 roster、store、Agent 工厂、子代理写文件、task 工具身份、证据提交/主控验收/重新指派，以及 Loader 卸载、重新启用和真实注册冲突恢复。
另通过真实委派工具执行前取消及原生 Session 的两次合法结果展示替换，核对失败派发无在飞占位、同一失败不重复触发熔断，并核对 JSON 回放一致。
退出前释放 Agent handle，关闭宿主并删除临时目录；清理失败或卡住时保持非零退出码，强制退出的同步清理钩子仍删除临时 home；现有 profile 和事实库不参与这笔验收。
不向 Agent 投入模型消息，不需要模型密钥；模型响应、实际长期委派和负载性能仍需另外验收。

CI 的离线任务固定 Node 22.23.2 / 24.19.0；真实宿主任务固定 Node 24.19.0 和 DSH 0.2.0-rc.2。
本次真实验收的版本、候选提交、命令和结果见 [2026-09-30 验收记录](superpowers/research/2026-09-30-dsh-0.2-acceptance.md)。
