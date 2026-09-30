/**
 * taskforce / orchestrator-scope — 主会话工具面收窄（本包最核心的差异化件）。
 *
 * 主张：**主会话只编排、不执行**。人格文本说"你自己不动手"是软约束，
 * 模型在压力下会绕过它；这里给的是**硬约束**，且硬约束分**两轨**：
 *
 * 1. **可见性过滤**（`agent.ctx.tools.restrict({ deny })`）—— 把执行/写类工具
 *    从主会话的**工具面上遮掉**（模型看不到就不会去调）。
 * 2. **执行守卫**（`agent.ctx.tools.guard(g)`）—— 在**执行入口**按真实调用身份
 *    拒绝约定 deny 项（即使工具仍在面上、即使过滤没生效，handler 也跑不起来）。
 *
 * ## 为什么必须有第 2 轨（独立复审 P1：边界失效后仍继续放行）
 * 只靠 `restrict` 的写法有四个可复现的漏口，复审在隔离夹具里逐条实测过：
 *
 * | 场景 | 只靠 restrict 的结果 |
 * |---|---|
 * | 初始只有 `read`，稍后注册 `bash` | 求交时 bash 还不存在 ⇒ 不提交；bash 上线后仍可见 |
 * | 成功隐藏 `bash` 后才注册 `write` | 旧实现首次成功后置 `state.done` ⇒ 后续不再检查 |
 * | `restrict` 返回 disposer 但**未改变工具面** | 反查只告警 ⇒ 告警后不再重试 |
 * | 前 8 次限制失败，第 9 次注册表恢复 | 旧实现 `MAX_ATTEMPTS` 后**永久放弃** |
 *
 * 四条的共同结论：**"工具面过滤"不能作为安全边界**（它是呈现层效果），
 * 执行边界必须在**执行入口**上按**真实调用身份**再判一次。`tools.guard()` 正是
 * 宿主给出的那个入口 —— 契约原文（`cordis_inspect_query Service tools` 实测）：
 *
 * > `guard(guard: ToolGuard): () => void` —— "Register a **monotonic** guard after
 * > the extensible `tools/pre-execute` waterfall. A plain-context guard applies
 * > globally; **one registered through `agent.ctx` applies only to that agent**.
 * > Any matching guard may deny by returning a reason, while **no guard can
 * > force-allow a call another guard denied**. The exact effect disposer is
 * > returned for ordered ownership and HMR cleanup."
 *
 * `ToolGuard` 精确形状（同一份实测）：
 * ```ts
 * export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
 * ```
 * 返回字符串 = 拒绝，返回 undefined = 放行本守卫。
 *
 * ## guard 为什么"只对主控生效"（三重实证，不是推测）
 * 1. **契约**：上面原文 —— 经 `agent.ctx` 注册的 guard 只作用于该 agent。
 * 2. **scope key 就是 agent 本身**：`dsh-agent-loop/lib/index.js:778`
 *    `this.scope = createScope(loopCtx, this)`、`:779` `this.ctx = this.scope.ctx`
 *    —— agent 的 scoped ctx 携带的 `[kScope]` 就是这个 Agent 实例
 *    （`dsh-scope/lib/index.js:312` `scopeOf(ctx) { return ctx[kScope] }`）。
 * 3. **派发侧按同一个 key 取层链**：`dsh-tools/lib/index.js:2928-2934`
 *    ```js
 *    guardReason(exec) {
 *      const globalReason = this.layers.global.guardReason(exec);
 *      if (globalReason !== void 0) return globalReason;
 *      if (exec.agent === void 0) return void 0;
 *      for (const layer of this.layers.chainLayers(exec.agent)) { … }
 *    ```
 *    层链以 `exec.agent` 为键 ⇒ 只有"注册 scope === 调用者 agent"的那一层会被走到。
 *    子代理是**另一个 Agent 实例**，拿不到主控那一层 ⇒ 天然不被误伤。
 * 4. 现网先例：官方 `dsh-subagent-in-process-driver/lib/index.js:85` 用
 *    `childCtx.tools.guard((exec) => …)` 给单个子会话装执行守卫 —— 同一机制。
 *
 * **因此本插件只从 `agent.ctx.tools` 发起 guard 注册，绝不用插件自己的 ctx**
 * （插件 ctx 没有 scope tag ⇒ 会落到 global 层 ⇒ 变成拦所有 agent）。
 *
 * ## 为什么不用 `pagedToolPatterns` 那种模式匹配
 * 梁神模式的分页族名匹配语义是「字面前缀 + 恰好一个结尾 `*`，且去前缀后必须
 * 还剩内容」（为 `mcp__server__fn` 这类族名设计）。对 `bash` 这种扁平工具名，
 * 写 `bash*` 会让 `rest` 为空 → 判定为常驻，**根本扣不掉**。所以正路是
 * `tools.restrict({ deny })` + `tools.guard()`。
 *
 * ## 无条件施加
 * 刻意**不**照抄梁神"只在 ptc 呈现下才装限制"的闸门（`tool-catalog.mjs:652`）：
 * 那条闸门在 `presentation: 'both'` 下永不触发，被扣留的工具在 `run_code`
 * 程序里仍然可达（漏隐藏）。本插件不看呈现模式，对主会话一律施加。
 *
 * ## 身份判据（子代理跳过）
 * `agent.session.header` 上任一条命中即视为子代理，**不加任何限制**：
 * - `origin === 'subagent'`（`SessionHeader.origin`，子代理产品的粗分类）
 * - `delegationDepth > 0`（顶层缺省、子代理 = 父 + 1，落盘以便重启后预算不重置）
 * 类型来源：`@deepseek-ai/dsh-session/lib/types/types.d.ts:58-98`。
 *
 * 已知取舍：手工从主会话 fork 出来的会话也带 `parentSession`，因此同样被判为
 * 子代理而跳过收窄。这是**故意**的 —— 判据宁可放宽（少限制）也不要误伤正在
 * 干活的会话；需要收紧的部署可以把这三条做成 config 开关。
 *
 * ## 施加时机与容错（`restrict` 对不存在的名字会抛错）
 * 契约原话（`cordis_inspect_query Service tools` 实测）：
 * "Restrict global tools for the calling agent scope. **Empty filters, unknown
 * names, scope-local names, and reserved transport names fail.** Restrictions
 * intersect; scoped registrations remain visible."
 *
 * 所以第 1 轨（可见性）是三层容错：
 * 1. **先读后写**：用 `tools.schemas(agent)` 读该 scope 当前可见的工具名，
 *    与 deny 清单求交，只把**确实存在**的名字交给 `restrict`；
 * 2. **空过滤器绝不提交**：求交为空时直接不调用（`{deny: []}` 会抛）；
 * 3. **try/catch + 告警**：注册表若仍然拒绝（名字在读取与提交之间消失、
 *    作用域其实不是 scoped），限制就是不生效，**绝不让它炸掉会话**。
 *
 * **没有"永久放弃"**：`agent/pre-step` 每次复核，幂等；晚注册的工具会被下一次
 * 复核捕获。旧实现的两条放弃路径（`state.done`、`MAX_ATTEMPTS = 8`）已删除 ——
 * 它们正是复审场景 2 / 场景 4 的成因。
 *
 * 机制借鉴：`@linxin666/dsh-liangshen` v0.4.2（MIT）的 `tool-catalog.mjs`
 * 的 `syncScopePaging` 容错结构与 `agent/created` 解构写法；
 * 收窄策略（deny 清单、子代理判据、双轨硬约束）为本包自研。
 */

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'taskforce-orchestrator-scope'

/** 无服务依赖：工具面走 `agent.ctx.tools` 的 scoped 视图。 */
export const inject = []

/**
 * 默认遮蔽清单 —— 「执行 / 写」类。
 *
 * 名字来源（**本机实测**，非猜测）：
 * - `bash`：`@deepseek-ai/dsh-tool-bash/lib/index.js` 内 `name: "bash"`
 * - `write` / `edit`：`@deepseek-ai/dsh-tool-fs/lib/` 内 `name: "write"` / `"edit"`
 *   （同包另有只读的 `read` / `read_image`，**保留**）
 * - `str_replace_editor`：`@deepseek-ai/dsh-tool-str-replace-editor/` 内
 *   `name: "str_replace_editor"`
 * 交叉验证：`cordis_inspect_query(host, Tool, listTools)` 在本机实际可调工具
 * 面里确认上述名字均为独立扁平名（非族名）。
 *
 * 保留（**不**遮蔽）：`read` / `read_image` / `glob` / `grep`（只读核对 ——
 * 主会话要靠它们核对子代理战果）、派活类（`subagent` / `subagent_fork` /
 * `send_message` / `list_agents` / `interrupt_agent`）、以及 todo / goal / skill /
 * web / ask_user 等非执行类。
 */
/**
 * 主会话默认遮蔽的名单：**凡改变本机系统状态、代码或插件来源的，一律遮蔽**。
 *
 * 分两组：
 *  - 标准执行/写工具：`bash` / `write` / `edit` / `str_replace_editor`
 *  - 本机插件注册的"改系统"入口（独立设计预审 P1-5 指出：只裁四个标准工具
 *    不够，`purge_*` / `plugin_*` / `spawn_teammate` 同样让编排者能动手）：
 *    `purge_apply` / `purge_revert` 改宿主核心代码；`plugin_install` /
 *    `plugin_remove` 装卸代码；`plugin_auto_update` / `plugin_set_auto_update`
 *    改插件配置；`spawn_teammate` 拉起常驻队友（本包按"单会话模式"设计，
 *    编排者应当用 `subagent`，不是 Agent Teams）。
 *
 * 保留：只读核对类（`read` / `glob` / `grep` / `read_image`）、派活类
 * （`subagent` / `subagent_fork` / `send_message` / `list_agents`）、
 * 编排自身的状态类（`task_*` / todo / goal / skill），以及只读的
 * `*_list` / `*_get` / `*_status` 查询。
 *
 * **两条轨对名单的用法不同**（这是本次修正的关键）：
 *  - 第 1 轨（`restrict`）**必须先与当前工具面求交**：`restrict` 对未知名会
 *    抛错，且一次抛错会让**整份名单**失效。名单因此"可以比实际工具面长"。
 *  - 第 2 轨（`guard`）用**全量名单**，绝不求交、绝不裁剪：guard 按名字判，
 *    未知名无害。**这才是"晚注册 / 部分降级"不能放行 handler 的原因** ——
 *    即使某个名字此刻还不存在（求交时被丢弃），它一旦上线就已经在 guard 的
 *    拒绝集合里。
 */
export const DEFAULT_DENY = [
  // PTC is executable Node code, including direct fs/subprocess imports.
  // It is a reserved transport: guard it, never pass it to restrict().
  'run_code',
  // 标准执行/写
  'bash',
  'write',
  'edit',
  'str_replace_editor',
  // 改宿主 / 改插件（本机 dsh-purge 与 dsh-pluginmgmt 注册）
  'purge_apply',
  'purge_revert',
  'plugin_install',
  'plugin_remove',
  'plugin_auto_update',
  'plugin_set_auto_update',
  // 拉起常驻队友：本包是「单会话 + 子代理」模式，编排者用 subagent
  'spawn_teammate',
]

/** 执行守卫拒绝时的稳定错误码（自测按码断言，不按文案）。 */
export const DENY_CODE = 'E_ORCHESTRATOR_SCOPE_DENIED'

/** 执行守卫拒绝时的固定提示（模型据此决定改派子代理，而不是重试）。 */
export const HINT_ORCHESTRATOR_SCOPE = '这不是参数问题，重试无用：「任务部队」主会话只有编排面，没有执行面。'
  + '要动手就派子代理（subagent / subagent_fork），把任务与验收判据写进派单描述；'
  + '要核对战果就用只读工具（read / glob / grep）与 task_board 读事实，不要自己跑命令或改文件。'

/**
 * 判断一个会话头是否属于子代理（**子代理一律跳过收窄**）。
 *
 * 判据只有两条：`origin === 'subagent'` 或 `delegationDepth > 0`。
 * 两者都是委派工具写入的语义字段，**真子代理必有其一**。
 *
 * ⚠️ 刻意**不用** `parentSession`：手工 fork 出来的会话同样带 `parentSession`，
 * 但它是一个**主会话**（人开的、要干活的门面），把它当子代理会**漏收窄** ——
 * 而漏收窄正是本插件要解决的核心问题（独立设计预审 P1-5 指出过这一点）。
 *
 * 传 undefined / null / 非对象时返回 false：读不到身份 ⇒ 按主会话处理，
 * 宁可多收窄也不要漏收窄（多收窄对主会话是设计意图）。
 *
 * @param header - `agent.session.header`。
 * @returns 是否子代理。
 */
export function isSubagentSession(header) {
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/** 解析实际生效的 deny 清单（config 覆写 → 默认值）。 */
export function resolveDeny(config) {
  const raw = config?.deny ?? config?.denyForMainSession
  if (Array.isArray(raw)) {
    return raw
      .filter(item => typeof item === 'string' && item.trim() !== '')
      .map(item => item.trim())
  }
  return [...DEFAULT_DENY]
}

/** 读一个 agent 的会话 id（身份判据用）；读不到返回 undefined。 */
export function sessionIdOf(agent) {
  const id = agent?.session?.header?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 造一个「按真实调用身份拒绝」的执行守卫（纯函数，便于自测）。
 *
 * 判据顺序（每一步都是**硬**的，没有"先放行再观察"）：
 * 1. `exec.agent` 缺失 ⇒ 放行（没有调用者身份就无法证明这是被保护会话；
 *    宿主在守卫之前已经有 waterfall 策略，这里不越权）。
 * 2. 调用者是**子代理** ⇒ 放行（双保险：本守卫本就挂在主控 scope 上，
 *    正常路径下子代理的调用根本走不到这一层 —— 但判据不依赖调用方行为）。
 * 3. 真实调用身份：`exec.agent === agent`（对象同一，宿主注入的正是本实例）
 *    **或** 会话 id 相同（同一会话的等价身份）。两者都不成立 ⇒ 放行。
 * 4. 工具名命中 deny 全集 ⇒ **返回拒绝理由字符串**（宿主据此产出 isError 结果，
 *    handler **不会被执行**）。否则放行。
 *
 * @param options.agent - 被保护的主控 Agent 实例（guard 的注册 scope）。
 * @param options.deny - 拒绝名单（**全量**，不做工具面求交）。
 * @param options.code - 拒绝码（默认 {@link DENY_CODE}）。
 * @param options.hint - 拒绝提示（默认 {@link HINT_ORCHESTRATOR_SCOPE}）。
 * @returns `ToolGuard`：`(exec) => string | undefined`。
 */
export function createDenyGuard({ agent, deny, code = DENY_CODE, hint = HINT_ORCHESTRATOR_SCOPE }) {
  const denySet = new Set(Array.isArray(deny) ? deny : [])
  const ownId = sessionIdOf(agent)
  return (exec) => {
    const caller = exec?.agent
    if (caller === undefined || caller === null || typeof caller !== 'object') return undefined
    if (isSubagentSession(caller.session?.header)) return undefined
    const sameAgent = caller === agent || (ownId !== undefined && sessionIdOf(caller) === ownId)
    if (!sameAgent) return undefined
    const toolName = typeof exec?.name === 'string' ? exec.name : ''
    if (toolName === '' || !denySet.has(toolName)) return undefined
    return `${code}: 工具 "${toolName}" 在主会话作用域被执行守卫硬拦截（主会话只编排、不执行）。`
      + ` hint: ${hint}`
  }
}

/**
 * 求交：只留下该 scope 当前**确实存在**的名字。
 * 纯函数，便于自测。
 * @param deny - 期望遮蔽的名字。
 * @param schemas - `tools.schemas(agent)` 的结果。
 * @returns `{ effective, missing }`。
 */
export function intersectWithSurface(deny, schemas) {
  const present = new Set(
    (Array.isArray(schemas) ? schemas : [])
      .map(entry => entry?.name)
      .filter(entryName => typeof entryName === 'string'),
  )
  const effective = []
  const missing = []
  for (const entryName of Array.isArray(deny) ? deny : []) {
    if (present.has(entryName)) effective.push(entryName)
    else missing.push(entryName)
  }
  return { effective, missing }
}

/** 读该 scope 当前可见的工具 schema；任何失败都当作"读不到"（undefined）。 */
function schemasOf(agent) {
  try {
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.schemas !== 'function') return undefined
    const list = tools.schemas(agent)
    return Array.isArray(list) ? list : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 `tools.restrict` 的拒绝消息里取出**可用全局工具名单**。
 *
 * 拒绝消息形状（本机实测）：
 *   `tools.restrict() names unknown global tool "X"; known global tools: a, b, c …`
 *
 * 只有**全局**工具能被 restrict；而 `tools.schemas(agent)` 返回的是 agent 看到的
 * **全部**工具，其中可能含 scope 内注册的名字 —— 它们能通过求交、却会让整个
 * restrict 调用抛错。这条消息自带完整可用名单，是唯一可靠的判据来源。
 * @param message - 拒绝消息原文。
 * @returns 可用名单；消息形状不符时 undefined。
 */
export function parseKnownGlobalTools(message) {
  if (typeof message !== 'string') return undefined
  const marker = 'known global tools:'
  const at = message.indexOf(marker)
  if (at === -1) return undefined
  const list = message.slice(at + marker.length)
    .split(/,\s*/)
    .map(entry => entry.trim().replace(/[.。]+$/, ''))
    .filter(entry => entry !== '' && !entry.includes(' '))
  return list.length > 0 ? list : undefined
}

/**
 * 提交工具面限制；被拒时按错误消息里的可用名单**修正一次**再试。
 *
 * 为什么必须容错：一次 `restrict` 抛错会让**整份名单**失效。实测代价 ——
 * 11 个应遮蔽项因其中一个非全局名字（`spawn_teammate`）而**全部暴露**，
 * 连原本能遮蔽的 4 个执行类也一起赔进去；而失败只体现在真实请求的工具面上，
 * 离线自测与启动日志都看不出来。
 *
 * ⚠️ 这条降级路径**只影响第 1 轨（可见性）**：第 2 轨的 guard 用全量名单，
 * 被这里"丢弃"的名字（如 `spawn_teammate`）照样在执行入口被拒绝。
 *
 * @param tools - `agent.ctx.tools`。
 * @param names - 期望遮蔽的名字。
 * @returns `{ dispose, applied, downgraded }`；无法修正时抛出原错误。
 */
export function restrictWithFallback(tools, names) {
  try {
    return { dispose: tools.restrict({ deny: names }), applied: names, downgraded: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const known = parseKnownGlobalTools(message)
    if (known === undefined) throw error
    const applied = names.filter(entry => known.includes(entry))
    if (applied.length === 0) throw error
    return { dispose: tools.restrict({ deny: applied }), applied, downgraded: true }
  }
}

/** 注册主会话工具面收窄（可见性过滤 + 执行守卫，双轨）。 */
export function apply(ctx, config) {
  const deny = resolveDeny(config)
  if (deny.length === 0) return
  const visibilityDeny = deny.filter(entry => entry !== 'run_code')

  const stateByAgent = new WeakMap()
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    // 宿主 logger 的 warn 可能被部署的日志级别吞掉，而这条诊断是排查
    // "收窄为何没生效"的唯一线索（真实请求面不会告诉你原因）——
    // 因此同时写 stderr，让它落进 dsh web 的运行日志。
    const line = `${name}: ${message}`
    try {
      ctx.logger?.warn?.(line)
    } catch {
      /* 诊断绝不能打断激活 */
    }
    try {
      process.stderr.write(`[taskforce] ${line}\n`)
    } catch {
      /* stderr 也是可选能力 */
    }
  }

  const stateOf = (agent) => {
    let state = stateByAgent.get(agent)
    if (state === undefined) {
      // 状态字段语义：
      //  - `guardDispose` / `guardInstalled`：执行守卫（第 2 轨）；
      //  - `dispose` / `applied`：**已被注册表接受、且反查确认真的生效**的可见性限制；
      //  - `refusedNames`：注册表**明确拒收为"非全局工具"**的名字。
      // 没有任何"完成 / 放弃"标志位：`undefined` 只表示"这一轨还没装上"，
      // 不表示"不再尝试"。旧实现的 `done` / `attempts` 造成过两个真实漏口
      // （复审场景 2 与场景 4），已删除。
      state = {
        guardDispose: undefined,
        guardInstalled: false,
        dispose: undefined,
        applied: [],
        refusedNames: new Set(),
      }
      stateByAgent.set(agent, state)
    }
    return state
  }

  /**
   * 撤掉本插件先前施加的**可见性**限制，让下一次读取能看到完整工具面。
   * `refusedNames` 刻意**不清空**：它是"注册表不接受这个名字"的既有事实，
   * 与某一次提交无关（撤销再提交不会让一个非全局名变成可遮蔽的）。
   */
  const clearRestriction = (agent) => {
    const state = stateByAgent.get(agent)
    if (state === undefined) return
    try {
      state.dispose?.()
    } catch {
      /* 撤销失败不该影响会话 */
    }
    state.dispose = undefined
    state.applied = []
  }

  /**
   * 第 2 轨：装执行守卫（幂等，失败可重试，永不放弃）。
   *
   * **必须从 `agent.ctx.tools` 发起**：guard 的 layer 由 `scopeOf(this.ctx)` 决定
   * （`dsh-tools/lib/index.js:2921-2925` → `dsh-scope/lib/index.js:190`），
   * 而 agent 的 scoped ctx 带的 scope key 就是该 agent 实例本人
   * （`dsh-agent-loop/lib/index.js:778-779`）。用插件自己的 ctx 会落到 global 层，
   * 那会拦掉**所有** agent（含子代理）。
   *
   * @param agent - 被保护的主控 agent。
   * @param state - 该 agent 的收窄状态。
   * @returns 守卫此刻是否已在位。
   */
  const ensureGuard = (agent, state) => {
    if (state.guardInstalled) return true
    const scoped = agent?.ctx?.tools
    if (scoped === undefined || typeof scoped.guard !== 'function') {
      warnOnce(
        'no-guard',
        '取不到 agent 作用域的执行守卫入口（agent.ctx.tools.guard 不可用）—— '
        + '本轨不生效，只保留可见性过滤；会在后续每一步继续重试。',
      )
      return false
    }
    let dispose
    try {
      dispose = scoped.guard(createDenyGuard({ agent, deny }))
    } catch (error) {
      warnOnce(
        'guard-refused',
        `执行守卫注册被拒：${error instanceof Error ? error.message : String(error)} —— 会在后续每一步重试。`,
      )
      return false
    }
    state.guardInstalled = true
    if (typeof dispose === 'function') {
      state.guardDispose = dispose
    } else {
      // 契约承诺返回 disposer；万一宿主没给，**也不重复注册** ——
      // 重复注册会让同一会话累积多份守卫，比"少一个 disposer"更糟。
      warnOnce('guard-no-disposer', '执行守卫已注册但宿主未返回 disposer：守卫在位，退出时可能不会被显式撤销。')
    }
    try {
      ctx.logger?.info?.(`${name}: 主会话执行守卫已就位（拒绝 ${deny.length} 个名单项，含晚注册与过滤降级项）`)
    } catch {
      /* 日志是可选能力 */
    }
    return true
  }

  /**
   * 第 1 轨：可见性过滤（尽力而为，失败/降级都不影响第 2 轨的硬拦截）。
   *
   * 与旧实现的三处差别：
   *  ① 不再有 `done` / `MAX_ATTEMPTS` 的"永久放弃"；
   *  ② 幂等判据是"本次可见的待遮蔽名字是否都已在已提交名单里"（而不是"跑过一次就算完"），
   *     所以**晚注册的名字会被下一次 pre-step 捕获并补提交**；
   *  ③ 反查**读不到**时整批保持「**未确认**」：一条都不写进 `applied`（否则下一次复核
   *     会把它误判成"已覆盖"而不再重试），但 disposer 保留，下一步先撤后读、重新提交；
   *     反查**读得到**时也只把"确实从面上消失"的名字记进 `applied`，仍可见的留给后续重试。
   *
   * @param agent - 主控 agent。
   * @param state - 该 agent 的收窄状态。
   * @returns 可见性限制此刻是否已覆盖当前面的全部待遮蔽名字。
   */
  const syncRestriction = (agent, state) => {
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') {
      warnOnce(
        'no-scoped-view',
        '取不到 agent 作用域的工具视图（agent.ctx.tools.restrict 不可用）—— 可见性过滤不生效；'
        + '执行守卫仍会拒绝名单项的执行。',
      )
      return false
    }

    const visible = schemasOf(agent)
    if (visible === undefined || visible.length === 0) {
      // 工具面还没稳定：不提交、也不标记任何"完成" —— 留给后续 pre-step。
      return false
    }
    const { effective, missing } = intersectWithSurface(visibilityDeny, visible)

    if (state.dispose === undefined && effective.length === 0) {
      warnOnce(
        'absent',
        `清单里的名字此刻在本会话工具面上一个都没有（${deny.join(', ')}）—— 本次不提交；`
        + '后续每一步都会复核，晚注册的名字一旦上线就会被补上（执行守卫已按全量名单在位）。',
      )
      return true
    }

    const covered = new Set(state.applied)
    // 幂等判据：本次**可见**的待遮蔽名字，是否都已被"确认生效的提交"或
    // "注册表明确拒收"覆盖。后者不再触发重提交 —— 对非全局名重试 `restrict`
    // 是徒劳的（注册表永远不会接受它），而它的执行已经有 guard 兜底；
    // 不这样区分，真宿主上 `spawn_teammate` 这类名字会让每一步都重提交一次。
    const pending = effective.filter(
      entry => !covered.has(entry) && !state.refusedNames.has(entry),
    )
    if (state.dispose !== undefined && pending.length === 0) return true

    // 需要（重新）提交。**先撤后读**：带着旧限制读，被遮蔽的名字已经不在面上，
    // 求交会误判为"不存在"，重提交时就会把它漏掉。
    // 撤销与重提交之间没有 await —— JS 单线程下这是一个原子段，模型插不进来。
    clearRestriction(agent)
    const full = schemasOf(agent)
    if (full === undefined || full.length === 0) return false
    const all = intersectWithSurface(visibilityDeny, full).effective
    if (all.length === 0) return false

    try {
      const settled = restrictWithFallback(tools, all)
      const dropped = all.filter(entry => !settled.applied.includes(entry))
      if (settled.downgraded) {
        warnOnce(
          'downgraded',
          `注册表只接受全局工具名，已把可见性名单收敛到可遮蔽子集：[${settled.applied.join(', ')}]`
          + `（丢弃：${dropped.join(', ')}）—— 这几个名字 restrict 永远管不到，`
          + '记为"不可遮蔽"、不再重复提交；它们的执行仍由执行守卫按全量名单拒绝。',
        )
      }
      if (typeof settled.dispose !== 'function') {
        warnOnce('unconfirmed', '工具注册表没有确认这次收窄（未返回 disposer）—— 可见性限制不生效，执行守卫仍在位')
        return false
      }

      // **反查**：`restrict` 返回 disposer 只证明"注册表接受了这次提交"，
      // 不证明"工具面真的变了"。差别是实打实的 —— 一次因非全局名字导致的
      // 整体拒绝曾在离线自测全绿、启动日志无警的情况下让 11 项全部暴露。
      //
      // 反查是**三态**，不是二值：
      //  · 读得到 → 只把**真的从面上消失**的名字记进 applied，其余留给下一次复核重试；
      //  · **读不到 → 整批保持「未确认」**：一条都不记 applied（没有证据表明任何一个
      //    名字真的消失了），但 **disposer 保留**（撤销句柄是下一步"先撤后读"重提交的前提）。
      //    旧实现在这一格把 `stillPresent` 折成空数组 ⇒ 全部名字被记为已覆盖 ⇒ 后续
      //    pending 判据认为已覆盖、不再重试，可见性就**永久停在"提交了但没生效"**上。
      //    触发条件真实存在：`restrict` 返回了 disposer、实际可见性尚未改变，
      //    恰好此时反查临时失败。注意这**不是执行绕过** —— 执行守卫按全量名单独立拒绝，
      //    这一格缺的是"可见性确认与重试"，不是执行边界。
      //    也不许用"改读操作前状态"糊过去：那只是把竞态换个位置，仍然是拿一个观测
      //    去断言另一个时刻的事实。
      //  · 被注册表**明确拒收**（非全局名）的那几个始终记进 refusedNames：那是提交
      //    之前就已知的事实，与反查读不读得到无关，不该被这一格拖着空转。
      const after = schemasOf(agent)
      for (const entry of dropped) state.refusedNames.add(entry)

      if (!Array.isArray(after)) {
        state.applied = []
        state.dispose = settled.dispose
        warnOnce(
          'unconfirmed-visibility:' + settled.applied.join(','),
          `收窄已提交（[${settled.applied.join(', ')}]）但**反查不到**当前工具面（tools.schemas 读不到）——`
          + '这批名字保持**未确认**：不记为已覆盖，disposer 保留，下一次 pre-step 先撤后读、重新提交并复核。'
          + '在此之前不要假设它们已经不可见；执行守卫仍在位，这些名字的执行会被拒绝。',
        )
        try {
          ctx.logger?.info?.(`${name}: 收窄提交未确认（反查不可读，保持重试）：[${settled.applied.join(', ')}]`)
        } catch {
          /* 日志是可选能力 */
        }
        return false
      }

      const stillPresent = settled.applied.filter(entry => after.some(schema => schema?.name === entry))
      state.applied = settled.applied.filter(entry => !stillPresent.includes(entry))
      state.dispose = settled.dispose

      if (stillPresent.length > 0) {
        warnOnce(
          'ineffective:' + stillPresent.join(','),
          `收窄已提交但反查发现这些名字仍在工具面上：${stillPresent.join(', ')}`
          + ' —— 可见性限制未真正生效（宿主实现或时序变化）；'
          + '这些名字**不会**被记为已覆盖，后续每一步都会重试；执行守卫此刻已能拒绝它们的执行。',
        )
      }
      if (missing.length > 0) {
        warnOnce(
          'partial',
          `部分名字本会话不存在，未纳入可见性过滤：${missing.join(', ')}`
          + `（已遮蔽 ${state.applied.join(', ') || '（无）'}；执行守卫按全量名单在位）`,
        )
      }
      try {
        ctx.logger?.info?.(`${name}: 主会话执行类工具已从工具面遮蔽 [${state.applied.join(', ') || '（无）'}]`)
      } catch {
        /* 日志是可选能力 */
      }
      return stillPresent.length === 0
    } catch (error) {
      // 注册表拒绝（名字在读取与提交之间消失、或作用域其实不是 scoped）时，
      // 这条限制就是不生效 —— 绝不能让会话失去它的工具面，也绝不放弃：
      // 下一次复核会重试，而执行守卫已经独立地把 handler 挡在门外。
      warnOnce(
        'refused',
        `工具注册表拒绝了本次可见性收窄：${error instanceof Error ? error.message : String(error)}`
        + ' —— 可见性限制不生效（后续每一步都会重试）；执行守卫仍在位，名单项的执行会被拒绝。',
      )
      return false
    }
  }

  /**
   * 对某个 agent 施加/复核两轨约束。幂等、无上限、永不放弃。
   * @param agent - 目标 agent。
   * @returns 两轨是否都已生效（诊断用；pre-step 不看返回值也会持续复核）。
   */
  const sync = (agent) => {
    if (agent?.session === undefined) return false

    // 身份门：子代理直接跳过，且不占任何状态。
    if (isSubagentSession(agent.session.header)) return false

    const state = stateOf(agent)
    // 执行守卫优先：它不依赖工具面快照，**晚注册的工具天然被覆盖**
    // （按名字判，名单在注册那一刻就已固定），所以先把它装上。
    const guarded = ensureGuard(agent, state)
    const filtered = syncRestriction(agent, state)
    return guarded && filtered
  }

  // 载荷是**对象**，必须解构 `{ agent }`：把第一个参数当 agent 读会拿到一个
  // 既没有 session 也没有 ctx 的对象，收窄会静默失效（梁神踩坑记录）。
  // `agent/created` 是 serial 模式，宿主会等待它，所以这里同步尝试一次；
  // 此时工具面若已稳定，第一次组装请求之前限制就已经在位。
  ctx.on('agent/created', ({ agent }) => {
    sync(agent)
  })

  // 兜底复核：每次 pre-step 都跑一次（幂等）。晚注册的工具、上一轮失败的
  // 提交、反查未生效的项，都在这里被重新捕获 —— 这是"不再有永久放弃"的落点。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    sync(payload?.agent)
    return decision
  })

  // 离开的作用域不该留下注册表限制：限制层以 agent 为键，
  // 键被回收后新会话会继承一个过期的过滤器。
  ctx.on('agent/disposed', ({ agent }) => {
    const state = stateByAgent.get(agent)
    if (state !== undefined) {
      try {
        state.guardDispose?.()
      } catch {
        /* 撤销守卫失败不该影响会话退出 */
      }
    }
    clearRestriction(agent)
    stateByAgent.delete(agent)
  })
}
