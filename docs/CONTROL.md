# 子代理控制工具（task_child_send / task_child_stop）

> 作用：把「**续作 / 停止本会话派出的子代理**」这件事，从**靠同名工具凑**改成**直接接原生生命周期服务**。
> 版本：0.2.0 · 2026-09-30 · 实现 `lib/tools/index.js` · 自测 `tools/verify-child-control.mjs`

## 1. DSH 0.2 的控制入口

在 DSH `0.2.0-rc.2` 中，原生 `@deepseek-ai/dsh-tool-subagent-control` 的
`send_message` / `interrupt_agent` 已分别调用 `subagents.sendMessage` / `subagents.interrupt`。
旧部署记录的 teammate 接口错配不能作为当前原生宿主的结论。

本包的 `task_child_send` / `task_child_stop` 继续直接调用同一生命周期服务，
额外核对 `listChildren(调用者会话)` 的直属归属，并返回当前轮状态和稳定错误码。
主控 persona 优先推荐这两个入口，不再声称原生控制工具只能操作 teammate。

## 2. 工具契约

### `task_child_send` —— 续作（把新要求发给子代理）

| 参数 | 必填 | 说明 |
|---|---|---|
| `target_id` | 是 | 目标子代理的 sessionId（派发返回的 `childId`） |
| `message` | 是 | **模型撰写的新指令全文**（改要求 / 补边界 / 纠正方向），不是 id、不是占位符 |
| `request_key` | 否 | 原操作的重试键，最多 256 UTF-8 字节；显式提供时必须有可用恢复日志 |

成功返回（紧凑 JSON）：

```
{ ok: true,
  sent:   { target_id, message_id, chars },
  caller_session, caller_role,
  target: { id, mode, label, current_turn, activity_before },
  delivery: "accepted（消息已被目标收件箱接纳：message_id 有效）—— 实际处理以目标后续事实为准",
  route:  { reported: false, reason: "宿主 sendMessage 只回收件箱 id，无路由回执；不得由 activity_before / current_turn 反推" },
  note, next }
```

> ⚠️ **`delivery` 不再报告投递路径，这是刻意的。** 早期实现按"投递后"的活动态判成
> `steer`（在跑）/ `queue`（空闲），但那个观测**证明不了接纳时走了哪条路径**：
> 空闲目标可能**已被这条消息本身唤醒**成 running，在跑的目标也可能**在回读前就结束**。
> 主实例实测到过 `activity_before=inactive` 却报 `steer` 的情形。
> 现在 `activity_before` 与 `current_turn` **作为两次观测各自保留**，而 `delivery` 只陈述
> "已被收件箱接纳"；路由在有明确回执之前一律 `route.reported = false`。

### `task_child_stop` —— 停止当前轮

| 参数 | 必填 | 说明 |
|---|---|---|
| `target_id` | 是 | 目标子代理 sessionId |
| `reason` | 否 | 只写进**返回体**供对账，不投递给目标（要它知道原因就先 `task_child_send` 再停） |
| `request_key` | 否 | 原操作的重试键，最多 256 UTF-8 字节；显式提供时必须有可用恢复日志 |

成功返回额外带 `stopped.accepted`、`state_truth`（区分「信号已发出」与「已安静」）。
`next` 给出机械路径：**要确认真实状态就去读能证明状态的地方**（`task_board` 看它落的事实、
`list_agents` 看 status），并显式警告**不要为了查状态重复调 `task_child_stop`** —— 那是
「再发一次停止信号」，不是查询；要它带着新要求接着干就先 `task_child_send` 再等它落事实。

挂载恢复日志时，控制效果前先持久化 intent，并返回 `operation.retry_key`。同键或同一可信 turn/step/rootCallId/callId 重放只读既有 operation，不再调用宿主。pending/unknown 不证明先前效果失败；必须保留原键，禁止换键自动重复发送或停止。

每个 tools activation 绑定首次观察到的恢复日志对象（包括首次控制之前已挂载的日志）。日志消失、不可读、关闭或换成另一个对象时，在效果调用前返回 `E_CONTROL_JOURNAL_UNAVAILABLE`。新 activation 的显式 `request_key` 同样要求日志。该码仅证明**本次未调用宿主**，不能推定此前同键效果失败；停止自动重试并向主控报告，恢复原日志后用原键读取 pending/replayed 结果。日志对象确需替换时，由主控核实原持久数据库并重新激活 tools；同一日志对象重连原数据库无需更换绑定。

只有从未观察到日志且没有显式 `request_key` 的 detached 旧适配器保留原控制行为，返回 `operation.durable:false`、`durability:"unavailable"`，不提供重放保护。`ctx.get` 正常返回 `undefined` 是可信缺省，不再反射查询；只有没有 `get` 的旧 context 才走属性读取。服务或 `recovery` 显式为 `null`，或主查询实际抛错，都拒绝效果调用。服务解析抛错不属于这种兼容场景。更多持久化边界见 [RECOVERY.md](RECOVERY.md)。

## 3. 授权判据（不靠提示词，靠代码）

1. **sender 必须是调用者自己**：取 `exec.agent` **本体引用**。
   真身 `sendMessage` 会做 `ctx.agents.get(sender.id) !== sender → UNAUTHORIZED`，所以重构对象、猜出来的对象都过不去。
2. **只能操作本会话派出的子代理**：用 `ctx.subagents.listChildren(调用者自己会话id)` 核对 `target_id`。
   真身 `listChildren` 是 **per-parent 持久化目录**，别人的 id 不会出现在本会话的目录里 ⇒ 主控**无法**操作别人的子代理。
3. **只认 continuable**：目录里 `mode !== 'continuable'` 的（`one-shot` / `unknown`）明确拒绝。
   **活动态是「三态」而非二值**：宿主 `listChildren()` 返回的 `SubagentCatalogEntry` **不含 `activity`**（那是 `listDescendants()` 才补的字段），所以活动态另行从 `agents.get(id).status` 取：
   - 取到且 `running` → `running`
   - 取到且 `idle` → `inactive`
   - **取不到（服务缺失 / 查无此 agent / 查询失败）→ `unknown`**，**不得**推断成"已停止"
   相应地，`interrupt()` 是同步接纳、异步停止的 **void** 接口：**调用未抛错即 `accepted:true`**；"是否真的停了"是独立观测（`execution.stopped`），**`accepted` 不表示已停止**。
4. **顺序即纪律**：先身份 → 再服务 → 再归属，全部通过才碰写入路径。拒绝时**一个服务方法都不调用**（自测 C14/C16 断言了这点）。
5. **不额外限 lead**：子代理同样可以续作/停止**它自己派出**的子代理。

## 4. 错误码（分类，不笼统失败）

| code | 含义 | hint 指向 |
|---|---|---|
| `E_CHILD_NO_AGENT` | `exec.agent` 缺失 / 无会话头 | 身份不可得，**上报**不要重试 |
| `E_CHILD_INPUT` | 空 `target_id` / 空 `message` / 类型不对 | 参数可自行修正 |
| `E_CHILD_NOT_OWN` | 目标不是本会话的子代理（含服务侧 `UNAUTHORIZED`） | **不许**换参数绕过 |
| `E_CHILD_SETTLED` | 目标是 one-shot / unknown，已结算 | 要再跑就重新派一个 |
| `E_CHILD_MISSING` | 保留码：目标不存在（当前与 `E_CHILD_NOT_OWN` 合并，二者对调用方动作相同） | — |
| `E_CHILD_NO_ID` | 无法核对归属（`listChildren` 读失败） | 服务问题，不冒险操作 |
| `E_CHILD_SERVICE` | `ctx.subagents` 未挂载或**缺所需方法** | 部署/宿主集成问题，核对原生 subagents 服务，不盲目换入口重试 |
| `E_CONTROL_JOURNAL_UNAVAILABLE` | 控制日志不可用或更换；本次未 dispatch，但此前效果仍可能未知 | 保留原键，**不得换键重试**；报告主控，恢复原日志后只读原结果 |
| `E_CONTROL_OUTCOME_UNKNOWN` | 既有操作 pending/unknown，或宿主效果后结果未能持久化 | 不推定失败，不重放；保留 `operation.retry_key` 核对持久日志和实际回执 |

## 5. 契约依据（实测，不是推测）

契约取自 `cordis_inspect_query(platform=host, provider=Service, method=listService, {service:"subagents"})`：

```
async sendMessage(
  sender: Agent,
  targetId: SessionId,
  content: ContentBlock[],
  options: SubagentSendMessageOptions,
): Promise<MessageId>

interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void

async listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>
```

```
export interface SubagentSendMessageOptions { readonly signal: AbortSignal; }

export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent; };

export type SubagentCatalogEntry = { readonly id: SessionId; readonly createdAt: number }
  & ({ mode: 'one-shot'; label?: string }
    | { mode: 'continuable'; label: string }
    | { mode: 'unknown'; label?: string });
```

本实现的调用形状与**官方适配器** `@deepseek-ai/dsh-tool-subagent-control/lib/index.js:52-58,84-89` 逐项同构：

```js
const sender = exec.agent                                    // 官方 :52 / 本包同
const message = [{ type: 'text', text: args.message }]        // 官方 :54 / 本包同
ctx.subagents.sendMessage(sender, targetId, message, { signal: exec.signal })  // 官方 :58
const caller = exec.agent                                     // 官方 :84 / 本包同
ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent: caller })         // 官方 :86
```

真身两处硬约束（`dsh-subagent/lib/types/continuation.js`）：

- `:195` `if (this.ctx.agents.get(sender.id) !== sender) throw new SubagentError('… requires the exact live sender agent', 'UNAUTHORIZED')`
  ⇒ sender 必须是 exact live Agent。
- `:202` `options.signal.throwIfAborted()` ⇒ **signal 不能省略**；本包用 `resolveSendSignal(exec, warn)` 转发真信号，
  宿主不给信号时才用带 `throwIfAborted()` 的兜底对象并留一条告警（不静默、也不把宿主契约问题升级成投递失败）。

`brandString()` 是**编译期专用**品牌（`dsh-brand/lib/index.js` 直接 `return value`），无运行时效用，故无需调用。

## 6. 注意与未决

- **不销毁**：`task_child_stop` 只中断当前轮。未认领的排队消息、Activation、已发布的子代都保留；
  驱动空闲后再 `task_child_send` 一条即可唤醒它继续处理队列。
- **fire-and-return**：中断是「信号已发出」，目标可能仍在跑；`current_turn` 是**那一刻的真实读值**，不是承诺。
- **不参与相邻 agent 标记**：官方适配器把自己的 `send_message` 工具用
  `markAdjacentAgentSendMessageTool` 打标（`dsh-tool-subagent-control/lib/index.js:22`，
  该标记由 `dsh-subagent/internal` 导出）；真身随后在
  `dsh-subagent/lib/types/continuation.js:172` 用 `isAdjacentAgentSendMessageTool(...)` 读这个标记，
  以决定是否给子代理注入续作提示语。本包是**独立命名**的控制工具，既不打标也不读该标记 ——
  与官方工具共存、互不干扰。
- **未决**：本包工具与官方 `send_message` 对同一目标的**并发投递顺序**未定义，取决于目标 inbox 的接纳顺序。
