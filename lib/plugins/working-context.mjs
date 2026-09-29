/**
 * taskforce / working-context — 每步在最新消息尾部钉一行客观状态。
 *
 * 目的：长任务里模型的注意力窗口会漂移。这一行不是"给模型看的提示词"，
 * 而是**从持久会话事件流折叠出来的客观快照** —— 它不依赖进程内存，
 * 所以 resume、reload、压缩（compaction）之后折叠结果一致。
 *
 * 渲染形态（字段按可用性出现，逗号分隔为「·」）：
 *   [任务部队: 波次 3 · 在飞 2 · 当前任务 #7 "重构解析器" · 最近事实 3 条]
 *
 * 数据源（全部为持久会话事件，无一项依赖进程内存）：
 * - 在飞子代理数：`tool/call`（name ∈ 派活工具集）计数 − `user/message`
 *   （`source.kind === 'subagent-settled'`）计数，下限 0。
 *   结算通知的 source 契约见 `@deepseek-ai/dsh-cordis-host-runner` 的
 *   `SubagentSettledMessageSource = { kind:'subagent-settled'; form:'notice';
 *   summary; senderSessionId }` —— 它是**持久 user 消息**，因此可折叠。
 *   （注意 `subagent/start` / `subagent/end` 是进程内 emit 事件，**不可**作数据源。）
 * - 当前任务：最新 `todo/write` 的 in_progress 标题，被下一条 `turn/start` 清空
 *   （与宿主 todos 投影同构）；若外部 store 提供了带 id 的任务则优先用 store。
 * - 最近事实条数：降级值 = 已收到的子代理结算通知数；store 存在时用 store。
 * - 波次：只有外部 store 提供时才有该字段。
 *
 * 外部 store（可选，非硬依赖）：`ctx.get(config.storeService ?? 'taskforceStore')`。
 * 取不到、形状不对、抛错 —— 一律降级到事件流折叠，绝不报错、绝不等待。
 *
 * 发布/去重纪律（关键，照搬梁神模式的正确做法，见
 * `.scratch/multiagent-prod-tool/liangshen-mechanism.md` §5.9）：
 * 内容未变则撤掉**本步**副本、保留历史副本；只有内容变化、或"已发布副本已不在
 * 可见面"（压缩把它遮蔽了）时才重新发布 —— 后者不做就会在压缩后永久丢失该行。
 *
 * 机制借鉴：`@linxin666/dsh-liangshen` v0.4.2（MIT）的 `working-context.mjs`
 * 的注入/去重框架；字段与数据源为本包自研（在飞子代理 / 结算通知折叠）。
 */

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'taskforce-working-context'

/** 无服务依赖：外部 store 走 `ctx.get` 的可选读取，缺席不阻塞激活。 */
export const inject = []

/** 单条标题截断上限，保持整行"一眼可读"。 */
const MAX_TITLE_CHARS = 80

/** 默认派活工具名（与 preset 行的 `toolName` 配置对应）。 */
export const DEFAULT_DELEGATION_TOOLS = ['subagent', 'subagent_fork']

/** 子代理结算通知的 source.kind（持久 user 消息）。 */
export const SUBAGENT_SETTLED_KIND = 'subagent-settled'

/**
 * "终结"事件取哪条通道（决定"在飞"怎么算）。
 *
 * 两种派活模式在事件流里留下的完成信号**完全不同**，必须显式选，不能猜：
 * - `'settled-notice'`（**默认**）：终结 = `subagent-settled` 通知数。
 *   由 `@deepseek-ai/dsh-subagent` 的 `createSettlementMessage(childId, terminal)`
 *   写出 —— 那是 **continuation-managed（continuable）专属**的送达通知。
 *   本 preset 的两份派活工具都配了 `backgroundMode: 'continuable'`，所以默认值正确。
 * - `'tool-result'`：终结 = 派活调用各自收到的 `tool/result` 数。用于 one-shot
 *   （block）模式部署 —— 那里没有结算通知，结果直接从 `tool/result` 返回。
 *
 * 选错的后果是单向的：用 `'settled-notice'` 跑 one-shot 会让"在飞"永久偏高；
 * 反过来会让它恒为 0。接上外部 store 时 store 值优先，直接绕开这个选择。
 */
export const DEFAULT_SETTLEMENT_CHANNEL = 'settled-notice'

/** 允许的终结通道取值。 */
export const SETTLEMENT_CHANNELS = ['settled-notice', 'tool-result']

/**
 * 读取会话事件流，容忍两种宿主形态：
 * `session.events` 数组 **或** `session.snapshotEvents()` 函数。
 * @param session - 会话对象。
 * @returns 事件数组（读不到则空数组）。
 */
export function sessionEvents(session) {
  if (Array.isArray(session?.events)) return session.events
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  return []
}

/** 把配置里的派活工具名解析成 Set，非法输入回落到默认值。 */
export function resolveDelegationTools(config) {
  const raw = config?.delegationTools
  if (Array.isArray(raw)) {
    const names = raw.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    if (names.length > 0) return new Set(names)
  }
  return new Set(DEFAULT_DELEGATION_TOOLS)
}

/**
 * 折叠子代理派发/终结流。
 *
 * 派发计数取 `tool/call` 且 name 属于派活工具集；终结通道由 `settlement` 选中
 * （见 {@link DEFAULT_SETTLEMENT_CHANNEL}）。在飞 = 派发 − 终结（下限 0）。
 *
 * 两个终结计数都一并返回，方便操作员核对选了哪条通道、以及另一条通道有多少。
 * 被中断而不终结的子代理会让该值偏高，这是可接受的近似 —— 该字段的用途是
 * "提醒还有多少活没回来"，不是精确账；要精确就用外部 store。
 *
 * @param events - 持久事件流。
 * @param delegationTools - 派活工具名集合。
 * @param settlement - `'settled-notice'`（默认）或 `'tool-result'`。
 * @returns `{ dispatched, settledNotices, delegatedResults, settled, inFlight }`。
 */
export function foldSubagentFlow(
  events,
  delegationTools = new Set(DEFAULT_DELEGATION_TOOLS),
  settlement = DEFAULT_SETTLEMENT_CHANNEL,
) {
  let dispatched = 0
  let settledNotices = 0
  let delegatedResults = 0
  // 只有"由派活调用产生"的 tool/result 才算完成信号：按 callId 配对。
  const pendingCalls = new Set()

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'tool/call') {
      if (!delegationTools.has(event.data?.name)) continue
      dispatched += 1
      const callId = event.data?.callId
      if (callId !== undefined && callId !== null) pendingCalls.add(callId)
      continue
    }
    if (event?.type === 'tool/result') {
      const callId = event.data?.callId ?? event.data?.message?.source?.callId
      if (callId !== undefined && pendingCalls.delete(callId)) delegatedResults += 1
      continue
    }
    if (event?.type === 'user/message' && event.data?.source?.kind === SUBAGENT_SETTLED_KIND) {
      settledNotices += 1
    }
  }

  const settled = settlement === 'tool-result' ? delegatedResults : settledNotices
  return {
    dispatched,
    settledNotices,
    delegatedResults,
    settled,
    inFlight: Math.max(0, dispatched - settled),
  }
}

/**
 * 最新 `todo/write` 里处于 in_progress 的条目，被下一条 `turn/start` 清空
 * （与宿主 todos 投影同构）。
 * @param events - 持久事件流。
 * @returns `{ id, title }[]`。
 */
export function inProgressTodos(events) {
  let todos
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'turn/start') {
      todos = undefined
      continue
    }
    if (event?.type === 'todo/write' && Array.isArray(event.data?.todos)) {
      todos = event.data.todos
    }
  }
  return (todos ?? [])
    .filter(item => item?.status === 'in_progress' && typeof item?.content === 'string' && item.content.trim() !== '')
    .map(item => ({ id: item.id, title: item.content.trim() }))
}

/** 按每标题预算裁剪，尽量在词边界收尾。 */
function clipTitle(title) {
  if (typeof title !== 'string') return ''
  if (title.length <= MAX_TITLE_CHARS) return title
  return `${title.slice(0, MAX_TITLE_CHARS - 3)}...`
}

/**
 * 可选读取外部事实库（`ctx.get('taskforceStore')`）的客观字段。
 *
 * **契约以本包 `lib/store/index.js` 的 `TaskforceStore` 实测为准**：
 * - `stats()` → `{ tasks:{total,open,claimed,done,partial,failed}, facts:{total,by_kind,by_confidence}, blockers_open }`
 * - `board()` → `{ scope:'open', open_tasks, tasks:[{id,title,status,owner,fact_count,...}] }`（只含未结任务）
 *
 * 映射（**只读它语义明确持有的东西，不猜**）：
 * - 事实条数 ← `stats().facts.total`
 * - 当前任务 ← `board().tasks` 里 `claimed` 优先、否则队首
 * - **在飞子代理数不从这里读** —— store 的任务 ≠ 子代理，硬映射会撒谎；该字段仍由事件流折叠。
 * - 波次：store 无此概念，字段整体省略（若将来 store 提供 `wave`，下面的兜底探测会自动接上）。
 *
 * 任何异常 / 形状不符 / 库未打开 —— 一律返回 undefined 让调用方降级，
 * 这个读取器绝不能成为会话的失败点。
 *
 * @param store - 外部 store 对象（可为 undefined）。
 * @returns `{ factCount?, task?, wave?, inFlight?, activeTasks? }` 或 undefined。
 */
export function readStoreState(store, runId) {
  if (store === undefined || store === null || typeof store !== 'object') return undefined
  const out = {}

  // ① 本包 store 的真实契约：本 run 的聚合计数（一条查询，恒定成本）。
  //    ⚠️ 必须显式传 runId：store 已按工作实例隔离，**无参落在「未归属域」**
  //    （迁移前的历史行），真实运行时那里是空的 —— 漏传会让本插件静默退化成
  //    todo/flow 分支，"最近事实 N 条"永远不显示。
  try {
    const stats = typeof store.stats === 'function' ? store.stats(runId) : undefined
    const factTotal = stats?.facts?.total
    if (Number.isInteger(factTotal) && factTotal >= 0) out.factCount = factTotal
    const tasks = stats?.tasks
    if (tasks !== undefined && tasks !== null && typeof tasks === 'object') {
      const open = Number.isInteger(tasks.open) ? tasks.open : 0
      const claimed = Number.isInteger(tasks.claimed) ? tasks.claimed : 0
      if (Number.isInteger(tasks.open) || Number.isInteger(tasks.claimed)) out.activeTasks = open + claimed
    }
  } catch {
    /* 库未打开 / 查询失败 ⇒ 降级 */
  }

  // ② 当前任务：本 run 的未结任务里 claimed 优先、否则队首。
  try {
    const board = typeof store.board === 'function' ? store.board({}, runId) : undefined
    const list = Array.isArray(board?.tasks) ? board.tasks : []
    const current = list.find(row => row?.status === 'claimed') ?? list[0]
    const title = current?.title
    if (typeof title === 'string' && title.trim() !== '') {
      out.task = { id: current.id, title: title.trim() }
    }
  } catch {
    /* 同上：读不到就用 todo 折叠 */
  }

  // ③ 兜底：未知/未来 store 形状的宽松别名（不存在的成员一律不调用）。
  try {
    let raw
    for (const method of ['snapshot', 'status', 'state']) {
      if (typeof store[method] !== 'function') continue
      try {
        raw = store[method]()
      } catch {
        raw = undefined
      }
      if (raw !== undefined && raw !== null) break
    }
    if (raw === undefined || raw === null) raw = store
    if (typeof raw === 'object') {
      const wave = raw.wave ?? raw.waveNumber
      if (out.wave === undefined && Number.isInteger(wave)) out.wave = wave
      const inFlight = raw.inFlight ?? raw.inFlightCount ?? raw.inflight
      if (out.inFlight === undefined && Number.isInteger(inFlight) && inFlight >= 0) out.inFlight = inFlight
      const facts = raw.facts ?? raw.factCount ?? raw.factLedger
      if (out.factCount === undefined && Array.isArray(facts)) out.factCount = facts.length
      if (out.factCount === undefined && Number.isInteger(facts) && facts >= 0) out.factCount = facts
      const task = raw.task ?? raw.currentTask
      if (out.task === undefined && typeof task === 'string' && task.trim() !== '') {
        out.task = { title: task.trim() }
      } else if (out.task === undefined && task !== null && typeof task === 'object') {
        const title = task.title ?? task.content ?? task.name
        if (typeof title === 'string' && title.trim() !== '') out.task = { id: task.id, title: title.trim() }
      }
    }
  } catch {
    /* 兜底探测失败无所谓 */
  }

  return Object.keys(out).length === 0 ? undefined : out
}

/** 渲染"当前任务"字段：store 给了 id 就带编号。 */
function renderTaskField(task) {
  const title = `"${clipTitle(task.title)}"`
  return task.id === undefined || task.id === null ? `当前任务 ${title}` : `当前任务 #${task.id} ${title}`
}

/** 把配置里的终结通道解析成合法值，非法输入回落默认。 */
export function resolveSettlementChannel(config) {
  const raw = config?.settlementChannel
  return SETTLEMENT_CHANNELS.includes(raw) ? raw : DEFAULT_SETTLEMENT_CHANNEL
}

/**
 * 渲染整行。所有字段都无话可说时返回 undefined（此时不注入任何消息）。
 * @param events - 持久事件流。
 * @param options - `{ delegationTools?, settlement?, store? }`。
 * @returns 形如 `[任务部队: ...]` 的字符串，或 undefined。
 */
export function renderWorkingContext(events, options) {
  const delegationTools = options?.delegationTools ?? new Set(DEFAULT_DELEGATION_TOOLS)
  const settlement = options?.settlement ?? DEFAULT_SETTLEMENT_CHANNEL
  const flow = foldSubagentFlow(events, delegationTools, settlement)
  const store = readStoreState(options?.store, options?.runId) ?? {}
  const fields = []

  if (store.wave !== undefined) fields.push(`波次 ${store.wave}`)

  const inFlight = store.inFlight ?? flow.inFlight
  if (inFlight > 0) fields.push(`在飞 ${inFlight}`)

  const todos = inProgressTodos(events)
  const task = store.task ?? todos[0]
  if (task !== undefined) fields.push(renderTaskField(task))

  // 降级口径：已终结的派活数 = 本会话已回收到多少份子代理产物。用所选通道计数，
  // 不做两通道相加（那会在 continuable 下把一次派活算成两份事实）。
  const factCount = store.factCount ?? flow.settled
  if (factCount > 0) fields.push(`最近事实 ${factCount} 条`)

  if (fields.length === 0) return undefined
  return `[任务部队: ${fields.join(' · ')}]`
}

/** 一条消息的文本内容（跨文本块拼接）。 */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** 该消息是否为本插件发布的 working-context 行。 */
export function isContextMessage(message) {
  const source = message?.source
  return source?.kind === name || (source?.kind === 'plugin' && source?.plugin === name)
}

/** 可见面 seq 集合；会话不暴露可见面时返回 undefined（= 不做可见性过滤）。 */
function visibleSeqSet(session) {
  const nodes = session?.surface?.nodes
  return Array.isArray(nodes) ? new Set(nodes) : undefined
}

/**
 * 从持久日志读回"已发布状态"：最新一条**可见**副本的文本；
 * 若全部副本都被遮蔽（压缩）则只给 `published` 标志、不给文本 ——
 * 后者正是"压缩后必须重发"的判据。
 * @param agent - 智能体对象。
 * @returns `{ published, text? }`。
 */
export function contextHistory(agent) {
  const session = agent?.session
  const events = sessionEvents(session)
  const visible = visibleSeqSet(session)
  let published = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' || !isContextMessage(event.data)) continue
    published = true
    if (visible === undefined || typeof event.seq !== 'number' || visible.has(event.seq)) {
      return { published, text: textOf(event.data) }
    }
  }
  return { published }
}

/** 构造一条持久 working-context 消息。 */
export function createContextMessage(line) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: line }],
    source: { kind: name },
  }
}

/** 可选读取外部 store：任何失败都降级，绝不抛出。 */
function readService(ctx, key) {
  try {
    return ctx?.get?.(key)
  } catch {
    return undefined
  }
}

/** 注册每步的 working-context 注入。 */
export function apply(ctx, config) {
  const delegationTools = resolveDelegationTools(config)
  const settlement = resolveSettlementChannel(config)
  const storeKey = typeof config?.storeService === 'string' && config.storeService.trim() !== ''
    ? config.storeService.trim()
    : 'taskforceStore'

  /**
   * 推导本会话的 run 归属：主会话 = 自身 sessionId；子代理 = 上溯到第一个
   * 非子代理祖先（根会话）的 id ⇒ **同一棵树共享一个 run**。
   *
   * 这里是**极简内联版**：真相源在 `lib/tools/index.js` 的 `deriveIdentity()`
   * （模型可见工具走那一条，带错误码、缓存与完整依据）。本插件刻意保持
   * **零 import 的自足性** —— 它是 preset-local 的纯折叠件，不该因为一个可选
   * 投影而耦合到带顶层 await 的工具层。
   *
   * 失败一律返回 `undefined`：store 字段缺席、退回 todo/flow 折叠，
   * **绝不成为会话的失败点**（与本插件其余部分的降级口径一致）。
   * @param agents - `ctx.get('agents')`（可能 undefined）。
   * @param agent - 当前 agent。
   * @returns run 标识，或 undefined。
   */
  const resolveRunId = (agents, agent) => {
    try {
      const header = agent?.session?.header
      if (header === null || header === undefined) return undefined
      if (typeof header.id !== 'string' || header.id === '') return undefined
      const isChild = h => h?.origin === 'subagent'
        || (typeof h?.delegationDepth === 'number' && h.delegationDepth > 0)
      if (!isChild(header)) return header.id
      let current = header
      for (let hop = 0; hop < 32; hop += 1) {
        const parentId = current?.parentSession
        if (typeof parentId !== 'string' || parentId === '') return undefined
        const parentHeader = agents?.get?.(parentId)?.session?.header
        if (parentHeader === null || parentHeader === undefined) {
          // 父不在活动表：depth===1 ⇒ 父必然是根（delegationDepth 语义 = 父 + 1，
          // 且 parentSession 由宿主落盘、不可伪造）。更深则拒绝 Service，
          // 绝不把"树中间"当根（会串 run）。
          return current.delegationDepth === 1 ? parentId : undefined
        }
        if (!isChild(parentHeader)) return parentHeader.id
        current = parentHeader
      }
      return undefined
    } catch {
      return undefined
    }
  }


  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (agent?.session === undefined) return decision

    // **身份解析失败时不要传 store**：`runId === undefined` 在 store 里指向
    // 「未归属域」—— 那是迁移之前的遗留行，不是"本会话没有数据"。照传会把
    // 旧任务标题与旧事实计数注入当前会话（独立复审复现过这条路径）。
    // 契约：**身份未知 ≠ 可以查 legacy**；此时只保留本会话的 todo/flow 折叠。
    const runId = resolveRunId(readService(ctx, 'agents'), agent)
    const line = renderWorkingContext(sessionEvents(agent.session), {
      delegationTools,
      settlement,
      store: runId === undefined ? undefined : readService(ctx, storeKey),
      runId,
    })

    const history = contextHistory(agent)
    const existing = decision.messages.find(isContextMessage)

    // 无话可说：不注入。已有的旧行留给压缩自然老化，不写空标记。
    if (line === undefined) {
      if (existing === undefined) return decision
      return { ...decision, messages: decision.messages.filter(message => message.id !== existing.id) }
    }

    // 已发布副本仍是这一行：撤掉本步副本（历史副本足够），避免每步复制。
    if (history.text === line) {
      if (existing === undefined) return decision
      return { ...decision, messages: decision.messages.filter(message => message.id !== existing.id) }
    }
    // 本步副本就是这一行：保持不动。
    if (existing !== undefined && textOf(existing) === line) return decision

    const message = createContextMessage(line)
    if (existing === undefined) {
      return { ...decision, messages: [...decision.messages, message] }
    }
    return {
      ...decision,
      messages: decision.messages.map(item => (item.id === existing.id ? message : item)),
    }
  }, { prepend: true })
}
