# 任务部队（taskforce）· DSH 多 agent 生产工具

> **主会话只编排，子代理全执行。**
> 版本 `0.2.0`，要求 DeepSeek Harness `>=0.2.0-rc.2`。

一个 DeepSeek Harness 的 **agent preset**（附带 host 插件）：把主会话变成**编排者** —— 它只做四件事（拆解 / 派活 / 核对 / 汇报），**自己不动手**；所有实际工作由子代理完成，结果落进共享事实库，主会话**读库核对**而不是听汇报。

## 两个正交的问题，一次解决

| 层 | 学自 | 管什么 |
|---|---|---|
| **编排层** | `dsh-redteam-mode`（github.com/Jueze-2019） | 谁派活、派给谁、并发、事实落库、核对纪律 |
| **注意力层** | 梁神模式 `@linxin666/dsh-liangshen`（MIT） | 工具面多大、系统提示词多长、事实钉在哪、退化如何熔断 |

redteam 解决"**谁干活**"，梁神解决"**干活时脑子还清不清醒**"。两者叠加才是长任务多 agent 的完整形态。

## 四个支柱

1. **主会话不执行** —— persona 写死"只做四件事"，并且 `orchestrator-scope` 在运行时把它自己的执行类工具遮蔽掉。
2. **保持接收态** —— 派活走 `continuable`：工具**只返回 childId 不返回结果**；子代理结算由 runtime 作为**服务通知**投进父会话 turn stream。所以主会话天然不阻塞，且能在干别的活时收到结果。
3. **全委派** —— 一切实际动作（读写 / 执行 / 检索 / 构建）发生在子代理的上下文里，不污染编排者。
4. **上下文纪律** —— 防漂移 / 防幻觉 / 防"变笨"：切片、外化、机械校验、运行时熔断。

## 架构：双平面

```
host 平面（cordis.patch.yml）
  taskforce        → lib/index.js    声明 agent preset 给 ctx.agentPresets.register
  taskforce-store  → lib/store/      SQLite 事实库，发布 ctx.taskforceStore
agent 平面（lib/preset.js 的 29 行）
  persona                   编排者人设（本 preset 的全部系统提示词基底）
  tool-presentation         native（主控保留实际编排工具）
  agent-instructions        工作区指令（AGENTS.md 链）
  tool-bash/fs/fs-search/str-replace-editor/jobs/skills/goal/plan/todo/web/ask-user
  delegation（isolate: workflowEngine）
    subagent(subagent)        maxDepth: 2 · continuable · 执行者 persona
    subagent_fork(fork)       maxDepth: 2 · continuable · 执行者 persona
    subagent-control / list-agents
  compaction（isolate: compaction+toolResultPruner）
  taskforce-tools            ← 消费 ctx.taskforceStore，注册 10 个模型可见工具
  taskforce-working-context  ← 每步钉一行客观状态
  taskforce-guard            ← 运行时退化断路器
  taskforce-orchestrator-scope ← 只收窄主会话，子代理不受影响
```

**为什么 store 在 host 平面**：preset 是 standing mount、被 roster 挂一次而覆盖每个 join 上来的 agent；preset 内任何 `provide()` 服务的行**必须**位于带 `isolate` 的 group 内，否则 `mountPreset` 直接抛 `Preset services require isolate realms`。跨会话服务按 registry 要求落在 host。

## 与 redteam 的刻意差异

操作员决定"子代理侧限制不照搬 redteam"，已落实为：

| 项 | redteam | 任务部队 |
|---|---|---|
| 子代理层级 | `maxDepth: 1`（叶子） | **`maxDepth: 2`**（可再派一层） |
| 委派工具可见性 | `toolFilter.deny [subagent_fork, workflow, ralph]` | **零 deny** |
| 并发 | 自建闸门压到 3、默认顺序派 | **只读并行 ≤6 / 含写压到 2–3 / 同资源串行** |

> 数值依据（**经独立审计校准**）：Anthropic 的「3–5」是其 Research 系统在**复杂研究任务**上的配置经验，**没有并发扫参证据**，不构成"最优区间"；Claude Code 的「20 / 默认 3 层」属**那个产品的版本相关规则**，不能当 DSH 参数依据。原生 DSH 0.2 默认委派深度为 1；本包为 spawn 和 fork 都显式指定 2，不依赖第三方宿主补丁。

## 事实库：跨子代理唯一的持久通道

三条原生通道里，派活只保证"已启动"、消息只保证"已接受"、结算通知只投一次 —— **只有共享状态是持久的**。

- 位置：`$DSH_HOME/taskforce/taskforce.db`（`config.root` > `$TASKFORCE_HOME` > `$DSH_HOME/taskforce` > `$HOME/.dsh/taskforce`）
- 表：`task` / `fact`（kind ∈ fact,artifact,decision,blocker；confidence ∈ CONFIRMED,PLAUSIBLE,REFUTED）/ `handoff` + 视图 `v_task_board`
- 服务 API（`ctx.taskforceStore`）：`openTask` / `claimTask` / `recordFact` / `recordHandoff` / `closeTask` / `submitTask` / `acceptTask` / `rejectTask` / `taskOf` / `board` / `stats`
- 模型可见工具（**10 个**）：`task_open` / `task_claim` / `task_fact` / `task_submit` / `task_accept` / `task_reject` / `task_close`（`submit` 的兼容别名）/ `task_board` / **`task_child_send`** / **`task_child_stop`**
- DSH 0.2 的原生 `send_message` / `interrupt_agent` 已接入子代理。本包的 `task_child_send` / `task_child_stop` 继续提供直属归属核对和状态回执。详见 [控制契约](docs/CONTROL.md)。

**状态机与验收门槛**（`docs/STORE.md` 有完整的状态 × 动作表）

`open → claimed → submitted → accepted`，另有 `rejected`；终态 = `accepted` / `cancelled` / `done` / `partial` / `failed`。

- **执行者不能自批**：子代理只能 `task_submit`（提交待验收）；**只有主会话**能 `task_accept` / `task_reject`（身份判据在工具层强制，不靠提示词）
- **验收要有执行依据**：没有任何证据事实时 `task_accept` **被拒**（`E_EVIDENCE_MISSING`，不是 warning）；自动写入的验收记录是 `decision` + `PLAUSIBLE`，**不会**冒充 `CONFIRMED` 事实。合法的人工豁免走 `waiver_reason`，来源可辨
- **驳回后换人**：主控可对 `rejected` 任务重新 `task_claim` 指定新执行者；owner、decision 与 handoff 原子写入，子代理不能借模型参数获得换人权限。
- **终态冻结**：已验收的任务不能被旧子代理改写（`close(failed)` 先查原状态，对终态一律 `E_TERMINAL`）
- **晚到结果不改写结论**：终态任务上的 `blocker` 允许落库并标 `late=true`，任务**出现在看板的 `late_blockers` 区**（不静默隐藏），但结论不变；要推翻已验收结论，走显式**重新复核**（主会话 `task_reject`，任务回到待办）
- 未解 blocker 会**阻止** `accept`；解阻塞 = 落一条 `decision` 且带 `resolves_fact_id` 指向它
- **跨 run 隔离有具名码**：别的**工作实例**的任务读不到也写不了，返回 `E_CROSS_RUN`（读 / 落事实 / 结任务三条路径共用同一拒绝点，文案点名双方 run）。注意区分：跨会话操作**别人的子代理**是子代理平面的 `E_CHILD_NOT_OWN`，两码不合并

**落库契约**：子代理的交付物是**库里的行**，不是它说的话。主会话核对 = 读 `task_board` 并对证据文件，不是复述汇报。

## 上下文纪律三件

- **`taskforce-working-context`**：每步把一行客观状态钉在最新消息尾部，**从持久事件流折叠**（resume / 压缩后结果一致），只在变化时重发布。
- **`taskforce-guard`**：支持原生与 PTC 内层事件，外层 `run_code` 成功不会抹掉内层的连续失败。运行时退化断路器。两个信号 —— **STALL**（连续零输出长推理）与 **ECHO**（同工具同参数连续失败）—— 触发时注入熔断消息并把 reasoning effort 临时降一档，窗口耗尽自动恢复。**无信号时绝不改写任何请求**（保 prefix cache 与用户的显式选择）。
- **`taskforce-orchestrator-scope`**：用 `restrict` 收窄可见性、用 `guard` 拒绝真实执行，默认拦截 `run_code`、写工具和宿主变更入口；保留传输名不交给 `restrict`，**只读与派活类保留**；判据是会话身份（`origin === 'subagent'` / `delegationDepth`），**子代理不被收窄**。

> `guard` 的存在理由（梁神源码自陈）：persona 的熔断纪律**停不住**退化，因为"在那个状态下，纪律文本本身已经掉出有效上下文。唯一有效的是**外部力量**"。

## 自测

```bash
npm test                       # 六套独立脚本 + 八个 node:test 文件；宿主标 UNVERIFIED
npm run test:integration        # 从 PATH 的真实 dsh 安装发现宿主
npm run test:all                # 离线与真实宿主都必须通过
npm run test:all -- --install-anchor /path/to/@deepseek-ai/dsh/package.json
node tools/verify-preset.mjs [profileDir] --install-dir /path/to/node_modules
```

显式路径缺失时失败，不回落到其他安装。预设检查使用 DSH 自己的 profile 解析和 Cordis Config 校验；完整宿主检查创建隔离的 `DSH_HOME`，只监听回环地址的临时端口，验证 roster、真实工具闭环、主子权限和插件生命周期，随后关闭并清理。`--profile-dir` 保留为指定 profile 的预设检查入口；完整 boot 始终使用隔离 profile，不重启现有实例。

CI 包含 Node 22.23.2 / 24.19.0 的离线任务，以及固定 DSH `0.2.0-rc.2` 的真实宿主任务。验收步骤与边界见 [可靠性说明](docs/RELIABILITY.md)，本次实测见 [0.2 验收记录](docs/superpowers/research/2026-09-30-dsh-0.2-acceptance.md)。

## 已知限制

1. 新增 bundle 需在目标实例重新加载配置或重启后生效；本次验收使用独立临时实例。
2. run 隔离在服务接口层：有文件执行权限的子代理仍可直接访问同一 SQLite 文件。默认保留现有 journal 模式，可按部署需要启用 WAL。
3. 主控的只读核对范围取决于宿主允许的路径；执行守卫覆盖默认拒绝清单，部署修改清单会改变边界。
4. `task_board` 对不存在的任务返回明确错误。工具编译器优先采用原生 `defineTool`，离线环境有等价兜底。
5. 本次原生验收不发送模型请求；外部模型、真实长时委派与高并发负载尚未做端到端验收。持久调度器与自动化仍是后续阶段的设计，不属于本次实现。

## 借鉴与致谢

- 编排骨架：`dsh-redteam-mode`（github.com/Jueze-2019）—— 主会话只指挥、事实落库、汇报节流。
- 上下文经济与退化熔断：`@linxin666/dsh-liangshen`（MIT）—— 本包的 `working-context` / `guard` / 工具面策略为**机制照搬、代码自研**。
- preset 声明范式：bundle 插件在激活时读取包内定义并交给 `ctx.agentPresets.register`，**不往 harness home 写任何文件**（旧式 `$DSH_HOME/.agent-presets/` 目录在当前 DSH 已无人读取）。
