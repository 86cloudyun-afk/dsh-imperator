import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { resolveInstallAnchor } from '../host-runtime.mjs'

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

let hostRoot = null
let skipReason = null
try {
  const anchor = resolveInstallAnchor({})
  // anchor = <prefix>/.../@deepseek-ai/dsh/package.json → 同级目录即兄弟宿主包所在处
  hostRoot = dirname(dirname(anchor))
} catch (error) {
  skipReason = `requires a resolvable @deepseek-ai/dsh install (anchor/PATH): ${error.message}`
}

async function importHost(pkg, entry) {
  const modulePath = join(hostRoot, pkg, entry)
  if (!existsSync(modulePath)) {
    throw new Error(`宿主包路径不存在：${modulePath}（宿主布局或包名已变化）`)
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
