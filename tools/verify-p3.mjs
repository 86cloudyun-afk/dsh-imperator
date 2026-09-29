#!/usr/bin/env node
/**
 * P3 自测：working-context / guard / orchestrator-scope。
 *
 * 覆盖：
 *  A. 三个文件的导出面（name / inject / apply 齐全）
 *  B. guard 折叠函数：STALL、ECHO 各正例与反例（纯函数，构造假事件序列）
 *  C. orchestrator-scope 身份判定：主会话 header  vs  子代理 header
 *  D. working-context 行渲染的实际字符串
 *  E. working-context 的"已发布副本是否还在可见面"去重纪律（压缩后必须重发）
 *  F. orchestrator-scope 集成冒烟：真注册表拒绝/未知名容错 + 子代理不被动
 *  G. guard 集成冒烟：熔断只 fire 一次 + 档位降一档 + 窗口耗尽自动恢复
 *
 * 运行：node tools/verify-p3.mjs
 */

import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_URL = {
  workingContext: new URL('../lib/plugins/working-context.mjs', import.meta.url).href,
  guard: new URL('../lib/plugins/guard.mjs', import.meta.url).href,
  orchestratorScope: new URL('../lib/plugins/orchestrator-scope.mjs', import.meta.url).href,
}

// ── 断言器 ────────────────────────────────────────────────────────────────
let passed = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : `  →  ${detail}`}`)
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `实际 ${a} / 期望 ${b}`)
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

// ── 测试用假宿主 ──────────────────────────────────────────────────────────
/** 最小 fake ctx：记录每个事件名下的监听器，收集日志。 */
function fakeCtx() {
  const handlers = new Map()
  const logs = []
  return {
    handlers,
    logs,
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    async emit(event, ...args) {
      const list = handlers.get(event) ?? []
      const out = []
      for (const fn of list) out.push(await fn(...args))
      return out
    },
    logger: {
      info: message => logs.push(['info', message]),
      warn: message => logs.push(['warn', message]),
    },
  }
}

/** 本机实测的主会话工具面（名字来源见 docs/CONTEXT.md）。 */
const REAL_SURFACE = [
  { name: 'bash' }, { name: 'read' }, { name: 'read_image' }, { name: 'write' },
  { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'str_replace_editor' },
  { name: 'subagent' }, { name: 'subagent_fork' }, { name: 'send_message' },
  { name: 'list_agents' }, { name: 'interrupt_agent' },
  { name: 'todo_write' }, { name: 'skill' }, { name: 'web_fetch' },
]

/** 造一个 agent 替身：scoped tools 视图记录 restrict / guard 调用。 */
function fakeAgent({ header, schemas = REAL_SURFACE, restrictImpl } = {}) {
  const restrictCalls = []
  const guardCalls = []
  const lifted = []
  const liftedGuards = []
  const denied = new Set()
  const agent = {
    session: { header, events: [], surface: undefined },
    ctx: {
      tools: {
        // 真身 `tools.schemas(agent)` 是**可见性解析器**：被 restriction 遮掉的名字不会再出现
        // （契约原文："one visibility resolver feeds presentation, lookup, and dispatch"）。
        // 夹具必须同样反映 restriction —— 否则本插件提交后的**反查**永远"发现名字还在"，
        // 会把它判成未生效而每步重试，幂等断言被夹具的错误契约误伤。
        schemas: () => schemas.filter((entry) => !denied.has(entry.name)),
        restrict: filter => {
          restrictCalls.push(filter)
          if (typeof restrictImpl === 'function') return restrictImpl(filter)
          for (const name of filter.deny ?? []) denied.add(name)
          const dispose = () => {
            for (const name of filter.deny ?? []) denied.delete(name)
            lifted.push(filter)
          }
          return dispose
        },
        // 真身 `tools.guard(guard)` 注册执行守卫并返回 disposer（契约见插件头注释）。
        guard: guarded => {
          guardCalls.push(guarded)
          return () => { liftedGuards.push(guarded) }
        },
      },
    },
  }
  return { agent, restrictCalls, guardCalls, lifted, liftedGuards }
}

const MAIN_HEADER = { version: 4, id: 'session-main', createdAt: 0, isSeeded: false }
const CHILD_HEADER = {
  version: 4, id: 'session-child', createdAt: 0, isSeeded: false,
  origin: 'subagent', delegationDepth: 1, parentSession: 'session-main',
}

// ══════════════════════════════════════════════════════════════════════════
// A. 导出面
// ══════════════════════════════════════════════════════════════════════════
section('A. 导出面（import() + name/inject/apply）')
const mods = {}
for (const [label, url] of Object.entries(PLUGIN_URL)) {
  try {
    mods[label] = await import(url)
  } catch (error) {
    mods[label] = undefined
    check(`import ${label}`, false, error instanceof Error ? error.message : String(error))
    continue
  }
  const mod = mods[label]
  check(
    `${label}: name/inject/apply 齐全`,
    typeof mod.name === 'string' && mod.name !== ''
      && Array.isArray(mod.inject)
      && typeof mod.apply === 'function',
    `name=${typeof mod.name} inject=${Array.isArray(mod.inject)} apply=${typeof mod.apply}`,
  )
  console.log(`       name = ${JSON.stringify(mod.name)}   inject = ${JSON.stringify(mod.inject)}`)
}

const wc = mods.workingContext
const guard = mods.guard
const scope = mods.orchestratorScope

// ══════════════════════════════════════════════════════════════════════════
// B. guard 折叠函数
// ══════════════════════════════════════════════════════════════════════════
section('B. guard.foldGuardSignal —— STALL / ECHO')

const LONG = 'x'.repeat(20000)

const stallPositive = [
  { type: 'turn/start' },
  { type: 'step/start' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: LONG }] } } },
]
const stallNegative = [
  { type: 'turn/start' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: LONG }] } } },
  { type: 'tool/call', data: { name: 'read', arguments: { file_path: '/tmp/x' }, callId: 'k1' } },
  { type: 'tool/result', data: { callId: 'k1', message: { isError: false } } },
]

eq(
  'STALL 正例（单步超长推理 + 零输出）→ stall',
  guard.foldGuardSignal(stallPositive, { stallSteps: 1, stallReasoningChars: 12000 }).signal,
  'stall',
)
eq(
  'STALL 反例（同长度推理但有工具调用）→ undefined',
  guard.foldGuardSignal(stallNegative, { stallSteps: 1, stallReasoningChars: 12000 }).signal,
  undefined,
)

/** 同签名失败 n 次。 */
function echoEvents(times, { interruptWithSuccess = false } = {}) {
  const events = [{ type: 'turn/start' }]
  for (let i = 1; i <= times; i += 1) {
    events.push({ type: 'tool/call', data: { name: 'bash', arguments: { command: 'ls' }, callId: `c${i}` } })
    events.push({ type: 'tool/result', data: { callId: `c${i}`, error: { message: 'boom' } } })
  }
  if (interruptWithSuccess) {
    events.push({ type: 'tool/call', data: { name: 'bash', arguments: { command: 'ls' }, callId: 'cx' } })
    events.push({ type: 'tool/result', data: { callId: 'cx', message: { isError: false } } })
  }
  return events
}

eq(
  'ECHO 正例（同参同工具连续失败 3 次，显式阈值 3）→ echo',
  guard.foldGuardSignal(echoEvents(3), { echoFailures: 3 }).signal,
  'echo',
)
eq(
  'ECHO 反例（中间插入一次成功）→ undefined',
  guard.foldGuardSignal(echoEvents(3, { interruptWithSuccess: true }), { echoFailures: 3 }).signal,
  undefined,
)
eq(
  'ECHO 反例（参数每次都不同）→ undefined',
  guard.foldGuardSignal([
    { type: 'turn/start' },
    { type: 'tool/call', data: { name: 'bash', arguments: { command: 'ls' }, callId: 'd1' } },
    { type: 'tool/result', data: { callId: 'd1', error: { message: 'boom' } } },
    { type: 'tool/call', data: { name: 'bash', arguments: { command: 'pwd' }, callId: 'd2' } },
    { type: 'tool/result', data: { callId: 'd2', error: { message: 'boom' } } },
    { type: 'tool/call', data: { name: 'bash', arguments: { command: 'id' }, callId: 'd3' } },
    { type: 'tool/result', data: { callId: 'd3', error: { message: 'boom' } } },
  ], { echoFailures: 3 }).signal,
  undefined,
)
eq(
  '默认灵敏度 = conservative（3 次失败不触发：×1.5 → 阈值 5）',
  guard.foldGuardSignal(echoEvents(3), guard.resolveThresholds({ effort: 'max' })).signal,
  undefined,
)
console.log(`       默认阈值（effort=max）: ${JSON.stringify(guard.resolveThresholds({ effort: 'max' }))}`)
eq(
  '默认灵敏度下 5 次失败才触发',
  guard.foldGuardSignal(echoEvents(5), guard.resolveThresholds({ effort: 'max' })).signal,
  'echo',
)
check(
  '默认灵敏度即 conservative',
  guard.DEFAULT_SENSITIVITY === 'conservative',
  String(guard.DEFAULT_SENSITIVITY),
)
eq('DEFAULT_STALL_STEPS = 1', guard.DEFAULT_STALL_STEPS, 1)
eq('档位梯子 max → high', guard.stepDownEffort('max'), 'high')
eq('档位梯子 high → low', guard.stepDownEffort('high'), 'low')
eq('档位梯子 low → 不动', guard.stepDownEffort('low'), undefined)
eq('档位梯子 off → 不动', guard.stepDownEffort('off'), undefined)

// ══════════════════════════════════════════════════════════════════════════
// C. orchestrator-scope 身份判定
// ══════════════════════════════════════════════════════════════════════════
section('C. orchestrator-scope.isSubagentSession —— 身份判定')
eq('主会话 header → false', scope.isSubagentSession(MAIN_HEADER), false)
eq('主会话 header（delegationDepth: 0）→ false', scope.isSubagentSession({ ...MAIN_HEADER, delegationDepth: 0 }), false)
eq('子代理 header（origin=subagent）→ true', scope.isSubagentSession(CHILD_HEADER), true)
eq('子代理 header（仅 delegationDepth: 1）→ true', scope.isSubagentSession({ ...MAIN_HEADER, delegationDepth: 1 }), true)
// 手工 fork 出来的主会话同样带 parentSession —— 它是「人开的主会话」，不是子代理，
// 必须被收窄（独立设计预审 P1-5：漏收窄才是核心问题）。故期望 false。
eq('fork 主会话（仅 parentSession）→ false（要收窄）', scope.isSubagentSession({ ...MAIN_HEADER, parentSession: 's0' }), false)
eq('未知名/缺 header → false（按主会话收窄）', scope.isSubagentSession(undefined), false)

const { effective, missing } = scope.intersectWithSurface(
  [...scope.DEFAULT_DENY, 'ghost_tool'],
  REAL_SURFACE,
)
eq('deny ∩ 实际工具面 = 四个标准执行/写类', effective, ['bash', 'write', 'edit', 'str_replace_editor'])
// DEFAULT_DENY 如今还含本机插件入口（purge_* / plugin_* / spawn_teammate）；
// 它们不在这个模拟面上 ⇒ 进 missing 被安全丢弃，ghost_tool 同理。
// 名单**允许比实际工具面长**（restrict 对未知名会抛错，故必须先求交）。
eq(
  '不存在的名字一律被隔离（含本机插件名与 ghost）',
  missing,
  [...scope.DEFAULT_DENY.filter(n => !['bash', 'write', 'edit', 'str_replace_editor'].includes(n)), 'ghost_tool'],
)
// 反向：当工具面**确实**含这些本机插件入口时，它们必须被遮蔽（P1-5 的核心诉求）。
const { effective: effectiveWithPlugins } = scope.intersectWithSurface(scope.DEFAULT_DENY, [
  ...REAL_SURFACE,
  { name: 'purge_apply' },
  { name: 'plugin_install' },
  { name: 'plugin_remove' },
  { name: 'spawn_teammate' },
])
eq(
  '本机插件入口存在时确实被遮蔽',
  effectiveWithPlugins.filter(n => ['purge_apply', 'plugin_install', 'plugin_remove', 'spawn_teammate'].includes(n)),
  ['purge_apply', 'plugin_install', 'plugin_remove', 'spawn_teammate'],
)

// ══════════════════════════════════════════════════════════════════════════
// D. working-context 行渲染
// ══════════════════════════════════════════════════════════════════════════
section('D. working-context.renderWorkingContext —— 行渲染')

const wcEvents = [
  { type: 'turn/start' },
  { type: 'tool/call', data: { name: 'subagent', callId: 'p1' } },
  { type: 'tool/call', data: { name: 'subagent', callId: 'p2' } },
  { type: 'tool/call', data: { name: 'subagent_fork', callId: 'p3' } },
  { type: 'user/message', data: { source: { kind: 'subagent-settled', form: 'notice' } } },
  { type: 'todo/write', data: { todos: [{ id: 7, content: '重构解析器', status: 'in_progress' }] } },
]

const flow = wc.foldSubagentFlow(wcEvents)
eq('派发计数 3', flow.dispatched, 3)
eq('settled-notice 通道终结数 1', flow.settledNotices, 1)
eq('（本序列没有派活回执）tool-result 通道终结数 0', flow.delegatedResults, 0)
eq('在飞 2', flow.inFlight, 2)

// continuable 的真实形态：派活后**立即**收到 tool/result 回执，真正的完成信号是结算通知。
const continuableEvents = [
  { type: 'turn/start' },
  { type: 'tool/call', data: { name: 'subagent', callId: 'a1', arguments: { prompt: 'x' } } },
  { type: 'tool/result', data: { callId: 'a1', message: { isError: false } } },
  { type: 'tool/call', data: { name: 'subagent', callId: 'a2', arguments: { prompt: 'y' } } },
  { type: 'tool/result', data: { callId: 'a2', message: { isError: false } } },
  { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'child-1' } } },
]
const byNotice = wc.foldSubagentFlow(continuableEvents)
eq('默认通道（settled-notice）：2 派活 − 1 结算 = 在飞 1', byNotice.inFlight, 1)
const byResult = wc.foldSubagentFlow(continuableEvents, undefined, 'tool-result')
eq('选错通道（tool-result）会低估为在飞 0（文档已标注的单向偏差）', byResult.inFlight, 0)
eq('两条通道的原始计数都在（便于核对）', [byNotice.settledNotices, byResult.delegatedResults], [1, 2])

const lineNoStore = wc.renderWorkingContext(wcEvents)
eq('无 store 降级（事实数 = 结算通知数 = 1）', lineNoStore, '[任务部队: 在飞 2 · 当前任务 #7 "重构解析器" · 最近事实 1 条]')

const lineWithStore = wc.renderWorkingContext(wcEvents, {
  store: { wave: 3, facts: ['a', 'b', 'c'] },
})
eq('带 store（波次 3 / 事实 3 条）', lineWithStore, '[任务部队: 波次 3 · 在飞 2 · 当前任务 #7 "重构解析器" · 最近事实 3 条]')
check('空状态不注入（返回 undefined）', wc.renderWorkingContext([]) === undefined, String(wc.renderWorkingContext([])))
check('坏 store 不抛错、降级到事件折叠', (() => {
  try {
    const thrown = { get snapshot() { throw new Error('boom') } }
    return wc.renderWorkingContext(wcEvents, { store: thrown }) === lineNoStore
  } catch {
    return false
  }
})(), 'store.snapshot 抛错时的行为')

// ══════════════════════════════════════════════════════════════════════════
// E. working-context 去重 / 可见面纪律
// ══════════════════════════════════════════════════════════════════════════
section('E. working-context.contextHistory —— 已发布副本是否还在可见面')

const published = {
  id: 'm-published',
  role: 'user',
  content: [{ type: 'text', text: lineNoStore }],
  source: { kind: wc.name },
}

const agentVisible = {
  session: {
    events: [{ type: 'user/message', seq: 5, data: published }],
    surface: { nodes: [5] },
  },
}
eq('副本可见 → 读回该行文本（不必重发）', wc.contextHistory(agentVisible), { published: true, text: lineNoStore })

const agentShadowed = {
  session: {
    events: [{ type: 'user/message', seq: 5, data: published }],
    surface: { nodes: [] },
  },
}
eq('副本被压缩遮蔽 → 只给 published、无文本（必须重发）', wc.contextHistory(agentShadowed), { published: true })

const agentFresh = { session: { events: [], surface: { nodes: [] } } }
eq('从未发布 → published:false', wc.contextHistory(agentFresh), { published: false })

const agentNoSurface = { session: { events: [{ type: 'user/message', seq: 5, data: published }] } }
eq('会话不暴露 surface → 不做可见性过滤（视为可见）', wc.contextHistory(agentNoSurface), { published: true, text: lineNoStore })

// 双形态读取
const agentSnapshot = {
  session: {
    snapshotEvents: () => [{ type: 'user/message', seq: 9, data: published }],
    surface: { nodes: [9] },
  },
}
eq('snapshotEvents() 形态也读得到', wc.contextHistory(agentSnapshot), { published: true, text: lineNoStore })

// ══════════════════════════════════════════════════════════════════════════
// F. orchestrator-scope 集成冒烟
// ══════════════════════════════════════════════════════════════════════════
section('F. orchestrator-scope.apply —— 集成冒烟')

{
  const ctx = fakeCtx()
  scope.apply(ctx, {})
  check('注册了 agent/created（serial，解构 { agent }）', (ctx.handlers.get('agent/created')?.length ?? 0) === 1)
  check('注册了 agent/pre-step', (ctx.handlers.get('agent/pre-step')?.length ?? 0) === 1)
  check('注册了 agent/disposed', (ctx.handlers.get('agent/disposed')?.length ?? 0) === 1)

  const { agent, restrictCalls, guardCalls } = fakeAgent({ header: MAIN_HEADER })
  await ctx.emit('agent/created', { agent, source: 'new' })
  eq('主会话被收窄一次', restrictCalls.length, 1)
  eq('deny 清单 = 执行/写四件', restrictCalls[0], { deny: ['bash', 'write', 'edit', 'str_replace_editor'] })
  check(
    '只读与派活类不在 deny 里（read/glob/grep/subagent 保留）',
    !restrictCalls[0].deny.includes('read') && !restrictCalls[0].deny.includes('glob')
      && !restrictCalls[0].deny.includes('grep') && !restrictCalls[0].deny.includes('subagent'),
    JSON.stringify(restrictCalls[0].deny),
  )
  // 缺陷 1 的硬约束：可见性过滤之外还要在**主控作用域**装执行守卫
  // （详细四场景回归见 tools/verify-scope-guard.mjs）。
  eq('主会话同时被装上 1 个执行守卫（agent scope）', guardCalls.length, 1)
  check(
    '守卫按名字判：拒绝 bash，放行 read（与工具面快照无关）',
    typeof guardCalls[0]({ name: 'bash', agent }) === 'string'
      && guardCalls[0]({ name: 'read', agent }) === undefined,
    String(guardCalls[0]({ name: 'bash', agent })),
  )

  // 幂等：再跑一次 pre-step 不应重复提交
  const preStep = ctx.handlers.get('agent/pre-step')[0]
  await preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
  eq('幂等：pre-step 不重复提交', restrictCalls.length, 1)
  console.log(`       日志: ${JSON.stringify(ctx.logs.filter(([level]) => level === 'info').map(([, m]) => m))}`)
}

{
  const ctx = fakeCtx()
  scope.apply(ctx, {})
  const { agent, restrictCalls, guardCalls } = fakeAgent({ header: CHILD_HEADER })
  await ctx.emit('agent/created', { agent, source: 'subagent' })
  await ctx.emit('agent/pre-step', { agent }, async () => ({ kind: 'enter', messages: [] }))
  eq('子代理：restrict 从未被调用（不被收窄）', restrictCalls.length, 0)
  eq('子代理：guard 也从未被装上（执行不被误伤）', guardCalls.length, 0)
}

{
  // 工具面未就绪 → 不标记完成 → 后续 pre-step 重试并成功
  const ctx = fakeCtx()
  scope.apply(ctx, {})
  const { agent, restrictCalls } = fakeAgent({ header: MAIN_HEADER, schemas: [] })
  await ctx.emit('agent/created', { agent, source: 'new' })
  eq('工具面为空时不提交空过滤器', restrictCalls.length, 0)
  // 工具面就绪后重试
  agent.ctx.tools.schemas = () => REAL_SURFACE
  const preStep = ctx.handlers.get('agent/pre-step')[0]
  await preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
  eq('工具面就绪后由 pre-step 补上', restrictCalls.length, 1)
}

{
  // 注册表拒绝（名字在读取与提交之间消失）→ 告警但绝不让会话炸掉
  const ctx = fakeCtx()
  scope.apply(ctx, {})
  const { agent } = fakeAgent({
    header: MAIN_HEADER,
    restrictImpl: () => { throw new Error('unknown tool name: bash') },
  })
  let threw
  try {
    await ctx.emit('agent/created', { agent, source: 'new' })
  } catch (error) {
    threw = error
  }
  check('restrict 抛错被吞掉，不冒泡', threw === undefined, threw instanceof Error ? threw.message : '')
  // 锚点随文案更新：新文案按两轨语义写成「拒绝了本次**可见性**收窄」
  // （执行守卫那一轨不受 restrict 失败影响，所以必须把两件事在措辞上分开）。
  check(
    '并且留下一次性告警',
    ctx.logs.some(([level, m]) => level === 'warn' && m.includes('拒绝了本次可见性收窄')),
    JSON.stringify(ctx.logs),
  )
  console.log(`       告警: ${JSON.stringify(ctx.logs.filter(([l]) => l === 'warn').map(([, m]) => m))}`)
}

{
  // 部分名字不存在 → 只提交实际存在的，并告警
  const ctx = fakeCtx()
  scope.apply(ctx, { deny: ['bash', 'ghost_tool'] })
  const { agent, restrictCalls } = fakeAgent({ header: MAIN_HEADER })
  await ctx.emit('agent/created', { agent, source: 'new' })
  eq('未知名不进入 restrict', restrictCalls[0], { deny: ['bash'] })
  check('缺名告警（partial）', ctx.logs.some(([l, m]) => l === 'warn' && m.includes('ghost_tool')), JSON.stringify(ctx.logs))
}

{
  // 离开的作用域必须撤掉限制
  const ctx = fakeCtx()
  scope.apply(ctx, {})
  const { agent, lifted } = fakeAgent({ header: MAIN_HEADER })
  await ctx.emit('agent/created', { agent, source: 'new' })
  await ctx.emit('agent/disposed', { agent })
  eq('agent/disposed → 限制被撤销', lifted.length, 1)
}

// ══════════════════════════════════════════════════════════════════════════
// G. guard 集成冒烟
// ══════════════════════════════════════════════════════════════════════════
section('G. guard.apply —— 熔断只 fire 一次 + 档位下调 + 自动恢复')

{
  const ctx = fakeCtx()
  guard.apply(ctx, { enabled: true, sensitivity: 'balanced', stepDownRequests: 3, refireCooldownSteps: 5 })
  const preStep = ctx.handlers.get('agent/pre-step')[0]
  const request = ctx.handlers.get('agent/request')[0]

  const agent = { session: { events: [] } }

  // 无信号：请求必须**逐字节不变**
  const before = { provider: 'p', model: 'm', reasoningEffort: 'max' }
  const untouched = await request({ agent }, async () => before)
  eq('无信号时不改写请求（同一对象）', untouched === before, true)

  // 制造 STALL
  agent.session.events = stallPositive
  const decision = await preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
  eq('熔断注入一条 user 消息', decision.messages.length, 1)
  check('熔断消息来源是本插件', decision.messages[0]?.source?.kind === guard.name, String(decision.messages[0]?.source?.kind))
  console.log(`       注入文本: ${JSON.stringify(decision.messages[0].content[0].text)}`)

  // 已触发窗口内：档位降一档（max → high）
  const lowered = await request({ agent }, async () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }))
  eq('窗口内档位降一档 max → high', lowered.reasoningEffort, 'high')
  check('只改 reasoningEffort，provider/model 原样', lowered.provider === 'p' && lowered.model === 'm')

  // 第二、三次请求继续在窗口内；第四次起自动恢复
  const second = await request({ agent }, async () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }))
  eq('第二次仍在窗口内', second.reasoningEffort, 'high')
  const third = await request({ agent }, async () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }))
  eq('第三次仍在窗口内', third.reasoningEffort, 'high')
  const fourth = await request({ agent }, async () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }))
  eq('窗口耗尽后自动恢复原档', fourth.reasoningEffort, 'max')

  // 同一 episode 只 fire 一次（冷却期内再触发不给消息）
  const again = await preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
  eq('冷却期内不重复注入（每 episode 只 fire 一次）', again.messages.length, 0)
  console.log(`       触发日志: ${JSON.stringify(ctx.logs.filter(([l]) => l === 'warn').map(([, m]) => m))}`)

  // 信号消失后（有工具调用）不再注入
  agent.session.events = stallNegative
  const quiet = await preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
  eq('信号消失后不注入', quiet.messages.length, 0)
}

{
  // enabled: false 一个监听器都不注册
  const ctx = fakeCtx()
  guard.apply(ctx, { enabled: false })
  eq('enabled:false → 零监听器', ctx.handlers.size, 0)
}

// ══════════════════════════════════════════════════════════════════════════
// I. 真机端到端：真实 TaskforceStore（node:sqlite）→ readStoreState → 行渲染
// ══════════════════════════════════════════════════════════════════════════
section('I. 真机端到端：真实事实库 → 行渲染')
{
  const tmp = mkdtempSync(join(tmpdir(), 'taskforce-p3-'))
  try {
    const { TaskforceStore } = await import(new URL('../lib/store/index.js', import.meta.url).href)
    const store = new TaskforceStore(tmp)
    store.open()
    try {
      const t1 = store.openTask({ title: '重构解析器' })
      store.openTask({ title: '还没人认领的任务' })
      store.openTask({ title: '收尾归档' })
      store.claimTask({ task_id: t1.task_id, child_id: 'child-a' })
      store.recordFact({
        task_id: t1.task_id, statement: '解析器重构完成', confidence: 'CONFIRMED', child_id: 'child-a',
      })
      store.recordFact({ statement: '一条全局事实', child_id: 'child-b' })

      const state = wc.readStoreState(store)
      check('真实 store 被读通（不再走降级）', state !== undefined, JSON.stringify(state))
      eq('事实总数 ← stats().facts.total', state.factCount, 2)
      eq('当前任务 ← board() 里 claimed 优先', state.task, { id: t1.task_id, title: '重构解析器' })
      eq('未结任务数 ← stats().tasks.open + claimed', state.activeTasks, 3)
      check('在飞子代理不来自 store（store 无此语义）', state.inFlight === undefined, String(state.inFlight))
      check('波次：store 无此概念 ⇒ 字段缺席', state.wave === undefined, String(state.wave))

      const line = wc.renderWorkingContext(wcEvents, { store })
      eq('真实 store 下的整行', line, `[任务部队: 在飞 2 · 当前任务 #${t1.task_id} "重构解析器" · 最近事实 2 条]`)
      console.log(`       渲染结果: ${line}`)
      console.log(`       store 读取: ${JSON.stringify(state)}`)
    } finally {
      store.close()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// H. 接线片段解析（docs/CONTEXT.md §4 的 URL 形式必须落到真实文件）
// ══════════════════════════════════════════════════════════════════════════
section('H. 接线：new URL(\'./plugins/x.mjs\', preset.js 的 URL) 解析')
{
  const presetUrl = new URL('../lib/preset.js', import.meta.url).href
  check('lib/preset.js 存在', existsSync(fileURLToPath(presetUrl)), presetUrl)
  for (const [label, file] of Object.entries({
    workingContext: './plugins/working-context.mjs',
    guard: './plugins/guard.mjs',
    orchestratorScope: './plugins/orchestrator-scope.mjs',
  })) {
    const href = new URL(file, presetUrl).href
    check(`${label}: ${file} 解析到存在的文件`, existsSync(fileURLToPath(href)), href)
    check(`${label}: 解析结果与自测 import 一致`, href === PLUGIN_URL[label], `${href} vs ${PLUGIN_URL[label]}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(68)}`)
console.log(`P3 自测：${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const label of failures) console.log(`  失败：${label}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
console.log(`插件入口 URL 示例：${pathToFileURL(new URL('../lib/plugins/guard.mjs', import.meta.url).pathname).href}`)
