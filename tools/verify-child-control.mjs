#!/usr/bin/env node
/**
 * task_child_send / task_child_stop 自测（假 ctx + 假 subagents 服务，零外部依赖）。
 *
 * 被审计出的 P1 是**接口错配**：真实请求里 `send_message` / `interrupt_agent` 是
 * 「向 teammate 发信 / 中断 teammate」的 Agent Teams 平面工具，而同一请求里的
 * `subagent` / `subagent_fork` 又告诉模型可以用它们继续子代理 —— 两套对象不能靠
 * 把 childId 填进 target 就视为接通（本包实际记录过 `active teammate not found`）。
 *
 * 本自测针对新增的同名不冲突工具，逐条钉住三件事：
 *   ① 走的是**原生生命周期服务**（`ctx.subagents.sendMessage` / `.interrupt`，不是转发给 teammate 工具）；
 *   ② sender 是**调用者自己的活 Agent**（`exec.agent` 本体，不是重构对象）；
 *   ③ 目标必须是**本会话自己派出的**子代理（按服务自己的 `listChildren` 目录核对），
 *      别人的子代理一律拒绝，且拒绝时**一个服务方法都不许调用**。
 *
 * 运行：node tools/verify-child-control.mjs   （退出码 0 = 全 PASS）
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const SRC = join(PKG, 'lib', 'tools', 'index.js')

let failed = 0
let passed = 0
const rows = []

function check(id, title, ok, detail = '') {
  if (ok) { passed += 1; rows.push({ id, ok }) } else { failed += 1; rows.push({ id, ok }) }
  const tail = ok || detail === '' ? '' : `\n        ↳ ${detail}`
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}  ${title}${tail}`)
}

function section(title) {
  console.log('')
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`)
}

/* ═══════════════════════════ 被测源码指纹 ═══════════════════════════ */

const SRC_SHA = existsSync(SRC)
  ? createHash('sha256').update(readFileSync(SRC)).digest('hex').slice(0, 16)
  : 'MISSING'

console.log('══════════ 子代理控制工具自测（task_child_send / task_child_stop）══════════')
console.log(`被测源码  ${SRC}`)
console.log(`源码指纹  lib/tools/index.js sha256:${SRC_SHA}`)

const toolsMod = await import(pathToFileURL(SRC).href)

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const LEAD_A = 'session-lead-a'
const LEAD_B = 'session-lead-b'
const CHILD_1 = 'session-child-1'
const CHILD_2 = 'session-child-2'
const CHILD_OTHER = 'session-child-other'

/** 会话头夹具：与宿主 `childSessionMeta()` 同形（parentSession/origin/delegationDepth）。 */
function agentOf(id, { parentSession, depth = 0, origin } = {}) {
  const header = {
    id,
    version: 4,
    createdAt: 0,
    isSeeded: false,
    origin,
    delegationDepth: depth,
    parentSession,
  }
  return { id, session: { header } }
}

const LEAD_AGENT_A = agentOf(LEAD_A)
const LEAD_AGENT_B = agentOf(LEAD_B)
const CHILD_AGENT = agentOf(CHILD_1, { parentSession: LEAD_A, depth: 1, origin: 'subagent' })

/** 目录条目夹具：服务返回 `SubagentCatalogEntry[]`（id + mode + label）。 */
const entry = (id, mode = 'continuable', label = id) => ({ id, mode, label, createdAt: 0 })

/**
 * 假 subagents 服务：**完整记录每次调用的参数**，并把结果/异常按用例注入。
 *
 * 刻意保留真身签名：`sendMessage(sender, targetId, content, options)`、
 * `interrupt(targetSessionId, authority)`、`listChildren(parentSessionId)`。
 *
 * ⚠️ **void 形状是刻意的**（复审缺陷 3 的成因就是这里造假）：
 * 真身 `interrupt()` 的签名是 `interrupt(targetSessionId, authority): void`
 * —— 同步接纳、异步停止，**不返回任何收据**（`dsh-subagent/lib/index.js:843-856`
 * 校验授权后直接 `activation.handle.agent.cancel(…)`）。旧的假服务返回
 * `{ accepted: true }`，与被测代码一起把"真宿主上永远 false"的 bug 掩盖成绿的。
 * 所以这里**明确返回 undefined**，并有一条断言钉住这个形状（见 D01）。
 *
 * 同理，真身 `listChildren()` 返回的 `SubagentCatalogEntry[]` 是
 * `{ id, createdAt, mode, label? }` —— **不带 `activity`**（`activity` 只由
 * another 接口 `listDescendants()` 补，而且语义是"观测到常驻 Session"，不是
 * "当前轮在跑"）。所以活动态改由下面的假 `agents` 表提供。
 */
function makeSubagents({
  children = [entry(CHILD_1)],
  childrenByParent,
  sendError,
  interruptError,
  listError,
  listValue,
  messageId = 'msg-0001',
  onSend,
} = {}) {
  const calls = { sendMessage: [], interrupt: [], listChildren: [] }
  const catalogOf = (parentSessionId) => (
    childrenByParent !== undefined && parentSessionId in childrenByParent
      ? childrenByParent[parentSessionId]
      : children
  )
  const service = {
    async sendMessage(sender, targetId, content, options) {
      calls.sendMessage.push({ sender, targetId, content, options })
      if (sendError !== undefined) throw sendError
      // `onSend` 让用例模拟「接纳这条消息这个动作本身改变了目标的处境」：
      // 空闲目标被唤醒成 running / 在跑的目标在调用方重读之前结束。
      // 这正是缺陷 R（投递路由反推）的**反例来源** —— 投递后的观测是这次投递
      // 造成的后果，不能反过来当作"接纳时走了哪条路径"的证据。
      if (typeof onSend === 'function') onSend({ sender, targetId, calls })
      return messageId
    },
    interrupt(targetSessionId, authority) {
      calls.interrupt.push({ targetSessionId, authority })
      if (interruptError !== undefined) throw interruptError
      // 真身契约 = void：未抛错即"请求已接纳"，没有收据可读。
      return undefined
    },
    async listChildren(parentSessionId) {
      calls.listChildren.push({ parentSessionId })
      if (listError !== undefined) throw listError
      if (listValue !== undefined) return listValue
      return catalogOf(parentSessionId)
    },
  }
  return { service, calls }
}

/**
 * 假 `ctx.agents`（活动 agent 表）—— 活动态的**唯一权威来源**。
 *
 * 契约（`cordis_inspect_query(host, Service, {service:'agents'})` 实测）：
 *   `get(id: SessionId): Agent | undefined`
 * 且 `Agent.status: AgentStatus = 'idle' | 'running'` —— "The current lifecycle state,
 * mirrored on every `agent/status` transition."（`dsh-agent/lib/types/runtime-types.d.ts:90,147`）。
 * 官方 `list_agents` 与之一致：`agents.get(id)?.status === 'running' ? 'running' : 'inactive'`。
 *
 * 表里没有该 id ⇒ `get()` 返回 undefined ⇒ 目标不 live ⇒ `inactive`（官方同一读法）。
 */
function makeAgents({ statusById = {} } = {}) {
  const calls = { get: [] }
  const table = new Map(Object.entries(statusById))
  return {
    calls,
    table,
    service: {
      get(id) {
        calls.get.push(id)
        if (!table.has(id)) return undefined
        return { id, status: table.get(id) }
      },
    },
    /** 模拟目标开始/停止跑：`'running'` / `'idle'`；`clear` = 移出活动表。 */
    setStatus(id, status) { table.set(id, status) },
    clear(id) { table.delete(id) },
  }
}

/** 搭一个 ctx：服务表里可有 taskforceStore（凭据要求可省）、subagents 与 agents。 */
function makeCtx({ subagents, agents, withStore = true } = {}) {
  const services = new Map()
  if (withStore) {
    services.set('taskforceStore', {
      openTask: () => ({ task_id: 1 }),
      board: () => ({ tasks: [] }),
    })
  }
  if (subagents !== undefined) services.set('subagents', subagents)
  // 假 ctx 里默认放一张活动表：真宿主上 `ctx.agents` 是常驻服务，
  // 缺了它反而会掩盖"活动态从哪来"这件事（旧实现读的是目录里不存在的字段）。
  // `withoutAgents` 用例刻意不挂它，用来验证"没有活动态就 unknown，不推断"。
  if (agents !== undefined) services.set('agents', agents)
  const state = { warnings: [], tools: [] }
  const ctx = {
    logger: { warn: (m) => state.warnings.push(String(m)), info() {} },
    get: (name) => services.get(name),
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, state, services }
}

/** 注册一次工具，返回按名调用 + 原始定义（含 parameters schema）+ 两张假服务表。 */
function harness(options = {}) {
  const agentsFake = options.agentsFake
    ?? makeAgents(options.agentsStatus === undefined ? {} : { statusById: options.agentsStatus })
  const { ctx, state, services } = makeCtx({
    ...options,
    // 注册的是**服务对象本身**（`{ get(id) }`），不是包着它的测试夹具。
    agents: options.withoutAgents === true ? undefined : agentsFake.service,
  })
  toolsMod.apply(ctx)
  const byName = new Map(state.tools.map((tool) => [tool.name, tool]))
  const call = async (name, args, exec) => JSON.parse(await byName.get(name).execute(args, exec))
  return { ctx, state, services, byName, call, agents: agentsFake }
}

/* ═══════════════════════════ 0. 注册面 ═══════════════════════════ */

section('0. 注册面：两个新工具名字不与既有工具冲突')

check(
  'C00a',
  'task_child_send / task_child_stop 都在 TOOL_NAMES 里，且与 Agent Teams 平面工具名不冲突',
  toolsMod.TOOL_NAMES.includes('task_child_send')
    && toolsMod.TOOL_NAMES.includes('task_child_stop')
    && !toolsMod.TOOL_NAMES.includes('send_message')
    && !toolsMod.TOOL_NAMES.includes('interrupt_agent'),
  `TOOL_NAMES=${toolsMod.TOOL_NAMES.join(',')}`,
)

check(
  'C00b',
  '工具描述明写「subagent / 本会话派出」并显式区分 teammate 平面（消除歧义的落点）',
  (() => {
    const send = toolsMod.TOOL_SPECS.task_child_send.description
    const stop = toolsMod.TOOL_SPECS.task_child_stop.description
    return send.includes('subagent') && send.includes('send_message')
      && stop.includes('subagent') && stop.includes('interrupt_agent')
      && send.includes('teammate') && stop.includes('teammate')
  })(),
  JSON.stringify({
    send: toolsMod.TOOL_SPECS.task_child_send.description.slice(0, 120),
    stop: toolsMod.TOOL_SPECS.task_child_stop.description.slice(0, 120),
  }),
)

check(
  'C00c',
  '参数 schema：target_id / message 为必填 string，reason 可选',
  (() => {
    const schema = toolsMod.compileParameters(toolsMod.TOOL_SPECS.task_child_send.parameters)
    const stopSchema = toolsMod.compileParameters(toolsMod.TOOL_SPECS.task_child_stop.parameters)
    return JSON.stringify(schema.required) === JSON.stringify(['target_id', 'message'])
      && schema.properties.target_id.type === 'string'
      && schema.properties.message.type === 'string'
      && stopSchema.required.length === 1 && stopSchema.required[0] === 'target_id'
      && stopSchema.properties.reason.type === 'string'
  })(),
  JSON.stringify(toolsMod.compileParameters(toolsMod.TOOL_SPECS.task_child_send.parameters)),
)

/* ═══════════════════════════ 1. 正常续作 ═══════════════════════════ */

section('1. 正常续作：sendMessage 收到正确的 sender / targetId / content')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service })
  const message = '改要求：只做 A 段，不要碰 B 段；完成后落一条 artifact 事实。'
  const result = await h.call('task_child_send', { target_id: CHILD_1, message }, { agent: LEAD_AGENT_A })
  const got = fake.calls.sendMessage[0]

  check(
    'C01',
    '续作成功：ok:true + message_id 回传 + 服务确实被调用一次',
    result.ok === true && result.sent?.message_id === 'msg-0001' && fake.calls.sendMessage.length === 1,
    JSON.stringify(result),
  )

  check(
    'C02',
    'sender === exec.agent 本体（同一引用，不是重构/伪造对象）',
    got !== undefined && got.sender === LEAD_AGENT_A,
    `sender=${JSON.stringify(got?.sender)}  same=${got?.sender === LEAD_AGENT_A}`,
  )

  check(
    'C03',
    'targetId 原样透传（trim 后 = 本会话子代理 id）',
    got?.targetId === CHILD_1,
    `targetId=${JSON.stringify(got?.targetId)}`,
  )

  check(
    'C04',
    'content 是契约形状的 ContentBlock[]：[{ type:"text", text: 全文 }]',
    Array.isArray(got?.content) && got.content.length === 1
      && got.content[0].type === 'text' && got.content[0].text === message,
    JSON.stringify(got?.content),
  )

  check(
    'C05',
    'options 满足 SubagentSendMessageOptions（signal 必填，不是 undefined）',
    got?.options !== undefined && got.options.signal !== undefined && got.options.signal !== null
      && typeof got.options.signal === 'object',
    JSON.stringify({ optionsKeys: Object.keys(got?.options ?? {}), signalType: typeof got?.options?.signal }),
  )

  check(
    'C06',
    '返回值带真实状态：current_turn 只有 running / inactive / unknown 三种取值',
    ['running', 'inactive', 'unknown'].includes(result.target?.current_turn),
    JSON.stringify(result.target),
  )

  check(
    'C07',
    '归属核对走的是服务自己的 listChildren(callerSessionId)，parentSessionId = 调用者会话；'
      + '且「操作前状态」复用归属核对那一份快照（不重复读目录）',
    fake.calls.listChildren.length === 2
      && fake.calls.listChildren.every((c) => c.parentSessionId === LEAD_A),
    JSON.stringify(fake.calls.listChildren),
  )

  check(
    'C07b',
    'activity_before 来自归属快照，current_turn 来自操作后重读（两次读，2 个字段各归其位）',
    result.target?.activity_before === 'inactive' && result.target?.current_turn === 'inactive',
    JSON.stringify(result.target),
  )
}

/* ═══════════════════════════ 2. 正常停止 ═══════════════════════════ */

section('2. 正常停止：interrupt 收到正确的 targetSessionId 与授权形状')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service })
  const result = await h.call('task_child_stop', { target_id: CHILD_1, reason: '方向错了' }, { agent: LEAD_AGENT_A })
  const got = fake.calls.interrupt[0]

  check(
    'C08',
    '停止成功：ok:true + accepted:true + 服务确实被调用一次',
    result.ok === true && result.stopped?.accepted === true && fake.calls.interrupt.length === 1,
    JSON.stringify(result),
  )

  check(
    'C09',
    'targetSessionId === CHILD_1（原样透传）',
    got?.targetSessionId === CHILD_1,
    JSON.stringify(got?.targetSessionId),
  )

  check(
    'C10',
    'authority 形状 = SubagentInterruptAuthority 的 ancestor 支：{ kind:"ancestor", agent:<调用者活 Agent> }',
    got?.authority?.kind === 'ancestor' && got.authority.agent === LEAD_AGENT_A,
    JSON.stringify({ kind: got?.authority?.kind, sameAgent: got?.authority?.agent === LEAD_AGENT_A }),
  )

  check(
    'C11',
    '返回体区分「信号已发出」与「已安静」：带 state_truth + current_turn',
    typeof result.state_truth === 'string' && result.state_truth.includes('中断信号已发出')
      && result.target?.current_turn !== undefined,
    JSON.stringify({ state_truth: result.state_truth, current_turn: result.target?.current_turn }),
  )

  check(
    'C12',
    'reason 只进返回体、不进服务调用（interrupt 签名只有两个参数）',
    result.stopped?.reason === '方向错了' && Object.keys(got ?? {}).length === 2,
    JSON.stringify(got),
  )
}

/* ═══════════════════════════ 3. 跨会话保护 ═══════════════════════════ */

section('3. 跨会话保护：目标不是本会话子代理时被拒，且一个服务方法都不调用')

{
  // 真身的 listChildren(parentSessionId) 是 **per-parent 持久化目录**：LEAD_B 名下根本没有
  // CHILD_1 这条记录。夹具必须同样按父区分，否则「服务里存在」会被误当成「本会话派出」。
  const scoped = makeSubagents({
    childrenByParent: { [LEAD_A]: [entry(CHILD_1)], [LEAD_B]: [entry(CHILD_2)] },
  })
  const scopedHarness = harness({ subagents: scoped.service })

  const sendOther = await scopedHarness.call('task_child_send', { target_id: CHILD_OTHER, message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C13',
    'task_child_send：别人的子代理 id → ok:false + E_CHILD_NOT_OWN + 可读错误（指名 id 与会话）',
    sendOther.ok === false && sendOther.code === 'E_CHILD_NOT_OWN'
      && sendOther.error.includes(CHILD_OTHER) && sendOther.error.includes(LEAD_A),
    JSON.stringify(sendOther),
  )
  check(
    'C14',
    'C13 的拒绝**没有**调用 sendMessage（拒绝发生在服务写入之前）',
    scoped.calls.sendMessage.length === 0,
    JSON.stringify(scoped.calls.sendMessage),
  )

  const stopOther = await scopedHarness.call('task_child_stop', { target_id: CHILD_OTHER }, { agent: LEAD_AGENT_A })
  check(
    'C15',
    'task_child_stop：别人的子代理 id → ok:false + E_CHILD_NOT_OWN',
    stopOther.ok === false && stopOther.code === 'E_CHILD_NOT_OWN',
    JSON.stringify(stopOther),
  )
  check(
    'C16',
    'C15 的拒绝**没有**调用 interrupt',
    scoped.calls.interrupt.length === 0,
    JSON.stringify(scoped.calls.interrupt),
  )

  // 关键反例：CHILD_1 确实是「服务里存在」的 continuable 子代理，但它挂在 LEAD_A 名下。
  // 换成 LEAD_B 调用必须被拒 —— 证伪「服务里能找到就能操作」这种错误判据。
  const crossCtx = await scopedHarness.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_B })
  check(
    'C17',
    '同一目标（服务里确实存在的 continuable 子代理）换另一个会话调用 → 被拒，禁止主控操作别人的子代理',
    crossCtx.ok === false && crossCtx.code === 'E_CHILD_NOT_OWN' && scoped.calls.sendMessage.length === 0,
    JSON.stringify({ result: crossCtx, sendCalls: scoped.calls.sendMessage.length }),
  )

  // LEAD_B 操作**自己**的子代理必须成功（否则「拒绝」可能只是能力不足，而不是权限判据在起作用）。
  // 实测读次数（非估计）：拒绝路径 1 次（归属核对即返回），成功路径 2 次（归属快照 + 操作后重读）。
  // 本节的 4 次调用 ⇒ C13(1) + C15(1) + C17(1) + C18(2) = 5 次，且父会话严格跟随调用者。
  const crossOwn = await scopedHarness.call('task_child_stop', { target_id: CHILD_2 }, { agent: LEAD_AGENT_B })
  check(
    'C18',
    '对照正例：同一服务、同一会话切到它自己的子代理 → 成功；且每次核对都以调用者自己的会话 id 为父',
    crossOwn.ok === true && scoped.calls.interrupt.length === 1
      && scoped.calls.listChildren.map((c) => c.parentSessionId).join(',')
        === `${LEAD_A},${LEAD_A},${LEAD_B},${LEAD_B},${LEAD_B}`,
    JSON.stringify({ result: crossOwn, queries: scoped.calls.listChildren }),
  )
}

/* ═══════════════════════════ 4. 已结算 / 目录不可用 ═══════════════════════════ */

section('4. 已结算子代理与目录读失败：分类错误，不笼统失败')

{
  const oneShot = makeSubagents({ children: [entry(CHILD_1, 'one-shot')] })
  const hOne = harness({ subagents: oneShot.service })
  const settled = await hOne.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C19',
    'one-shot（已结算）→ E_CHILD_SETTLED（≠ 不存在，也 ≠ 跨会话）',
    settled.ok === false && settled.code === 'E_CHILD_SETTLED' && oneShot.calls.sendMessage.length === 0,
    JSON.stringify(settled),
  )

  const unknown = makeSubagents({ children: [entry(CHILD_1, 'unknown')] })
  const hUnknown = harness({ subagents: unknown.service })
  const unknownResult = await hUnknown.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C20',
    'unknown 模式 → 同样按 E_CHILD_SETTLED 拒绝（记录不足以证明可续作）',
    unknownResult.ok === false && unknownResult.code === 'E_CHILD_SETTLED',
    JSON.stringify(unknownResult),
  )

  const broken = makeSubagents({ listError: new Error('session query unavailable') })
  const hBroken = harness({ subagents: broken.service })
  const brokenResult = await hBroken.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C21',
    '目录读失败 → E_CHILD_NO_ID + 提示归因到服务不可用（不猜、不冒险操作他人子代理）',
    brokenResult.ok === false && brokenResult.code === 'E_CHILD_NO_ID'
      && brokenResult.error.includes('session query unavailable')
      && brokenResult.hint.includes('不可用') && broken.calls.interrupt.length === 0,
    JSON.stringify({ result: brokenResult, interruptCalls: broken.calls.interrupt.length }),
  )

  const notArray = makeSubagents({ listValue: null })
  const hNotArray = harness({ subagents: notArray.service })
  const notArrayResult = await hNotArray.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C22',
    '目录返回非数组（异常宿主）→ 按「不是本会话子代理」拒绝，不抛异常、不调用服务',
    notArrayResult.ok === false && notArrayResult.code === 'E_CHILD_NOT_OWN' && notArray.calls.sendMessage.length === 0,
    JSON.stringify(notArrayResult),
  )
}

/* ═══════════════════════════ 5. 身份缺失 ═══════════════════════════ */

section('5. 身份缺失：拒绝服务，不退化、不猜')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service })

  const noExec = await h.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, undefined)
  check(
    'C23',
    'exec 缺失 → E_CHILD_NO_AGENT，且无任何服务调用',
    noExec.ok === false && noExec.code === 'E_CHILD_NO_AGENT' && fake.calls.sendMessage.length === 0,
    JSON.stringify({ result: noExec, calls: fake.calls.sendMessage.length }),
  )

  const noAgent = await h.call('task_child_stop', { target_id: CHILD_1 }, {})
  check(
    'C24',
    'exec.agent 缺失 → E_CHILD_NO_AGENT（停止同样不退化）',
    noAgent.ok === false && noAgent.code === 'E_CHILD_NO_AGENT'
      && noAgent.hint.includes('身份不可得') && fake.calls.interrupt.length === 0,
    JSON.stringify(noAgent),
  )

  const noHeader = await h.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: {} })
  check(
    'C25',
    'agent 无会话头（无法证明本会话派出了谁）→ E_CHILD_NO_AGENT，不猜 id',
    noHeader.ok === false && noHeader.code === 'E_CHILD_NO_AGENT' && fake.calls.sendMessage.length === 0,
    JSON.stringify(noHeader),
  )

  const identityFirst = await h.call('task_child_send', { target_id: '', message: '' }, undefined)
  check(
    'C26',
    '参数校验优先于身份：坏参数（空 target_id / 空 message）立刻返回可自行修正的 E_CHILD_INPUT，'
      + '不会先被身份问题掩盖成需要上报的错误',
    identityFirst.ok === false && identityFirst.code === 'E_CHILD_INPUT',
    JSON.stringify(identityFirst),
  )

  const nonStringPlusNoAgent = await h.call('task_child_send', { target_id: 42, message: 'hi' }, undefined)
  check(
    'C26b',
    '两处都不对时同样先报 E_CHILD_INPUT（可修正），而不是先报身份（需上报）',
    nonStringPlusNoAgent.ok === false && nonStringPlusNoAgent.code === 'E_CHILD_INPUT',
    JSON.stringify(nonStringPlusNoAgent),
  )
}

/* ═══════════════════════════ 6. 服务不可用 ═══════════════════════════ */

section('6. 服务不可用：可读错误而非崩溃（不静默降级到 teammate 工具）')

{
  const noService = harness({ subagents: undefined })
  const result = await noService.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C27',
    'subagents 未挂载 → ok:false + E_CHILD_SERVICE + 提示「不要改用 send_message / interrupt_agent」',
    result.ok === false && result.code === 'E_CHILD_SERVICE'
      && result.error.includes('subagents') && result.hint.includes('send_message')
      && result.hint.includes('不可用'),
    JSON.stringify(result),
  )
  check(
    'C28',
    '同上：注册期已告警（不静默），且工具仍保持注册（10 个）',
    noService.state.warnings.some((w) => w.includes('subagents')) && noService.state.tools.length === 10,
    JSON.stringify({ warnings: noService.state.warnings, tools: noService.state.tools.length }),
  )

  const emptyService = harness({ subagents: {} })
  const emptyResult = await emptyService.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C29',
    '服务对象存在但缺 listChildren（半挂载）→ 同样 E_CHILD_SERVICE，不抛 TypeError',
    emptyResult.ok === false && emptyResult.code === 'E_CHILD_SERVICE',
    JSON.stringify(emptyResult),
  )

  const onlySend = harness({ subagents: { listChildren: async () => [], sendMessage: async () => 'x' } })
  const stopOnSendOnly = await onlySend.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  const sendOnSendOnly = await onlySend.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C30',
    '半能力服务（只有 sendMessage）→ 停止报 E_CHILD_SERVICE（缺 interrupt）；续作**不误报**服务不可用，'
      + '而是按目录判据拒绝（该服务目录为空 ⇒ 目标不是它的子代理）',
    stopOnSendOnly.ok === false && stopOnSendOnly.code === 'E_CHILD_SERVICE'
      && sendOnSendOnly.ok === false && sendOnSendOnly.code === 'E_CHILD_NOT_OWN',
    JSON.stringify({ stop: stopOnSendOnly.code, send: sendOnSendOnly.code }),
  )
}

/* ═══════════════════════════ 7. 参数校验 ═══════════════════════════ */

section('7. 参数校验：空消息 / 缺 targetId 被拒，且不调用服务')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service })

  const emptyMessage = await h.call('task_child_send', { target_id: CHILD_1, message: '   ' }, { agent: LEAD_AGENT_A })
  check(
    'C31',
    '空消息（纯空白）→ E_CHILD_INPUT，未调用 sendMessage',
    emptyMessage.ok === false && emptyMessage.code === 'E_CHILD_INPUT'
      && emptyMessage.error.includes('message') && fake.calls.sendMessage.length === 0,
    JSON.stringify(emptyMessage),
  )

  const missingMessage = await h.call('task_child_send', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C32',
    '缺 message 字段 → E_CHILD_INPUT（不变成 undefined 投递）',
    missingMessage.ok === false && missingMessage.code === 'E_CHILD_INPUT' && fake.calls.sendMessage.length === 0,
    JSON.stringify(missingMessage),
  )

  const missingTarget = await h.call('task_child_send', { message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C33',
    '缺 target_id → E_CHILD_INPUT，未调用 sendMessage',
    missingTarget.ok === false && missingTarget.code === 'E_CHILD_INPUT' && fake.calls.sendMessage.length === 0,
    JSON.stringify(missingTarget),
  )

  const nonStringTarget = await h.call('task_child_send', { target_id: 42, message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C34',
    'target_id 类型不是 string → 按缺失处理（拒绝），不把数字偷偷转成 id',
    nonStringTarget.ok === false && nonStringTarget.code === 'E_CHILD_INPUT' && fake.calls.sendMessage.length === 0,
    JSON.stringify(nonStringTarget),
  )

  const stopMissing = await h.call('task_child_stop', {}, { agent: LEAD_AGENT_A })
  check(
    'C35',
    'task_child_stop 缺 target_id → E_CHILD_INPUT，未调用 interrupt',
    stopMissing.ok === false && stopMissing.code === 'E_CHILD_INPUT' && fake.calls.interrupt.length === 0,
    JSON.stringify(stopMissing),
  )
}

/* ═══════════════════════════ 8. 服务抛错传播 ═══════════════════════════ */

section('8. 服务侧抛错：转成可读 ok:false，不崩工具')

{
  const sendFail = makeSubagents({ children: [entry(CHILD_1)], sendError: new Error('subagent/delivery-unavailable') })
  const hSend = harness({ subagents: sendFail.service })
  const sendResult = await hSend.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A })
  check(
    'C36',
    'sendMessage 抛错 → ok:false 且带上服务原文（模型能判断是不可用还是参数问题）',
    sendResult.ok === false && sendResult.error.includes('delivery-unavailable'),
    JSON.stringify(sendResult),
  )

  const interruptFail = makeSubagents({
    children: [entry(CHILD_1)],
    interruptError: Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }),
  })
  const hStop = harness({ subagents: interruptFail.service })
  const stopResult = await hStop.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C37',
    'interrupt 抛 UNAUTHORIZED → E_CHILD_NOT_OWN + 原文，明确「不是参数抄错能修的」',
    stopResult.ok === false && stopResult.code === 'E_CHILD_NOT_OWN'
      && stopResult.error.includes('UNAUTHORIZED') && stopResult.error.includes('授权'),
    JSON.stringify(stopResult),
  )
}

/* ═══════════════════════════ 8b. signal 契约 ═══════════════════════════ */

section('8b. signal 契约：真身直接调 options.signal.throwIfAborted()')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service })
  const result = await h.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A })
  const signal = fake.calls.sendMessage[0]?.options?.signal

  check(
    'C45',
    '宿主不给 signal 时仍投递成功，且 options.signal 是可用的取消信号（implement throwIfAborted）',
    result.ok === true
      && typeof signal?.throwIfAborted === 'function'
      && signal.aborted === false
      && (() => { try { signal.throwIfAborted(); return true } catch { return false } })(),
    JSON.stringify({ ok: result.ok, hasThrow: typeof signal?.throwIfAborted, aborted: signal?.aborted }),
  )

  check(
    'C46',
    '兜底生效时留可观测告警（不静默吞掉宿主契约问题）',
    h.state.warnings.some((w) => w.includes('没有可用 signal')),
    JSON.stringify(h.state.warnings),
  )

  // 调用方自己带真信号时必须原样转发（取消语义才能真的生效）。
  const realSignal = new AbortController().signal
  const result2 = await h.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A, signal: realSignal })
  check(
    'C47',
    'exec.signal 存在时原样透传（同一引用），不使用兜底',
    result2.ok === true && fake.calls.sendMessage[1]?.options?.signal === realSignal,
    JSON.stringify({ same: fake.calls.sendMessage[1]?.options?.signal === realSignal }),
  )

  const aborted = new AbortController()
  aborted.abort()
  const result3 = await h.call('task_child_send', { target_id: CHILD_1, message: 'hi' }, { agent: LEAD_AGENT_A, signal: aborted.signal })
  check(
    'C48',
    '已取消的信号照样按原引用转发（取消与否由服务判定，本工具不替它决定）',
    result3.ok === true && fake.calls.sendMessage[2]?.options?.signal === aborted.signal
      && fake.calls.sendMessage[2].options.signal.aborted === true,
    JSON.stringify({ abortedForwarded: fake.calls.sendMessage[2]?.options?.signal?.aborted }),
  )
}

/* ═══════════════════════════ 9. 停止后确认真实状态 ═══════════════════════════ */

section('9. 「停止后确认真实状态」这条验收的机械支撑')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  // 活动态来自 `ctx.agents`（假活动表），**不再**塞进 listChildren 的目录条目 ——
  // 真身目录不带 activity，旧夹具那样写就等于在测一个不存在的字段。
  const h = harness({ subagents: fake.service, agentsStatus: { [CHILD_1]: 'running' } })
  const resultRunning = await h.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C38',
    '目标仍在跑时返回 current_turn=running + state_truth 明确「信号已发 ≠ 已安静」',
    // 锚点用**观测值**而不是旧文案的字面串（'仍显示 running'）：修正后文案按复审要求
    // 把取值写成 status=… / current_turn=…，语义不变、字面变了。
    resultRunning.target?.current_turn === 'running'
      && resultRunning.state_truth.includes('current_turn=running')
      && resultRunning.state_truth.includes('仍在跑')
      && resultRunning.state_truth.includes('信号已发'),
    JSON.stringify({ target: resultRunning.target, state_truth: resultRunning.state_truth }),
  )

  h.agents.setStatus(CHILD_1, 'idle')
  const resultIdle = await h.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C39',
    '目标已停时返回 current_turn=inactive（同一个调用给出真实状态，调用方无需猜）',
    resultIdle.target?.current_turn === 'inactive' && resultIdle.state_truth.includes('inactive'),
    JSON.stringify({ target: resultIdle.target, state_truth: resultIdle.state_truth }),
  )

  const beforeSend = fake.calls.sendMessage.length
  const sendIdle = await h.call('task_child_send', { target_id: CHILD_1, message: '接着做 B 段' }, { agent: LEAD_AGENT_A })
  check(
    'C40',
    '空闲目标续作：投递成功，delivery 只述「已被收件箱接纳」，不再由投递后活动态推 queue',
    sendIdle.ok === true && fake.calls.sendMessage.length === beforeSend + 1
      && sendIdle.delivery.startsWith('accepted')
      && !/steer|queue/.test(sendIdle.delivery)
      && sendIdle.route?.reported === false,
    JSON.stringify({ delivery: sendIdle.delivery, route: sendIdle.route, target: sendIdle.target }),
  )
}

/* ═══════════════════════════ 10. 与既有 8 工具的隔离 ═══════════════════════════ */

section('10. 不影响既有工具行为')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service })
  const board = await h.call('task_board', {}, { agent: LEAD_AGENT_A })
  check(
    'C41',
    '既有 task_board 仍走事实库（不因新增工具而改变），且返回体无子代理字段污染',
    board.ok === true && board.viewer === `lead:${LEAD_A}` && board.can_accept === true
      && board.sent === undefined && board.stopped === undefined,
    JSON.stringify(board),
  )

  const storeGone = harness({ subagents: fake.service, withStore: false })
  const noStore = await storeGone.call('task_board', {}, { agent: LEAD_AGENT_A })
  check(
    'C42',
    '既有工具的服务缺失路径不变：task_board 仍报事实库「服务不可用」且 hint 指向部署问题',
    noStore.ok === false && noStore.error.includes('服务不可用') && noStore.hint.includes('部署问题'),
    JSON.stringify(noStore),
  )

  // 目录按父会话区分：LEAD_A 的直属子代是 CHILD_1；CHILD_1 自己是父，直属子代是 CHILD_2。
  // 于是「用 CHILD_1 的身份能否操作 CHILD_2」只可能成立当且仅当工具真的按**调用者自己的会话**查目录。
  const nested = makeSubagents({
    childrenByParent: { [LEAD_A]: [entry(CHILD_1)], [CHILD_1]: [entry(CHILD_2)] },
  })
  const nestedHarness = harness({ subagents: nested.service })

  const childStopsOwnChild = await nestedHarness.call('task_child_stop', { target_id: CHILD_2 }, { agent: CHILD_AGENT })
  check(
    'C43',
    '子代理能停**自己派出**的子代理（不额外限 lead），用的是它自己的会话 id 去查目录',
    childStopsOwnChild.ok === true && nested.calls.listChildren.at(-1)?.parentSessionId === CHILD_1
      && nested.calls.interrupt[0]?.targetSessionId === CHILD_2
      && nested.calls.interrupt[0]?.authority?.agent === CHILD_AGENT,
    JSON.stringify({ result: childStopsOwnChild, queries: nested.calls.listChildren, interrupt: nested.calls.interrupt }),
  )

  const leadCannotReachGrandchild = await nestedHarness.call(
    'task_child_send',
    { target_id: CHILD_2, message: 'hi' },
    { agent: LEAD_AGENT_A },
  )
  check(
    'C44',
    '反向隔离：主控管不到「子代理的子代理」（不在它的直属目录里 → E_CHILD_NOT_OWN，无服务调用）',
    leadCannotReachGrandchild.ok === false && leadCannotReachGrandchild.code === 'E_CHILD_NOT_OWN'
      && nested.calls.sendMessage.length === 0,
    JSON.stringify({ result: leadCannotReachGrandchild, sendCalls: nested.calls.sendMessage.length }),
  )
}

/* ═══════ 11. 契约形状自检 + 缺陷 2/3 回归（假服务必须与真宿主一致） ═══════ */

section('11a. 契约形状自检：假服务必须与真宿主一致（复审判过一次"假绿"）')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const returned = fake.service.interrupt(CHILD_1, { kind: 'ancestor', agent: LEAD_AGENT_A })
  check(
    'C49',
    '假 interrupt() 是 **void**（返回 undefined），与真身 `interrupt(targetSessionId, authority): void` 一致',
    returned === undefined,
    `实际返回 ${JSON.stringify(returned)}（真身 dsh-subagent/lib/index.js:843-856 不返回收据）`,
  )

  const rowsOf = await fake.service.listChildren(LEAD_A)
  check(
    'C50',
    '假 listChildren() 的目录条目**不含 activity**，与真身 `SubagentCatalogEntry` 一致'
      + '（activity 只由 listDescendants 补，且语义是"常驻 Session"而非"当前轮在跑"）',
    Array.isArray(rowsOf) && rowsOf.length > 0
      && rowsOf.every((row) => !Object.hasOwn(row, 'activity')),
    JSON.stringify(rowsOf),
  )

  const agentsFake = makeAgents({ statusById: { [CHILD_1]: 'running' } })
  const live = agentsFake.service.get(CHILD_1)
  check(
    'C51',
    '假 agents.get() 与真身 `get(id: SessionId): Agent | undefined` 一致：'
      + '命中返回带 `status` 的对象，未命中返回 undefined（无伪造字段）',
    live !== undefined && live.status === 'running' && agentsFake.service.get('nope') === undefined,
    JSON.stringify({ hit: live, miss: agentsFake.service.get('nope') }),
  )
}

section('11b. 缺陷 3 回归：宿主 interrupt() 是 void —— 未抛错即"请求已接纳"')

{
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service })
  const result = await h.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C52',
    'void 契约下停止成功仍报 accepted:true（旧实现读 receipt?.accepted ⇒ 真宿主上恒 false）',
    result.ok === true && result.stopped?.accepted === true,
    JSON.stringify(result.stopped),
  )
  check(
    'C53',
    '返回体标明接纳判据来自 void 契约（receipt 字段），不是凭空断言',
    typeof result.stopped?.receipt === 'string' && result.stopped.receipt.includes('void'),
    JSON.stringify(result.stopped),
  )

  // 兼容支：万一宿主将来返回显式收据且**明确否认**，以收据为准（不被"void ⇒ 一律接纳"盖住）。
  const explicit = {
    async listChildren() { return [entry(CHILD_1)] },
    sendMessage: async () => 'msg-0001',
    interrupt() { return { accepted: false } },
  }
  const hExplicit = harness({ subagents: explicit })
  const denied = await hExplicit.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C54',
    '显式否认收据（{accepted:false}）仍被读成未接纳 —— 契约变化不被掩盖',
    denied.ok === true && denied.stopped?.accepted === false && String(denied.stopped?.receipt).includes('receipt'),
    JSON.stringify(denied.stopped),
  )
}

section('11c. 缺陷 2 回归：没有活动态就 unknown，不推断"已停止"/queue/steer')

{
  // agents 服务不可用（宿主版本缺该服务）⇒ 活动态读不到。
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service, withoutAgents: true })

  const stop = await h.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C55',
    '读不到活动态 ⇒ current_turn=unknown（不是 inactive）',
    stop.ok === true && stop.target?.current_turn === 'unknown',
    JSON.stringify(stop.target),
  )
  check(
    'C56',
    'unknown **不落进"已安静"分支**：state_truth 明说无法证明，且不出现"不在跑"的结论',
    stop.state_truth.includes('无法证明') && stop.state_truth.includes('current_turn=unknown')
      && !stop.state_truth.includes('活动 agent 表此刻显示目标不在跑'),
    JSON.stringify(stop.state_truth),
  )
  check(
    'C57',
    '"请求已接纳"与"执行已停止"分开：accepted=true 而 execution.stopped=null（未知，不推导）',
    stop.stopped?.accepted === true && stop.execution?.stopped === null && stop.execution?.observed === 'unknown',
    JSON.stringify({ stopped: stop.stopped, execution: stop.execution }),
  )

  const send = await h.call('task_child_send', { target_id: CHILD_1, message: '继续' }, { agent: LEAD_AGENT_A })
  check(
    'C58',
    '读不到活动态：投递仍成功，delivery 仍是同一句「已接纳」—— 不再有由活动态派生的 unknown / queue / steer 三路话术',
    send.ok === true && send.sent?.message_id === 'msg-0001'
      && send.delivery.startsWith('accepted')
      && !/steer|queue/.test(send.delivery)
      && send.route?.reported === false,
    JSON.stringify({ delivery: send.delivery, route: send.route }),
  )

  check(
    'C59',
    '不把"重复调 task_child_stop 查状态"当建议（旧的 next 文案会诱导这一用法）',
    !stop.next.includes('再 task_child_stop') && stop.next.includes('不要为了查状态重复调'),
    JSON.stringify(stop.next),
  )
}

{
  // 活动态与目录**分两路**：第 2 次目录读（状态刷新那次）失败，活动态仍必须读得到。
  let listCalls = 0
  const flaky = {
    async listChildren() {
      listCalls += 1
      if (listCalls > 1) throw new Error('SESSION_QUERY_UNAVAILABLE')
      return [entry(CHILD_1)]
    },
    sendMessage: async () => 'msg-0001',
    interrupt() {},
  }
  const h = harness({ subagents: flaky, agentsStatus: { [CHILD_1]: 'running' } })
  const result = await h.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  check(
    'C60',
    '目录读失败不影响活动态（两路来源分开）：仍读出 running，而不是被一起降级成 unknown',
    result.ok === true && result.target?.current_turn === 'running' && result.execution?.stopped === false
      && listCalls === 2,
    JSON.stringify({ target: result.target, execution: result.execution, listCalls }),
  )
}

{
  // 目标在跑：accepted（已接纳）与 execution.stopped（已停止）必须是两个不同的答案。
  const fake = makeSubagents({ children: [entry(CHILD_1)] })
  const h = harness({ subagents: fake.service, agentsStatus: { [CHILD_1]: 'running' } })
  const stop = await h.call('task_child_stop', { target_id: CHILD_1 }, { agent: LEAD_AGENT_A })
  const send = await h.call('task_child_send', { target_id: CHILD_1, message: '继续' }, { agent: LEAD_AGENT_A })
  check(
    'C61',
    '目标 running：stop 报 accepted=true 但 execution.stopped=false（接纳 ≠ 停止）；'
      + 'send 的 delivery 只述「已接纳」、不报 steer',
    stop.stopped?.accepted === true && stop.execution?.stopped === false
      && stop.state_truth.includes('current_turn=running')
      && send.delivery.startsWith('accepted') && !/steer|queue/.test(send.delivery)
      && send.route?.reported === false,
    JSON.stringify({ stopped: stop.stopped, execution: stop.execution, delivery: send.delivery }),
  )
}

section('11d. 缺陷 R 回归：投递路径不由「投递后的活动态」推断（两次观测 ≠ 路由回执）')

{
  // 复审给的两个反例，逐条复现。两例的**投递本身都成功**（message_id 有效），
  // 差别只在"接纳这条消息这个动作改变了目标的处境"，于是旧实现在投递后读到
  // 的活动态恰好指向**错误的**那条路由。
  //
  // 反例 1：空闲目标被**本次投递**唤醒 ⇒ 投递后 running。旧实现报 steer，
  // 但这条消息走的其实是"起新一轮"。
  const agentsWake = makeAgents({})
  const wakeFake = makeSubagents({
    children: [entry(CHILD_1)],
    onSend: () => agentsWake.setStatus(CHILD_1, 'running'),
  })
  const hWake = harness({ subagents: wakeFake.service, agentsFake: agentsWake })
  const woke = await hWake.call('task_child_send', { target_id: CHILD_1, message: '接着做' }, { agent: LEAD_AGENT_A })

  check(
    'R01',
    '空闲目标被本次投递唤醒（投递后 running）：投递成功，但 delivery 不报 steer；'
      + '两次观测如实为 activity_before=inactive / current_turn=running',
    woke.ok === true && woke.sent?.message_id === 'msg-0001'
      && woke.target?.activity_before === 'inactive' && woke.target?.current_turn === 'running'
      && !/steer|queue/.test(woke.delivery) && woke.route?.reported === false,
    JSON.stringify({ target: woke.target, delivery: woke.delivery, route: woke.route }),
  )

  // 反例 2：在跑的目标在调用方重读之前结束 ⇒ 投递后 inactive。旧实现报 queue。
  const agentsEnd = makeAgents({ statusById: { [CHILD_1]: 'running' } })
  const endFake = makeSubagents({
    children: [entry(CHILD_1)],
    onSend: () => agentsEnd.clear(CHILD_1),
  })
  const hEnd = harness({ subagents: endFake.service, agentsFake: agentsEnd })
  const ended = await hEnd.call('task_child_send', { target_id: CHILD_1, message: '接着做' }, { agent: LEAD_AGENT_A })

  check(
    'R02',
    '在跑目标在重读前结束（投递后 inactive）：投递成功，但 delivery 不报 queue；'
      + '两次观测如实为 activity_before=running / current_turn=inactive',
    ended.ok === true && ended.sent?.message_id === 'msg-0001'
      && ended.target?.activity_before === 'running' && ended.target?.current_turn === 'inactive'
      && !/steer|queue/.test(ended.delivery) && ended.route?.reported === false,
    JSON.stringify({ target: ended.target, delivery: ended.delivery, route: ended.route }),
  )

  // 三态一致性：投递后的活动态取 running / inactive / unknown 三种值时，
  // delivery **逐字相同** —— 这才是"路由话术与活动态解耦"的机械证明。
  // （旧实现在这三格给出三句不同文案，其中两句是路由断言。）
  const agentsRun = makeAgents({ statusById: { [CHILD_1]: 'running' } })
  const hRun = harness({ subagents: makeSubagents({ children: [entry(CHILD_1)] }).service, agentsFake: agentsRun })
  const runSend = await hRun.call('task_child_send', { target_id: CHILD_1, message: 'x' }, { agent: LEAD_AGENT_A })

  const hIdle = harness({ subagents: makeSubagents({ children: [entry(CHILD_1)] }).service })
  const inactiveSend = await hIdle.call('task_child_send', { target_id: CHILD_1, message: 'x' }, { agent: LEAD_AGENT_A })

  const hNoAgents = harness({
    subagents: makeSubagents({ children: [entry(CHILD_1)] }).service,
    withoutAgents: true,
  })
  const unknownSend = await hNoAgents.call('task_child_send', { target_id: CHILD_1, message: 'x' }, { agent: LEAD_AGENT_A })

  const everyDelivery = [runSend.delivery, inactiveSend.delivery, unknownSend.delivery, woke.delivery, ended.delivery]
  check(
    'R03',
    'running / inactive / unknown 三种投递后活动态（含两个反例）下 delivery 逐字相同：'
      + '路由断言与活动态彻底解耦',
    everyDelivery.every((text) => text === everyDelivery[0])
      && runSend.target?.current_turn === 'running'
      && inactiveSend.target?.current_turn === 'inactive'
      && unknownSend.target?.current_turn === 'unknown',
    JSON.stringify({
      running: runSend.delivery,
      inactive: inactiveSend.delivery,
      unknown: unknownSend.delivery,
      turns: [runSend.target?.current_turn, inactiveSend.target?.current_turn, unknownSend.target?.current_turn],
    }),
  )

  check(
    'R04',
    '「没有路由回执」被显式表达而不是沉默：route.reported=false 且 reason 指名 sendMessage 只回 message_id',
    woke.route?.reported === false
      && typeof woke.route?.reason === 'string'
      && woke.route.reason.includes('sendMessage') && woke.route.reason.includes('message_id'),
    JSON.stringify(woke.route),
  )

  check(
    'R05',
    'route.reason 明确否定反推：点名 activity_before / current_turn，并写明"空闲可能已被唤醒、在跑可能已结束"',
    typeof woke.route?.reason === 'string'
      && woke.route.reason.includes('activity_before') && woke.route.reason.includes('current_turn')
      && woke.route.reason.includes('唤醒') && woke.route.reason.includes('结束'),
    String(woke.route?.reason),
  )

  check(
    'R06',
    '两次观测都**保留**（不是删掉投递后那次换一致）：两个反例里 activity_before 与 current_turn 各自取到的是'
      + '自己那一刻的值，且互不相同',
    woke.target.activity_before !== woke.target.current_turn
      && ended.target.activity_before !== ended.target.current_turn
      && ['running', 'inactive', 'unknown'].includes(ended.target?.activity_before),
    JSON.stringify({ wake: woke.target, end: ended.target }),
  )

  check(
    'R07',
    '投递成功这条事实没有被削弱：两个反例都拿到 message_id，且服务确实被调用（不是"不报路由"变成"不投递"）',
    wakeFake.calls.sendMessage.length === 1 && endFake.calls.sendMessage.length === 1
      && wakeFake.calls.sendMessage[0].targetId === CHILD_1
      && endFake.calls.sendMessage[0].content?.[0]?.text === '接着做',
    JSON.stringify({ wake: wakeFake.calls.sendMessage.length, end: endFake.calls.sendMessage.length }),
  )
}

/* ═══════════════════════════ 汇总 ═══════════════════════════ */

console.log('')
console.log('══════════ 汇总 ══════════')
console.log(`断言：${passed} PASS / ${failed} FAIL（共 ${rows.length} 条）`)
console.log(`源码指纹 lib/tools/index.js sha256:${SRC_SHA}`)
if (failed > 0) {
  console.log('失败项：' + rows.filter((r) => !r.ok).map((r) => r.id).join(', '))
}
process.exit(failed === 0 ? 0 : 1)
