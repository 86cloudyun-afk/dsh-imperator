# TaskForce 0.2.1：预设隔离修复

## 缺陷与边界

Issue #7 的原生复现：在官方 DSH 0.2.0-rc.2 中，同一空白会话从 taskforce 切到 standard 后，预设身份、persona 和 task_* 工具已经切换，但 agent 自有的 guard/restrict 仍然存在。基线为 main f7cd3f3。它不是“所有新标准会话被全局接管”，也不能解释未经读取的用户现场全部异常。

## 实现

执行限制仍注册在调用者的 agent 工具层，不改成全局限制。另以官方 scopeOf/scopeChainOf 检查该 agent 是否仍属于安装此插件的精确预设版本；相同预设 ID 的新旧版本不混用。离开后只撤销本插件持有的精确 disposer，不清空工具注册表、沙箱、宿主 guard 或其他插件的过滤器。

作用域模块在插件激活时通过宿主 pluginPackages 目录解析，支持包链接在宿主 node_modules 之外的安装方式，不另装一份 SDK。真实宿主无法解析此模块时拒绝启用，而不是默认认领所有会话；无宿主的独立用法保留兼容路径。

registry.recompose 的 tools/change 通知负责及时释放离开的限制，agent-preset/selected 负责根据实际作用域重新接入；不相信通知中的请求预设值。pre-step 等待结束时再次核对作用域。低层 recompose 进入预设而不记录 selected 时，仍由下次 scoped pre-step 建立执行守卫。正式 registry.select 路径须在切换完成后即恢复正确工具面。

清理两层各自执行，一层抛错不跳过另一层；失败的句柄保留以便重试，不声称恢复成功。离开的旧 guard 即使卸载失败也不会继续施加 TaskForce 限制；其他安全规则不受影响。未知作用域不作为解除已安装限制的依据。插件真正卸载时释放自身跟踪的注册。

工作状态和失败保护的异步钩子在 await 之后也核对作用域，避免已选 standard 的会话收到新注入的 TaskForce 状态、ECHO 或推理档位改写。不会删除或改写历史会话消息。

## 验证与复现

`npm test` 包含离线生命周期回归；`npm run test:all -- --install-anchor /path/to/@deepseek-ai/dsh/package.json` 另外运行 `tools/verify-isolation.mjs`。真实检查包含默认标准模式、TaskForce 正例、并存标准模式、minimal、往返切换、外部安全限制保留、等待中的 pre-step 切换、持久恢复、标准失败负例、TaskForce 失败正例、新旧预设版本重载及资源清理。

验收必须出现 `ISOLATION_VERIFIED`。测试使用独立临时 DSH_HOME 和回环端口，无模型请求，无 API key，不改用户生产 profile。离线检查不能替代原生检查；最终结果以对应提交的 CI 和交付包内日志为准。

旧版已经运行的 agent 可能仍持有旧闭包，复制新文件不会热修补它。升级后重新加载插件并新建会话，或通过原有正常停机方式重启实例；无需删除事实库、会话历史或全局配置。真实模型质量、长时负载和现场部署仍不在无模型验收范围内。
