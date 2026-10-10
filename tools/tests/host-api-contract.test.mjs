import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { resolveInstallAnchor } from '../host-runtime.mjs'
import { foldGuardSignal, createGuardProjection } from '../../lib/plugins/guard.mjs'
import { apply as applyTools } from '../../lib/tools/index.js'
import { tempStore } from './helpers.mjs'

/**
 * 宿主 API 符号锚点契约（**不依赖行号**）。
 *
 * 背景：`lib/plugins/scope-membership.mjs`、`lib/tools/index.js` 的身份判据与
 * `lib/tools/index.js` 的工具注册，都**功能性地依赖**宿主包的具体导出符号与
 * 语义（例如子代理会话头必须带 `origin:'subagent'` / `delegationDepth`）。
 * 源码注释里用「包名 + 文件:行号」记录了这些依赖，但行号会随宿主版本漂移，
 * 因此本守卫**只断言符号与语义锚点**，不做行号内容匹配。
 *
 * 纪律（与既有 native 测试同款）：解析不到宿主安装（无 `--install-anchor` /
 * `DSH_INSTALL_ANCHOR`，PATH 里也没有 dsh）时，**如实 SKIP 并说明原因**，
 * 不假装通过。
 */

let hostRequire = null
let hostResolverNote = null
let skipReason = null
try {
  const anchor = resolveInstallAnchor({})
  // 用宿主自己的解析器定位兄弟包：createRequire(anchor) 会按 Node 算法
  // 依次在 <dsh>/node_modules → 上层 node_modules 中查找，因此**嵌套布局**
  // （…/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-scope）与
  // **扁平布局**（…/node_modules/@deepseek-ai/dsh-scope）都能解析。
  // 注意：不能用 dirname(dirname(anchor)) 拼接——那只在扁平布局下成立。
  hostRequire = createRequire(anchor)
  hostResolverNote = `anchor=${anchor}`
} catch (error) {
  skipReason = `requires a resolvable @deepseek-ai/dsh install (anchor/PATH): ${error.message}`
}

async function importHost(pkg, entry) {
  const name = `@deepseek-ai/${pkg}`
  let packageRoot
  try {
    // 首选：用 package.json 定位包根（最精确）
    packageRoot = dirname(hostRequire.resolve(`${name}/package.json`))
  } catch (primaryError) {
    // 回退：部分包的 exports 未开放 ./package.json —— 由入口文件回溯包根
    let entryPath
    try {
      entryPath = hostRequire.resolve(name)
    } catch (fallbackError) {
      throw new Error(`宿主包 ${name} 无法解析（宿主布局或包名已变化）：${fallbackError.message}；${hostResolverNote}`)
    }
    const marker = `/${pkg}`
    const index = entryPath.lastIndexOf(marker)
    packageRoot = index < 0 ? dirname(entryPath) : entryPath.slice(0, index + marker.length)
  }
  const modulePath = join(packageRoot, entry)
  if (!existsSync(modulePath)) {
    throw new Error(`宿主包路径不存在：${modulePath}（包根 ${packageRoot}；入口 ${entry}）`)
  }
  return import(pathToFileURL(modulePath).href)
}

const skip = skipReason !== null ? skipReason : false

test('dsh-scope 必须导出 scopeOf / scopeChainOf（scope-membership 的硬依赖）', { skip }, async () => {
  const scope = await importHost('dsh-scope', 'lib/index.js')
  assert.equal(typeof scope.scopeOf, 'function',
    'dsh-scope 未导出 scopeOf（函数）—— lib/plugins/scope-membership.mjs 的作用域归属判据会失效')
  assert.equal(typeof scope.scopeChainOf, 'function',
    'dsh-scope 未导出 scopeChainOf（函数）—— 同上，且插件将以 fail-closed 拒绝激活')
})

test('dsh-subagent 的 childSessionMeta 必须产出 origin/delegationDepth/parentSession 语义锚点', { skip }, async () => {
  const subagent = await importHost('dsh-subagent', 'lib/index.js')
  assert.equal(typeof subagent.childSessionMeta, 'function',
    'dsh-subagent 未导出 childSessionMeta —— lib/tools/index.js 的「子代理 = origin===subagent 或 depth>0」判据失去宿主侧统一写入点')

  // 最小夹具：只需 session.header（id/cwd）与可调用的 ctx.get
  const parent = {
    session: { header: { id: 'host-api-contract-fixture', cwd: '/tmp' } },
    ctx: { get: () => undefined },
  }
  const meta = subagent.childSessionMeta(parent, 1, false)
  assert.equal(meta.origin, 'subagent',
    `childSessionMeta().origin 不再是 'subagent'（实得 ${JSON.stringify(meta.origin)}）：身份判据会把子代理误判为主会话`)
  assert.equal(meta.delegationDepth, 1,
    `childSessionMeta().delegationDepth 未按入参写入（实得 ${JSON.stringify(meta.delegationDepth)}）：深度判据与 maxDepth 预算失效`)
  assert.equal(meta.parentSession, 'host-api-contract-fixture',
    'childSessionMeta().parentSession 未取父会话 id：上溯链（run 归属推导）会断')
  assert.equal(meta.isSeeded, false, 'childSessionMeta().isSeeded 未按入参写入')
})

test('dsh-tools 必须导出可用的 defineTool（工具注册行的硬依赖）', { skip }, async () => {
  const tools = await importHost('dsh-tools', 'lib/index.js')
  assert.equal(typeof tools.defineTool, 'function',
    'dsh-tools 未导出 defineTool —— lib/tools/index.js 的 10 个模型可见工具无法按原生形状注册（会退回本地兜底实现）')
  // 说明：本守卫只断言**符号锚点**（跨版本改名/移除检测）。defineTool 的**调用形状**
  // （必填 output 等字段、schema 编译）由既有 native 测试覆盖：lib/tools/index.js
  // 用它注册全部 10 个工具，verify-host / preset-isolation / host-boundaries 走真实注册路径。
})

/** Public SDK constructors and durable Session records provide the actual wire
 * shape; only the unavailable external effect is represented by its receipt. */
async function nativeGuardOutcomeHistory(kind) {
  const [{ Session }, { createToolResultMessage }] = await Promise.all([
    importHost('dsh-session', 'lib/index.js'), importHost('dsh-llm', 'lib/index.js'),
  ])
  const session = Session.create('guard-outcome-' + kind)
  for (let step = 1; step <= 3; step++) {
    const callId = 'same-provider-id'
    const durable = kind === 'durable-unknown'
    session.append('step/start', { turn: 1, step })
    const invoked = session.append('tool/call', { turn: 1, step, callId,
      name: durable ? 'task_child_send' : 'bash',
      arguments: durable ? '{"target_id":"child","message":"continue"}' : '{"command":"one fixed effect"}' })
    const receipt = durable ? JSON.stringify({
      ok: false, error: 'external effect is unresolved', code: 'E_CONTROL_OUTCOME_UNKNOWN',
      hint: 'retain the original retry key; do not repeat effects',
      operation: { status: 'unknown', retry_key: 'original-retry-key' },
    }) : 'uncommitted outcome'
    session.append('tool/result', { turn: 1, step,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: receipt }], isError: !durable }),
      ...(durable ? {} : { error: {
        name: kind === 'native-unknown' ? 'ToolOutcomeUnknownError' : 'ToolNotStartedError',
        code: kind === 'native-unknown' ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED',
      } }),
    }, { surfaceOp: 'append', sourceEventSeqs: [invoked.seq] })
    session.append('step/end', { turn: 1, step })
  }
  return session.snapshotEvents()
}

for (const kind of ['native-unknown', 'durable-unknown']) {
  test('native SDK result shape does not classify ' + kind + ' as definite-failure ECHO', { skip }, async () => {
    const events = await nativeGuardOutcomeHistory(kind)
    assert.equal(foldGuardSignal(events, { echoFailures: 3, detectStall: false }).signal, undefined)
    assert.equal(createGuardProjection({ echoFailures: 3 }).read(events).echo, undefined)
  })
}
test('native SDK definite TOOL_NOT_STARTED result shape still triggers ECHO', { skip }, async () => {
  const events = await nativeGuardOutcomeHistory('not-started')
  assert.equal(foldGuardSignal(events, { echoFailures: 3, detectStall: false }).signal, 'echo')
})

for (const transport of ['native', 'PTC']) {
  test('native SDK durable rejected stop replay triggers ECHO through ' + transport, { skip }, async t => {
    const [{ Session }, { createToolResultMessage }] = await Promise.all([
      importHost('dsh-session', 'lib/index.js'), importHost('dsh-llm', 'lib/index.js'),
    ])
    const store = tempStore(t), session = Session.create('guard-rejected-sdk-' + transport)
    const run = session.header.id, child = 'guard-rejected-sdk-child'
    const agent = { id: run, session }, definitions = new Map()
    const args = { target_id: ' ' + child + ' ', request_key: ' sdk-original-rejected-key ' }
    let effects = 0
    applyTools({
      logger: { warn() {} },
      get(name) {
        if (name === 'taskforceStore') return store
        if (name === 'agents') return { get: id => id === run ? agent : undefined }
        if (name === 'subagents') return {
          async listChildren() { return [{ id: child, mode: 'continuable', createdAt: 0 }] },
          interrupt() { effects++; return { accepted: false } },
        }
      },
      tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } },
    })
    const invoke = id => definitions.get('task_child_stop').execute(args, {
      agent, callId: id, signal: new AbortController().signal,
    })
    const initial = JSON.parse(await invoke('initial-sdk-rejection'))
    assert.equal(initial.ok, true)
    assert.equal(initial.stopped.accepted, false)
    assert.equal(initial.operation.status, 'rejected')
    const rows = () => store.open().prepare('SELECT * FROM control_operation ORDER BY id').all()
    const before = rows()
    assert.equal(before.length, 1)
    for (let step = 1; step <= 6; step++) {
      const callId = 'same-provider-id'
      const text = await invoke(callId), receipt = JSON.parse(text)
      assert.equal(receipt.operation.status, 'rejected')
      assert.equal(receipt.operation.operation_id, initial.operation.operation_id)
      assert.equal(receipt.operation.retry_key, args.request_key)
      assert.equal(receipt.operation.replayed, true)
      assert.equal(receipt.operation.invoke, false)
      session.append('step/start', { turn: 1, step })
      if (transport === 'native') {
        const invoked = session.append('tool/call', { turn: 1, step, callId,
          name: 'task_child_stop', arguments: JSON.stringify(args) })
        session.append('tool/result', { turn: 1, step,
          message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
        }, { surfaceOp: 'append', sourceEventSeqs: [invoked.seq] })
      } else {
        const invoked = session.append('tool/call', { turn: 1, step, callId,
          name: 'run_code', arguments: JSON.stringify({ code: 'transport ' + step }) })
        session.append('tool/ptc-dispatch-start', { turn: 1, step, rootCallId: callId,
          subCallId: 'same-inner-id', name: 'task_child_stop', arguments: JSON.stringify(args) })
        session.append('tool/ptc-dispatch', { turn: 1, step, rootCallId: callId,
          subCallId: 'same-inner-id', isError: false, content: [{ type: 'text', text }] })
        session.append('tool/result', { turn: 1, step,
          message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'wrapper complete' }], isError: false }),
        }, { surfaceOp: 'append', sourceEventSeqs: [invoked.seq] })
      }
      session.append('step/end', { turn: 1, step })
    }
    assert.equal(effects, 1, 'SDK histories contain six replay attempts with zero additional interrupts')
    assert.deepEqual(rows(), before)
    const events = session.snapshotEvents()
    assert.equal(foldGuardSignal(events, { echoFailures: 6, detectStall: false }).signal, 'echo')
    assert.equal(createGuardProjection({ echoFailures: 6 }).read(events).echo?.signal, 'echo')
  })
}
