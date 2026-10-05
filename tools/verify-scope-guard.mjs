#!/usr/bin/env node
/**
 * orchestrator-scope 执行守卫回归（缺陷 1：主控执行边界失效后仍继续放行）。
 *
 * 本脚本复现独立复审在隔离夹具里实测的**四个漏口**，并按修正方向逐条验收：
 *
 * | 场景 | 只靠 restrict 的旧结果 | 本脚本的验收判据 |
 * |---|---|---|
 * | 1 初始只有 read，稍后注册 bash | bash 仍可见、从未施加限制 | 主控执行被拒 + handler 未运行 + 复核后也从面上消失 |
 * | 2 成功隐藏 bash 后才注册 write | write 仍可见、限制只调用一次 | 同上，且 restrict 被**再次**调用 |
 * | 3 restrict 返回 disposer 但未改变工具面 | 告警后不再重试 | 执行仍被拒 + 告警 + 复核继续重试 |
 * | 4 前 8 次限制失败，第 9 次注册表恢复 | 不再调用 restrict | 第 9 次确实被调用 + 全程执行被拒 |
 *
 * 另有四条通用验收：
 *  - **子代理不被误伤**（登记过的与从未登记的都要放行）；
 *  - **别的主控会话不被无差别拦截**（守卫按真实调用身份生效，不是全局拦截）；
 *  - **守卫只挂在 agent scope 上**（`globalGuardCalls === 0`：用插件 ctx 注册会让子代理一起被拦）；
 *  - **agent/disposed 撤销两轨**。
 *
 * 假宿主按**真实契约**建模（这一点被复审判过一次"假绿"，所以在这里显式钉住）：
 *  - `tools.schemas(scope)` / `tools.restrict(filter)` / `tools.guard(g)` 都是
 *    **scoped 视图**：层由调用者的 scope 决定 —— 与真身
 *    `dsh-tools/lib/index.js:2886,2909,2922`（`this.layers.effect(this.ctx, …)` →
 *    `dsh-scope/lib/index.js:190` `scopeOf(ctx)`）一致；
 *  - 派发走**单调守卫链**：`guardReason(exec)` 先 global 层，再 `exec.agent` 的层链
 *    —— 与真身 `dsh-tools/lib/index.js:2928-2934` 一致；
 *  - guard 返回字符串即拒绝，**handler 不执行**（真身 prepareExecution 在
 *    `:3241` 用 `guardReason` 短路成 isError 结果，从不到 dispatch）；
 *  - `restrict` 抛错的报文形状与真身一致，供 `parseKnownGlobalTools` 走降级分支。
 *
 * ## 断言形状纪律（2026-09-29 修：本文件曾整片假绿）
 * `check(id, title, ok, detail)` 是**四参**签名，`ok` 必须是布尔表达式。
 * 本文件一度有 45 处写成三参 `check('<id> <标题>', <布尔>, <详情>)` —— 布尔落进了
 * `title` 槽、详情字符串落进了 `ok` 槽，于是**只要详情非空就恒 PASS**：S1–S5/G1–G7
 * 整片断言实际上什么都没验，其中 G1/G3/G4 对应的行为当时就是坏的（假宿主 `surface`
 * 只给可见性、没 `registerTool` ⇒ `host.call` 一律返回 `UNKNOWN_TOOL`）。
 * 现已全部改成四参；另加两条机械自证：① 本文件不存在"PASS 行尾挂着布尔字面量"
 * 的假绿形态；② 每条新增断言都用"旧实现 × 新自测"反证过它真的会红。
 * **改夹具时先看这一行** —— 形状错了比断言少了更危险（它报告的是假绿，不是少测）。
 *
 * ## 假绿第三例：判据无法区分"守卫拒绝"与"工具不存在"（2026-09-29 修）
 * 场景 7 原先只把 `bash` / `write` 放进工具面、**不给执行 handler**；`host.call()` 在
 * 找不到 handler 时返回 `UNKNOWN_TOOL` / `isError:true` / `ran:false`，而 S7d 只断言
 * "isError 为真且没跑过" ⇒ **清空该场景的守卫后 S7d 照旧 PASS**（独立复审在隔离副本
 * 实测：`guards:0`、两条 `UNKNOWN_TOOL`，全套仍 57 PASS / 0 FAIL）。
 * 定性：**测试证明力不足，没有复现生产执行绕过** —— 修法是夹具补上"会记录执行的 handler"，
 * 判据同时要求报文里出现 `scope.DENY_CODE`，并让三种形态（守卫拒绝 / 执行被放行 /
 * 其余报文）在失败详情里可分辨。**禁用该场景 guard 后 S7d 必须失败。**
 *
 * 运行：node tools/verify-scope-guard.mjs   （退出码 0 = 全 PASS）
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const SRC = join(PKG, 'lib', 'plugins', 'orchestrator-scope.mjs')

let failed = 0
let passed = 0

function check(id, title, ok, detail = '') {
  if (ok) passed += 1
  else failed += 1
  const tail = ok || detail === '' ? '' : `\n        ↳ ${detail}`
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}  ${title}${tail}`)
}

function section(title) {
  console.log('')
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`)
}

const SRC_SHA = existsSync(SRC)
  ? createHash('sha256').update(readFileSync(SRC)).digest('hex').slice(0, 16)
  : 'MISSING'

console.log('══════════ 主控执行边界（orchestrator-scope）四场景回归 ══════════')
console.log(`被测源码  ${SRC}`)
console.log(`源码指纹  lib/plugins/orchestrator-scope.mjs sha256:${SRC_SHA}`)

const scope = await import(pathToFileURL(SRC).href)

/* ═══════════════════════════ 假宿主 ═══════════════════════════ */

const MAIN_HEADER = { version: 4, id: 'session-main', createdAt: 0, isSeeded: false }
const MAIN_HEADER_2 = { version: 4, id: 'session-main-2', createdAt: 0, isSeeded: false }
const CHILD_HEADER = {
  version: 4, id: 'session-child', createdAt: 0, isSeeded: false,
  origin: 'subagent', delegationDepth: 1, parentSession: 'session-main',
}
const CHILD_HEADER_2 = { version: 4, id: 'session-child-2', createdAt: 0, isSeeded: false, delegationDepth: 2 }

/**
 * 假宿主：工具注册表 + 按 scope 分层的 restriction / guard + 单调派发。
 *
 * @param options.surface - 初始面上的工具名。
 * @param options.restrictNoop - `restrict` 返回 disposer 但**不改变工具面**（场景 3）。
 * @param options.restrictFailures - 前 N 次 `restrict` 调用抛错（场景 4）。
 * @param options.schemasFailOn - 第 N 次（1 基）`tools.schemas` 调用抛错（场景 6：
 *   "提交后反查失败"那一刻；调用序在 S6a 里自证）。
 * @param options.restrictHidesOnly - `restrict` 只对这批名字真的生效（场景 7：部分生效）。
 * @param options.executable - 这批名字**一开始就带 handler**（= "执行真的会发生"的那一半）。
 *   `surface` 只给可见性；两者分开建模，是因为真宿主里"在面上"与"能执行"本是一体，
 *   而夹具需要分别观测。**只给 `surface` 不给 handler 时 `call()` 一律返回 `UNKNOWN_TOOL`**，
 *   于是"守卫拒绝"与"工具不存在"在断言眼里同形（场景 7 曾经的假绿）。
 */
function makeHost({
  surface = [],
  executable = [],
  restrictNoop = false,
  restrictFailures = 0,
  globalNames,
  schemasFailOn = [],
  schemasFailMessage = 'SESSION_TOOLS_PROJECTION_UNAVAILABLE',
  restrictHidesOnly,
  // 降级路径注入点（对应 orchestrator-scope 的 no-guard / guard-refused / no-scoped-view）。
  omitGuard = false,
  guardRefusal,
  omitRestrict = false,
} = {}) {
  const registry = new Set(surface)
  const handlers = new Map()
  // `executable` 先装 handler，且**不动 registry**：这两个名字是"已经存在的工具"，
  // 只是需要可执行的那一半（对照 `registerTool` = 面上*新出现*一个工具，两件事）。
  for (const name of executable) handlers.set(name, () => `${name}-ran`)
  const ranLog = []
  const globalLayer = { guards: [], restrictions: [] }
  const layers = new Map()
  const stats = {
    globalGuardCalls: 0,
    restrictCalls: [],
    guardCalls: [],
    schemasCalls: 0,
    // noop disposer 被调用几次 —— "反查未确认时 disposer 是否仍然留在手上"的观测点。
    noopDisposeCalls: 0,
  }
  let failuresLeft = restrictFailures
  // 可在用例中途翻转：用来演"下一步宿主恢复了"。
  const flags = { restrictNoop: restrictNoop === true, guardRefusal }
  const failOn = new Set(schemasFailOn)
  const hidesOnly = restrictHidesOnly === undefined ? undefined : new Set(restrictHidesOnly)
  // 真宿主的 restrict 只认**全局**工具名；scope-local 注册（如本机的 spawn_teammate）
  // 会让整批提交抛错并在报文里带出可用名单（`tools.restrict() names unknown global
  // tool "X"; known global tools: …`）。给 `globalNames` 就复刻这条约束。
  const globals = globalNames === undefined ? undefined : new Set(globalNames)

  const layerOf = (key) => {
    if (key === undefined) return globalLayer
    let layer = layers.get(key)
    if (layer === undefined) {
      layer = { guards: [], restrictions: [] }
      layers.set(key, layer)
    }
    return layer
  }

  /** 该 viewer 看到的工具名（restriction 交集语义：deny 命中即不可见）。 */
  const visibleNames = (viewer) => {
    const denied = new Set()
    const layersWalked = viewer === undefined ? [globalLayer] : [globalLayer, layerOf(viewer)]
    for (const layer of layersWalked) {
      for (const filter of layer.restrictions) {
        for (const name of filter.deny ?? []) {
          // 部分生效的宿主：只遮蔽指定子集（其余名字即使被提交也仍在面上）。
          if (hidesOnly !== undefined && !hidesOnly.has(name)) continue
          denied.add(name)
        }
      }
    }
    return [...registry].filter((name) => !denied.has(name))
  }

  /** 单调守卫链：先 global，再 exec.agent 的层（真身 dsh-tools:2928-2934）。 */
  const guardReason = (exec) => {
    for (const guard of globalLayer.guards) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    if (exec.agent === undefined) return undefined
    for (const guard of layerOf(exec.agent).guards) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }

  /** scoped 的工具视图：层归属由 `key` 决定（undefined = 插件 ctx = global 层）。 */
  const toolsFor = (key) => ({
    schemas(viewer) {
      stats.schemasCalls += 1
      if (failOn.has(stats.schemasCalls)) throw new Error(schemasFailMessage)
      return visibleNames(viewer === undefined ? key : viewer).map((name) => ({ name }))
    },
    restrict(filter) {
      stats.restrictCalls.push({ scope: key, filter })
      if (failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error(
          'tools.restrict() names unknown global tool "ghost"; known global tools: '
          + [...registry].sort().join(', '),
        )
      }
      if (globals !== undefined) {
        const unknown = (filter.deny ?? []).filter((name) => !globals.has(name))
        if (unknown.length > 0) {
          throw new Error(
            `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} `
            + `${unknown.map((name) => `"${name}"`).join(', ')}; known global tools: `
            + `${[...globals].sort().join(', ') || '(none)'}`,
          )
        }
      }
      if (flags.restrictNoop) return () => { stats.noopDisposeCalls += 1 }
      const layer = layerOf(key)
      layer.restrictions.push(filter)
      return () => {
        const at = layer.restrictions.indexOf(filter)
        if (at >= 0) layer.restrictions.splice(at, 1)
      }
    },
    guard(guard) {
      if (key === undefined) stats.globalGuardCalls += 1
      stats.guardCalls.push({ scope: key })
      const layer = layerOf(key)
      layer.guards.push(guard)
      return () => {
        const at = layer.guards.indexOf(guard)
        if (at >= 0) layer.guards.splice(at, 1)
      }
    },
  })

  const makeAgent = (header) => {
    const agent = { id: header.id, session: { header } }
    // toolsFor() 每次返回**新建**的 scoped 视图对象 ⇒ 这里的降级注入只影响本 agent。
    const tools = toolsFor(agent)
    if (omitRestrict) tools.restrict = undefined
    if (omitGuard) {
      tools.guard = undefined
    } else {
      // 可翻转的拒绝注入：翻转 flags 后委托回原生实现（= 模拟"宿主恢复"）。
      const nativeGuard = tools.guard
      tools.guard = (guard) => {
        if (flags.guardRefusal !== undefined) throw new Error(flags.guardRefusal)
        return nativeGuard(guard)
      }
    }
    agent.ctx = { tools }
    return agent
  }

  /** 派发一次工具调用：被守卫拒绝 ⇒ handler **不执行**。 */
  const call = (name, agent) => {
    const exec = { callId: `call-${ranLog.length + 1}`, name, arguments: {}, agent, signal: undefined }
    const reason = guardReason(exec)
    if (reason !== undefined) return { ran: false, isError: true, message: reason }
    const handler = handlers.get(name)
    if (handler === undefined) return { ran: false, isError: true, message: `UNKNOWN_TOOL: ${name}` }
    ranLog.push(name)
    return { ran: true, isError: false, value: handler() }
  }

  return {
    stats,
    makeAgent,
    call,
    ranLog,
    visibleNames,
    layerOf,
    guardsOf: (agent) => layerOf(agent).guards,
    // 面上新出现一个工具（= 宿主晚注册），并给它一个能证明"跑过"的 handler
    registerTool: (name) => {
      registry.add(name)
      handlers.set(name, () => `${name}-ran`)
      return name
    },
    restrictCallsOf: (agent) => stats.restrictCalls.filter((entry) => entry.scope === agent).length,
    /** 翻转"restrict 收下提交但不改面"的宿主行为：用来演"下一步恢复了"。 */
    setRestrictNoop: (value) => { flags.restrictNoop = value === true },
    /** 翻转"宿主恢复提供可用 guard"的注入（降级路径 D2 的恢复段用）。 */
    setGuardRefusal: (value) => { flags.guardRefusal = value },
  }
}

/** 记录事件监听器的假插件 ctx（与 verify-p3 同款）。 */
function fakePluginCtx() {
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
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
  }
}

const preStepOf = (ctx) => ctx.handlers.get('agent/pre-step')[0]
const tick = async (ctx, agent) => preStepOf(ctx)({ agent }, async () => ({ kind: 'enter', messages: [] }))
const warnsOf = (ctx) => ctx.logs.filter(([level]) => level === 'warn').map(([, text]) => text)

/* ═══════════════════════════ 场景 1 ═══════════════════════════ */

section('场景 1：初始只有 read，稍后注册 bash（旧行为：bash 仍可见、从未施加限制）')

{
  const host = makeHost({ surface: ['read', 'glob'] })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  check(
    'S1a',
    '初始面上没有 bash 时不提交空过滤器（求交为空）',
    host.restrictCallsOf(agent) === 0,
    `restrict 调用 ${host.restrictCallsOf(agent)} 次`,
  )
  check(
    'S1b',
    '执行守卫**已经**就位（不依赖工具面快照）',
    host.guardsOf(agent).length === 1 && host.stats.guardCalls[0]?.scope === agent,
    `guards=${host.guardsOf(agent).length} scope=${String(host.stats.guardCalls[0]?.scope === agent)}`,
  )

  host.registerTool('bash')

  const denied = host.call('bash', agent)
  check(
    'S1c',
    '主控调用 bash 被拒（晚注册的工具照样命中守卫）',
    denied.isError === true && denied.message.includes(scope.DENY_CODE),
    JSON.stringify(denied),
  )
  check(
    'S1d',
    'bash 的 handler 未运行',
    denied.ran === false && host.ranLog.length === 0,
    JSON.stringify(host.ranLog),
  )
  check(
    'S1e',
    '拒绝是可读错误：带 code 与 hint',
    denied.message.includes(scope.DENY_CODE) && denied.message.includes('hint:')
      && denied.message.includes(scope.HINT_ORCHESTRATOR_SCOPE),
    denied.message,
  )

  await tick(ctx, agent)
  check(
    'S1f',
    '复核后 bash 也被从工具面遮蔽（可见性那一轨补上了）',
    !host.visibleNames(agent).includes('bash') && host.restrictCallsOf(agent) >= 1,
    `visible=${JSON.stringify(host.visibleNames(agent))} restrict=${host.restrictCallsOf(agent)}`,
  )
  console.log(`       告警: ${JSON.stringify(warnsOf(ctx))}`)
}

/* ═══════════════════════════ 场景 2 ═══════════════════════════ */

section('场景 2：成功隐藏 bash 后才注册 write（旧行为：写入仍可见、限制只调用一次）')

{
  const host = makeHost({ surface: ['bash', 'read'] })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  check(
    'S2a',
    '首次收窄成功：bash 已从面上消失',
    !host.visibleNames(agent).includes('bash') && host.restrictCallsOf(agent) === 1,
    `visible=${JSON.stringify(host.visibleNames(agent))} restrict=${host.restrictCallsOf(agent)}`,
  )

  host.registerTool('write')
  const denied = host.call('write', agent)
  check(
    'S2b',
    '晚注册的 write 立刻被守卫拒绝（不需要等下一次复核）',
    denied.isError === true && denied.message.includes(scope.DENY_CODE),
    JSON.stringify(denied),
  )
  check(
    'S2c',
    'write 的 handler 未运行',
    denied.ran === false && host.ranLog.length === 0,
    JSON.stringify(host.ranLog),
  )

  await tick(ctx, agent)
  const afterFirst = host.restrictCallsOf(agent)
  check(
    'S2d',
    '复核发现新名字并**再次**提交（旧实现首次成功即 done，永不复查）',
    afterFirst >= 2 && !host.visibleNames(agent).includes('write'),
    `restrict=${afterFirst} visible=${JSON.stringify(host.visibleNames(agent))}`,
  )

  await tick(ctx, agent)
  check(
    'S2e',
    '已覆盖时幂等：不重复提交（避免 restriction 层无限堆积）',
    host.restrictCallsOf(agent) === afterFirst,
    `restrict=${host.restrictCallsOf(agent)}（上一轮 ${afterFirst}）`,
  )
}

/* ═══════════════════════════ 场景 3 ═══════════════════════════ */

section('场景 3：restrict 返回 disposer 但未改变工具面（旧行为：告警后不再重试）')

{
  const host = makeHost({ surface: ['bash', 'read'], restrictNoop: true })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  check(
    'S3a',
    '反查发现限制未生效并告警',
    warnsOf(ctx).some((text) => text.includes('可见性限制未真正生效')),
    JSON.stringify(warnsOf(ctx)),
  )
  check(
    'S3b',
    'bash 仍在工具面上（假宿主刻意不改面）',
    host.visibleNames(agent).includes('bash'),
    JSON.stringify(host.visibleNames(agent)),
  )

  const denied = host.call('bash', agent)
  check(
    'S3c',
    '即便如此，主控执行仍被拒（过滤失效 ≠ 放行）',
    denied.isError === true && denied.message.includes(scope.DENY_CODE),
    JSON.stringify(denied),
  )
  check(
    'S3d',
    'bash 的 handler 未运行',
    denied.ran === false && host.ranLog.length === 0,
    JSON.stringify(host.ranLog),
  )

  const before = host.restrictCallsOf(agent)
  await tick(ctx, agent)
  check(
    'S3e',
    '未生效的项**不记入已覆盖**，后续复核继续重试（旧实现告警后放弃）',
    host.restrictCallsOf(agent) > before,
    `restrict ${before} → ${host.restrictCallsOf(agent)}`,
  )
}

/* ═══════════════════════════ 场景 4 ═══════════════════════════ */

section('场景 4：前 8 次限制失败，第 9 次注册表恢复（旧行为：MAX_ATTEMPTS 后永久放弃）')

{
  const host = makeHost({ surface: ['bash', 'read'], restrictFailures: 8 })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  const deniedDuringFailure = host.call('bash', agent)
  check(
    'S4a',
    '注册表拒绝期间，bash 的执行依旧被拒（不靠 restrict 兜底）',
    deniedDuringFailure.isError === true && deniedDuringFailure.ran === false,
    JSON.stringify(deniedDuringFailure),
  )

  for (let round = 0; round < 9; round += 1) await tick(ctx, agent)

  check(
    'S4b',
    '第 9 次及以后仍在调用 restrict（没有"永久放弃"）',
    host.restrictCallsOf(agent) >= 9,
    `restrict 调用 ${host.restrictCallsOf(agent)} 次`,
  )
  check(
    'S4c',
    '注册表恢复后限制最终生效：bash 从面上消失',
    !host.visibleNames(agent).includes('bash'),
    JSON.stringify(host.visibleNames(agent)),
  )
  check(
    'S4d',
    '全程 handler 一次都没跑',
    host.ranLog.length === 0,
    JSON.stringify(host.ranLog),
  )
  check(
    'S4e',
    '失败期间留下可读告警（不是静默降级）',
    warnsOf(ctx).some((text) => text.includes('拒绝了本次可见性收窄')),
    JSON.stringify(warnsOf(ctx)),
  )
}

/* ═══════════════ 场景 5：与真宿主同形 —— 非全局名不被无限重提交 ═══════════════ */

section('场景 5（本机真宿主同形）：spawn_teammate 这类非全局名不触发无限重提交')

{
  // 本机主实例实测：`restrict` 只接受全局工具名，清单里的 `spawn_teammate`
  // （本机插件 scope-local 注册）会让整批提交抛错，降级后它仍在工具面上 ——
  // 若不区分"未生效"与"注册表明确拒收"，每一步 pre-step 都会重提交一次。
  const SPAWN = 'spawn_teammate'
  const host = makeHost({ surface: ['bash', 'read', SPAWN], globalNames: ['bash', 'read'] })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  check(
    'S5a',
    '首次降级：只提交可遮蔽子集，非全局名被丢弃',
    host.stats.restrictCalls.at(-1)?.filter?.deny?.join(',') === 'bash',
    JSON.stringify(host.stats.restrictCalls.map((entry) => entry.filter)),
  )
  check(
    'S5b',
    '降级后 bash 仍被真遮蔽（降级不等于放弃）',
    !host.visibleNames(agent).includes('bash'),
    JSON.stringify(host.visibleNames(agent)),
  )

  const spawnDenied = host.call(SPAWN, agent)
  check(
    'S5c',
    '非全局名的执行由守卫拒绝（restrict 管不到它，guard 兜底）',
    spawnDenied.isError === true && spawnDenied.ran === false && spawnDenied.message.includes(scope.DENY_CODE),
    JSON.stringify(spawnDenied),
  )

  const before = host.restrictCallsOf(agent)
  await tick(ctx, agent)
  await tick(ctx, agent)
  check(
    'S5d',
    '后续复核不再重复提交（拒收项记为"不可遮蔽"，不空转）',
    host.restrictCallsOf(agent) === before,
    `restrict ${before} → ${host.restrictCallsOf(agent)}`,
  )
  check(
    'S5e',
    '降级告警点明两件事：不再重复提交 + 执行仍被守卫拒绝',
    warnsOf(ctx).some((text) => text.includes('不可遮蔽') && text.includes('执行守卫')),
    JSON.stringify(warnsOf(ctx)),
  )
}

/* ═══════ 场景 6：提交后反查失败 —— 保持「未确认」，下一步恢复并重试 ═══════ */

section('场景 6：反查读不到时保持「未确认」（旧行为：被记成"已确认隐藏"，此后永不重试）')

{
  // 复审的口径：`restrict` 返回 disposer 只证明"注册表接受了这次提交"，不证明
  // "工具面真的变了"。反查本身**读不到**时，旧实现把 stillPresent 折成空数组
  // ⇒ 全部名字被记进 applied ⇒ 后续 pending 判据认为已覆盖、不再重试，
  // 可见性就永久停在"提交了但没生效"上。
  //
  // 触发条件照复审原文构造：`restrict` 返回了 disposer、**实际可见性尚未改变**
  // （restrictNoop），恰好此时反查临时失败（第 3 次 schemas 读抛错）。
  // 这是**可见性确认与重试**的缺口，不是执行绕过 —— 执行守卫独立在位，S6c/S6h 钉住它。
  //
  // ⚠️ 这条夹具**不许用"改成读操作前状态"来绕**：那只是把竞态换个位置，
  // 仍然拿一个观测断言另一个时刻的事实；断言只认"未确认 ⇒ 保留句柄 ⇒ 下一步重试"。
  const host = makeHost({ surface: ['bash', 'read'], restrictNoop: true, schemasFailOn: [3] })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  check(
    'S6a',
    '夹具自证：反查那一刻确实读不到 —— 本次提交的读序列是 ①求交读 ②先撤后读 ③提交后反查，'
      + '第 3 次抛错即"提交后反查失败"',
    host.stats.schemasCalls === 3 && host.restrictCallsOf(agent) === 1,
    `schemas=${host.stats.schemasCalls} restrict=${host.restrictCallsOf(agent)}`,
  )
  check(
    'S6b',
    '未确认被**如实**表达：告警写"反查不到"+"未确认"，不写成"已生效/已遮蔽"',
    warnsOf(ctx).some((text) => text.includes('未确认') && text.includes('反查不到'))
      && !warnsOf(ctx).some((text) => text.includes('已遮蔽')),
    JSON.stringify(warnsOf(ctx)),
  )

  const deniedDuring = host.call('bash', agent)
  check(
    'S6c',
    '未确认期间执行守卫仍在位：主控 bash 被拒且 handler 未跑（缺的是可见性确认，不是执行边界）',
    deniedDuring.isError === true && deniedDuring.message.includes(scope.DENY_CODE)
      && deniedDuring.ran === false && host.ranLog.length === 0,
    JSON.stringify(deniedDuring),
  )

  const beforeRetry = host.restrictCallsOf(agent)
  await tick(ctx, agent)
  check(
    'S6d',
    '下一步**继续重试**：未确认的那批被重新提交（旧实现因 applied 被填满而跳过，restrict 会停在 1）',
    host.restrictCallsOf(agent) > beforeRetry,
    `restrict ${beforeRetry} → ${host.restrictCallsOf(agent)}`,
  )
  check(
    'S6e',
    '限制清理句柄被保留：重提交前的"先撤后读"确实撤销到了上一次的 disposer',
    host.stats.noopDisposeCalls >= 1,
    `noopDisposeCalls=${host.stats.noopDisposeCalls}（0 = 句柄没留在手上）`,
  )

  // "下一步恢复"：宿主这次真的改变工具面。
  host.setRestrictNoop(false)
  await tick(ctx, agent)
  check(
    'S6f',
    '恢复后重提交真的生效：bash 从工具面消失',
    !host.visibleNames(agent).includes('bash'),
    JSON.stringify(host.visibleNames(agent)),
  )
  const settledCalls = host.restrictCallsOf(agent)
  await tick(ctx, agent)
  check(
    'S6g',
    '生效后恢复幂等：不再重复提交（重试不是无限空转）',
    host.restrictCallsOf(agent) === settledCalls,
    `restrict=${host.restrictCallsOf(agent)}（上一轮 ${settledCalls}）`,
  )
  check(
    'S6h',
    '全程 handler 一次都没跑（未确认 ≠ 放行）',
    host.ranLog.length === 0,
    JSON.stringify(host.ranLog),
  )
}

/* ═══════ 场景 6b：未确认 × 注册表拒收 共存 —— 拒收项不空转、可遮蔽项继续重试 ═══════ */

section('场景 6b：未确认与"非全局名"降级共存（守门：拒收登记不被未确认那一格吞掉）')

{
  // 修正里动了 `refusedNames` 的登记时机（提到未确认分支之前）。这条断言守的就是那一行：
  // "注册表明确拒收"是**提交之前**就已知的事实，与反查读不读得到无关 ——
  // 它必须照常生效，否则非全局名会跟着未确认项每一步重提交一次（真宿主上就是每步空转）。
  const host = makeHost({
    surface: ['bash', 'spawn_teammate', 'read'],
    globalNames: ['bash', 'read'],
    restrictNoop: true,
    schemasFailOn: [3],
  })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  const firstSubmit = host.stats.restrictCalls.at(-1)?.filter?.deny?.join(',')
  check(
    'S6i',
    '降级在未确认之前照常发生：提交收敛到可遮蔽子集（只含 bash）',
    firstSubmit === 'bash' && warnsOf(ctx).some((text) => text.includes('不可遮蔽')),
    `deny=${firstSubmit} warns=${JSON.stringify(warnsOf(ctx))}`,
  )

  await tick(ctx, agent)
  const retrySubmit = host.stats.restrictCalls.at(-1)?.filter?.deny?.join(',')
  check(
    'S6j',
    '未确认不放飞拒收项：重提交仍只含可遮蔽名，spawn_teammate 不跟着空转',
    retrySubmit === 'bash' && host.restrictCallsOf(agent) >= 2,
    `deny=${retrySubmit} restrict=${host.restrictCallsOf(agent)}`,
  )
}

/* ═══════ 场景 7：反查读得到时，只把「确实消失」的名字记为已覆盖（钉住既有行为） ═══════ */

section('场景 7：部分生效 —— 只有确实从面上消失的名字算已覆盖，仍可见的继续重试')

{
  // 宿主只遮蔽子集（bash 消失、write 仍在面上）：applied 只能收 bash；
  // write 那句"仍未生效"的告警必须**指名 write**、不牵连已经消失的 bash。
  // `executable` 是本场景的关键一环：这两个名字在面上是"已经存在的工具"（不是之后新注册的），
  // 只给 `surface` 不给 handler 时 `host.call()` 一律报 `UNKNOWN_TOOL` ⇒ S7d 的"被拒绝"
  // 与"工具不存在"同形（假绿第三例，见文件头）。
  const host = makeHost({
    surface: ['bash', 'write', 'read'],
    executable: ['bash', 'write'],
    restrictHidesOnly: ['bash'],
  })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  check(
    'S7a',
    '未生效告警精确到名字：只点名仍在面上的 write，不把已消失的 bash 算进去',
    warnsOf(ctx).some((text) => text.includes('可见性限制未真正生效')
      && text.includes('write') && !text.includes('bash')),
    JSON.stringify(warnsOf(ctx)),
  )
  check(
    'S7b',
    'bash 确实从面上消失（部分生效也是生效）',
    !host.visibleNames(agent).includes('bash'),
    JSON.stringify(host.visibleNames(agent)),
  )
  const before = host.restrictCallsOf(agent)
  await tick(ctx, agent)
  check(
    'S7c',
    '仍可见的 write 不记已覆盖：下一步继续重试',
    host.restrictCallsOf(agent) > before,
    `restrict ${before} → ${host.restrictCallsOf(agent)}`,
  )
  const deniedBash = host.call('bash', agent)
  const deniedWrite = host.call('write', agent)
  // 三种形态必须可分辨：守卫拒绝（报文含 DENY_CODE）／执行被放行／其余报文（例如夹具没有
  // handler 时的 `UNKNOWN_TOOL`）。**只断言 `isError === true` 没有鉴别力** —— 守卫缺席与
  // handler 缺席会在同一条判据下同形；清空本场景守卫后 S7d 必须失败（假绿第三例）。
  const outcome = (result) => {
    if (result.ran === true) return 'EXECUTED_ALLOWED'
    if (typeof result.message === 'string' && result.message.includes(scope.DENY_CODE)) return 'DENIED_BY_GUARD'
    return `NOT_DENIED_BY_GUARD(${result.message})`
  }
  const bashOutcome = outcome(deniedBash)
  const writeOutcome = outcome(deniedWrite)
  check(
    'S7d',
    '两个名字的执行都被守卫拒绝：两条报文都含 DENY_CODE（与"工具不存在"可区分），handler 一次都没跑',
    bashOutcome === 'DENIED_BY_GUARD' && writeOutcome === 'DENIED_BY_GUARD' && host.ranLog.length === 0,
    JSON.stringify({ bash: bashOutcome, write: writeOutcome, ran: host.ranLog }),
  )
}

/* ═══════════════════ 通用验收：子代理 / 别的主控 / 作用域 ═══════════════════ */

section('通用验收：子代理不被误伤 · 守卫按真实身份生效 · 不落到 global 层')

{
  const host = makeHost({ surface: ['bash', 'read'] })
  // 面上的 `bash` 必须**带 handler**：`registerTool` 才是夹具里"这个工具真的能被执行"
  // 的那一半（只给 `surface` 只有可见性）。少了这一步，`host.call()` 一律返回
  // `UNKNOWN_TOOL`，于是"子代理放行"与"守卫拒绝"**都**表现为 `ran === false`，
  // G1/G3/G4 会静默判错（这是本夹具曾真实发生过的假绿，见文件头"假绿"注记）。
  host.registerTool('bash')
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const main = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent: main, source: 'new' })

  const child = host.makeAgent(CHILD_HEADER)
  await ctx.emit('agent/created', { agent: child, source: 'subagent' })
  const childRun = host.call('bash', child)
  check(
    'G1',
    '子代理执行 bash 正常（handler 真的跑了，未被误伤）',
    childRun.ran === true && childRun.isError === false && childRun.value === 'bash-ran',
    JSON.stringify({ ...childRun, ran: childRun.ran }),
  )
  check(
    'G2',
    '子代理既没被收窄也没被装守卫',
    host.guardsOf(child).length === 0 && host.restrictCallsOf(child) === 0,
    `guards=${host.guardsOf(child).length} restrict=${host.restrictCallsOf(child)}`,
  )

  const strayChild = host.makeAgent(CHILD_HEADER_2)
  check(
    'G3',
    '从未经过 agent/created 的子代理同样不被拦（守卫挂主控 scope，子代理走不到那层）',
    host.call('bash', strayChild).ran === true,
    JSON.stringify(host.call('bash', strayChild)),
  )

  const otherMain = host.makeAgent(MAIN_HEADER_2)
  check(
    'G4',
    '未被收窄的另一个主控会话不受本会话守卫影响（按真实调用身份，不是全局拦截）',
    host.call('bash', otherMain).ran === true,
    JSON.stringify(host.call('bash', otherMain)),
  )

  check(
    'G5',
    '守卫只注册在 agent scope 上：global 层从未被注册过（用插件 ctx 会连子代理一起拦）',
    host.stats.globalGuardCalls === 0 && host.layerOf(undefined).guards.length === 0,
    `globalGuardCalls=${host.stats.globalGuardCalls}`,
  )

  const denied = host.call('bash', main)
  check(
    'G6',
    '同一时刻主控仍被拒，且拒绝理由是**执行守卫**（G1/G3/G4 的放行不是"守卫没工作"，'
      + '也不是 handler 不存在导致的 UNKNOWN_TOOL）',
    denied.isError === true && denied.ran === false && denied.message.includes(scope.DENY_CODE),
    JSON.stringify(denied),
  )

  await ctx.emit('agent/disposed', { agent: main })
  check(
    'G7',
    'agent/disposed 撤销两轨：守卫卸载且限制解除',
    host.guardsOf(main).length === 0 && host.visibleNames(main).includes('bash'),
    `guards=${host.guardsOf(main).length} visible=${JSON.stringify(host.visibleNames(main))}`,
  )
}

/* ═══════════════════ 守卫纯函数形状（与 ToolGuard 契约逐条对应） ═══════════════════ */

section('守卫形状：ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined')

{
  const host = makeHost({ surface: ['bash'] })
  const main = host.makeAgent(MAIN_HEADER)
  const child = host.makeAgent(CHILD_HEADER)
  const other = host.makeAgent(MAIN_HEADER_2)
  const guard = scope.createDenyGuard({ agent: main, deny: scope.DEFAULT_DENY })

  check(
    'T1',
    '命中：返回 string（真身以"返回字符串"作为单调拒绝）',
    typeof guard({ name: 'bash', agent: main }) === 'string',
    String(guard({ name: 'bash', agent: main })),
  )
  check(
    'T2',
    '未命中：返回 undefined（放行本守卫）',
    guard({ name: 'read', agent: main }) === undefined,
    String(guard({ name: 'read', agent: main })),
  )
  check(
    'T3',
    '子代理身份：放行（双保险，不依赖注册 scope）',
    guard({ name: 'bash', agent: child }) === undefined,
    String(guard({ name: 'bash', agent: child })),
  )
  check(
    'T4',
    '别的主控：放行（按真实调用身份判定）',
    guard({ name: 'bash', agent: other }) === undefined,
    String(guard({ name: 'bash', agent: other })),
  )
  check(
    'T5',
    'exec.agent 缺失：放行（身份不可证明时不越权）',
    guard({ name: 'bash' }) === undefined,
    String(guard({ name: 'bash' })),
  )
  check(
    'T6',
    '同一会话 id 的等价身份：拒绝（身份判据是会话，不是对象指针）',
    typeof guard({ name: 'bash', agent: { id: MAIN_HEADER.id, session: { header: { ...MAIN_HEADER } } } }) === 'string',
    String(guard({ name: 'bash', agent: { id: MAIN_HEADER.id, session: { header: { ...MAIN_HEADER } } } })),
  )
  check(
    'T7',
    '名单里的"改系统"入口一并拒绝（purge_* / plugin_* / spawn_teammate）',
    ['purge_apply', 'plugin_install', 'plugin_auto_update', 'spawn_teammate']
      .every((name) => typeof guard({ name, agent: main }) === 'string'),
    JSON.stringify(['purge_apply', 'plugin_install', 'plugin_auto_update', 'spawn_teammate']
      .map((name) => [name, typeof guard({ name, agent: main })])),
  )
  check(
    'T7b',
    'pwsh 与 bash 同类：主会话执行守卫硬拦截（官方 dsh-tool-pwsh 第一方工具）',
    typeof guard({ name: 'pwsh', agent: main }) === 'string'
      && String(guard({ name: 'pwsh', agent: main })).includes(scope.DENY_CODE),
    String(guard({ name: 'pwsh', agent: main })),
  )
  check(
    'T8',
    '全量名单不裁剪：guard 用 DEFAULT_DENY 原样建集（不与工具面求交）',
    scope.DEFAULT_DENY.every((name) => typeof guard({ name, agent: main }) === 'string')
      && scope.DEFAULT_DENY.length >= 12,
    `deny 项 ${scope.DEFAULT_DENY.length}`,
  )
  check(
    'T9',
    '拒绝文案含 code 与 hint（可读错误，模型知道该改派子代理）',
    (() => {
      const text = guard({ name: 'bash', agent: main })
      return text.includes(scope.DENY_CODE) && text.includes(scope.HINT_ORCHESTRATOR_SCOPE)
    })(),
    String(guard({ name: 'bash', agent: main })),
  )
  check(
    'T10',
    '默认 deny 覆盖既有清单（标准执行/写 + 改宿主/改插件 + 拉起队友）',
    ['bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'purge_apply', 'purge_revert',
      'plugin_install', 'plugin_remove', 'plugin_auto_update', 'plugin_set_auto_update',
      'spawn_teammate'].every((name) => scope.DEFAULT_DENY.includes(name)),
    `DEFAULT_DENY(${scope.DEFAULT_DENY.length})=${scope.DEFAULT_DENY.join(', ')}`,
  )
}

/* ═══════════════════ 场景 D：三条降级路径（AUDIT4 候选 2）═══════════════════ */

section('场景 D1：agent.ctx.tools.guard 不可用 —— 降级路径 no-guard')

{
  const host = makeHost({ surface: ['read', 'bash'], executable: ['bash'], omitGuard: true })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  const warns = warnsOf(ctx)
  check(
    'D1a',
    'guard 入口不可用时如实告警（含原因、后果与「继续重试」承诺）',
    warns.some((text) => text.includes('取不到 agent 作用域的执行守卫入口')
      && text.includes('本轨不生效') && text.includes('继续重试')),
    JSON.stringify(warns),
  )
  check(
    'D1b',
    '该轨确实未装上（guards 层为空，降级如实发生）',
    host.guardsOf(agent).length === 0,
    `guards=${host.guardsOf(agent).length}`,
  )
  check(
    'D1c',
    '可见性轨不受影响：bash 仍被从面上遮蔽',
    !host.visibleNames(agent).includes('bash'),
    `visible=${JSON.stringify(host.visibleNames(agent))}`,
  )
  check(
    'D1d',
    '降级语义如实：无守卫时不伪称拦截（本夹具记录这一事实）',
    host.call('bash', agent).ran === true,
    JSON.stringify(host.call('bash', agent)),
  )
  await tick(ctx, agent)
  check(
    'D1e',
    '每步复核持续重试且告警幂等（warnOnce 只发一次）',
    host.guardsOf(agent).length === 0
      && warnsOf(ctx).filter((text) => text.includes('取不到 agent 作用域的执行守卫入口')).length === 1,
    `guards=${host.guardsOf(agent).length} no-guard 告警数=${warnsOf(ctx).filter((text) => text.includes('取不到 agent 作用域的执行守卫入口')).length}`,
  )
}

section('场景 D2：guard 注册被拒 —— 降级路径 guard-refused（含宿主恢复后重试成功）')

{
  const host = makeHost({ surface: ['read', 'bash'], executable: ['bash'], guardRefusal: 'registry exploded' })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  const warns = warnsOf(ctx)
  check(
    'D2a',
    '注册被拒时如实告警并带原始错误文本',
    warns.some((text) => text.includes('执行守卫注册被拒') && text.includes('registry exploded')),
    JSON.stringify(warns),
  )
  check(
    'D2b',
    '被拒后该轨不在位（guards 层为空）',
    host.guardsOf(agent).length === 0,
    `guards=${host.guardsOf(agent).length}`,
  )
  check(
    'D2c',
    '被拒不影响可见性轨：bash 仍被遮蔽',
    !host.visibleNames(agent).includes('bash'),
    `visible=${JSON.stringify(host.visibleNames(agent))}`,
  )

  // 边界声明（REVIEW-15-16 Q3，复核者 cdc017d2）：下面的「宿主恢复」是**显式夹具翻转**
  // （`setGuardRefusal(undefined)`），只覆盖**插件侧的每步重试路径** —— 它不模拟宿主
  // registry 的真实恢复时序（何时恢复、恢复瞬间是否存在并发调用窗口）。该时序需在集成
  // 环境（真实宿主）另验；此处断言的是「插件在恢复后的一次复核内即重装守卫」。
  host.setGuardRefusal(undefined) // 宿主恢复
  await tick(ctx, agent)
  check(
    'D2d',
    '宿主恢复后，下一次复核把守卫真正装上（「永不放弃」落点）',
    host.guardsOf(agent).length === 1,
    `guards=${host.guardsOf(agent).length}`,
  )
  const denied = host.call('bash', agent)
  check(
    'D2e',
    '恢复后的守卫按全量名单拒绝 bash（执行边界回来了）',
    denied.isError === true && denied.message.includes(scope.DENY_CODE),
    JSON.stringify(denied),
  )
}

section('场景 D3：agent.ctx.tools.restrict 不可用 —— 降级路径 no-scoped-view')

{
  const host = makeHost({ surface: ['read', 'bash'], executable: ['bash'], omitRestrict: true })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })

  const warns = warnsOf(ctx)
  check(
    'D3a',
    'restrict 不可用时如实告警（含「可见性不生效 / 执行守卫仍在位」）',
    warns.some((text) => text.includes('取不到 agent 作用域的工具视图')
      && text.includes('可见性过滤不生效') && text.includes('执行守卫仍会拒绝')),
    JSON.stringify(warns),
  )
  check(
    'D3b',
    '可见性轨确实不生效：bash 仍在面上（降级如实发生）',
    host.visibleNames(agent).includes('bash'),
    `visible=${JSON.stringify(host.visibleNames(agent))}`,
  )
  const denied = host.call('bash', agent)
  check(
    'D3c',
    '执行守卫独立在位：bash 的执行仍被拒绝（第 2 轨兜底）',
    denied.isError === true && denied.message.includes(scope.DENY_CODE) && denied.ran === false,
    JSON.stringify(denied),
  )
}

/* ═══════════════ 场景 E：名单漂移诊断（只告警不拦截）═══════════════ */

section('场景 E：DEFAULT_DENY 名单漂移诊断（AUDIT4 候选 3）')

{
  const drift = scope.executionLikeToolsNotDenied(
    ['read', 'glob', 'exec_shell', 'apply_patch', 'todo_write', 'mmap_remove', 'bash'],
    scope.DEFAULT_DENY,
  )
  check(
    'E1',
    '漂移判定：只报「疑似执行类且不在名单」的名字（编排工具与豁免不误报）',
    JSON.stringify(drift) === JSON.stringify(['exec_shell', 'apply_patch']),
    JSON.stringify(drift),
  )

  const host = makeHost({ surface: ['read', 'exec_shell'], executable: ['exec_shell'] })
  const ctx = fakePluginCtx()
  scope.apply(ctx, {})
  const agent = host.makeAgent(MAIN_HEADER)
  await ctx.emit('agent/created', { agent, source: 'new' })
  const warns = warnsOf(ctx)
  check(
    'E2',
    '端到端：激活时对漂移名字告警一次（含「只告警不拦截」声明）',
    warns.some((text) => text.includes('疑似执行类') && text.includes('exec_shell')
      && text.includes('只告警不拦截')),
    JSON.stringify(warns),
  )
  check(
    'E3',
    '只告警不拦截：漂移工具仍按现状放行（诊断未改变任何行为）',
    host.call('exec_shell', agent).ran === true,
    JSON.stringify(host.call('exec_shell', agent)),
  )

  const cleanHost = makeHost({ surface: ['read', 'glob', 'todo_write'] })
  const cleanCtx = fakePluginCtx()
  scope.apply(cleanCtx, {})
  await cleanCtx.emit('agent/created', { agent: cleanHost.makeAgent(MAIN_HEADER), source: 'new' })
  check(
    'E4',
    '零漂移：工具面全为非执行类时不产生漂移告警（假命中=0）',
    !warnsOf(cleanCtx).some((text) => text.includes('疑似执行类')),
    JSON.stringify(warnsOf(cleanCtx)),
  )

  // E5-E8（REVIEW-15-16 独立复核补漏）：plugin_update 的遮蔽与诊断可捕获性 + 豁免腐烂守卫
  check(
    'E5',
    'plugin_update 在 DEFAULT_DENY 内（与 plugin_install/remove 同类：下载并运行新插件代码）',
    scope.DEFAULT_DENY.includes('plugin_update'),
    JSON.stringify(scope.DEFAULT_DENY.filter((name) => name.startsWith('plugin_'))),
  )
  const pluginSurface = ['read', 'plugin_update', 'plugin_install']
  check(
    'E6',
    'plugin_update 已被遮蔽时，漂移诊断不把它报为漏网',
    scope.executionLikeToolsNotDenied(pluginSurface, scope.DEFAULT_DENY).length === 0,
    JSON.stringify(scope.executionLikeToolsNotDenied(pluginSurface, scope.DEFAULT_DENY)),
  )
  check(
    'E7',
    '反向：从名单移除 plugin_update 后，诊断会报出它（证明该名字可被模式捕获）',
    scope.executionLikeToolsNotDenied(pluginSurface,
      scope.DEFAULT_DENY.filter((name) => name !== 'plugin_update')).includes('plugin_update'),
    JSON.stringify(scope.executionLikeToolsNotDenied(pluginSurface,
      scope.DEFAULT_DENY.filter((name) => name !== 'plugin_update'))),
  )
  const rottedExemptions = [...scope.DRIFT_EXEMPT]
    .filter((name) => !scope.EXECUTION_LIKE_PATTERNS.some((pattern) => pattern.test(name)))
  check(
    'E8',
    'DRIFT_EXEMPT 无腐烂：每条豁免仍被某个模式命中（否则豁免已无意义，应删除）',
    rottedExemptions.length === 0,
    JSON.stringify(rottedExemptions),
  )

  // E9-E10：把 E7 对 plugin_update 的「移除后可被捕获」约定推广到**整份** DEFAULT_DENY。
  // 否则名单里有的项（此前 pwsh / purge_apply / purge_revert / plugin_auto_update /
  // plugin_set_auto_update）一旦在重构中被误删，漂移诊断不会报出 ⇒ 静默放行且无人察觉。
  const unbackstopped = scope.DEFAULT_DENY
    .filter((name) => !scope.executionLikeToolsNotDenied([name],
      scope.DEFAULT_DENY.filter((other) => other !== name)).includes(name))
  check(
    'E9',
    '整份 DEFAULT_DENY 均有漂移兜底：任一项从名单移除后，诊断都会报出它（推广 E7）',
    unbackstopped.length === 0,
    `无兜底项=${JSON.stringify(unbackstopped)}`,
  )
  const shellTwins = ['bash', 'pwsh']
  check(
    'E10',
    'bash 与 pwsh 两个 shell 孪生对称：移除名单后都会被漂移诊断报出（对齐 PR #22 的同类判定）',
    shellTwins.every((name) => scope.executionLikeToolsNotDenied([name],
      scope.DEFAULT_DENY.filter((other) => other !== name)).includes(name)),
    JSON.stringify(shellTwins.map((name) => [name, scope.executionLikeToolsNotDenied([name],
      scope.DEFAULT_DENY.filter((other) => other !== name))])),
  )
}

/* ═══════════════════════════ 汇总 ═══════════════════════════ */

console.log('')
console.log('══════════════════════════════════════════════════════════════════')
console.log(`结果：${passed} PASS / ${failed} FAIL`)
console.log('══════════════════════════════════════════════════════════════════')
process.exitCode = failed === 0 ? 0 : 1
