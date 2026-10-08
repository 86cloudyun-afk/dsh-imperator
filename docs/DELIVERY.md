# TaskForce 0.2 交付、验收与回滚

## 交付目标

本版将 PR #4/#5 的研究型主会话、思考保护、归属隔离、快照读取与恢复补强，与 PR #6 的 DSH 原生兼容、PTC 执行守卫、两层委派和审计换人整合。包版本为 0.2.1，声明 DSH >=0.2.0-rc.2；固定原生验收目标为官方 0.2.0-rc.2，不能把版本范围声明当作所有未来版本均已测试。

可交付口径是：完整离线测试、原生契约与执行边界、实际隔离 web boot、任务工具闭环、卸载恢复、异常清理以及打包后验收通过。不是“没有任何未知缺陷”的保证，也不包含生产服务器部署或外部模型效果验收。

## 包含内容与核验

`local-dsh-taskforce-0.2.1.tgz` 包含 lib、cordis.patch.yml、tools、docs 和 package.json/README。运行时没有新增第三方依赖，没有安装/prepare 生命周期脚本。CI 制品记录精确提交和 Git tree、Node/npm/DSH 版本、npm 包完整性摘要、归档 SHA-256 和完整测试日志。先核验交付包旁的 SHA256SUMS，解压后执行：

```sh
mkdir taskforce-candidate
tar -xzf local-dsh-taskforce-0.2.1.tgz -C taskforce-candidate
cd taskforce-candidate/package
npm test
npm run test:all -- --install-anchor /absolute/path/to/@deepseek-ai/dsh/package.json
```

anchor 必须指向实际安装的官方 DSH package.json，不是 profile。省略时可从 PATH 的 dsh 查找。显式错误路径会失败。`test:all` 的四个原生结果必须均为 PASSED，并出现 HOST_VERIFIED 和 ISOLATION_VERIFIED；单独的离线退出 0、SKIP 或 UNVERIFIED 不代表原生通过。

验证会创建独立临时 DSH_HOME，绑定回环地址临时端口，关闭浏览器和访问 URL 输出，并完成清理；不向模型投入消息，不读取已有实例的任务数据。只读元数据及测试结果在日志中出现，不输出模型密钥或访问令牌。

## 在目标实例安装

以下为操作员主动部署步骤，不由交付脚本自动执行。先确认目标 DSH 和 Node 版本，备份 profile 的 package.json、锁文件、cordis.patch.yml 及相关覆盖层。数据库备份必须在停止写入后完整复制，或使用 SQLite 在线备份；不要在 WAL 正在写入时只复制主 db 文件。

在确认目标 profile 后，以其管理员身份安装经校验的本地包，例如 web profile：

```sh
dsh plugin --profile web add /absolute/path/local-dsh-taskforce-0.2.1.tgz
dsh --profile web --dump-config
```

官方 CLI 将 `dsh plugin --profile <name> <pnpm args>` 转发到 profile 的包管理器。核对目标 profile 的依赖以及 dsh.profile.bundles 中均有且仅有一份 `@local/dsh-taskforce`；保留已有其他 bundle 与用户覆盖。按目标实例的管理方式重新加载或重启，不直接杀死承载当前会话的进程。

加载后确认 roster 的 taskforce 恰好一项、broken 为空、事实库可用；在新任务中确认主控能只读查证、子代理能执行、子代理不能自批。切换工具呈现模式不得让主控获得 run_code 写权限。旧会话可能保留先前 composition，需在新会话核验。生产端仍需一次真实模型任务验收；本仓库 CI 不代替此项。

## 回滚

先停止新派发并妥善结束受影响任务，保存诊断和新增事实。恢复备份的 profile 依赖/锁文件/覆盖层或安装先前已验证包，再按实例管理方式重载。仅在明确需要且确认停止写入后恢复数据库备份，不能静默丢弃升级后的新增事实。先前 main 6b81d4d 在 PTC、fork 深度和跨步 ID 上有已知缺陷，不应把回滚到该版称为同等级安全验收通过。

## 契约与未覆盖范围

ECHO 采用调用发起顺序，晚到旧成功不清空新失败；native/PTC 命名空间及 turn/step 限定调用身份。派发统计保留尝试、回执、失败三个字段，不充当持久调度额度。STALL 默认只观察且不降档。

阶段 B/C 持久调度器与自动开发仍未实现；执行者的文件权限也不由服务层 run 隔离代替。实际模型输出、长时并发、费用、其他宿主版本和用户生产环境不在隔离无模型验收范围内。历史报告记录其候选版本；新版本状态以精确提交对应的 CI 与验收记录为准。

CLI 机制参考：[官方 DSH 包说明](https://www.npmjs.com/package/@deepseek-ai/dsh)。固定版本实际安装与运行证据由 CI 记录。

0.2.1 补充修复 issue #7：退出 TaskForce 后撤销本插件作用域限制，并阻止等待中的 TaskForce 钩子向已切换的会话注入消息。标准模式隔离是本版交付门槛；历史 0.2.0 包不包含此修复。见 `PRESET_ISOLATION.md`。

## Opt-in 固定模型回归（0.3）

离线 `npm test` 包含 `tools/tests/model-regression.test.mjs` 的 mock 超时、错误、usage、验收、复用与独立 grader 行为测试，不联网调用模型。真实模型验收另行显式执行，要求精确的官方 `@deepseek-ai/dsh@0.2.0-rc.2` 安装锚点：

```bash
node tools/verify-model.mjs --model-calls \
  --install-anchor /absolute/path/to/@deepseek-ai/dsh/package.json \
  --provider deepseek-official --model deepseek-flash \
  --request-cap 80 --stage-timeout-ms 180000 \
  --output-dir /absolute/path/to/model-report
```

可选 `--package-sha256 <64位小写SHA256>` 绑定实际交付 tarball 的摘要；调用者应先独立计算该摘要。报告 `report.json` 绑定包版本、完整 git commit（源码树可取时）、产品源码 SHA256、可选包摘要、宿主/Node 版本与 provider/model。每阶段给出请求、输入/输出/缓存 tokens、时长、新建/复用/返工、事实和验收数量、固定独立断言数量；失败阶段仍保留已知计数。只有四阶段独立判据、真实任务闭环、完整 usage 与清理全部通过，`ok` 才为 true，CLI 才退出 0。

本工具在独立进程使用官方临时 profile，沿用环境提供的 provider 配置和凭据；凭据不进入报告。仅持久化白名单指标，不保存 reasoning、credentials、模型对话、原始工具输出或任意错误消息。报告不包含可复用数据库或证据日志，因为隔离的 home/workspace 在结束时清除。严格验收结果在清除前由当前源码和真实宿主日志再次检查，固定 grader 由 verifier 控制并在模型工作区外执行。详细阶段判据、软预算与限制见 `docs/ORCHESTRATION.md`。

没有显式 opt-in、非法请求/timeout 参数、超时、超过全局请求上限、provider/tool 错误、usage 缺失、未收口任务、错误执行者复用、无有效 strict 回执或独立断言失败均退出非零。不得用单条模型总结、模型改写后的测试退出码、静态提示词字数或 mock 成功代替真实模型验收。

固定金额回归仅评价自包含 ESM 的同步 `sumMoney` 和标准 ECMAScript 内建；不支持 money.mjs 导入其他模块、访问 Node 宿主全局或异步返回。该约束已写入固定模型提示；测试文件仍允许 node:test。grader 在一次性子进程的新 `vm.SourceTextModule` realm 执行模型源码，输入也在该 realm 创建，判据和完成协议留在外层。所需 `--experimental-vm-modules` 仅由 grader 子进程开启，使用 Node 内建能力，无新增依赖；它不是通用模块或 OS 沙箱。
