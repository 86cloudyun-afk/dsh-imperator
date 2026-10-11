# 隔离原生验证器的监听器清理设计

用户已授权完整调查、实现、审核、PR 与合并。本任务只改本仓库的隔离验证工具，不修改安装的 SDK，也不宣称修复生产宿主的全局监听器泄漏或解释历史执行者停止。

两个固定 SDK 的 native-only / Imperator 四组对照均显示：12 次 profile 启动后，每个 `unhandledRejection`、`uncaughtException`、`SIGTERM`、`SIGINT` 事件保留 12 个回调，关闭应用未释放。192 个注册堆栈均来自原生 `runProfile` / `installFailLoud`；50 次 Session 创建和 Agent/插件构造没有额外增长。证据在外部 `listener-warning/audit-report.md`，不得用 warning 阈值代替生命周期证据。

在 `tools/host-runtime.mjs` 集中管理独占的原生启动范围，并让现有隔离验证调用方通过 fixture 的 `runProfile` 启动实际 SDK。启动前后立即用 `rawListeners` 按引用和重复次数比较上述四事件；成功或失败返回之前捕获新增回调，不在 dispose 时通过迟到的全局差集猜测归属。固定成功启动应每事件新增一个回调；失败启动可以新增零或一个。异常基数必须使诊断失败，不扩大清理范围。帮助函数可提供小型可注入 emitter 的测试接口，具体内部命名由实现决定。

每进程最多一个存活的环境所属 controlledProfile fixture，创建时在改变环境、创建临时目录和await前占用独占token，完成fixture清理后才释放；竞争创建不改变活跃fixture的环境、目录或监听器。dispose包括环境/token幂等，旧fixture再次dispose不得覆盖后续fixture的环境或token。每fixture只允许一次boot。此合同用于已经独立进程运行、独占 DSH_HOME 的验证器，不能扩展为共享生产进程中的通用安全清理。fixture 只允许一次启动。实际启动函数和应用对象保持真实，原生信号与 fatal-error 监听器在应用停止、flush 和 disposal 期间仍有效。正常应用清理完成后，fixture 释放捕获的确切回调，重复 dispose 幂等，再恢复环境和删除临时目录。native cleanup deadline到期不证明真实Promise已settled：保留非零升级及回调到实际teardown结算或进程退出，不报告timeout路径成功恢复监听器生命周期，不扩大现有deadline。

保留启动前的普通/once 回调、重复注册，以及启动捕获完成后添加的不同外部回调；不得 removeAllListeners、增加 max listeners、关闭警告或修改 SDK。原生启动失败、应用清理失败和 hanging cleanup 仍保持非零退出及现有有界闸，不能因 fixture 清理成功掩盖它们。迁移所有caller清理顺序，nested finally保证exit hook移除和process.exitCode处理，即使fixture.dispose抛诊断也执行；原setup/teardown错误作为主错误或AggregateError成员保留，fixture错误为次级。fixture先完成可证明所属的清理再报告保存诊断。捕获基数异常不能让成功返回的应用失去清理路径：由调用方照常处理应用 teardown，再报告 fixture 诊断失败。

调用方涉及 verify-model、verify-host、verify-isolation 和 scheduler-native 测试。无新依赖、schema、包名或 runtime 组件；Node `^22.23.2 || ^24.19.0`、宿主 `0.2.0-rc.2` / `0.2.1-alpha.2`、60000ms 子进程验收与 12000ms 原生清理闸不变，full-tree adapter 关闭。

验收先记录原生重复启动和错误启动的实际 RED，再验证每次 teardown 后四事件的原始引用/重复数回到基线，两 pins 各 12 次启动无监听器增长、请求/stream 调用为零，外部 sentinel 和 once wrappers 保留。特别覆盖fixture创建期间await边界竞争、旧dispose在下一fixture存活时重放、成功app+异常基数仍teardown、native teardown拒绝+fixture诊断保留两者、setup错误+fixture诊断保留原错误并完成所属清理。保留故意失败样本，不把 SDK 自身被修改或生产稳定性作为结果。

调用方预检补充：createNativeHarness 当前没有 emergency exit hook；迁移时在 fixture 存活期登记同步临时 home 清理，以覆盖 native shutdown 的 process.exit（会跳过 Promise finally）。该退出清理不能提前释放仍在 teardown 中的 fatal/signal callbacks，普通结束、setup/teardown/fixture 诊断均以 nested finally 移除自己的 exit hook、恢复 exitCode；保留失败退出及两个 10000ms paid cleanup bounds。用独立有界子进程的实际 native reject/hang 路径证明 home 已删除且不能输出成功标记，不投入模型请求。scheduler-native 的 workingStore.close() 即使抛错也必须在 finally 尝试实际 application.shutdown，之后才做 fixture 所属清理，原 close 错误与次级 shutdown/fixture 错误都保留。

paid cleanup 两次 deadline race 必须分别保留其原始 handle-dispose / app-shutdown Promise 的实际结算状态；第二段完成不能证明第一段超时后仍未 settled 的清理已结束。监听器释放必须等待全部已启动的实际 teardown settled，或由已选择失败的进程退出路径结束；不得用 race 包装器完成替代原始 Promise。
