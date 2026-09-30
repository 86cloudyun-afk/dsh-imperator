# 任务部队 · P3 上下文纪律三件（一页说明）

三个 preset-local 插件，零依赖、零构建、纯 ESM。全部只监听宿主事件，**不 `provide()` 任何服务**
（那会要求 isolate realm，而它们不在 group 里）。

| 文件 | Cordis name | 干什么 |
|---|---|---|
| `lib/plugins/working-context.mjs` | `taskforce-working-context` | 每步在最新消息尾部钉一行客观状态，只在变化时重发布 |
| `lib/plugins/guard.mjs` | `taskforce-guard` | 运行时退化断路器：STALL / ECHO 触发 → 熔断消息 + 档位临时降一档 |
| `lib/plugins/orchestrator-scope.mjs` | `taskforce-orchestrator-scope` | 主会话工具面收窄：遮蔽执行/写类，子代理不受影响 |

数据源纪律：三件的信号**全部从持久会话事件流折叠**，不读进程内存 —— resume / reload / 压缩后
折叠出同一结论。事件回放一律双形态（`session.events` 数组 **或** `session.snapshotEvents()`）。

---

## 1. `orchestrator-scope` — deny / keep 清单与名字来源

**施加方式**：`agent.ctx.tools.restrict({ deny })` 收窄可见性，`agent.ctx.tools.guard()` 按真实调用者拒绝执行。预设显式选择 native 呈现。
契约原话（`cordis_inspect_query(host, Service, listService{service:"tools"})` 实测）：

> `restrict(filter: ToolRestriction): () => void` —— *"Restrict global tools for the calling agent
> scope. Empty filters, unknown names, scope-local names, and reserved transport names fail.
> Restrictions intersect; scoped registrations remain visible."*

模式匹配那条路走不通：`pagedToolPatterns` 的语义是「字面前缀 + 恰好一个结尾 `*`，且去前缀后必须
还剩内容」，是为 `mcp__server__fn` 族名设计的；对 `bash` 这种扁平名写 `bash*` 会让 `rest` 为空 →
被判定为常驻，**根本扣不掉**。

### 标准执行工具与保留传输

| 工具名 | 名字来源（本机实测） |
|---|---|
| `run_code` | DSH PTC 保留传输；可直接 import Node fs/subprocess，因此只交给 guard 拒绝，不交给 restrict |
| `bash` | `@deepseek-ai/dsh-tool-bash/lib/index.js` → `name: "bash"` |
| `write` | `@deepseek-ai/dsh-tool-fs/lib/` → `name: "write"` |
| `edit` | `@deepseek-ai/dsh-tool-fs/lib/` → `name: "edit"` |
| `str_replace_editor` | `@deepseek-ai/dsh-tool-str-replace-editor/lib/index.js` → `name: "str_replace_editor"` |

交叉验证：`cordis_inspect_query(host, Tool, listTools)`（本机实际可调工具面）确认上述名字均为
**独立扁平名**，非族名；`dsh-tool-fs` 一个包同时提供只读的 `read` / `read_image` 与可写的
`write` / `edit`，所以遮蔽必须逐名列举，不能整包屏蔽。

默认拒绝清单还包含插件安装/移除/更新、purge 和 spawn_teammate 等宿主变更入口，详见 `DEFAULT_DENY`。

### 保留（keep，主会话仍可用）

- 只读核对类：`read`、`read_image`、`glob`、`grep` —— 主会话要靠它们核对子代理战果。
- 派活/联络类：`subagent`、`subagent_fork`、`send_message`、`list_agents`、`interrupt_agent`。
- 非执行类：`todo_write`、`skill`、`web_search`、`web_fetch`、`ask_user_question`、goal 三件、jobs 三件。

### 身份判据（子代理一律跳过，不加任何限制）

`agent.session.header` 上任一条命中即视为子代理。类型来源
`@deepseek-ai/dsh-session/lib/types/types.d.ts:58-98`：

- `origin === 'subagent'`（子代理产品的粗分类）
- `delegationDepth > 0`（顶层缺省、子代理 = 父 + 1，落盘以便重启后预算不重置）

`parentSession` 单独存在不证明是子代理；手工 fork 的主会话仍受限制。

### 容错（`restrict` 对不存在的名字会抛错）

三层：① **先读后写** —— `tools.schemas(agent)` 读该 scope 当前可见的工具名，与 deny 求交，
只把确实存在的名字交给 `restrict`（未知名根本不进去，整批就不会因一个名字全盘失败）；
② **空过滤器绝不提交**（`{deny: []}` 会抛）；③ **`try/catch` + 一次性告警** —— 注册表仍拒绝时
限制就是不生效，绝不炸掉会话。工具面未就绪（`schemas()` 为空）时不标记完成，留给后续
`agent/pre-step` 持续幂等复核，不永久放弃；执行 guard 不依赖工具面快照。

**无条件施加**：刻意不照抄梁神「只在 `presentation === 'ptc'` 时才装限制」的闸门
（`tool-catalog.mjs:652`）—— 那条闸门在出厂 `presentation: 'both'` 下永不触发，被扣留的工具在
`run_code` 程序里仍可达（漏隐藏）。

---

## 2. `guard` — 阈值与默认值

| 常量 | 值 | 说明 |
|---|---|---|
| `DEFAULT_STALL_STEPS` | `1` | 单步梯：一步爆字符下限且零输出即触发（该步须**同时**满足"个体巨大"且"零输出"） |
| `STALL_REASONING_CHARS_BY_EFFORT` | `{max:8000, high:12000, low:20000}` | 按请求**当前**档位自适应 |
| `DEFAULT_STALL_REASONING_CHARS` | `12000` | 未知档位（数字档 / `off`） |
| `GLOBAL_MIN_REASONING_CHARS` | `200` | 慢烧梯计入门槛 |
| `DEFAULT_GLOBAL_STALL_CAP` | `4` | 慢烧梯：连续零输出推理步上限 |
| `DEFAULT_ECHO_FAILURES` | `3` | 同参同工具连续失败 |
| `SENSITIVITY_SCALE` | `{conservative:1.5, balanced:1.0, aggressive:0.5}` | 整表缩放，下限钳制 200 / 2 / 2 |
| `DEFAULT_SENSITIVITY` | **`conservative`** | ← **与梁神（`balanced`）的刻意分歧** |
| `DEFAULT_STEP_DOWN_REQUESTS` | `3` | 档位下调持续的请求数 |
| `DEFAULT_REFIRE_COOLDOWN_STEPS` | `5` | 触发后静默步数 |
| `EFFORT_LADDER` | `['max','high','low']` | 只沿这条梯下调，其它档位不动 |

**为什么默认保守**：误断一次真实的长思考，比漏报一次空转更贵 —— 前者会让模型丢掉已经推进到
一半的推理链。默认下 `effort=max` 的实际阈值是 `{stallReasoningChars:12000, globalStallCap:6,
echoFailures:5}`（自测实测）。要更早介入的操作员显式改成 `balanced` / `aggressive`。

**PTC 兼容**：按 `subCallId` 配对内层 start/dispatch；重复内层失败可触发 ECHO，成功的外层 run_code 不清空该链。没有内层派发的传输语法/执行失败仍按普通调用折叠。

**无信号时绝不改写请求**：唯一被改的字段是 `reasoningEffort`（请求参数，不是提示词内容），
所以 prefix cache 的唯一键面不受影响，用户显式选择的档位也不会被静默覆盖。信号本身每步从
持久事件流重新折叠，所以 resume 不会继承过期判定。

**每个 episode 只 fire 一次**：冷却期（默认 5 步）内不再注入；档位下调窗口（默认 3 次请求）
耗尽后自动回落到路由自己的档位。

---

## 3. `working-context` — 字段与降级口径

行形态（字段按可用性出现，空则整行不注入）：

```
[任务部队: 波次 3 · 在飞 2 · 当前任务 #7 "重构解析器" · 最近事实 3 条]
```

| 字段 | 数据源 | 降级口径 |
|---|---|---|
| `波次 N` | 外部事实库（**当前 store 无此概念 ⇒ 字段省略**；将来 store 提供 `wave` 会自动接上） | 无 ⇒ 整个字段省略 |
| `在飞 N` | **不来自 store** —— store 的任务 ≠ 子代理，硬映射会撒谎 | 事件折叠：原生与 PTC 派发数 − 终结数（下限 0） |
| `当前任务 …` | 外部事实库：`board().tasks` 里 `claimed` 优先、否则队首（带 id 才有 `#id`） | 最新 `todo/write` 的 in_progress 标题，被下一条 `turn/start` 清空 |
| `最近事实 N 条` | 外部事实库：`stats().facts.total` | 已终结的派活数（= 本会话回收了多少份子代理产物） |

### 外部事实库的真实契约（已对齐，非猜测）

来源：本包 `lib/store/index.js` 的 `TaskforceStore`（**实测跑通**，见 §5 的 I 段端到端）：

- `stats()` → `{ tasks:{total,open,claimed,done,partial,failed}, facts:{total,by_kind,by_confidence}, blockers_open }`
- `board()`（无参）→ `{ scope:'open', open_tasks, tasks:[{id,title,status,owner,fact_count,…}] }`，**只含未结任务**

映射只取语义明确持有的东西：事实条数 ← `stats().facts.total`；当前任务 ← `board().tasks` 的
`claimed` 优先项。`stats()` 另给的 `open+claimed` 也读出来放在返回对象的 `activeTasks` 里备用，
但**不渲染**（避免把行撑长）。

在 preset-local 插件里通过 `ctx.get('taskforceStore')` 读取 —— 三个插件都**不** `inject` 它，
所以事实库缺席时行照常渲染（该字段走降级），不会阻塞激活。

### 派活/终结的折叠（有前提，必须显式选通道）

两种派活模式留下的完成信号**完全不同**，所以做成了 config（默认值匹配本 preset）：

- `settlementChannel: 'settled-notice'`（**默认**）：终结 = `user/message` 且
  `source.kind === 'subagent-settled'` 的条数。这条消息由
  `@deepseek-ai/dsh-subagent/lib/index.js:647-652` 的 `createSettlementMessage(childId, terminal)`
  写出 —— 是 **continuation-managed（continuable）专属**的送达通知，**持久 user 消息**。
  本 preset 的两份派活工具（`subagent` / `subagent_fork`）都配了
  `backgroundMode: 'continuable'`，所以默认值正确。
- `settlementChannel: 'tool-result'`：终结 = 派活调用各自收到的 `tool/result` 数
  （按 `callId` 与派活调用配对）。用于 one-shot（block）部署 —— 那里没有结算通知。

选错的后果是单向的：用 `'settled-notice'` 跑 one-shot 会让"在飞"永久偏高；反过来会恒为 0。
接上外部 store 时 store 值优先，直接绕开这个选择。
（**不要**用 `subagent/start` / `subagent/end` —— 它们是进程内 emit 事件，不是持久会话事件。）

### 发布/去重纪律（最易错的一点）

只看"内容变没变"会在压缩后**永久丢失**这一行。正确判据是"**已发布副本是否还在可见面**"：

1. 内容未变、且已发布副本仍可见 ⇒ 撤掉**本步**副本，保留历史副本（不每步复制）。
2. 内容未变、但已发布副本**被压缩遮蔽** ⇒ 重新发布（`session.surface.nodes` 里已无该 `seq`）。
3. 内容变化 ⇒ 替换。
4. 无字段可说 ⇒ 不注入；已有旧行留给压缩自然老化，不写空标记。

外部 store 走 `ctx.get('taskforceStore')`（config 键 `storeService`）**可选读取**：取不到、
形状不对、抛错 —— 一律降级到事件折叠，绝不报错、绝不等待。字段别名宽松匹配
（`wave`/`waveNumber`、`inFlight`/`inFlightCount`、`task`/`currentTask`、`facts`/`factCount`）。

---

## 4. 接线状态

**已由主会话接线**（`lib/preset.js` 现在的写法，与下面给出的形式一致）：

```js
/** 行名必须绝对化：registry 按「声明者的 base」解析，相对名会在包外 404。 */
const pluginUrl = (file) => new URL(`./plugins/${file}`, import.meta.url).href
// ...
    { id: 'taskforce-working-context', name: pluginUrl('working-context.mjs') },
    { id: 'taskforce-guard', name: pluginUrl('guard.mjs') },
    { id: 'taskforce-orchestrator-scope', name: pluginUrl('orchestrator-scope.mjs') },
```

等价写法（若不用 helper）：

```js
{ id: 'taskforce-guard', name: new URL('./plugins/guard.mjs', import.meta.url).href },
```

**为什么必须用 file URL 绝对化**：registry 在 `scope.ctx.extend({ baseUrl: record.context.baseUrl })`
下挂载预设，行名是相对**声明者**的 base 解析的 —— 直接写 `'./plugins/guard.mjs'` 会去包外找文件。
`lib/preset.js` 在 `lib/` 下、三个文件在 `lib/plugins/` 下，所以相对路径是 `./plugins/x.mjs`。
（`package.json` 的 `files` 已含 `lib`，`lib/plugins/` 随之入包，无需改动。）

三项都**不** `provide()` 服务，所以不需要 `isolate` realm，也不能放进 group 的 isolate 里。
`tools/verify-p3.mjs` 的 H 段会用这条 URL 形式解析文件，确保它落到真实路径。

### 可选 config 一览

| 插件 | 键 | 默认 | 语义 |
|---|---|---|---|
| working-context | `delegationTools` | `['subagent','subagent_fork']` | 派活工具名（与本 preset 的 `toolName` 对应） |
| working-context | `settlementChannel` | `'settled-notice'` | 终结通道；one-shot 部署改 `'tool-result'` |
| working-context | `storeService` | `'taskforceStore'` | 外部事实库服务键 |
| guard | `enabled` | `true` | 关闭时**零监听器** |
| guard | `sensitivity` | `'conservative'` | `conservative` / `balanced` / `aggressive` |
| guard | `stallSteps` | `1` | 单步梯步数 |
| guard | `stallReasoningChars` | 未设（走自适应表） | 一旦显式设置即覆盖自适应表，下限 200 |
| guard | `globalStallCap` | 未设（走表，默认 4） | 下限 2 |
| guard | `echoFailures` | 未设（走表，默认 3） | 下限 2 |
| guard | `stepDownRequests` | `3` | 档位下调窗口 |
| guard | `refireCooldownSteps` | `5` | 触发后静默步数 |
| orchestrator-scope | `deny`（别名 `denyForMainSession`） | `DEFAULT_DENY` | 主会话遮蔽清单；空数组 = 不注册任何监听器 |

---

## 5. 自测

```bash
cd packages/dsh-taskforce && node tools/verify-p3.mjs
```

覆盖：导出面、STALL/ECHO 正反例、灵敏度默认值、身份判定、求交容错、行渲染、**压缩后重发纪律**、
**真实事实库端到端**（临时库 → `openTask`/`claimTask`/`recordFact` → 行渲染）、接线 URL 解析，
以及两个集成冒烟（真注册表拒绝/未知名容错/子代理不被动；熔断只 fire 一次 / 档位降一档 /
窗口耗尽自动恢复）。当前 **80 项全通过**。

---

## 6. 已知边界（未决项）

1. DSH 0.2 的真实 boot 与 Agent 工厂已经验证首次请求前的主控收窄；晚注册/降级仍由 guard 与每步复核兜底。
2. one-shot 部署需把 `settlementChannel` 改成 `'tool-result'`；本预设默认使用 continuable 结算通知。
3. PTC 未结算 start 计为未决；失败或取消不证明子代理已创建，成功结算按 `subCallId` 去重。在飞数仍是提示性近似，不是调度器账本。
4. 三个插件已在真实 DSH `0.2.0-rc.2` 中加载并通过 roster、工具与生命周期检查，见 [验收记录](superpowers/research/2026-09-30-dsh-0.2-acceptance.md)。
5. 行里暂不渲染未结任务总数；当前任务和事实计数仍从同一 run 的 store 读取。
