/**
 * taskforce / guard — 运行时退化断路器（防"变笨"）。
 *
 * 为什么需要它：长上下文 + 高档位推理下，模型会出现"退化性生成" —— 一轮接一轮
 * 只有推理、既无工具调用也无可见回复文本，人设里的"思考纪律"拦不住它，
 * 因为在那个状态下纪律文本本身已经掉出有效上下文。**唯一有效的是外部力量。**
 * 本插件就是那个外部力量。
 *
 * 两个信号，全部从持久会话事件流折叠（从不读进程内存 —— resume / 压缩后
 * 重新折叠得到同一结论）：
 *
 * - STALL：连续 N 个 assistant step 只有推理、既无工具调用也无可见回复文本
 *   （零输出长推理）。**不需要读推理文本**（被路由抹掉的场景也读不到），
 *   推理块字符数就是"长思考"的客观度量。
 *   两条并联梯子：① 单步梯（一步就爆字符下限且零输出）② 慢烧梯
 *   （连续 N 步零输出，且每步都有实质推理）。
 * - ECHO：同一工具 + 同一参数连续失败 M 次且中间无成功 —— 一个坏调用卡死的闭环。
 *
 * 触发时**每个 episode 只 fire 一次**：
 *   1. 在下一个 pre-step 注入一条熔断 user 消息（唯一保证能到达模型的通道，
 *      与 working-context 投影同等持久），告诉它循环已被外部打断，请收口
 *      或换一个**实质性不同**的动作；
 *   2. 通过 `agent/request` 瀑布把 reasoning effort **临时降一档**
 *      （max→high→low，其它档位不动），持续 `stepDownRequests` 次请求后
 *      自动回落到路由自己的档位。
 *
 * **无信号时绝不改写任何请求**：唯一被改的字段是 `reasoningEffort`（请求参数，
 * 不是提示词内容），因此 prefix cache 的唯一键面不受影响，用户显式选择的档位
 * 也不会被静默覆盖。
 *
 * 保守性（本包与梁神模式的**刻意分歧**）：默认 `sensitivity: 'conservative'`
 * （梁神默认 `balanced`）。理由：误断一次真实的长思考，比漏报一次空转更贵 ——
 * 前者会让模型丢掉已经推进到一半的推理链。需要更早介入的操作员把它显式调成
 * `balanced` 或 `aggressive` 即可。
 *
 * 机制借鉴：`@linxin666/dsh-liangshen` v0.4.2（MIT）的 `guard.mjs`
 * （阈值表与两梯折叠算法）；本文件为独立重写，默认灵敏度与配置面按本包纪律调整。
 */

/** Cordis 插件名（loader 诊断用）。 */
import { toolEvent, ptcRootCalls } from './tool-events.mjs'

export const name = 'taskforce-guard'

/** 无服务依赖：只用 `ctx.on` 与可选 `ctx.logger`。 */
export const inject = []

/**
 * 单步梯：连续多少个"超长且零输出"的 step 触发。
 *
 * 取 1 是刻意的：单独一步的推理就爆掉字符下限且无任何输出，本身已经是
 * 退化性生成的首发症状；等第二步只会让它再烧掉一整轮 384K 量级的生成。
 * 慢烧梯负责小步累积的情形，所以这条梯子保持"一击即发"并不会抬高误报率 ——
 * 一步必须**同时**满足"个体巨大"且"零输出"才计入。
 */
export const DEFAULT_STALL_STEPS = 1

/**
 * 单步推理字符下限，按请求**当前**的 reasoning effort 取值。
 * 下限跟随模型被要求花的预算：max 档产生最长轨迹（官方数据：是甜点区的
 * 1.6–1.8 倍），有记录的空转都发生在那里，所以它的下限最低；low 档本来就
 * 简短，一步零输出却跑得很长几乎必然异常，下限可以更高而不误报。
 *
 * 标尺锚点：DeepSeek-V4.1 官方 MAX OUTPUT = 384K。max 档下限 8000 字符
 * （约 2–4K 思考 token）远超任何健康单步，却能在空转的头 2% 就抓住它。
 */
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

/** 触发后档位下调持续多少次请求。 */
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
  if (Array.isArray(session?.events)) return session.events
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  return []
}

/** 一条 assistant/message 事件携带的推理字符数。 */
export function reasoningCharsOf(event) {
  let chars = 0
  for (const block of event?.data?.message?.content ?? []) {
    if (block?.type === 'reasoning') chars += String(block.text ?? '').length
  }
  return chars
}

/** 一条 assistant/message 事件携带的可见回复块数（非空文本）。 */
export function visibleRepliesOf(event) {
  let count = 0
  for (const block of event?.data?.message?.content ?? []) {
    if (block?.type === 'text' && String(block.text ?? '').trim().length > 0) count += 1
  }
  return count
}

/** 一次工具调用的稳定签名：名字 + 规范化后的参数。 */
export function callSignature(event) {
  const tool = event?.data?.name
  if (typeof tool !== 'string') return undefined
  let args = event.data?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      /* 保留原始字符串 */
    }
  }
  let canonical
  try {
    canonical = JSON.stringify(args ?? null)
  } catch {
    canonical = String(args)
  }
  return `${tool}${canonical}`
}

/** 一条 tool/result 是否是错误结果。 */
export function isErrorResult(event) {
  const tool = toolEvent(event)
  return Boolean(tool?.phase === 'result' && tool.isError)
}

/**
 * 从事件流折叠断路器判定。
 *
 * 折叠沿流"由旧到新"推进，只关心**流尾**是否已经退化（当前是否退化，而非历史上是否退化过）：
 * - 连续零输出长推理步数（assistant/message 的推理字符数超阈值，且到下一个
 *   step/turn 边界前既无 tool/call 也无可见文本）；
 * - 最新工具调用的签名及其连续失败计数，被任何成功、或任何形状不同的调用清零。
 *
 * @param events - 持久事件流。
 * @param options - `{ stallSteps, stallReasoningChars, echoFailures, globalStallCap }`。
 * @returns `{ signal: 'stall' | 'echo' | undefined, detail }`。
 */
export function foldGuardSignal(events, options) {
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

  let lastSignature
  let lastCallId
  let failStreak = 0
  const stream = Array.isArray(events) ? events : []
  const wrappers = ptcRootCalls(stream)

  for (const event of stream) {
    const tool = toolEvent(event)
    if (tool !== undefined) {
      if (tool.phase === 'call') pendingOutput = true
      // Native run_code success means the transport completed, not that its
      // inner tools succeeded. Keep the logical failure chain intact.
      if (!tool.ptc && wrappers.has(tool.callId)) continue
      if (tool.phase === 'call') {
        const signature = callSignature({ data: tool })
        if (signature !== lastSignature) {
          lastSignature = signature
          failStreak = 0
        }
        lastCallId = tool.callId
      } else {
        if (tool.callId !== undefined && lastCallId !== undefined && tool.callId !== lastCallId) continue
        if (tool.isError) {
          if (lastSignature !== undefined) failStreak += 1
        } else {
          failStreak = 0
          lastSignature = undefined
          lastCallId = undefined
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
      default:
        break
    }
  }
  closeStep()

  if (stallStreak >= stallSteps) {
    return { signal: 'stall', detail: `${stallStreak} 个连续零输出的超长推理步（每步 ${stallChars}+ 字符）` }
  }
  if (globalStreak >= globalCap) {
    return { signal: 'stall', detail: `${globalStreak} 个连续零输出推理步（慢烧）` }
  }
  if (failStreak >= echoFailures) {
    return { signal: 'echo', detail: `${failStreak} 次同参数同工具的连续失败` }
  }
  return { signal: undefined, detail: '' }
}

/**
 * 解析一次请求的阈值：当前档位的自适应下限 × 灵敏度缩放；
 * 显式细调项（stallReasoningChars / globalStallCap / echoFailures）压过整张表。
 * 入参全部可选，返回值始终完整合法。
 */
export function resolveThresholds(options) {
  const effort = options?.effort
  const sensitivity = SENSITIVITY_SCALE[options?.sensitivity] !== undefined
    ? options.sensitivity
    : DEFAULT_SENSITIVITY
  const scale = SENSITIVITY_SCALE[sensitivity]
  const baseFloor = STALL_REASONING_CHARS_BY_EFFORT[effort] ?? DEFAULT_STALL_REASONING_CHARS
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
    '停止在思考里重新推导。现在只做**其中一件**：',
    '1. 把手上已有的最佳结论直接收口；或',
    '2. 采取**一个实质性不同**的动作（换工具、换参数，或切更小的子步骤）并验证它的结果。',
    '不要重复被打断的模式。',
  ].join(' ')
}

/** 注册信号折叠、pre-step 熔断注入与请求档位下调。 */
export function apply(ctx, config) {
  const enabled = config?.enabled !== false
  if (!enabled) return

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
  const stepDownRequests = integerAtLeast(config?.stepDownRequests, 'stepDownRequests', 1, DEFAULT_STEP_DOWN_REQUESTS)
  const refireCooldown = integerAtLeast(config?.refireCooldownSteps, 'refireCooldownSteps', 1, DEFAULT_REFIRE_COOLDOWN_STEPS)

  // 每个 agent 的运行时状态：冷却/下调窗口，以及最近一次请求观测到的档位。
  // 信号本身永远从持久事件流重新折叠，所以 resume 不会继承过期判定；
  // 档位是**只读观测**，只在已触发 episode 的窗口内被改写。
  const stateByAgent = new WeakMap()
  const stateOf = (agent) => {
    let state = stateByAgent.get(agent)
    if (state === undefined) {
      state = { cooldown: 0, firedVerdict: undefined, stepDownLeft: 0, currentEffort: undefined }
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
    const state = stateOf(agent)
    // 只读观测：路由实际解析出的档位。这一步本身绝不改动请求。
    if (typeof resolved?.reasoningEffort === 'string') state.currentEffort = resolved.reasoningEffort
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
    const state = stateOf(agent)

    const thresholds = resolveThresholds({
      effort: state.currentEffort,
      sensitivity,
      stallReasoningChars: overrideStallChars,
      globalStallCap: overrideGlobalCap,
      echoFailures: overrideEcho,
    })
    const verdict = foldGuardSignal(sessionEvents(agent.session), { stallSteps, ...thresholds })

    if (verdict.signal !== undefined && state.cooldown === 0) {
      // 触发：注入熔断消息并武装档位下调窗口。
      state.cooldown = refireCooldown
      state.stepDownLeft = stepDownRequests
      state.firedVerdict = verdict
      const message = {
        id: globalThis.crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: renderGuardMessage(verdict) }],
        source: { kind: name },
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
