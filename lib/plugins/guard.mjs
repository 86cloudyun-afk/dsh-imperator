import { createScopeMembership } from './scope-membership.mjs'
import { toolEvent, scopedToolEvents } from './tool-events.mjs'
import { createEventProjection } from './event-projection.mjs'
/**
 * taskforce / guard — observable stall signals and repeated-failure protection.
 *
 * STALL is a heuristic based on reasoning length and lack of visible output;
 * it does not establish that useful reasoning has stopped. ECHO identifies
 * repeated failures of the same tool call. Neither signal inspects or logs
 * private reasoning content beyond measuring its length.
 *
 * Compatibility defaults retain legacy interruption and temporary effort
 * step-down. The TaskForce preset explicitly selects stallAction: 'observe'
 * and stepDownRequests: 0: log STALL without injecting a message, still
 * interrupt ECHO, and never lower the requested reasoning effort.
 *
 * Signals fold durable session events. Observation deduplication and legacy
 * cooldown/step-down windows are per-agent runtime state, not durable quotas;
 * a restarted agent may log the same STALL observation again. Persisted ECHO
 * notices acknowledge previous calls, so their failures are not re-alerted on
 * resume. No raw tool arguments or reasoning are added to those notices.
 *
 * Mechanism provenance: @linxin666/dsh-liangshen v0.4.2 (MIT), independently
 * implemented with TaskForce-specific policy and configuration.
 */

import { createHash } from 'node:crypto'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'taskforce-guard'

/** 无服务依赖：只用 `ctx.on` 与可选 `ctx.logger`。 */
export const inject = []

/** Legacy single-step signal threshold; not a validated quality measure. */
export const DEFAULT_STALL_STEPS = 1

/** Historical heuristic floors, retained for compatibility, not model benchmarks. */
export const STALL_REASONING_CHARS_BY_EFFORT = {
  max: 8000,
  high: 12000,
  low: 20000,
}

/** 未知档位（数字档、off）的下限：单步梯按 high 档值待命，其余交给慢烧梯。 */
export const DEFAULT_STALL_REASONING_CHARS = 12000

/** 同参同工具连续失败多少次构成 ECHO 闭环。 */
export const DEFAULT_ECHO_FAILURES = 3

/**
 * 单步推理至少这么多字符才计入**慢烧梯**。刻意很低：慢烧梯要抓的是
 * "许多各自看着合理、但都零输出的小步"构成的循环，所以真思考过就该计；
 * 一个工具 ack、一个空轮不能算。
 */
export const GLOBAL_MIN_REASONING_CHARS = 200

/** 慢烧梯：连续多少个零输出推理步触发。 */
export const DEFAULT_GLOBAL_STALL_CAP = 4

/**
 * 灵敏度预设：对自适应阈值整体缩放，供"更怕误断"或"更怕漏报"的操作员
 * 一键切换，而不必手调四个数。
 * - conservative：所有下限与上限 × 1.5 取整 —— 最少打断（**本包默认**）。
 * - balanced：× 1.0，校准过的默认表。
 * - aggressive：下限 × 0.5、上限 − 1（有最小钳制）—— 更早抓住，代价是更多误报。
 */
export const SENSITIVITY_OPTIONS = ['conservative', 'balanced', 'aggressive']

/** 默认灵敏度：保守优先（本包纪律：宁可漏报，不要误断真实长思考）。 */
export const DEFAULT_SENSITIVITY = 'conservative'

const SENSITIVITY_SCALE = { conservative: 1.5, balanced: 1.0, aggressive: 0.5 }

/** Legacy downgrade window. Set stepDownRequests: 0 to disable all downgrades. */
export const DEFAULT_STEP_DOWN_REQUESTS = 3

/** 触发后静默多少步（防熔断消息刷屏）。 */
export const DEFAULT_REFIRE_COOLDOWN_STEPS = 5

/** 档位下调只沿这条梯子走；其它档位（含 off、数字档）一律不动。 */
export const EFFORT_LADDER = ['max', 'high', 'low']

/** 校验正整数配置项，缺失时回落默认值。 */
function integerAtLeast(value, field, minimum, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name}: ${field} 必须是 >= ${minimum} 的整数`)
  }
  return value
}

/**
 * 读取会话事件流，容忍两种宿主形态：
 * `session.events` 数组 **或** `session.snapshotEvents()` 函数。
 */
export function sessionEvents(session) {
  try {
    const events = session?.events
    if (Array.isArray(events)) return events
    const snapshot = session?.snapshotEvents
    if (typeof snapshot === 'function') {
      const value = snapshot.call(session)
      if (Array.isArray(value)) return value
    }
  } catch { /* Optional synchronous history is unavailable, not failure evidence. */ }
  return []
}

/** 一条 assistant/message 事件携带的推理字符数。 */
export function reasoningCharsOf(event) {
  let chars = 0
  const content = event?.data?.message?.content
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'reasoning' && typeof block.text === 'string') chars += block.text.length
  }
  return chars
}

/** 一条 assistant/message 事件携带的可见回复块数（非空文本）。 */
export function visibleRepliesOf(event) {
  let count = 0
  const content = event?.data?.message?.content
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) count += 1
  }
  return count
}

/** Canonical JSON: sort object keys recursively, never reorder arrays. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A comparable tool + JSON argument signature; unrepresentable input is unknown. */
export function callSignature(event) {
  const tool = event?.data?.name
  if (typeof tool !== 'string' || tool.length === 0) return undefined
  let args = event.data?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      /* Malformed JSON remains a distinct raw string, not an empty object. */
    }
  }
  try {
    // Normalize to persisted JSON semantics first (and reject cycles/BigInt).
    // A pair encoding prevents collisions between tool names and arguments.
    const json = JSON.stringify(args ?? null)
    return JSON.stringify([tool, canonicalJson(JSON.parse(json))])
  } catch {
    return undefined
  }
}

/** 一条 tool/result 是否是错误结果。 */
export function isErrorResult(event) {
  const tool = toolEvent(event)
  return tool?.phase === 'result' && tool.isError === true
}

const TASK_ERROR_TOOLS = new Set([
  'task_open', 'task_claim', 'task_fact', 'task_submit', 'task_verify', 'task_accept',
  'task_reject', 'task_close', 'task_board', 'task_child_send', 'task_child_stop',
  'task_workflow_create', 'task_workflow_submit', 'task_workflow_state',
])

/** Only our registered tools define this text envelope as a semantic error. */
function taskErrorEnvelope(event, tool, name) {
  if (!TASK_ERROR_TOOLS.has(name)) return false
  const data = event?.data
  if ([data?.name, data?.message?.source?.toolName].some(value => value !== undefined && value !== name)) return false
  const content = tool.ptc ? data?.content : data?.message?.content
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
    || typeof content[0].text !== 'string') return false
  try {
    const value = JSON.parse(content[0].text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && value.ok === false && typeof value.error === 'string'
      && (typeof value.code === 'string' || value.code === null) && typeof value.hint === 'string'
  } catch {
    return false
  }
}

/**
 * Fold STALL and ECHO together in one pass over durable events.
 * ECHO uses invocation order, not result arrival order. Only the first matched
 * result of a distinct callId counts. Unknown/pending calls break the tail;
 * replayed or orphaned results cannot manufacture failure evidence.
 * Persisted ECHO notices acknowledge only calls preceding that notice.
 */
function createGuardReducer(options) {
  const stallSteps = options?.stallSteps ?? DEFAULT_STALL_STEPS
  const stallChars = options?.stallReasoningChars ?? DEFAULT_STALL_REASONING_CHARS
  const echoFailures = options?.echoFailures ?? DEFAULT_ECHO_FAILURES
  const globalCap = options?.globalStallCap ?? DEFAULT_GLOBAL_STALL_CAP

  let stallStreak = 0
  let globalStreak = 0
  // 当前步：是否见过推理、是否见过任何输出（工具调用或可见文本）。
  let pendingReasoning = 0
  let pendingOutput = false

  const closeStep = () => {
    // 单步梯：一步爆字符下限且零输出，就前进一格。
    if (pendingReasoning >= stallChars && !pendingOutput) {
      stallStreak += 1
    } else if (pendingOutput || pendingReasoning > 0) {
      stallStreak = 0
    }
    // 慢烧梯：任何输出清零；零输出步只有在"确实推理过"时才推进
    // （光秃秃的工具 ack 或空想不能算），并由硬上限封顶，
    // 使一次正常的长时间调查（许多小的只读步）不会靠累积触发。
    if (pendingOutput) {
      globalStreak = 0
    } else if (pendingReasoning >= GLOBAL_MIN_REASONING_CHARS) {
      globalStreak = Math.min(globalStreak + 1, globalCap)
    }
    pendingReasoning = 0
    pendingOutput = false
  }

  const calls = []
  const byId = new Map()
  let acknowledgedThrough = 0

  const coordinates = {}
  const append = events => {
    for (const { event, tool } of scopedToolEvents(events, coordinates)) {
      if (tool !== undefined) {
        // Only an actual run_code wrapper is transparent; its successful result
        // says nothing about the tools it contains. Mark it retrospectively to
        // preserve one pass over the durable stream.
        if (tool.ptc && tool.rootKey !== undefined) {
          const wrapper = byId.get(tool.rootKey)
          if (wrapper?.toolName === 'run_code') wrapper.wrapper = true
        }
        if (tool.phase === 'call') {
          pendingOutput = true
          const canonical = callSignature({ data: tool })
          const signature = canonical === undefined ? undefined : createHash('sha256').update(canonical).digest('hex')
          const id = tool.key
          if (id === undefined) {
            calls.push({ signature, failed: undefined })
            continue
          }
          if (byId.has(id)) {
            const previous = byId.get(id)
            if (previous.signature !== signature) {
              previous.ambiguous = true
              previous.failed = undefined
              calls.push({ signature: undefined, failed: undefined })
            }
            continue
          }
          const record = { id, toolName: tool.name, signature, failed: undefined }
          calls.push(record)
          byId.set(id, record)
        } else {
          const record = byId.get(tool.key)
          if (record !== undefined && !record.ambiguous && record.failed === undefined) {
            record.failed = tool.isError || taskErrorEnvelope(event, tool, record.toolName)
          }
        }
        continue
      }
      switch (event?.type) {
        case 'step/start':
        case 'turn/start':
          closeStep()
          break
        case 'assistant/message': {
          const reasoning = reasoningCharsOf(event)
          if (reasoning > 0) pendingReasoning += reasoning
          if (visibleRepliesOf(event) > 0) pendingOutput = true
          break
        }
        case 'user/message': {
          const source = event.data?.source
          if (source?.kind === name && source?.signal === 'echo') acknowledgedThrough = calls.length
          break
        }
        default:
          break
      }
    }
  }

  const snapshot = () => {
    // Project the current open step without closing it in the accumulated
    // state. A second read, or later output in this step, must remain replayable.
    let currentStall = stallStreak
    let currentGlobal = globalStreak
    if (pendingReasoning >= stallChars && !pendingOutput) currentStall += 1
    else if (pendingOutput || pendingReasoning > 0) currentStall = 0
    if (pendingOutput) currentGlobal = 0
    else if (pendingReasoning >= GLOBAL_MIN_REASONING_CHARS) currentGlobal = Math.min(currentGlobal + 1, globalCap)

    let stall
    if (currentStall >= stallSteps) {
      stall = { signal: 'stall', detail: `${currentStall} 个连续零输出的超长推理步（每步 ${stallChars}+ 字符）` }
    } else if (currentGlobal >= globalCap) {
      stall = { signal: 'stall', detail: `${currentGlobal} 个连续零输出推理步（慢烧）` }
    }

    const tail = calls.findLast(record => !record.wrapper)
    let failStreak = 0
    if (tail?.signature !== undefined) {
      for (let i = calls.length - 1; i >= acknowledgedThrough; i -= 1) {
        const record = calls[i]
        if (record.wrapper) continue
        if (record.signature !== tail.signature || record.failed !== true) break
        failStreak += 1
      }
    }
    const echo = failStreak >= echoFailures
      ? { signal: 'echo', detail: `${failStreak} 次同参数同工具的连续失败` }
      : undefined
    return { stall, echo, echoKey: echo === undefined ? undefined : tail.id }
  }
  return { append, snapshot }
}

export function foldGuardSignals(events, options) {
  const reducer = createGuardReducer(options)
  reducer.append(events)
  return reducer.snapshot()
}

/** Mutating the supplied thresholds invalidates the accumulated projection. */
export function createGuardProjection(options) {
  return createEventProjection(() => createGuardReducer(options), () => JSON.stringify([
    options?.stallSteps ?? DEFAULT_STALL_STEPS,
    options?.stallReasoningChars ?? DEFAULT_STALL_REASONING_CHARS,
    options?.echoFailures ?? DEFAULT_ECHO_FAILURES,
    options?.globalStallCap ?? DEFAULT_GLOBAL_STALL_CAP,
  ]))
}

/** Compatibility selector; the runtime consumes both signals without a second scan. */
export function foldGuardSignal(events, options) {
  const { stall, echo } = foldGuardSignals(events, options)
  return (options?.detectStall !== false ? stall : undefined) ?? echo ?? { signal: undefined, detail: '' }
}

/**
 * 解析一次请求的阈值：当前档位的自适应下限 × 灵敏度缩放；
 * 显式细调项（stallReasoningChars / globalStallCap / echoFailures）压过整张表。
 * 入参全部可选，返回值始终完整合法。
 */
export function resolveThresholds(options) {
  const effort = options?.effort
  const sensitivity = Object.hasOwn(SENSITIVITY_SCALE, options?.sensitivity)
    ? options.sensitivity
    : DEFAULT_SENSITIVITY
  const scale = SENSITIVITY_SCALE[sensitivity]
  const baseFloor = Object.hasOwn(STALL_REASONING_CHARS_BY_EFFORT, effort)
    ? STALL_REASONING_CHARS_BY_EFFORT[effort]
    : DEFAULT_STALL_REASONING_CHARS
  const stallReasoningChars = options?.stallReasoningChars !== undefined
    ? options.stallReasoningChars
    : Math.max(200, Math.round(baseFloor * scale))
  const globalStallCap = options?.globalStallCap !== undefined
    ? options.globalStallCap
    : Math.max(2, Math.round(DEFAULT_GLOBAL_STALL_CAP * scale))
  const echoFailures = options?.echoFailures !== undefined
    ? options.echoFailures
    : Math.max(2, Math.round(DEFAULT_ECHO_FAILURES * scale))
  return { stallReasoningChars, globalStallCap, echoFailures }
}

/** 沿档位梯子降一档；未知档位或已在梯子底部时返回 undefined（= 不动）。 */
export function stepDownEffort(effort) {
  const index = EFFORT_LADDER.indexOf(effort)
  if (index < 0 || index === EFFORT_LADDER.length - 1) return undefined
  return EFFORT_LADDER[index + 1]
}

/** 熔断消息文本：只说"被打断了"和"接下来两个选项"，不复述任何私有推理。 */
export function renderGuardMessage(verdict) {
  const what = verdict.signal === 'stall'
    ? '连续多步只有推理、既无工具调用也无回复'
    : '同一个工具调用以完全相同的参数反复失败'
  return [
    `[任务部队 · 熔断] 运行时已经打断了一个退化循环：${what}。`,
    verdict.signal === 'stall'
      ? '停止在思考里重新推导。现在只做**其中一件**：'
      : '停止重复同参失败调用，保留必要的根因分析。现在只做**其中一件**：',
    '1. 把手上已有的最佳结论直接收口；或',
    '2. 采取**一个实质性不同**的动作（换工具、换参数，或切更小的子步骤）并验证它的结果。',
    '不要重复被打断的模式。',
  ].join(' ')
}

/** 注册信号折叠、pre-step 熔断注入与请求档位下调。 */
export function apply(ctx, config) {
  const ownsAgent = createScopeMembership(ctx)
  const enabled = config?.enabled !== false
  if (!enabled) return

  const stallAction = config?.stallAction === undefined ? 'interrupt' : config.stallAction
  if (!['observe', 'interrupt'].includes(stallAction)) {
    throw new TypeError(`${name}: stallAction 必须是 observe 或 interrupt`)
  }

  const sensitivity = SENSITIVITY_OPTIONS.includes(config?.sensitivity)
    ? config.sensitivity
    : DEFAULT_SENSITIVITY
  // 细调项一旦显式设置，就对所有档位生效；缺席时走自适应表。
  const overrideStallChars = config?.stallReasoningChars !== undefined
    ? integerAtLeast(config.stallReasoningChars, 'stallReasoningChars', 200, DEFAULT_STALL_REASONING_CHARS)
    : undefined
  const overrideGlobalCap = config?.globalStallCap !== undefined
    ? integerAtLeast(config.globalStallCap, 'globalStallCap', 2, DEFAULT_GLOBAL_STALL_CAP)
    : undefined
  const overrideEcho = config?.echoFailures !== undefined
    ? integerAtLeast(config.echoFailures, 'echoFailures', 2, DEFAULT_ECHO_FAILURES)
    : undefined
  const stallSteps = integerAtLeast(config?.stallSteps, 'stallSteps', 1, DEFAULT_STALL_STEPS)
  const stepDownRequests = integerAtLeast(config?.stepDownRequests, 'stepDownRequests', 0, DEFAULT_STEP_DOWN_REQUESTS)
  const refireCooldown = integerAtLeast(config?.refireCooldownSteps, 'refireCooldownSteps', 1, DEFAULT_REFIRE_COOLDOWN_STEPS)

  // 每个 agent 的运行时状态：冷却/下调窗口，以及最近一次请求观测到的档位。
  // 不可变事件追加使用增量 reducer；会话、作用域或阈值变化重新折叠；
  // 档位是**只读观测**，只在已触发 episode 的窗口内被改写。
  const stateByAgent = new WeakMap()
  const stateOf = (agent) => {
    let state = stateByAgent.get(agent)
    if (state === undefined || state.session !== agent.session || state.sessionId !== agent.session?.header?.id
      || state.scope !== agent.ctx) {
      const options = {}
      state = { cooldown: 0, firedEchoKey: undefined, stepDownLeft: 0, currentEffort: undefined, observedStall: false,
        session: agent.session, sessionId: agent.session?.header?.id, scope: agent.ctx,
        options, projection: createGuardProjection(options) }
      stateByAgent.set(agent, state)
    }
    return state
  }

  ctx.on('agent/disposed', ({ agent }) => {
    stateByAgent.delete(agent)
  })

  // 一个监听器两件事，按信息位置排序：请求瀑布先看到档位（它是已解析调用配置的
  // 一部分），所以这里把当前档位记下来供**下一次** pre-step 解析阈值；
  // 并且只在已触发 episode 的窗口内把它降一档。
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload?.agent
    if (agent === undefined) return resolved
    if (ownsAgent(agent) === false) { stateByAgent.delete(agent); return resolved }
    const state = stateOf(agent)
    // 只读观测：路由实际解析出的档位。这一步本身绝不改动请求。
    state.currentEffort = typeof resolved?.reasoningEffort === 'string' ? resolved.reasoningEffort : undefined
    if (state.stepDownLeft === 0) return resolved
    state.stepDownLeft -= 1
    const lowered = stepDownEffort(resolved?.reasoningEffort)
    if (lowered === undefined) return resolved
    return { ...resolved, reasoningEffort: lowered }
  })

  // 折叠信号并注入熔断消息。`step/start` 不是每个宿主都会作为 ctx 事件发出，
  // 所以折叠放在 pre-step —— 每个模型请求前唯一保证会跑的钩子 —— 用的是
  // 最近一次 agent/request 观测记下的档位（首次请求前为 undefined）。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (agent === undefined) return decision
    if (ownsAgent(agent) === false) { stateByAgent.delete(agent); return decision }
    const state = stateOf(agent)

    const thresholds = resolveThresholds({
      effort: state.currentEffort,
      sensitivity,
      stallReasoningChars: overrideStallChars,
      globalStallCap: overrideGlobalCap,
      echoFailures: overrideEcho,
    })
    const events = sessionEvents(agent.session)
    Object.assign(state.options, { stallSteps, ...thresholds })
    const { stall, echo, echoKey } = state.projection.read(events)
    const verdict = (stallAction === 'interrupt' ? stall : undefined) ?? echo

    if (stallAction === 'observe' && stall !== undefined) {
      // Observation neither injects a message nor consumes ECHO's cooldown.
      if (!state.observedStall) {
        state.observedStall = true
        try {
          ctx.logger?.warn?.(`${name}: STALL 观察（${stall.detail}）；未打断、未降档`
            + ` [${sensitivity}, 档位 ${state.currentEffort ?? '未知'}]`)
        } catch {
          /* Optional diagnostics must never fail a session. */
        }
      }
    } else {
      state.observedStall = false
    }

    const alreadyNotified = verdict?.signal === 'echo' && state.firedEchoKey === echoKey
    if (verdict !== undefined && !alreadyNotified && state.cooldown === 0) {
      // 触发：注入熔断消息并武装档位下调窗口。
      state.cooldown = refireCooldown
      state.stepDownLeft = stepDownRequests
      if (verdict.signal === 'echo') state.firedEchoKey = echoKey
      const message = {
        id: globalThis.crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: renderGuardMessage(verdict) }],
        source: { kind: name, signal: verdict.signal },
      }
      try {
        ctx.logger?.warn?.(
          `${name}: 断路器触发（${verdict.detail}）`
          + ` [${thresholds.stallReasoningChars}ch/${thresholds.globalStallCap}步/${thresholds.echoFailures}次失败,`
          + ` ${sensitivity}, 档位 ${state.currentEffort ?? '未知'}]`,
        )
      } catch {
        /* 日志是可选能力 */
      }
      return { ...decision, messages: [...decision.messages, message] }
    }

    if (state.cooldown > 0) state.cooldown -= 1
    return decision
  })
}
