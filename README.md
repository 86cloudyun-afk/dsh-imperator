# DSH IMPERATOR

> ### *He who speaks — and legions march.*

**dsh指挥官** · 主会话统御决策，子代理军团执行 · 版本 `0.2.1`；验收目标为官方 DSH `0.2.0-rc.2`，Node 22/24。

一个 DeepSeek Harness 的 **agent preset**（附带 host 插件）：主会话亲自做只读调查、方案比较、决策和验收，子代理负责有边界的执行任务。优先复用已有执行者，不再为每个信息缺口新建代理；写文件、命令执行和宿主变更的限制保持不变。

详见 [研究型编排与思考保护](docs/ORCHESTRATION.md)：当前包含派发前决策、任务合并、复用与独立审查纪律、软预算，以及 STALL 观察模式；**不代表阶段 B 的全树硬调度额度已经实现**。

## 两个正交的问题，一次解决

| 层 | 学自 | 管什么 |
|---|---|---|
| **编排层** | `dsh-redteam-mode`（github.com/Jueze-2019） | 谁派活、派给谁、并发、事实落库、核对纪律 |
| **注意力层** | 梁神模式 `@linxin666/dsh-liangshen`（MIT） | 工具面多大、系统提示词多长、事实钉在哪、退化如何熔断 |

redteam 解决"**谁干活**"，梁神解决"**干活时脑子还清不清醒**"。两者叠加才是长任务多 agent 的完整形态。

## 四个支柱

1. **主会话负责研究与决策** —— 用获准的只读工具亲自查证；`orchestrator-scope` 的工具过滤和执行守卫继续阻止命令、写入及宿主变更。
2. **保持接收态** —— 派活走 `continuable`：工具**只返回 childId 不返回结果**；子代理结算由 runtime 作为**服务通知**投进父会话 turn stream。所以主会话天然不阻塞，且能在干别的活时收到结果。
3. **按需委派、优先复用** —— 执行任务按可验收产物组织，续作与补证据优先交给原执行者；独立复核聚焦变更和风险，不默认全量重做。
4. **保护有效思考** —— 切片、外化、机械校验；默认仅观察 STALL，保留 ECHO 重复失败保护，不自动降低推理档位。

## 架构：双平面

```
host 平面（cordis.patch.yml）
  taskforce        → lib/index.js    声明 agent preset 给 ctx.agentPresets.register
  taskforce-store  → lib/store/      SQLite 事实库，发布 ctx.taskforceStore
agent 平面（lib/preset.js 的 29 行）
  persona                   编排者人设（本 preset 的全部系统提示词基底）
  tool-presentation         native（执行守卫独立于呈现模式）
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
| 子代理层级 | `maxDepth: 1`（叶子） | **`maxDepth: 2`**（保留能力，默认不主动嵌套） |
| 委派工具可见性 | `toolFilter.deny [subagent_fork, workflow, ralph]` | **零 deny** |
| 并发 | 自建闸门压到 3、默认顺序派 | **纪律上限：只读 ≤6 / 含写默认 ≤2 / 同资源串行；不是已实现的硬闸门** |

> 并发值是可调整的编排纪律，不是经过负载实验得出的最优值。spawn/fork 都显式指定最大深度 2，不依赖第三方宿主补丁。

## 事实库：跨子代理唯一的持久通道

三条原生通道里，派活只保证"已启动"、消息只保证"已接受"、结算通知只投一次 —— **只有共享状态是持久的**。

- 位置：`$DSH_HOME/taskforce/taskforce.db`（`config.root` > `$TASKFORCE_HOME` > `$DSH_HOME/taskforce` > `$HOME/.dsh/taskforce`）
- 表：`task` / `fact`（kind ∈ fact,artifact,decision,blocker；confidence ∈ CONFIRMED,PLAUSIBLE,REFUTED）/ `handoff` + 视图 `v_task_board`
- 服务 API（`ctx.taskforceStore`）：`openTask` / `claimTask` / `recordFact` / `recordHandoff` / `closeTask` / `submitTask` / `acceptTask` / `rejectTask` / `taskOf` / `board` / `stats` / `workingState`
- 模型可见工具（**10 个**）：`task_open` / `task_claim` / `task_fact` / `task_submit` / `task_accept` / `task_reject` / `task_close`（`submit` 的兼容别名）/ `task_board` / **`task_child_send`** / **`task_child_stop`**
- DSH 0.2 原生控制工具也支持子代理；本包优先使用带直属归属核对与稳定回执的 `task_child_send` / `task_child_stop`，见 `docs/CONTROL.md`。

**状态机与验收门槛**（`docs/STORE.md` 有完整的状态 × 动作表）

`open → claimed → submitted → accepted`，另有 `rejected`；终态 = `accepted` / `cancelled` / `done` / `partial` / `failed`。

- **执行者不能自批**：子代理只能 `task_submit`（提交待验收）；**只有主会话**能 `task_accept` / `task_reject`（身份判据在工具层强制，不靠提示词）
- **验收要有执行依据**：没有任何证据事实时 `task_accept` **被拒**（`E_EVIDENCE_MISSING`，不是 warning）；自动写入的验收记录是 `decision` + `PLAUSIBLE`，**不会**冒充 `CONFIRMED` 事实。合法的人工豁免走 `waiver_reason`，来源可辨
- **驳回后可审计换人**：仅主会话可对 `rejected` 任务更换 owner；状态、decision 与 handoff 同事务写入。
- **终态冻结**：已验收的任务不能被旧子代理改写（`close(failed)` 先查原状态，对终态一律 `E_TERMINAL`）
- **晚到结果不改写结论**：终态任务上的 `blocker` 允许落库并标 `late=true`，任务**出现在看板的 `late_blockers` 区**（不静默隐藏），但结论不变；要推翻已验收结论，走显式**重新复核**（主会话 `task_reject`，任务回到待办）
- 未解 blocker 会**阻止** `accept`；解阻塞 = 落一条 `decision` 且带 `resolves_fact_id` 指向它
- **跨 run 隔离有具名码**：别的**工作实例**的任务读不到也写不了，返回 `E_CROSS_RUN`（读 / 落事实 / 结任务三条路径共用同一拒绝点，文案点名双方 run）。注意区分：跨会话操作**别人的子代理**是子代理平面的 `E_CHILD_NOT_OWN`，两码不合并

**落库契约**：子代理的交付物是**库里的行**，不是它说的话。主会话核对 = 读 `task_board` 并对证据文件，不是复述汇报。

## 上下文纪律三件

- **`taskforce-working-context`**：每步把一行客观状态钉在最新消息尾部，**从持久事件流折叠**（resume / 压缩后结果一致），只在变化时重发布。
- **`taskforce-guard`**：区分 **STALL**（零输出长推理的启发式信号）与 **ECHO**（同工具同参数连续失败）。本 preset 显式设置 `stallAction: 'observe'`、`stepDownRequests: 0`：STALL 只记录诊断、不注入打断消息；ECHO 仍提示停止重复失败调用；两者都不降低路由选定的 reasoning effort。独立使用 guard 且不提供新配置时，保留旧版打断与降档默认值。
- **`taskforce-orchestrator-scope`**：可见性过滤与执行守卫分开，主控在 native 和 PTC/both 下均拒绝 `run_code`、命令、写工具及默认宿主变更入口；子代理保留执行权限。

> 推理长度和没有可见输出不能证明思考无效。观察模式保护正常研究，但也不自动终止真实的零输出循环；宿主的超时、取消和预算控制仍然必要。

## 整仓可靠性补强

见 [整仓补强与验收边界](docs/PROJECT_HARDENING.md)：事实与任务双重归属过滤、异常验收保护、回滚失败的连接清理、单查询工作投影、派发估计去重和超时判定。CI 保留与实际检出版本绑定的源码及日志验证包 7 天；不是部署记录或真实模型效果报告。

## 交付与自测

安装包包含源码、文档和完整验证脚本；CI 解压实际 npm 归档后再进行真实宿主验收。
详见 [安装、验证与回滚](docs/DELIVERY.md)。

```bash
npm test
npm run test:all -- --install-anchor /absolute/path/to/@deepseek-ai/dsh/package.json
```

不传 anchor 时可从 PATH 的 dsh 安装发现；显式路径错误时不会悄悄回退。
`npm test` 中的宿主 UNVERIFIED 和仅宿主用例 SKIP 不算原生通过；`test:all` 要求预设契约、原生边界、真实 web boot 和 standard/TaskForce 切换隔离均成功。

### 端到端实挂（隔离 DSH_HOME，不碰现有实例）

在仓库根目录执行，原生验收需官方 DSH `0.2.0-rc.2` + Node 22。子 shell 保留调用者环境，退出时只清理本次创建并验证的临时目录；全程使用临时 `DSH_HOME`，不发模型请求、不需要 API key。

```bash
(
set -euo pipefail
# 1. 先创建并验证本次专用目录，再打包；任一步失败立即中止
SMOKE_PARENT="$(cd "${TMPDIR:-/tmp}" && pwd -P)" || exit 1
SMOKE_ROOT="$(mktemp -d "$SMOKE_PARENT/dsh-taskforce-smoke.XXXXXXXX")" || exit 1
SMOKE_NAME="${SMOKE_ROOT##*/}"
case "$SMOKE_NAME" in dsh-taskforce-smoke.????????) ;; *) exit 1 ;; esac
[ "$SMOKE_ROOT" = "$SMOKE_PARENT/$SMOKE_NAME" ] && [ -d "$SMOKE_ROOT" ] && [ ! -L "$SMOKE_ROOT" ] || exit 1
readonly SMOKE_ROOT
cleanup() { rm -rf -- "$SMOKE_ROOT"; }
trap cleanup EXIT
PACK_NAME="$(npm pack --ignore-scripts --pack-destination "$SMOKE_ROOT")" || exit 1
case "$PACK_NAME" in ''|.*|*[!A-Za-z0-9._-]*) exit 1 ;; esac
case "$PACK_NAME" in *.tgz) ;; *) exit 1 ;; esac
TGZ="$SMOKE_ROOT/$PACK_NAME"
[ -f "$TGZ" ] && [ ! -L "$TGZ" ] || exit 1

# 2. 装进临时 DSH_HOME 的 web profile（首次会自动初始化该 profile）
export DSH_HOME="$SMOKE_ROOT/home" DSH_TELEMETRY_DISABLED=1
mkdir "$DSH_HOME"
dsh plugin --profile web add "$TGZ"
dsh --profile web --dump-config | grep taskforce   # 应出现 taskforce 与 taskforce-store 两行

# 3. 回环试挂：日志应出现 [taskforce] preset "taskforce" declared (21 rows)，
#    且无 failed to import / activate；确认后 Ctrl-C 停止试挂并继续验收
trap ':' INT
dsh --profile web --host 127.0.0.1 --port 0 --no-open || [ "$?" -eq 130 ]

# 4. 全量原生验收（自建并清理自己的临时 home）；anchor 取自 PATH 上的 dsh
ANCHOR="$(dirname "$(dirname "$(realpath "$(command -v dsh)")")")/package.json"
npm run test:all -- --install-anchor "$ANCHOR"     # 须见 HOST_VERIFIED 与 ISOLATION_VERIFIED
)
```

`21 rows` 是预设顶层行数；`verify-preset` 报告的 `29 rows` 含嵌套 group 内的行，两者不矛盾。生产实例的安装、备份与回滚仍按 [DELIVERY.md](docs/DELIVERY.md) 执行。

## 已知边界

读取快照、证据归属与验收约束已保留；默认 STALL 仅观察、不降档。ECHO 统一按调用发起顺序判断，旧成功不能清空新失败；native/PTC 的调用 ID 按所属 turn/step 区分，外层传输成功不代替内层工具成功。派发计数保留全部尝试与失败回执，未结算估计会扣除失败，不冒充实际存活代理数。

服务层 run 隔离不是文件系统隔离；有文件权限的执行者仍可能直接读取共享 SQLite 文件。完整看板仍随任务数增长；未实现阶段 B/C 的全树硬额度和自动化调度器。隔离宿主验收不发送模型请求，不能替代真实模型、长期并发、费用或目标生产实例验收。安装包不会自动修改正在运行的 DSH，也不会自动重启它。

## 借鉴与致谢

- 编排骨架：`dsh-redteam-mode`（github.com/Jueze-2019）—— 主会话只指挥、事实落库、汇报节流。
- 上下文经济与退化熔断：`@linxin666/dsh-liangshen`（MIT）—— 本包的 `working-context` / `guard` / 工具面策略为**机制照搬、代码自研**。
- preset 声明范式：bundle 插件在激活时读取包内定义并交给 `ctx.agentPresets.register`，**不往 harness home 写任何文件**（旧式 `$DSH_HOME/.agent-presets/` 目录在当前 DSH 已无人读取）。

### 模式隔离（0.2.1）

TaskForce 只作用于选择该预设的会话。切换回 standard/minimal 时撤销本插件自己的 guard/restrict；不会删除宿主或其他插件的安全限制。新建、并存、反复切换、持久恢复及预设重载由原生隔离验收覆盖。详见 `docs/PRESET_ISOLATION.md`。

## 命名

| 层 | 名称 | 状态 |
|---|---|---|
| 项目对外名 | **dsh指挥官** / *DSH Imperator* | 本仓库发布名 |
| 包名 | `@local/dsh-taskforce` | **固定** —— profile 的 `link:` 依赖与 CI 的 `npm pack` 产物名直接引用 |
| preset 标识符 | `taskforce` | **固定** —— 被用户配置、`ctx.agentPresets.register` 与三套验证脚本引用 |
| preset 显示名 / persona 自称 | `任务部队` | **固定** —— `lib/preset.js` 与运行时状态行使用，`verify-isolation` / `verify-p3` 对其有硬断言 |
| 事实库路径 | `$DSH_HOME/taskforce/taskforce.db` | **固定** —— 既有数据所在 |

改名只作用于发布门面（仓库名、README 标题、包描述）。技术标识符与运行时可观测字符串一律不动——它们是既有部署、CI 与验收契约的一部分，改动会打断正在运行的宿主。
