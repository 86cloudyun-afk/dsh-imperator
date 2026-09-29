/**
 * @local/dsh-taskforce — P2「事实库」的 agent 平面工具行
 *
 * 只注册模型可见工具，自己不发布任何服务（所以不需要 isolate realm）。
 * 消费的是 host 平面 `taskforceStore`（lib/store/index.js 发布），
 * 与 dsh-redteam-mode 的 lib/tools.js 取 `ctx.redteam` 是同一套机制。
 *
 * API 依据（不猜，逐条实测/读源）：
 *   · `ctx.tools.register(definition): () => void`
 *     —— @deepseek-ai/dsh-tools lib/types/index.d.ts:634-636。
 *   · `defineTool(options)` 接收 `{ name, description, parameters, output, execute }`，
 *     把参数 DSL（每项 `{ type, required?, enum?, description? }`）编译成 raw JSON Schema
 *     —— lib/types/schema.d.ts:177-248；实测：`{ a: { type:'string', required:true } }`
 *     编译为 `{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}`。
 *     `execute` 的签名是 **`(args, exec: ToolRunContext)`** ——
 *     lib/types/schema.d.ts:210 `execute(args: InferArgs<S>, exec: ToolRunContext)`，
 *     与 lib/types/index.d.ts:128 同形。**第二个参数是本文件全部身份判据的入口。**
 *   · `ctx.get(name, strict?): any | undefined` 读服务，无该服务时返回 undefined
 *     —— @deepseek-ai/cordis lib/types/reflect.d.ts:14-16。
 *
 * ── 身份推导（缺口 A 的关键，逐条给依据）────────────────────────────────
 *
 * **身份只能来自宿主，绝不能来自模型参数。** 链路如下：
 *
 * 1. **宿主把调用者 Agent 塞进每次工具执行**：
 *    @deepseek-ai/dsh-tools `ToolExecutionInput.agent?: Agent`
 *    —— lib/types/index.d.ts:228-229 注释原文
 *    "The agent on whose behalf the call runs (set by the agent loop)."
 *    填充点是 agent 循环本身：@deepseek-ai/dsh-agent-loop lib/index.js:509-520
 *    ```js
 *    async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {
 *      const agent = ctx.agents.requireInitiator();
 *      ...
 *      exec: { callId: block.id, name: block.name, arguments: parseArguments(block.arguments), agent, signal }
 *    ```
 *    即 `exec.agent` 由宿主注入，模型无法伪造。
 *
 *    **上溯用的服务**：`ctx.get('agents')` —— host 平面的活动 agent 表。契约
 *    （`cordis_inspect_query(host, Service, listService)` 实测原文）：
 *    "Agent service (`ctx.agents`): tracks live agents and carries the initiating
 *     Agent through one process-local asynchronous driver chain."
 *    方法签名：`get(id: SessionId): Agent | undefined` / `requireInitiator(): Agent` /
 *    `list(): Agent[]` / `roots(): Agent[]`。`requireInitiator()` 正是 agent 循环
 *    给 `exec.agent` 赋值的那一支（dsh-agent-loop lib/index.js:510）。
 *    该服务只在**本进程活动表**里可见；不在表里的祖先按下面的 depth 规则处理。
 *
 * 2. **Agent → 会话头**：`Agent.session: Session`（@deepseek-ai/dsh-agent
 *    lib/types/runtime-types.d.ts:143 "The live session this agent drives"），
 *    `Session.header: SessionHeader`（@deepseek-ai/dsh-session lib/types/index.d.ts:119）。
 *    `SessionHeader` 字段见 @deepseek-ai/dsh-session lib/types/types.d.ts:58-98：
 *    `id` / `parentSession?` / `origin?: 'subagent'` / `delegationDepth?`。
 *
 * 3. **子代理判据**：子代理会话头由 @deepseek-ai/dsh-subagent
 *    lib/types/child-agent.js:112-127 `childSessionMeta()` **统一**写入
 *    （spawn 与 fork 两条路径共用这一个函数）：
 *    ```js
 *    return { ..., parentSession: parentHeader.id, isSeeded, origin: 'subagent', delegationDepth: childDepth };
 *    ```
 *    运行时另在 `options.subagentDepth` 打戳（同文件 resolveChildAgentOptions）；
 *    `delegationDepthOf()`（lib/types/depth.js:15-25）取两者最大值。
 *    所以子代理 = `origin === 'subagent'` 或 `depth > 0`。
 *    **`parentSession` 单独存在不算子代理** —— 它同时表达 fork 血缘
 *    （types.d.ts:80 "The session this one was forked from (seed lineage)"），
 *    手工 fork 出来的主会话不应因此丢掉验收权。
 *
 * 4. **上溯到根**：与官方 @deepseek-ai/dsh-subagent
 *    lib/types/continuation-activation.js:402-415 `liveLineage()` 同构 ——
 *    沿 `session.header.parentSession` 走，用 `ctx.agents.get(id)` 解析每一跳
 *    （`liveLineage` 遇到不 live 的祖先就停）。本插件的差别：**链断时不降级**，
 *    直接拒绝服务（见下）。
 *
 * 5. **run 归属语义**：主会话用自身 sessionId；子代理用其**根会话** id
 *    ⇒ 同一棵树共享一个 run，不同主会话互相隔离。
 *
 * **失败方向（硬约束）**：身份推不出来时**拒绝服务**，绝不退化成"看全部"或
 * "落到未归属域"。宁可某个并行度受限的会话拿不到工具，也不能让两个工作实例
 * 互相看见、互相关单。
 */

/** Cordis 插件名。 */
export const name = 'taskforce-tools'

/** 硬依赖：工具注册表。事实库服务走 ctx.get 软解析（见 resolveService）。 */
export const inject = ['tools']

/** host 平面服务名。 */
const STORE_SERVICE = 'taskforceStore'

/** host 平面的活动 agent 表（上溯祖先链用）。 */
const AGENTS_SERVICE = 'agents'

/** `acceptTask` / `rejectTask` 需要的 actor 角色（与数据层同值）。 */
export const LEAD_ACTOR = 'lead'

/** 身份推导失败的稳定错误码（自测按码断言，不按文案）。 */
export const IDENTITY_CODES = {
  noAgent: 'E_NO_AGENT',
  noSession: 'E_NO_SESSION',
  noAgentsService: 'E_NO_AGENTS_SERVICE',
  brokenChain: 'E_BROKEN_CHAIN',
  cycle: 'E_CYCLE',
}

/** 身份错误码判定集（含子代理平面的 `E_CHILD_NO_AGENT`；声明在 CHILD_ERROR_CODES 之后）。 */

/** 服务缺失时的固定提示（模型据此决定上报而不是重试）。 */
const HINT_SERVICE = '事实库未挂载：这是部署问题（合成里 taskforce-store 行没启用），不是参数问题；不要反复重试，直接向用户报告。'

/** 输入/对象标识出错时的固定提示。 */
const HINT_INPUT = '参数或对象标识有问题：先 task_board 看现有任务与事实，核对 id 与取值后重试；失败不要静默跳过。'

const HINT_STORE_BUSY = 'SQLite 写锁繁忙：稍后有限次数重试，并在每次重试前核对任务状态；持续繁忙就报告给用户。'
const HINT_TASK_CONFLICT = '任务状态或认领者发生竞争：先 task_board 读板核对最新 owner 与状态，再决定下一步；不要盲目重试认领。'

/** 身份推导失败时的固定提示（与参数错误严格区分：这不是重试能解决的）。 */
const HINT_IDENTITY = '调用者身份不可得：这是宿主集成问题，不是参数问题。不要重试、不要改参数绕过；直接向用户报告这一行。为保住工作实例隔离，身份不可得时拒绝服务。'

/** 越过提交/验收边界的固定提示。 */
const HINT_ROLE = '提交与验收是分开的两步：执行者只能 task_submit，验收只能由主会话 task_accept / task_reject。这不是可以重试的参数问题 —— 换工具名重试也不会成功。'

/**
 * 终态（已收口）任务被要求改写结论时的固定提示。
 * 对应数据层 `E_TERMINAL`：这是**状态机边界**，不是参数问题。
 */
const HINT_TERMINAL = '任务已收口（accepted / cancelled 等终态）：终态结论不会被任何普通写入自动改写 —— '
  + '包括晚到的 task_close(failed)、重复 submit、以及事后补落的事实。这不是参数问题，重试无用。'
  + '需要继续做就开新任务；只有当结论确实错了（例如收口之后又发现了阻塞）时，'
  + '由主会话对同一 task_id 调 task_reject（reason 必填）= **显式重新复核**：'
  + '任务会置回 rejected、重新出现在默认待办板。收口后发现的阻塞请直接 task_fact(kind=blocker)，'
  + '这类"晚到阻塞"允许落库（不改结论，会出现在看板的 late_blockers 区）。'

/**
 * 验收缺执行依据时的固定提示。
 * 对应数据层 `E_EVIDENCE_MISSING`：只认可非 REFUTED 的事实或产物指针。
 */
const HINT_EVIDENCE = '验收需要有效执行依据：confidence 为 CONFIRMED / PLAUSIBLE，且 kind=fact / artifact 或带非空 evidence_path[:line]。'
  + 'REFUTED 不算；提交说明、打回理由、验收记录这些无路径的 decision 也不算。'
  + '这不是参数问题：先让执行者 task_fact 落证据再 task_submit，然后重新 task_accept。'
  + '确实无法产出证据时（探索性调查、被外部条件阻塞），由主会话在 task_accept 里写明 waiver_reason '
  + '做显式人工豁免 —— 验收记录会标「人工豁免」，不会混进"已验证事实"。'

const HINT_RESOLUTION = 'resolves_fact_id 只能由同任务、同 run 的 kind=decision 且 confidence=CONFIRMED / PLAUSIBLE 指向 blocker；'
  + 'artifact、fact 或 REFUTED 不能解阻塞。请核对 blocker fact_id 后重新落有效 decision。'

/**
 * 跨工作实例（run）操作被拒时的固定提示。
 * 对应数据层 `E_CROSS_RUN`：这是**隔离边界**，既不是参数问题，也不是子代理归属问题。
 */
const HINT_CROSS_RUN = '任务归属另一个工作实例（run）：读 / 落事实 / 结任务都只能作用于本 run 的任务 —— '
  + '同一棵子代理树共享一个 run，不同主会话互相隔离。这不是参数写法问题：'
  + '先核对 task_id 是从哪次会话拿到的（task_board 只看得到本 run 的任务，跨 run 的 id 抄得再对也读不到）。'
  + '不要重试、不要换 id 试探 —— 该任务由它所属的那次会话自己处理，把这一行报给用户即可。'

/** host 平面子代理服务名（**软解析**：合成里没有它也不影响事实库那 8 个工具）。 */
const SUBAGENTS_SERVICE = 'subagents'

/** 本包子代理控制工具的**专属**错误码（与既有码空间分开，便于自测按码断言）。 */
export const CHILD_ERROR_CODES = {
  service: 'E_CHILD_SERVICE',
  input: 'E_CHILD_INPUT',
  noAgent: 'E_CHILD_NO_AGENT',
  notOwn: 'E_CHILD_NOT_OWN',
  missing: 'E_CHILD_MISSING',
  settled: 'E_CHILD_SETTLED',
  noId: 'E_CHILD_NO_ID',
}

/** 身份可用、但授权/对象/服务不成立时的固定提示（每次都带 `target_id`，模型能就地决定重取或上报）。 */
const HINT_CHILD = '这不是「换个人重试」能解决的问题：target_id 必须是**你这次执行任务时自己派出的**子代理 id（子代理清单可见）。'
  + '跨会话、非直属的 id 会被拒绝，不要重试、不要换参数绕过。'
  + '要用任务的共享状态通道先 task_board 核对；续作/停止与 Agent Teams 的 send_message / interrupt_agent 是**两套不同的平面**，'
  + 'teammate 的工具不认子代理，对应不上就向主控报告这一行。'

/** 子代理服务缺失时的固定提示。 */
const HINT_CHILD_SERVICE = '子代理平面（ctx.subagents）不可用：这是部署或宿主集成问题，不是参数问题。'
  + '不要重试、不要改用 send_message / interrupt_agent 去凑（那是 Agent Teams 平面，不认子代理）；直接向主控报告这一行。'

/** 身份错误码判定集（含子代理平面的 `E_CHILD_NO_AGENT`）。 */
const IDENTITY_CODE_SET = new Set([...Object.values(IDENTITY_CODES), CHILD_ERROR_CODES.noAgent])

/** 本地兜底编译器的注解字段（与真身一致）。 */
const ANNOTATIONS = ['description', 'title', 'default', 'examples']

/** 从真身取 defineTool；失败则置空，改用本地实现。 */
let nativeDefineTool = undefined
try {
  ({ defineTool: nativeDefineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  nativeDefineTool = undefined
}

/** 真身 defineTool 是否可用（诊断与自测用）。 */
export const usingNativeDefineTool = typeof nativeDefineTool === 'function'

/**
 * 参数 DSL 单项 → raw JSON Schema。
 * 与真身 `parameterSchemaSpecToJsonSchema` 的输出逐字段一致（自测 S31 有断言）。
 * @param spec - 作者侧 schema 节点。
 * @returns raw JSON Schema 节点。
 */
export function compileValueSchema(spec) {
  const node = {}
  for (const key of ANNOTATIONS) {
    if (spec[key] !== undefined) node[key] = spec[key]
  }
  if (Array.isArray(spec.oneOf)) {
    node.oneOf = spec.oneOf.map(compileValueSchema)
    return node
  }
  switch (spec.type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      node.type = spec.type
      if (Array.isArray(spec.enum)) node.enum = [...spec.enum]
      if (spec.const !== undefined) node.const = spec.const
      return node
    }
    case 'array':
      node.type = 'array'
      if (spec.items !== undefined) node.items = compileValueSchema(spec.items)
      return node
    case 'object': {
      node.type = 'object'
      node.additionalProperties = spec.additionalProperties === true
      node.properties = compileParameters(spec.properties ?? {})
      return node
    }
    default:
      // 作者侧 `json` 节点在真身里退化为纯注解，这里保持一致。
      return node
  }
}

/**
 * 参数表 → 隐式开放对象根。
 * @param parameters - 每属性 schema（`required: true` 标记必填）。
 * @returns raw JSON Schema 对象根。
 */
export function compileParameters(parameters) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = compileValueSchema(spec)
    if (spec.required === true) required.push(key)
  }
  const root = { type: 'object', properties }
  if (required.length > 0) root.required = required
  return root
}

/**
 * 兜底 defineTool：产出与真身同形的 ToolDefinition。
 * @param options - 同真身的选项。
 * @returns 注册表可直接消费的定义。
 */
function fallbackDefineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters ?? {}),
    output: options.output,
    execute: options.execute,
  }
}

/** 最终使用的构造器。 */
const define = typeof nativeDefineTool === 'function' ? nativeDefineTool : fallbackDefineTool

/** 输出声明（本插件所有工具都返回紧凑 JSON 字符串）。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/**
 * 兜底取消信号：`SubagentSendMessageOptions.signal` 是**必填**字段
 * （契约原文 `{ readonly signal: AbortSignal }`），所以永远不能传 undefined。
 * 服务只把 caller 取消当作「**接纳之前**」的放弃理由，绝不取消已经接纳的投递；
 * 因此这里只转发调用方自己的取消，没有就填一个永不自燃的信号。
 */
const INERT_ABORT_SIGNAL = Object.freeze({
  aborted: false,
  reason: undefined,
  onabort: null,
  throwIfAborted() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false },
})

/**
 * 取本次调用的取消信号：只认调用方自己真实存在的那一个，否则填兜底。
 *
 * 真身 `sendMessage` 会直接调用 `options.signal.throwIfAborted()`
 * （见 /opt/dsh/install/node_modules/@deepseek-ai/dsh-subagent/lib/types/continuation.js:196），
 * 所以 `signal` 既不能省略、也不能是缺方法的裸对象 —— 官方工具传的是 `exec.signal`。
 * 兜底只在宿主不符合契约时生效，并且会留下一条可观测告警：宁可继续投递（取消只是
 * 「接纳前放弃」的语义，不是必须发生的），也不把「宿主没给信号」升级成投递失败。
 *
 * @param exec - 工具执行上下文（宿主可能不带信号）。
 * @param warn - 告警回调（兜底生效时调用一次）。
 * @returns AbortSignal 或结构等价的兜底对象。
 */
function resolveSendSignal(exec, warn) {
  const candidate = exec?.signal
  if (candidate !== null && typeof candidate === 'object' && 'aborted' in candidate) return candidate
  warn?.('调用上下文没有可用 signal：已用兜底不取消信号投递（宿主 ToolRunContext 应提供 exec.signal）。')
  return INERT_ABORT_SIGNAL
}

/* ─────────────────────────── 身份推导 ─────────────────────────── */

/**
 * 构造带 `code`（与可选 `hint`）的异常。
 *
 * 子代理平面（task_child_send / task_child_stop）用同一工厂造错，
 * 好处是**失败分类统一**：调用方永远能靠 `code` 分流，靠 `hint` 决定重试还是上报。
 *
 * @param code - 稳定错误码（见 {@link IDENTITY_CODES} / {@link CHILD_ERROR_CODES}）。
 * @param message - 可读错误正文（写清「谁、对谁、为什么不成立」）。
 * @param hint - 可选固定提示；缺省由 `wrap` 按 code 归类。
 * @returns 带码的 Error。
 */
function codedError(code, message, hint) {
  const error = new Error(message)
  error.code = code
  if (hint !== undefined) error.hint = hint
  return error
}

/** 构造带错误码的身份错误（`codedError` 的身份平面别名，既有调用点语义不变）。 */
function identityError(code, message) {
  return codedError(code, message)
}

/**
 * 读一个 Agent 的会话头（字段全部做防御性归一）。
 * @param agent - 候选 Agent。
 * @returns `{ id, parentSession, origin, depth }`；无法取到 id 时返回 undefined。
 */
function readHeader(agent) {
  if (agent === null || typeof agent !== 'object') return undefined
  const header = agent.session?.header
  const id = typeof header?.id === 'string' && header.id !== ''
    ? header.id
    : (typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined)
  if (id === undefined) return undefined
  const runtimeDepth = agent.options?.subagentDepth
  const headerDepth = header?.delegationDepth
  const depths = [headerDepth, runtimeDepth].filter((n) => Number.isSafeInteger(n) && n >= 0)
  return {
    id,
    parentSession: typeof header?.parentSession === 'string' && header.parentSession !== ''
      ? header.parentSession
      : null,
    origin: header?.origin,
    depth: depths.length === 0 ? 0 : Math.max(...depths),
  }
}

/** 是不是子代理会话（spawn 与 fork 两条路径共用同一 header 写入点）。 */
function isSubagentHeader(header) {
  return header.origin === 'subagent' || header.depth > 0
}

/**
 * 从工具执行上下文推导调用者的**工作实例归属（run）**。
 *
 * 语义：主会话用自身 sessionId；子代理用其「根会话」id ⇒ 同一棵树共享一个 run，
 * 不同主会话互相隔离。**只读**，不产生任何副作用。
 *
 * @param agent - 宿主注入的调用者 Agent（`exec.agent`）。缺失即拒绝。
 * @param agentsService - `ctx.get('agents')`（祖先链解析用；`get(id) → Agent`）。
 * @param options - `{ warn }` 可选告警回调 + `{ cache }` 缓存 Map（成功结果）。
 * @returns `{ runId, sessionId, isRoot, isSubagent, depth, lineage }`。
 * @throws 带 `code` 的身份错误（见 {@link IDENTITY_CODES}）——**绝不返回降级值**。
 */
export function deriveIdentity(agent, agentsService, options = {}) {
  const header = readHeader(agent)
  if (header === undefined) {
    throw identityError(
      IDENTITY_CODES.noAgent,
      '无法确定调用者身份：工具执行上下文里没有可用的 agent / session（exec.agent 缺失）。'
      + '事实库按调用者的工作实例隔离，身份不可得时拒绝服务，而不是退化成看全部。',
    )
  }
  const cache = options.cache
  const cached = cache instanceof Map ? cache.get(header.id) : undefined
  if (cached !== undefined) return cached

  // 非子代理（含手工 fork 出来的主会话）：它自己就是工作实例的根。
  if (!isSubagentHeader(header)) {
    const identity = {
      runId: header.id,
      sessionId: header.id,
      isRoot: true,
      isSubagent: false,
      depth: header.depth,
      lineage: [header.id],
      source: 'self-root',
    }
    cache?.set(header.id, identity)
    return identity
  }

  // 子代理：沿 parentSession 上溯到第一个非子代理的祖先。
  const lineage = [header.id]
  const seen = new Set([header.id])
  let root = header
  while (isSubagentHeader(root)) {
    const parentId = root.parentSession
    if (parentId === null) {
      throw identityError(
        IDENTITY_CODES.brokenChain,
        `无法确定工作实例：会话 ${root.id} 标记为子代理（origin=${JSON.stringify(root.origin)}，depth=${root.depth}）`
        + '但会话头里没有 parentSession，上溯链在此断掉。为避免把不同工作实例的事实混在一起，本次调用被拒绝。',
      )
    }
    if (seen.has(parentId)) {
      throw identityError(
        IDENTITY_CODES.cycle,
        `无法确定工作实例：会话祖先链出现环（${[...lineage, parentId].join(' → ')}）。`,
      )
    }
    const parent = typeof agentsService?.get === 'function' ? agentsService.get(parentId) : undefined
    const parentHeader = readHeader(parent)
    if (parentHeader === undefined) {
      // 父不在活动表（已卸载 / 主会话重启过 / agents 服务取不到）。
      //
      // **depth === 1 时可以安全地用父 id 当 run**：`delegationDepth` 的语义是
      // 父 depth + 1（@deepseek-ai/dsh-subagent lib/types/child-agent.js:33
      // `const childDepth = delegationDepthOf(parent) + 1;`），所以 depth=1 的会话
      // 其父的 depth 必然是 0 —— 顶层会话就是本树的根。而 `parentSession` 是宿主在
      // `childSessionMeta()` 里落盘的（同文件 :112-127），模型无法伪造。
      // 因此这条放宽既不会把两个工作实例并到一起，也不会放宽可见范围。
      //
      // depth > 1 时无法确定中间层是不是子代理 ⇒ 仍然拒绝（宁可不服务也不串 run）。
      if (root.depth === 1) {
        lineage.push(parentId)
        root = { id: parentId, parentSession: null, origin: undefined, depth: 0 }
        break
      }
      throw identityError(
        IDENTITY_CODES.brokenChain,
        `无法确定工作实例：从会话 ${root.id} 沿 parentSession 上溯到 ${parentId} 时解析不到该会话`
        + `（工作实例解析需要 host 平面 "agents" 服务：${agentsService === undefined ? '当前上下文取不到它' : '该祖先已不在活动表中'}），`
        + `且本会话 delegation depth=${root.depth} > 1，无法据此断定祖先就是根。`
        + '为避免把两个工作实例的事实混在一起，本次调用被拒绝；请让主会话核对后重试，或报告这一行。',
      )
    }
    lineage.push(parentHeader.id)
    seen.add(parentHeader.id)
    root = parentHeader
  }

  const identity = {
    runId: root.id,
    sessionId: header.id,
    isRoot: root.id === header.id,
    isSubagent: true,
    depth: header.depth,
    lineage,
    source: 'lineage-root',
  }
  cache?.set(header.id, identity)
  return identity
}

/**
 * 10→10 个工具的模型可见定义（名称 → 描述与参数 DSL）。
 * 单独导出是为了让自测能在**真实规格**上做「兜底 ≡ 真身」的编译等价断言。
 *
 * 描述里一律写清「谁能调、调了会怎样」：权限差异在工具层用身份判据强制，
 * 提示词只做说明，不承担约束。
 */
export const TOOL_SPECS = {
  task_open: {
    description:
      '在共享事实库开一个任务，返回 task_id。任务是你与子代理之间唯一的共享状态通道：'
      + '子代理只认 task_id，不看聊天记录。派活前先开任务，把「怎么算成了」写进 note。'
      + '任务自动归属**当前工作实例**（由宿主按调用者身份判定，不取参数）。'
      + '主会话与子代理都能调。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: '任务标题：一句话说清要达成什么，尽量可机械检查',
      },
      note: {
        type: 'string',
        description: '补充说明：验收判据、已知输入、死路、边界。子代理会读到它',
      },
    },
  },

  task_claim: {
    description:
      '把任务认领给某个子代理（child_id 用派发时拿到的 childId 或你约定的代号）。'
      + '认领后 owner 落库；已被别人认领的任务会拒绝重复认领，避免两个子代理同时写同一个任务。'
      + '只能认领**当前工作实例**内、状态为 open 或 rejected 的任务；跨工作实例或状态不对会明确报错。'
      + 'owner 只是标签（谁在干），不是权限来源 —— 任务归属永远由宿主按身份判定。',
    parameters: {
      task_id: { type: 'integer', required: true, description: '任务 id（task_open 的返回值）' },
      child_id: { type: 'string', required: true, description: '认领者的子代理代号 / childId' },
    },
  },

  task_fact: {
    description:
      '往任务上落一条事实 —— 这是核对时唯一可信的东西。消息只保证「已接受」，子代理的自述不算数，'
      + '只有落库的事实能被主会话读到并复算。kind：fact=已验证事实 / artifact=产出物路径 / '
      + 'decision=决策 / blocker=阻塞。confidence：CONFIRMED 能指名证据行 / PLAUSIBLE 机制可信但未复现 / '
      + 'REFUTED 已被证伪（缺省 PLAUSIBLE）。'
      + '解阻塞用同任务、同 run 的 kind=decision + CONFIRMED / PLAUSIBLE，并带上 resolves_fact_id=<那条 blocker 的 fact_id>；'
      + '只要还有**未解** blocker，主会话的 task_accept 就会被拒。'
      + '**验收门槛**：任务上至少要有一条 CONFIRMED / PLAUSIBLE 的 fact / artifact（或带非空 evidence_path 的产物指针）才算"有执行依据"；REFUTED 不算 —— '
      + '只落 decision 不构成依据，task_accept 会被拒（E_EVIDENCE_MISSING）。'
      + '**任务已收口（accepted/cancelled）后**只有 kind=blocker 允许落：'
      + '它会被标成「晚到阻塞」（不改结论，立刻出现在默认看板的 late_blockers 区），其余 kind 一律被拒（E_TERMINAL）。'
      + '任务必须属于**当前工作实例**，跨实例写入被拒。主会话与子代理都能调。',
    parameters: {
      task_id: { type: 'integer', required: true, description: '任务 id' },
      kind: {
        type: 'string',
        required: true,
        enum: ['fact', 'artifact', 'decision', 'blocker'],
        description: '事实类型：fact / artifact / decision / blocker',
      },
      statement: {
        type: 'string',
        required: true,
        description: '一句可核查的陈述（不要写「已完成」这类无法核查的话；带数值、路径、版本）',
      },
      evidence_path: {
        type: 'string',
        description: '证据文件路径（例如 /root/Hack/findings/evidence/x/run.log）',
      },
      evidence_line: { type: 'integer', description: '证据行号（配合 evidence_path 定位到行）' },
      confidence: {
        type: 'string',
        enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'],
        description: '置信度，缺省 PLAUSIBLE',
      },
      resolves_fact_id: {
        type: 'integer',
        description: '要消解的 blocker 事实 id（仅同任务、同 run 的 decision + CONFIRMED/PLAUSIBLE 可使用）',
      },
      child_id: { type: 'string', description: '落这条事实的子代理代号（写进 created_by）' },
    },
  },

  task_submit: {
    description:
      '**提交任务待验收**（执行者的收口动作）：状态 claimed/open → submitted。'
      + '**子代理与主会话都能调，但提交不等于完成** —— 它只是把任务交到主会话的验收队列里。'
      + '提交后任务仍会出现在默认看板里（主会话的待办来源）；'
      + '要真正收口，只能由主会话 task_accept（验收通过）或 task_reject（打回）。'
      + '有未解 blocker 时提交仍会成功，但会带回 warnings，且后续 task_accept 会被拒。'
      + '重复提交幂等（already:true）。',
    parameters: {
      task_id: { type: 'integer', required: true, description: '任务 id' },
      note: {
        type: 'string',
        description: '提交说明（会作为一条 decision 事实落库，主会话核对时读得到）',
      },
    },
  },

  task_accept: {
    description:
      '**验收通过**：状态 submitted → accepted，任务真正收口（**终态**，之后任何普通写入都不能再改写它）。'
      + '**只有主会话能调**（身份判据在工具层强制，不看提示词）：子代理调用会被拒并返回可读错误，'
      + '因为执行者不能自批。'
      + '要求任务已经是 submitted（不能被验收两次，也不能跳过提交直接验收）；'
      + '**存在未解 blocker 的任务一律拒绝验收**（返回可读错误并逐条列出 blocker 的 fact_id 与陈述），'
      + '不是 warning —— 先把 blocker 解掉（落 decision 事实 + resolves_fact_id）再验收。'
      + '**必须有执行依据**：任务上至少一条 confidence=CONFIRMED/PLAUSIBLE 的 fact / artifact（或带非空 evidence_path 的产物指针）；REFUTED 不计，'
      + '否则拒绝验收（code=E_EVIDENCE_MISSING）—— 提交说明、打回理由、验收记录这些系统写下的 decision 都不算依据。'
      + '确实无法产出证据时用 `waiver_reason` 做**显式人工豁免**：这是例外通道，'
      + '验收记录会写明「人工豁免」，**不会**混进"已验证事实"，板上可查，别拿它当常规路径。'
      + '验收记录本身是**系统裁决记录**（decision + PLAUSIBLE，evidence 如实为空，并列出被采信的依据事实 id），'
      + '不冒充 CONFIRMED 的已验证事实。'
      + '只能作用于当前工作实例内的任务，跨实例被拒。',
    parameters: {
      task_id: { type: 'integer', required: true, description: '任务 id' },
      note: { type: 'string', description: '验收附注：核对了哪些证据、哪些是保留意见' },
      waiver_reason: {
        type: 'string',
        description: '人工豁免理由（**仅在没有执行依据且确实无法产出时使用**；会给验收记录打上「人工豁免」标记）',
      },
    },
  },

  task_reject: {
    description:
      '**主会话的否决权**：任务 submitted → rejected（打回执行者重做），或对**已收口**的任务做**重新复核**。'
      + '**只有主会话能调**（与 task_accept 同一身份判据）；子代理调用被拒。'
      + '**reason 必填**：打回必须给出可执行的理由，否则子代理无法知道要补什么。'
      + '**对终态任务（accepted / cancelled）**：同一条命令 = 推翻已签发结论的**显式重新复核** —— '
      + '任务置回 rejected 并**重新出现在默认待办板**，返回体带 reopened / previous_status，'
      + '并列出复核时挂着的未解晚到阻塞。这是把"收口后才发现的问题"变回可处理状态的唯一通道。'
      + '落一条 decision 事实（不是 blocker —— 打回本身不该把任务卡死，'
      + '否则重做后重新提交会因自造阻塞永远验不过）。'
      + '打回后原认领者用 task_claim 重新认领（rejected 状态可再认领），补完事实再 task_submit。',
    parameters: {
      task_id: { type: 'integer', required: true, description: '任务 id' },
      reason: {
        type: 'string',
        required: true,
        description: '打回 / 重新复核理由：具体缺什么、要补哪条证据、验收判据差在哪、为什么要推翻结论',
      },
    },
  },

  task_close: {
    description:
      '**兼容别名，不产生最终完成**：result=done/partial 等价于 task_submit（提交待验收），'
      + 'result=failed 等价于放弃（状态 cancelled）。'
      + '它**永远不会**把任务置为 accepted —— 验收通过只有主会话能做的 task_accept 一条路。'
      + '**任务已收口时一律被拒（E_TERMINAL）**：终态结论不会被一条晚到的 failed 改写成 cancelled，'
      + '这正是"已验收的任务被旧子代理改写"的修复点；要推翻结论只能由主会话 task_reject 重新复核。'
      + '新写的行为请直接用 task_submit；调用 task_close 时返回体会带 alias_of 与 mapped_status 说明映射。',
    parameters: {
      task_id: { type: 'integer', required: true, description: '任务 id' },
      result: {
        type: 'string',
        required: true,
        enum: ['done', 'partial', 'failed'],
        description: 'done/partial → 提交待验收（submitted）；failed → 放弃（cancelled）',
      },
      note: { type: 'string', description: '可选附注：done/partial 作为提交说明，failed 作为取消裁决记录' },
    },
  },

  task_board: {
    description:
      '读事实板 —— 主会话核对的唯一入口。**范围恒为当前工作实例**（由宿主按身份判定）：'
      + '无参数：返回本工作实例的待办任务（open/claimed/submitted/rejected）+ 每任务最近 5 条事实摘要；'
      + '其中 submitted 的就是**等你验收的**（返回体里有 submitted_tasks 计数）。'
      + '另有 `late_blockers` / `late_blocked_tasks`：**已收口任务上未消解的晚到阻塞** —— '
      + '它们不属于待办集合，但会显示在这里，不会被藏起来；处理方式是对该任务 task_reject 重新复核。'
      + '给 task_id：返回该任务详情（事实最多 50 条 + 交接记录 + 未解 blocker 计数 + task.late + late_blockers）。'
      + '跨工作实例的任务不可见、也不可读详情（会明确报错，不会静默返回空）。'
      + '核对 = 读板并对证据文件，而不是复述子代理的汇报。',
    parameters: {
      task_id: { type: 'integer', description: '留空 = 本工作实例的待办任务；给了 = 该任务详情' },
    },
  },

  task_child_send: {
    description:
      '**向「本会话自己派出的子代理」发送一条新指令（续作）** —— 目标对象是 subagent（你用 subagent / subagent_fork 派出去的执行者），'
      + '**不是** Agent Teams 的 teammate（那套是 `send_message` / `interrupt_agent`，两者是不同平面，不要混用）。'
      + 'target_id 用派发返回值里的 childId（也就是该子会话的 sessionId），或者 task_board / 子代理清单里显示的同一个 id。'
      + '服务端会核对「你 → 该 id」确实是**直属父子关系**：只有真正派它出来的会话能续作它，'
      + '跨会话、非直属、或已经被别的会话接管的 id 一律拒绝（返回 ok:false + code，不会静默丢弃，也不会代你去操作别人的子代理）。'
      + 'message 是**模型自己撰写的新指令全文**（不是 id）：改要求、补范围、纠正方向都写在这里，目标把它当作新一轮的输入。'
      + '**投递路径不由本工具报告**：宿主 `sendMessage(...): Promise<MessageId>` 只回"被接纳消息的收件箱 id"，没有路由回执；'
      + '"在最近步骤边界被接纳（steer，目标正在跑）"还是"直接起新一轮（queue，目标空闲；缺席的直属子代理从持久化冷启）"'
      + '是宿主在接纳那一刻内部决定的，调用方观测不到。'
      + '返回体因此把"可证事实"与"两次观测"分开写：`delivery` 只说消息已被收件箱接纳，'
      + '`route.reported=false` 明写"没有路由回执、不报 steer / queue"，'
      + '`target.activity_before` / `target.current_turn` 是投递前、投递后的**两次独立观测**（都取自宿主活动 agent 表，'
      + '与官方 `list_agents` 同一判据；读不到就是 `unknown`）—— 它们**不能**反推这条消息走了哪条路径。'
      + '返回 message_id 只证明「消息已被目标的收件箱接纳」，**不等于它已经改完** —— 想知道真实状态就再 task_board 看它落的事实。',
    parameters: {
      target_id: {
        type: 'string',
        required: true,
        description: '目标子代理的 sessionId（派发返回的 childId）；必须是本会话自己派出的子代理',
      },
      message: {
        type: 'string',
        required: true,
        description: '要投递的新指令全文（改要求 / 补边界 / 纠正方向），会作为模型撰写的消息进入目标下一轮',
      },
    },
  },

  task_child_stop: {
    description:
      '**停止「本会话自己派出的子代理」的当前轮** —— 目标对象是 subagent（你派出去的执行者），'
      + '**不是** teammate（teammate 用 `interrupt_agent`，不要拿它来停子代理）。'
      + 'target_id 用派发返回值里的 childId。授权判据与 task_child_send 完全一致：只有该子代理的**直接父会话**能停它，'
      + '跨会话的 id 一律拒绝并返回可读错误。'
      + '语义是「中断当前轮」而不是「销毁」：取消信号发出后，未认领的排队消息、Activation 与已发布的子代都保留；'
      + '被中断的驱动变空闲后，一条新的投递（task_child_send）会唤醒它继续跑队列里剩下的消息。'
      + '**这里返回的是「请求已接纳」而不是「它已经死了」**：本调用是 fire-and-return（宿主 `interrupt()` 是 void 接口），'
      + '目标可能还在跑直到它自己观察到信号。返回体把两件事**分开**：`stopped.accepted`（请求是否已接纳 = 调用未抛错）'
      + '与 `execution.stopped`（执行是否已停止 = 单独观测到的 `current_turn`）。'
      + '`current_turn` 只有 running / inactive / unknown 三种取值，`unknown` 表示宿主活动表读不到 —— **不要当成已安静**。'
      + '要查状态请用 task_board 或 list_agents，**不要重复调本工具来"查询"**（那是在再发一次停止信号）。',
    parameters: {
      target_id: {
        type: 'string',
        required: true,
        description: '目标子代理的 sessionId（派发返回的 childId）；停止它的当前轮',
      },
      reason: {
        type: 'string',
        description: '可选的停止理由：只写进本次调用的返回体供你对账，不会投递给目标（要它知道原因就先 task_child_send 再停）',
      },
    },
  },
}

/** 模型可见工具名清单（自测与文档用）。 */
export const TOOL_NAMES = Object.keys(TOOL_SPECS)

/** 只有主会话（run 的根会话）能调的工具。 */
export const LEAD_ONLY_TOOLS = ['task_accept', 'task_reject']

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cordis 入口：解析事实库服务并注册 10 个模型可见工具
 * （8 个事实库工具 + 2 个子代理控制工具 task_child_send / task_child_stop）。
 * @param ctx - agent 平面插件上下文（携带 ctx.tools 与 ctx.get）。
 * @param _config - 预留（当前无配置项）。
 */
export function apply(ctx, _config = {}) {
  /** 服务缺失只告警一次，避免刷屏。 */
  let warned = false
  /** 身份失败只告警一次（每次调用仍失败，但日志不刷屏）。 */
  let warnedIdentity = false
  /** 子代理服务缺失只告警一次。 */
  let warnedChild = false

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`taskforce-tools: ${message}`)
    } catch {
      /* 诊断失败不影响功能 */
    }
  }

  /**
   * 惰性解析事实库服务：每次调用都重取，服务晚到也能自愈。
   * @returns 服务实例，未挂载时返回 undefined。
   */
  const resolveService = () => {
    let service
    try {
      if (typeof ctx.get === 'function') service = ctx.get(STORE_SERVICE)
    } catch {
      service = undefined
    }
    if (service === undefined) {
      // 兜底通道：反射层属性访问（ctx.get 不可用时仍能拿到服务）。
      try {
        service = ctx[STORE_SERVICE]
      } catch {
        service = undefined
      }
    }
    return service === undefined || service === null ? undefined : service
  }

  /**
   * 惰性解析 host 平面的活动 agent 表（祖先链上溯用）。
   * 取不到不是致命错误：非子代理（主会话）根本不需要它。
   * @returns `{ get(id) }` 或 undefined。
   */
  const resolveAgents = () => {
    try {
      if (typeof ctx.get === 'function') {
        const service = ctx.get(AGENTS_SERVICE)
        if (service !== undefined && service !== null) return service
      }
    } catch {
      /* 落到反射通道 */
    }
    try {
      const reflected = ctx[AGENTS_SERVICE]
      return reflected === undefined || reflected === null ? undefined : reflected
    } catch {
      return undefined
    }
  }

  /** 取可用服务；缺失时告警并抛可读错误（不静默降级）。 */
  const requireService = () => {
    const service = resolveService()
    if (service === undefined || typeof service.openTask !== 'function') {
      if (!warned) {
        warned = true
        warn(
          `服务 "${STORE_SERVICE}" 不可用：事实库未挂载（检查 cordis 合成里 taskforce-store 行是否启用）；`
          + '工具保持注册，但每次调用都会返回 ok:false。',
        )
      }
      throw new Error(`${STORE_SERVICE} 服务不可用：事实库（@local/dsh-taskforce/lib/store）未挂载或未激活`)
    }
    return service
  }

  /** 身份推导缓存：会话血缘是静态的，同一 session 推导一次即可（失败不缓存）。 */
  const identityCache = new Map()

  /**
   * 从 `exec.agent` 推导身份并缓存。
   * @param exec - 工具执行上下文（ToolRunContext）。
   * @returns 身份对象。
   * @throws 身份错误（含 `code`），**绝不降级**。
   */
  const identityOf = (exec) => {
    try {
      return deriveIdentity(exec?.agent, resolveAgents(), { cache: identityCache })
    } catch (error) {
      if (!warnedIdentity) {
        warnedIdentity = true
        warn(
          `调用者身份推导失败（${error?.code ?? 'no-code'}）：${messageOf(error)}；`
          + '工具保持注册，但身份不可得的调用会返回 ok:false（为保住工作实例隔离，不放宽范围）。',
        )
      }
      throw error
    }
  }

  /**
   * 要求调用者是主会话（run 的根会话）。**权限靠身份判据，不靠提示词。**
   * @param identity - 已推导的身份。
   * @param toolName - 触发工具名（写进错误信息）。
   */
  const requireLead = (identity, toolName) => {
    if (identity.isRoot) return
    const error = new Error(
      `${toolName} 只有主会话能调：当前调用者是子代理（session=${identity.sessionId}，`
      + `所属工作实例=${identity.runId}，delegation depth=${identity.depth}）。`
      + '子代理只能 task_submit 提交待验收 —— 执行者不能自批；'
      + '验收或打回由主会话读库核对后执行。',
    )
    error.code = 'E_NOT_LEAD'
    throw error
  }

  /* ─────────────── 子代理平面（task_child_send / task_child_stop）─────────────── */

  /**
   * 惰性解析宿主子代理服务（`ctx.subagents`）。
   *
   * 与事实库同款双通道：`ctx.get('subagents')` 优先，取不到再走反射层属性访问；
   * 每次都重取，服务晚到也能自愈。
   * @returns 服务实例，未挂载时返回 undefined。
   */
  const resolveSubagents = () => {
    try {
      if (typeof ctx.get === 'function') {
        const service = ctx.get(SUBAGENTS_SERVICE)
        if (service !== undefined && service !== null) return service
      }
    } catch {
      /* 落到反射通道 */
    }
    try {
      const reflected = ctx[SUBAGENTS_SERVICE]
      return reflected === undefined || reflected === null ? undefined : reflected
    } catch {
      return undefined
    }
  }

  /**
   * 取可用的子代理服务；缺失时告警一次并抛可读错误（**不静默降级、不改用 teammate 工具**）。
   *
   * 能力按**方法**分派而不是一刀切：宿主版本可能只提供了其中一支，
   * 缺哪支就只废掉用它的那个工具，不要连带把另一个工具也判成「服务不可用」。
   *
   * @param need - `'send'`（要 sendMessage）或 `'interrupt'`（要 interrupt）。
   * @returns 具备所需方法的服务。
   * @throws `E_CHILD_SERVICE`。
   */
  const requireSubagents = (need) => {
    const service = resolveSubagents()
    const method = need === 'send' ? 'sendMessage' : 'interrupt'
    const usable = service !== undefined && typeof service.listChildren === 'function'
      && typeof service[method] === 'function'
    if (!usable) {
      if (!warnedChild) {
        warnedChild = true
        warn(
          `服务 "${SUBAGENTS_SERVICE}" 不可用（缺 listChildren 或 .${method}）：子代理平面未挂载或不匹配（核对合成里的 subagent 行与宿主版本）；`
          + 'task_child_send / task_child_stop 保持注册，但对应调用会返回 ok:false（不会退化成 send_message / interrupt_agent）。',
        )
      }
      throw codedError(
        CHILD_ERROR_CODES.service,
        `${SUBAGENTS_SERVICE} 服务不可用：宿主子代理平面（ctx.subagents）未挂载或缺少 ${method}`
        + `（拿到的类型：${service === undefined ? 'undefined' : typeof service}），本工具无法接原生生命周期服务。`
        + '不要改用 send_message / interrupt_agent（Agent Teams 平面，不认子代理）。',
        HINT_CHILD_SERVICE,
      )
    }
    return service
  }

  /**
   * 取调用者**自己**的 Agent 实例（本包唯一可信的身份来源，与 `deriveIdentity` 同一入口 `exec.agent`）。
   *
   * 服务契约要求 `sender` 是「exact live Agent」：它既是授权者也是消息来源，
   * 因此**只接受 `exec.agent` 本身**，不接受任何参数、id 或推导出来的重构对象。
   *
   * 注意这里**刻意不调用 `deriveIdentity`**：那个函数算的是「事实库工作实例归属」，
   * 它还会为实现 run 隔离去上溯祖先链（可能因 E_BROKEN_CHAIN / E_CYCLE 拒绝），
   * 而子代理平面只需要「本会话自己是谁」+「自己派了谁」两件事 —— 引入无关判据只会
   * 凭空多出一个失败点，把本来能续作的情况误伤成失败。
   *
   * @param exec - 工具执行上下文。
   * @returns `{ agent, sessionId, isSubagent }`。
   * @throws `E_CHILD_NO_AGENT`。
   */
  const callerAgentOf = (exec) => {
    const agent = exec?.agent
    if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) {
      throw codedError(
        CHILD_ERROR_CODES.noAgent,
        '无法确定调用者身份：工具执行上下文里没有可用的 agent（exec.agent 缺失）。'
        + 'sender 必须是调用者自己的 Agent 实例 —— 身份不可得时拒绝服务，而不是拿一个伪造或猜出来的 sender 去发消息。',
        HINT_IDENTITY,
      )
    }
    const header = readHeader(agent)
    if (header === undefined) {
      throw codedError(
        CHILD_ERROR_CODES.noAgent,
        '无法确定调用者身份：exec.agent 上没有可用会话 id，因此无法列出「本会话派出了哪些子代理」。'
        + '身份不可得时拒绝服务，不退化、不猜。',
        HINT_IDENTITY,
      )
    }
    return { agent, sessionId: header.id, isSubagent: isSubagentHeader(header) }
  }

  /**
   * 核对 `targetId` 确实是**本会话派出的**子代理，并返回它的目录条目。
   *
   * 判据用的是服务自己的持久化目录 `listChildren(callerSessionId)`（与宿主内部同一份事实），
   * 不看参数里可能顺手填进来的任何 owner / parent 字段 —— 所以「主控去操作别人的子代理」在
   * 这里就被挡死：别人的 id 不会出现在本会话的直属子代理目录里。
   *
   * @param service - 已解析的子代理服务。
   * @param callerSessionId - 调用者会话 id（必须是子代理的直接父会话）。
   * @param targetId - 参数传入的目标 id（已 trim）。
   * @returns 目录条目 `{ id, mode, label?, createdAt }` + `activity`（当前轮活动态，来自 `ctx.agents`）。
   * @throws `E_CHILD_NOT_OWN` / `E_CHILD_MISSING` / `E_CHILD_SETTLED` / `E_CHILD_NO_ID`。
   */
  const ownChildOf = async (service, callerSessionId, targetId) => {
    let entries
    try {
      entries = await service.listChildren(callerSessionId)
    } catch (error) {
      throw codedError(
        CHILD_ERROR_CODES.noId,
        `无法核对目标归属：读取会话 ${callerSessionId} 的子代理目录失败（${messageOf(error)}）。`
        + '在无法证明「这个 id 确实由本会话派出」的情况下拒绝服务，不冒险操作他人子代理。',
        HINT_CHILD_SERVICE,
      )
    }
    const list = Array.isArray(entries) ? entries : []
    const found = list.find((entry) => entry !== null && typeof entry === 'object' && entry.id === targetId)
    if (found === undefined) {
      throw codedError(
        CHILD_ERROR_CODES.notOwn,
        `拒绝操作：${targetId} 不是会话 ${callerSessionId} 的子代理（本会话的直接子代理目录里没有这个 id）。`
        + '只能续作/停止**自己派出的**子代理；别人的子代理由它自己的父会话负责。'
        + '请先核对 target_id 是否抄错，或改用你自己的子代理 id。',
        HINT_CHILD,
      )
    }
    if (found.mode !== 'continuable') {
      throw codedError(
        CHILD_ERROR_CODES.settled,
        `拒绝操作：${targetId} 的子代理模式是 ${JSON.stringify(found.mode)}（目录记录），不是 continuable。`
        + '本工具只接续作型子代理：one-shot 已经结算（结果在派发返回值里），unknown 模式的记录不足以证明可续作。'
        + '需要再跑一轮就重新派一个子代理，或让主控核对这条目录记录。',
        HINT_CHILD,
      )
    }
    return {
      ...found,
      // ⚠️ **刻意不读 `found.activity`**：真身 `listChildren()` 返回的是
      // `SubagentCatalogEntry[]` = `{ id, createdAt, mode, label? }`
      // （`dsh-subagent/lib/types/projection-types.d.ts`），**没有 `activity` 字段**。
      // `activity` 只由另一条接口 `listDescendants()` 补上，而且它的语义是
      // "Whether recursive catalog listing observed a **resident Session**. This does
      // not encode a durable outcome or guarantee continuation delivery."
      // （`dsh-subagent/lib/types/control-types.d.ts` 的 `SubagentCatalogRow`）——
      // **不是「当前轮在跑」**。旧实现把「缺失」统一折叠成 `inactive`，等于凭空
      // 断言"它已经停了"。活动态一律从权威活动表现读（见 liveActivityOf），
      // 读不到就是 `unknown`，不推断。
      activity: liveActivityOf(targetId),
    }
  }

  /**
   * 读目标子代理的**当前轮**状态 —— 唯一权威来源是宿主的活动 agent 表。
   *
   * 契约（`cordis_inspect_query(host, Service, {service:'agents'})` 实测原文）：
   *   `get(id: SessionId): Agent | undefined`；
   *   `Agent.status: AgentStatus` —— "The current lifecycle state, mirrored on
   *   every `agent/status` transition."，`AgentStatus = 'idle' | 'running'`
   *   （`dsh-agent/lib/types/runtime-types.d.ts:90,147`）。
   * 真身实现（`dsh-agent-loop/lib/index.js:786-788`）：
   * ```js
   * get status() { return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running" }
   * ```
   * 阶段在 turn 内就是 `running` —— **这正是「当前轮在跑」的定义**。
   * 官方 `list_agents` 用同一判据（`dsh-tool-subagent-control/lib/types/list-agents.js:19-21`），
   * 其 JSDoc 原文是 "Report turn activity without exposing whether the child is loaded."，
   * 函数体只有一行：
   * ```js
   * function statusOf(agents, id) { return agents.get(id)?.status === 'running' ? 'running' : 'inactive' }
   * ```
   *
   * **三态，不推断**：
   *  - `'running'` / `'inactive'`：活动表给出的直接事实。不在表里 = 没有活着的
   *    Agent 在跑 = `inactive`（官方适配器同一读法）；
   *  - `'unknown'`：`ctx.agents` 不可用、抛错、或返回的对象没有可读 status ——
   *    **没有活动态就不猜**。旧实现把「读不到」折叠成 `inactive`，停止文案再把它写成
   *    "已不在跑当前轮"，等于把未知说成已安静。
   *
   * @param targetId - 目标子会话 id。
   * @returns `'running' | 'inactive' | 'unknown'`。
   */
  const liveActivityOf = (targetId) => {
    const agents = resolveAgents()
    if (agents === undefined || typeof agents.get !== 'function') return 'unknown'
    try {
      const live = agents.get(targetId)
      if (live === undefined || live === null) return 'inactive'
      const status = live.status
      if (status === 'running') return 'running'
      if (status === 'idle') return 'inactive'
      // 活动表给了对象却读不出状态：仍是"没有活动态"，不猜。
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * 读目标的**当前真实状态**（活动态 + 目录模式），用于返回体而不是让调用方猜。
   *
   * 两路来源刻意分开：目录只提供 `mode`，活动态只来自 `ctx.agents`。
   * 旧实现把两者绑在一次 `listChildren` 里，目录读失败就把活动态一起降级 ——
   * 而目录本来就不带活动态，等于永远走降级分支。
   *
   * @param service - 子代理服务。
   * @param callerSessionId - 调用者会话 id。
   * @param targetId - 目标 id。
   * @returns `{ activity, mode }`；`activity` 读不到时是 `'unknown'`（不是 `'inactive'`）。
   */
  const targetStateOf = async (service, callerSessionId, targetId) => {
    let mode = null
    try {
      const entries = await service.listChildren(callerSessionId)
      const found = (Array.isArray(entries) ? entries : [])
        .find((entry) => entry !== null && typeof entry === 'object' && entry.id === targetId)
      if (found !== undefined && typeof found.mode === 'string') mode = found.mode
    } catch {
      /* 目录读不到只影响 mode；活动态不依赖目录 */
    }
    return { activity: liveActivityOf(targetId), mode }
  }

  /**
   * 统一收敛：成功包 `ok:true`，失败转结构化 `ok:false`（含原文与提示）。
   * 数据层抛出的可读错误在这里变成模型能读懂、能决定重试与否的返回值。
   * @param handler - 具体实现（收到 `(args, exec)`）。
   * @returns 返回 JSON 字符串的工具 execute。
   */
  const wrap = (handler) => async (args, exec) => {
    try {
      const value = await handler(args ?? {}, exec)
      return JSON.stringify({ ok: true, ...value })
    } catch (error) {
      const text = messageOf(error)
      const code = error?.code
      const detected = typeof error?.hint === 'string' ? error.hint : undefined
      let hint
      if (detected !== undefined) hint = detected
      else if (code === CHILD_ERROR_CODES.service || text.includes('服务不可用')) hint = HINT_SERVICE
      else if (code === CHILD_ERROR_CODES.missing || code === CHILD_ERROR_CODES.settled
        || code === CHILD_ERROR_CODES.notOwn || code === CHILD_ERROR_CODES.input) hint = HINT_CHILD
      else if (code === CHILD_ERROR_CODES.noId) hint = HINT_CHILD_SERVICE
      else if (code !== undefined && IDENTITY_CODE_SET.has(code)) hint = HINT_IDENTITY
      else if (code === 'E_NOT_LEAD') hint = HINT_ROLE
      // v3 store 层错误码（lib/store/index.js 的 STORE_CODES，按字面值对应，保持本行零耦合）：
      else if (code === 'E_TERMINAL') hint = HINT_TERMINAL
      else if (code === 'E_EVIDENCE_MISSING') hint = HINT_EVIDENCE
      else if (code === 'E_RESOLUTION_INVALID') hint = HINT_RESOLUTION
      else if (code === 'E_CROSS_RUN') hint = HINT_CROSS_RUN
      else if (code === 'E_STORE_BUSY') hint = HINT_STORE_BUSY
      else if (code === 'E_TASK_CONFLICT') hint = HINT_TASK_CONFLICT
      else hint = HINT_INPUT
      return JSON.stringify({ ok: false, error: text, code: code ?? null, hint })
    }
  }

  /** 每个工具的执行体：先身份、后服务（身份不可得时连服务都不碰）。 */
  const handlers = {
    task_open: async (args, exec) => {
      const identity = identityOf(exec)
      const opened = requireService().openTask({ title: args.title, note: args.note }, identity.runId)
      return {
        ...opened,
        claimer: identity.isRoot ? 'lead' : `child:${identity.sessionId}`,
        next: '把 task_id 写进派单描述，让子代理先 task_claim 再干活',
      }
    },

    task_claim: async (args, exec) => {
      const identity = identityOf(exec)
      const claimed = requireService().claimTask(
        { task_id: args.task_id, child_id: args.child_id },
        identity.runId,
      )
      return {
        ...claimed,
        next: '让它干活，每完成一步就 task_fact 落库；完成时 task_submit 提交待验收（不是自己结任务）',
      }
    },

    task_fact: async (args, exec) => {
      const identity = identityOf(exec)
      return requireService().recordFact({
        task_id: args.task_id,
        kind: args.kind,
        statement: args.statement,
        evidence_path: args.evidence_path,
        evidence_line: args.evidence_line,
        confidence: args.confidence,
        resolves_fact_id: args.resolves_fact_id,
        child_id: args.child_id,
      }, identity.runId)
    },

    task_submit: async (args, exec) => {
      const identity = identityOf(exec)
      return requireService().submitTask(
        { task_id: args.task_id, note: args.note },
        identity.runId,
      )
    },

    task_accept: async (args, exec) => {
      const identity = identityOf(exec)
      requireLead(identity, 'task_accept')
      const accepted = requireService().acceptTask(
        // waiver_reason 如实透传：数据层只认非空理由，豁免会写进验收记录（板上可查）。
        { task_id: args.task_id, note: args.note, waiver_reason: args.waiver_reason },
        identity.runId,
        LEAD_ACTOR,
      )
      return { ...accepted, verified_by: `lead:${identity.sessionId}` }
    },

    task_reject: async (args, exec) => {
      const identity = identityOf(exec)
      requireLead(identity, 'task_reject')
      return requireService().rejectTask(
        { task_id: args.task_id, reason: args.reason },
        identity.runId,
        LEAD_ACTOR,
      )
    },

    task_close: async (args, exec) => {
      const identity = identityOf(exec)
      const closed = requireService().closeTask({ task_id: args.task_id, result: args.result, note: args.note }, identity.runId)
      return {
        ...closed,
        next: 'task_close 是 task_submit 的兼容别名，不产生最终完成；最终完成只能由主会话 task_accept',
      }
    },

    task_board: async (args, exec) => {
      const identity = identityOf(exec)
      const board = requireService().board(
        args.task_id === undefined || args.task_id === null ? {} : { task_id: args.task_id },
        identity.runId,
      )
      return {
        ...board,
        viewer: identity.isRoot ? `lead:${identity.sessionId}` : `child:${identity.sessionId}`,
        can_accept: identity.isRoot,
      }
    },

    task_child_send: async (args, exec) => {
      const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : ''
      const message = typeof args.message === 'string' ? args.message.trim() : ''
      if (targetId === '') {
        throw codedError(
          CHILD_ERROR_CODES.input,
          'task_child_send 缺 target_id：请填本会话派出的子代理 id（派发返回的 childId / 子会话 sessionId）。',
          HINT_CHILD,
        )
      }
      if (message === '') {
        throw codedError(
          CHILD_ERROR_CODES.input,
          'task_child_send 的 message 为空：它是**模型撰写的新指令全文**（改要求、补边界、纠正方向），'
          + '不是 id、不是占位符。空消息会被服务当成无内容投递，因此在本地就拒绝。',
          HINT_CHILD,
        )
      }
      // 顺序即纪律：先身份、再服务、再归属，全部通过后才允许碰任何写入路径。
      // 「操作前状态」直接取归属核对那次快照，不再多读一遍目录。
      const caller = callerAgentOf(exec)
      const service = requireSubagents('send')
      const child = await ownChildOf(service, caller.sessionId, targetId)

      const messageId = await service.sendMessage(
        caller.agent,
        targetId,
        [{ type: 'text', text: message }],
        { signal: resolveSendSignal(exec, warn) },
      )

      // 只有「操作后的状态」必须重读：它才是投递被接纳之后目标的真实处境。
      const after = await targetStateOf(service, caller.sessionId, targetId)
      return {
        sent: { target_id: targetId, message_id: messageId, chars: message.length },
        caller_session: caller.sessionId,
        caller_role: caller.isSubagent ? 'subagent' : 'lead',
        target: {
          id: child.id,
          mode: child.mode,
          label: typeof child.label === 'string' ? child.label : null,
          // 两次**观测**，各归其位、各只描述自己那一刻：投递前取自归属核对那份目录快照，
          // 投递后取自活动 agent 表。它们是事实，但**不是路由证据**（见 route.reason）。
          activity_before: child.activity,
          current_turn: after.activity,
        },
        // 只说宿主真给过的收据。宿主契约（`cordis_inspect_query(host, Service,
        // {service:'subagents'})` 原文）：
        //   `async sendMessage(sender, targetId, content, options): Promise<MessageId>`
        //   returns: "the accepted message's inbox id."
        // —— 只回收件箱 id。宿主描述里确实写了接纳时的内部分流（running 目标在最近
        // 步骤边界接纳、idle 目标起新一轮、缺席的直属子代理从持久化冷启），但那是**接纳
        // 那一刻的内部决定**，调用方读不到；`sendMessage` 侧也没有 `SubagentPromptRequest`
        // 那种 caller 指定的 `delivery: 'queue' | 'steer'` 入参（那条是 Remote prompt 面）。
        // 因此这里只报「已接纳」，**不报 steer / queue**。
        delivery: 'accepted（消息已被目标收件箱接纳：message_id 有效）'
          + ' —— 实际处理以目标后续事实为准（task_board 读它落的事实）。',
        // 旧实现用**投递后的活动态**反推路由（running ⇒ steer / inactive ⇒ queue），
        // 这是返回语义错误：空闲目标可能已被本次消息唤醒成 running，在跑的目标也可能
        // 在后读之前结束 —— 操作后的状态证明不了接纳时走了哪条生命周期路径。
        // 改成"读操作前状态"同样消不掉这个竞态，所以这里**不报路由**，只如实标注为什么。
        route: {
          reported: false,
          reason: '宿主未提供路由回执：sendMessage 只返回 message_id（契约 Promise<MessageId>）。'
            + '「在最近步骤边界接纳（steer）」与「起新一轮（queue）」的区分发生在宿主接纳那一刻的内部路径上，'
            + '不由本工具观测，也**不由 activity_before / current_turn 反推** ——'
            + '空闲目标可能已被这条消息唤醒成 running，在跑的目标也可能在后读之前结束，'
            + '两个观测点都证明不了接纳时走的是哪条路径。宿主将来若返回路由回执，这里才报告路由。',
        },
        note: 'message_id 只证明「已被目标收件箱接纳」，不代表它已经照办；真实进度以它落库的事实为准（task_board）。',
        next: '要确认真实状态就 task_board 读它前面落的事实；要停它的当前轮用 task_child_stop。',
      }
    },

    task_child_stop: async (args, exec) => {
      const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : ''
      if (targetId === '') {
        throw codedError(
          CHILD_ERROR_CODES.input,
          'task_child_stop 缺 target_id：请填要停止当前轮的子代理 id（派发返回的 childId）。',
          HINT_CHILD,
        )
      }
      const caller = callerAgentOf(exec)
      const service = requireSubagents('interrupt')
      const child = await ownChildOf(service, caller.sessionId, targetId)

      // 授权形状取自服务契约 SubagentInterruptAuthority：
      // `{ kind: 'ancestor', agent }` —— agent 必须是**调用者自己的活 Agent**，
      // 服务会拿它去核对「你是不是这个 live 目标的祖先」，伪造会直接 UNAUTHORIZED。
      //
      // ⚠️ 宿主 `interrupt()` 是 **void**：同步接纳、异步停止。
      // 契约原文（`cordis_inspect_query(host, Service, {service:'subagents'})` 实测）：
      //   `interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void`
      // 真身实现（`dsh-subagent/lib/index.js:843-856`）校验授权后调
      // `activation.handle.agent.cancel(…)`，**不返回任何收据**：
      // ```js
      // interrupt(targetSessionId, authority) {
      //   if (authority.kind === "ancestor") { …校验 exact live ancestor… }
      //   const activation = this.resident.get(targetSessionId);
      //   if (activation === void 0) return;          // 静默返回
      //   if (activation.inbox.closing !== void 0) return;
      //   activation.handle.agent.cancel(…);          // 只发信号，不等它停
      // }
      // ```
      // 旧实现读 `receipt?.accepted === true` ⇒ 真宿主上**永远 false**：
      // 成功停止也被报成"没被接纳"。官方适配器读的也是同一个 void 接口的
      // 「未抛错」语义（`dsh-tool-subagent-control/lib/index.js:90` 那一支
      // `return Promise.resolve({ accepted: true })` 是在**自己**的成功路径上
      // 构造收据，而不是从 `interrupt()` 的返回值里取）。
      //
      // 因此本包按 void 契约读：
      //   ① 调用**未抛错** ⇒ 请求已接纳（accepted = true）；
      //   ② 万一宿主将来真返回了显式收据并且**明确否认**（`accepted === false`），
      //      则以收据为准 —— 不会被"void ⇒ 一切皆接纳"掩盖契约变化。
      let accepted = true
      let receiptKind = 'void（宿主 interrupt 契约无返回体：未抛错即已接纳）'
      try {
        const receipt = service.interrupt(targetId, { kind: 'ancestor', agent: caller.agent })
        if (receipt !== undefined && receipt !== null && typeof receipt === 'object' && 'accepted' in receipt) {
          accepted = receipt.accepted !== false
          receiptKind = 'receipt（宿主返回了显式收据）'
        }
      } catch (error) {
        throw codedError(
          CHILD_ERROR_CODES.notOwn,
          `停止被服务拒绝：interrupt(${targetId}) 抛出 ${error?.code ?? error?.name ?? 'error'}：${messageOf(error)}。`
          + '这表示「你 → 该子代理」的父子授权在服务侧对不上（例如它已被重新派发或归属已变），不是参数抄错能修的。',
          HINT_CHILD,
        )
      }

      const after = await targetStateOf(service, caller.sessionId, targetId)
      return {
        stopped: {
          target_id: targetId,
          // 「请求已接纳」：调用未抛错即成立（void 契约），与"执行是否已停止"分开。
          accepted,
          receipt: receiptKind,
          reason: typeof args.reason === 'string' && args.reason !== '' ? args.reason : null,
        },
        // 「执行是否已停止」**单独观测**（来自活动 agent 表），绝不由 accepted 推导。
        execution: {
          observed: after.activity,
          stopped: after.activity === 'unknown' ? null : after.activity === 'inactive',
        },
        caller_session: caller.sessionId,
        caller_role: caller.isSubagent ? 'subagent' : 'lead',
        target: {
          id: child.id,
          mode: child.mode,
          current_turn: after.activity,
          activity_before: child.activity,
        },
        // 三分支，**unknown 绝不落进"已安静"**：没有活动态就明说观测不到。
        state_truth: after.activity === 'running'
          ? '中断信号已发出（请求已接纳），但活动 agent 表此刻显示目标仍在跑（status=running，current_turn=running）：'
            + 'fire-and-return 的语义就是「信号已发」而非「已安静」，它会在观察到信号后停下。'
          : after.activity === 'inactive'
            ? '中断信号已发出（请求已接纳），且活动 agent 表此刻显示目标不在跑'
              + '（status=idle 或不在该表中，current_turn=inactive）。'
            : '中断信号已发出（请求已接纳），但**无法证明**目标此刻是否已停：'
              + '宿主活动 agent 表不可用（读不到 status），因此 current_turn=unknown。'
              + '不要把它当成"已安静"—— 请求已接纳 ≠ 执行已停止，二者是两件事。',
        note: '本调用不销毁子代理：未认领的排队消息、Activation 与已发布的子代都保留；'
          + '驱动空闲后再发一条 task_child_send 即可唤醒它继续处理队列。',
        next: '要确认真实状态就读它能证明状态的地方（task_board 看它落的事实，或 list_agents 看 status）；'
          + '**不要为了查状态重复调 task_child_stop** —— 那是"再发一次停止信号"，不是查询。'
          + '要它带着新要求接着干就先 task_child_send 再等它落事实。',
      }
    },
  }

  // 激活时先探一次：把「服务不在」变成启动期可见的告警，而不是第一次调用时才炸。
  if (resolveService() === undefined) {
    warn(`启动探测：服务 "${STORE_SERVICE}" 尚未提供（可能挂载顺序靠后）；工具已注册，调用时惰性解析。`)
  }
  if (resolveSubagents() === undefined) {
    warn(
      `启动探测：服务 "${SUBAGENTS_SERVICE}" 尚未提供（合成里 subagent 行晚到或未启用）；`
      + 'task_child_send / task_child_stop 已注册，调用时惰性解析 —— 取不到即返回 ok:false，不退化到 teammate 工具。',
    )
  }

  for (const [toolName, spec] of Object.entries(TOOL_SPECS)) {
    ctx.tools.register(define({
      name: toolName,
      description: spec.description,
      parameters: spec.parameters,
      output: TEXT_OUTPUT,
      execute: wrap(handlers[toolName]),
    }))
  }
}
