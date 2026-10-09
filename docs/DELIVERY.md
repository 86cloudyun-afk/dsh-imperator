# Imperator 0.3.1 交付、验收与回滚

## 交付目标

本版修正续作通知和未知派发结果的未结算估计，优化新开的空待办页，并增加固定 alpha.2 宿主兼容验收。提示词不再无条件引用已废弃的 `cwd` 变量；旧宿主仍按原生变量提供目录，新宿主保留必需的目录上下文。保留可信 session 归属与作者审计、opt-in 严格执行回执、有界分页看板、冻结事件增量投影、独立 durable governor core 及固定四阶段 opt-in 模型回归。包版本为 0.3.1，Node 范围为 `^22.23.2 || ^24.19.0`，声明 DSH >=0.2.0-rc.2；固定原生验收目标为官方 0.2.0-rc.2 / 0.2.1-alpha.2（预发布版），不能把版本范围声明当作所有未来版本均已测试。

F1修正候选 `c237ab8` 的108个归档文件与提交逐字节相同，实际解压包已通过双Node全量原生验证及显式四阶段模型验收（58条native stream请求、215946ms，运行/usage/route错误计数全0）。包SHA为 `c4556657616dcd1d016bad5ceb9e4e30a89811ff9de41697430fb7914d815c16`；完整身份与证据见 [0.3验收记录](superpowers/research/2026-10-08-imperator-0.3-acceptance.md)。历史55条普通agent样本与六次失败278条保留，旧辅助调用覆盖缺失、历史发生情况及usage未知，不能推断历史全部provider用量完整。最终文档归档将不同于模型候选包，仍须controller核对产品等价、双Node、唯一最终范围复核、更新CI与exact HEAD merge；本记录不宣称这些步骤完成。固定样例不证明生产部署或普遍性能/费用改善。

## 包含内容与核验

`local-dsh-taskforce-0.3.1.tgz` 包含 lib、cordis.patch.yml、tools、docs 和 package.json/README。运行时没有新增第三方依赖，没有安装/prepare 生命周期脚本。CI 制品记录精确提交和 Git tree、Node/npm/DSH 版本、npm 包完整性摘要、归档 SHA-256 和完整测试日志。先核验交付包旁的 SHA256SUMS，解压后执行：

```sh
mkdir taskforce-candidate
tar -xzf local-dsh-taskforce-0.3.1.tgz -C taskforce-candidate
cd taskforce-candidate/package
npm test
npm run test:all -- --install-anchor /absolute/path/to/@deepseek-ai/dsh/package.json
```

anchor 必须指向实际安装的官方 DSH package.json，不是 profile。省略时可从 PATH 的 dsh 查找。显式错误路径会失败。`test:all` 的四个原生结果必须均为 PASSED，并出现 HOST_VERIFIED 和 ISOLATION_VERIFIED；单独的离线退出 0、SKIP 或 UNVERIFIED 不代表原生通过。

验证会创建独立临时 DSH_HOME，绑定回环地址临时端口，关闭浏览器和访问 URL 输出，并完成清理；不向模型投入消息，不读取已有实例的任务数据。只读元数据及测试结果在日志中出现，不输出模型密钥或访问令牌。

## 0.3 数据迁移与运行边界

固定包名 `@local/dsh-taskforce`、preset `taskforce`、显示名 `任务部队` 与数据库 `$DSH_HOME/taskforce/taskforce.db` 不变。开库在事务中补 `task.owner_session`、执行 policy/清单/命令/cwd/generation 与 `fact.actor_session`，创建 `execution_receipt` / `execution_waiver`；历史行不猜填真实身份或成功回执。旧未绑定路径保留具名警告；历史已 trim 的身份不能自动还原。管理员应核对原始会话记录，不能把昵称当可信身份。

可信宿主显式创建 governor 时才在同库创建 run、reservation、retry charge、resource hold 与 audit 表。重启 unknown 保留额度与资源；保守 retry 迁移可能对无法证明的历史重叠多计 retry 额度，旧 reservation 不得作未证明的 bind，须可信主控审计恢复/扩展/结算。见 [GOVERNOR.md](GOVERNOR.md)。升级新增列/表不删除事实；恢复旧数据库备份会丢升级后的记录，回滚前必须保存并审查。

`execution` 仅在 `task_open` 显式设置，默认 `legacy`。`task_verify` 保留原生执行安全层；源码、日志、generation 或 owner 变化会使旧成功失效，最新非零/unknown/pending 不可被旧成功覆盖。人工 waiver 返回 `execution_verified:false`。有同 UID unrestricted shell 的执行者可直接改数据库，本功能是工具接口约束，不能替代 OS 隔离。

默认 `task_board` 的 tasks/summary 每页25、最大100，完整工具 JSON 上限65536 UTF-8 bytes；截短字段与页尾预算缩减均可辨，游标仍能取全数据。详情和显式 facts/handoffs/late_blockers 原文页只限条数，不受摘要字节上限约束。原生冻结事件追加增量折叠，可变恢复 seed 或历史 replacement 全量重放；前缀扫描/复制仍 O(n)。

执行者编辑既有文件前用自己的 native read 建立观察，新任务/续作重新读；成功 native write/edit 后允许连续编辑，不机械重读。FS_NOT_OBSERVED/FS_STALE_VERSION 时 read 并重新判断。原生观察按 Session 对象维护；真实冷恢复保留旧read历史也不恢复观察，root read 或 shell cat/grep/native grep 均不替代 worker read。实际 flush/dispose/resume 与 fresh/resumed spawn/fork 提示挂载已有无模型证据，详见验收记录。

## 在目标实例安装

以下为操作员主动部署步骤，不由交付脚本自动执行。先确认目标 DSH 和 Node 版本，备份 profile 的 package.json、锁文件、cordis.patch.yml 及相关覆盖层。数据库备份必须在停止写入后完整复制，或使用 SQLite 在线备份；不要在 WAL 正在写入时只复制主 db 文件。

在确认目标 profile 后，以其管理员身份安装经校验的本地包，例如 web profile：

```sh
dsh plugin --profile web add /absolute/path/local-dsh-taskforce-0.3.1.tgz
dsh --profile web --dump-config
```

官方 CLI 将 `dsh plugin --profile <name> <pnpm args>` 转发到 profile 的包管理器。核对目标 profile 的依赖以及 dsh.profile.bundles 中均有且仅有一份 `@local/dsh-taskforce`；保留已有其他 bundle 与用户覆盖。按目标实例的管理方式重新加载或重启，不直接杀死承载当前会话的进程。

加载后确认 roster 的 taskforce 恰好一项、broken 为空、事实库可用；在新任务中确认主控能只读查证、子代理能执行、子代理不能自批。切换工具呈现模式不得让主控获得 run_code 写权限。旧会话可能保留先前 composition，需在新会话核验。生产端仍需一次真实模型任务验收；本仓库 CI 不代替此项。

## 回滚

先停止新派发并妥善结束受影响任务，保存诊断和新增事实。恢复备份的 profile 依赖/锁文件/覆盖层或安装先前已验证包，再按实例管理方式重载。仅在明确需要且确认停止写入后恢复数据库备份，不能静默丢弃升级后的新增事实。先前 main 6b81d4d 在 PTC、fork 深度和跨步 ID 上有已知缺陷，不应把回滚到该版称为同等级安全验收通过。

## 契约与未覆盖范围

ECHO 采用调用发起顺序，晚到旧成功不清空新失败；native/PTC 命名空间及 turn/step 限定调用身份。派发统计保留尝试、回执、失败三个字段，不充当持久调度额度。STALL 默认只观察且不降档。

durable governor core 已提供可信宿主 API，但 `createNativeGovernorAdapter()` 无条件返回 `E_SCHEDULER_CAPABILITY` 并列出 H01–H06，配置或回调不能解锁。原生派发仍只有软预算纪律，阶段 C 自动开发未实现；执行者的文件权限也不由服务层 run 隔离代替。实际模型输出、长时并发、费用、其他宿主版本和用户生产环境不在隔离无模型验收范围内。历史报告记录其候选版本；新版本状态以精确提交对应的 CI 与验收记录为准。

CLI 机制参考：[官方 DSH 包说明](https://www.npmjs.com/package/@deepseek-ai/dsh)。固定版本实际安装与运行证据由 CI 记录。

0.2.1 补充修复 issue #7：退出 TaskForce 后撤销本插件作用域限制，并阻止等待中的 TaskForce 钩子向已切换的会话注入消息。标准模式隔离是本版交付门槛；历史 0.2.0 包不包含此修复。见 `PRESET_ISOLATION.md`。

## Opt-in 固定模型回归（0.3）

离线 `npm test` 包含 `tools/tests/model-regression.test.mjs` 的 mock 超时、错误、usage、验收、复用与独立 grader 行为测试，不联网调用模型。真实模型验收另行显式执行，要求精确的官方 `@deepseek-ai/dsh@0.2.0-rc.2` 或 `@deepseek-ai/dsh@0.2.1-alpha.2` 安装锚点：

```bash
node tools/verify-model.mjs --model-calls \
  --install-anchor /absolute/path/to/@deepseek-ai/dsh/package.json \
  --provider deepseek-official --model deepseek-flash \
  --request-cap 80 --stage-timeout-ms 180000 \
  --output-dir /absolute/path/to/model-report
```

可选 `--package-sha256 <64位小写SHA256>` 绑定实际交付 tarball 的摘要；调用者应先独立计算该摘要。报告 `report.json` 绑定包版本、完整 git commit（源码树可取时）、产品源码 SHA256、可选包摘要、宿主/Node 版本与 provider/model。每阶段给出请求、输入/输出/缓存 tokens、时长、新建/复用/返工、事实和验收数量、固定独立断言数量；失败阶段仍保留已知计数。只有四阶段独立判据、真实任务闭环、完整 usage 与清理全部通过，`ok` 才为 true，CLI 才退出 0。

原生验证器固定每个获准请求输出容量为8192 tokens，同时配置 provider 默认值与 root agent；官方子会话继承此配置，不降低 reasoning effort。在全局公开 `llm/stream` waterfall 消费边界，以 SDK `isAgentLoopRequest` 的精确对象标记、真实 agent/request 的 agent/turn/step/signal 和受控 root 子树核对归属，只对匹配的一次实际流消费计请求。SDK prepared call 已解析的 provider/model/maxTokens 必须匹配固定路由与8192，错误路由或65536等容量在派发前拒绝。报告 `outputCapacity.source=native-stream-boundary`；自定义离线 harness 为 `custom-harness-unverified`。报告 `auxiliaryPolicy=reject-before-dispatch`：本固定回归不支持辅助 LLM 调用，包括自动 compaction；尝试即拒绝并锁存失败，不能捕获异常后继续获准。生产 preset compaction 保持 auto=true 及其原配置，未被禁用或更改。历史 `native-configuration` 仅证明普通 agent 配置，不能证明辅助请求容量；8192与历史4096不能作同额度性能比较。

本工具在独立进程使用官方临时 profile，沿用环境提供的 provider 配置和凭据；凭据不进入报告。仅持久化白名单指标，不保存 reasoning、credentials、模型对话、原始工具输出或任意错误消息。报告不包含可复用数据库或证据日志，因为隔离的 home/workspace 在结束时清除。严格验收结果在清除前由当前源码和真实宿主日志再次检查，固定 grader 由 verifier 控制并在模型工作区外执行。详细阶段判据、软预算与限制见 `docs/ORCHESTRATION.md`。

没有显式 opt-in、非法请求/timeout 参数、超时、超过全局请求上限、provider/tool 错误、usage 缺失、未收口任务、错误执行者复用、无有效 strict 回执或独立断言失败均退出非零。不得用单条模型总结、模型改写后的测试退出码、静态提示词字数或 mock 成功代替真实模型验收。

金额修复与同执行者续作阶段固定使用 `evidence_policy=legacy`，提示及观察到的实际任务策略必须一致，否则报告 `evidence-policy` 失败。第四阶段仍要求 execution 真实严格回执与主控验收。这仅控制同名金额任务的证据策略；当前8192与历史4096额度、独立grader和工作量控制仍有差异，比较为描述性单次样本，不测量自主策略选择；独立判据、请求上限和 timeout 不变。

固定金额回归仅评价自包含 ESM 的同步 `sumMoney` 和标准 ECMAScript 内建；不支持 money.mjs 导入其他模块、访问 Node 宿主全局或异步返回。该约束已写入固定模型提示；测试文件仍允许 node:test。grader 在一次性子进程的新 `vm.SourceTextModule` realm 执行模型源码，输入也在该 realm 创建，判据和完成协议留在外层。所需 `--experimental-vm-modules` 仅由 grader 子进程开启，使用 Node 内建能力，无新增依赖；它不是通用模块或 OS 沙箱。

执行阶段的 `closure` 诊断只记录固定失败码（new-task-count/task-status/owner-mismatch/waiver/legacy-evidence）、任务/新任务数量和最多 20 条任务的 ID、枚举状态、ownerMatches、evidenceCount、waived、证据策略与 strictVerified；超出部分仍参与全部判定，`truncated` 明示详情截断。不写 owner/session 原文、事实、附注、模型输出或错误消息。waived 依据当前接受记录的系统裁决标记及本代结构化 execution_waiver 记录；普通事实或附注提及「不使用人工豁免」不算实际豁免。

总报告及阶段 `runtimeDiagnostics` 保留 step-error、native-tool-error、ptc-tool-error、noncompleted-turn、missing-message、missing-usage、invalid-usage、duplicate-message、route-mismatch、no-requests，并增加 auxiliary-call、stream-attribution、capacity-mismatch、stream-error、stream-admission-error、compaction-error、pending-stream。每个实际消费流按 SDK 最新 cumulative usage 帧计一次，要求完整合法 usage、一次成功终结及迭代耗尽；异常、取消、提前退出、max-tokens或缺终结均失败。流 usage 为原生总量来源，持久 assistant/message 继续独立核验；失败阶段保留已观察 usage 与任务指标，取消/清理等待流结束后再收集最终已知usage。native compaction/end.error 进入运行闸，即使 pre-step 捕获异常并继续也不能 PASS。持久错误和边界拒绝阻止后续派发，拒绝调用不计请求；并发尚在途流不提前作为持久错误，阶段结束必须完整。全局cap80、每阶段180000ms、stream idle30000ms、清理及原生/PTC scope 不变。每类保留计数，最多20条固定枚举/数字索引详情，不保存原始会话ID、路径、错误、工具内容、模型输出或凭据。bash非零退出仍是普通工具结果，真实isError/错误事件才触发工具错误闸。

新四阶段样本按native stream计量58请求215946ms，usage input58054/output41812/cacheRead1526144/cacheWrite0。历史旧计量样本55请求229651ms及六次失败278请求1470626ms保留；旧七次合计333条观察请求1700277ms，辅助发生情况和usage未知。八次混合观察范围合计391请求1916223ms、input422242/output289464/cacheRead9956352/cacheWrite0；此加总不是历史完整provider总量证明。新repair/reuse两阶段41请求156713ms，对历史v0.2.1的58请求144214ms，请求较少而时长更长，输出额度8192/4096、grader及工作量不同，不是同额度受控比较。完整stage/usage、失败与范围说明见验收记录；最终文档包与审核/CI/merge仍待controller完成。
