#!/usr/bin/env node
/** Opt-in native model evaluation. Importing this module never boots a host or calls a provider. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { controlledProfile, nativeModule, resolveInstallAnchor, installationVersion } from './host-runtime.mjs'
import { MODEL_STAGES, STRICT_COMMAND, STRICT_FILES, writeModelFixture, gradeMoney } from './model-fixtures.mjs'
import { strictExecutionEvidence } from '../lib/store/execution.js'
import { toolEvent } from '../lib/plugins/tool-events.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fail = code => { throw Object.assign(new Error(code), { verificationCode: code }) }
const count = value => Number.isSafeInteger(value) && value >= 0
const tick = () => new Promise(resolveTick => setTimeout(resolveTick, 10))

/** Sorted paths and exact bytes of runtime + verification sources; independent of git availability. */
export function productFingerprint(root = ROOT) {
  const hash = createHash('sha256')
  function visit(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) add(child)
      else throw new Error('Unsupported product source entry')
    }
  }
  function add(path) {
    const bytes = readFileSync(join(root, path))
    hash.update(`${path.replaceAll('\\', '/')}\0${bytes.length}\0`).update(bytes)
  }
  add('package.json'); add('cordis.patch.yml'); visit('lib'); visit('tools')
  return hash.digest('hex')
}
function workspaceFingerprint(workspace) {
  const hash = createHash('sha256')
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name)
      hash.update(full.slice(workspace.length))
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) hash.update(readFileSync(full))
      else hash.update('non-file')
    }
  }
  visit(workspace)
  return hash.digest('hex')
}
function validate(options) {
  if (options.modelCalls !== true) throw new TypeError('Explicit --model-calls opt-in is required')
  const requestCap = options.requestCap ?? 80
  const stageTimeoutMs = options.stageTimeoutMs ?? 180000
  if (!Number.isSafeInteger(requestCap) || requestCap < 1 || requestCap > 80) throw new TypeError('requestCap must be an integer in 1..80')
  if (!Number.isSafeInteger(stageTimeoutMs) || stageTimeoutMs < 1 || stageTimeoutMs > 2147483647) throw new TypeError('stageTimeoutMs must be a positive 32-bit integer')
  for (const name of ['installAnchor', 'provider', 'model', 'outputDir']) if (typeof options[name] !== 'string' || !options[name].trim()) throw new TypeError(`${name} is required`)
  for (const name of ['provider', 'model']) if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(options[name])) throw new TypeError(`${name} must be a route identifier`)
  if (options.packageSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.packageSha256)) throw new TypeError('packageSha256 must be a SHA256 digest')
  return { ...options, requestCap, stageTimeoutMs }
}
async function deadline(work, ms, onTimeout) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => { try { onTimeout() } finally { reject(Object.assign(new Error('timeout'), { verificationCode: 'timeout' })) } }, ms)
    })])
  } finally { clearTimeout(timer) }
}
const eventsOf = session => session.events ?? []
const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
function accounting(snapshot, requests, route) {
  const usage = Object.fromEntries(usageKeys.map(key => [key, 0]))
  let valid = true
  const matched = new Set()
  for (const session of snapshot.sessions) for (const event of eventsOf(session)) {
    const tool = toolEvent(event)
    if (event.type === 'step/error' || tool?.phase === 'result' && tool.isError
      || event.type === 'turn/end' && event.data?.reason?.kind !== 'completed') valid = false
    if (event.type !== 'assistant/message') continue
    const key = `${session.id}:${event.data.turn}:${event.data.step}`
    if (!requests.has(key)) continue
    if (matched.has(key)) { valid = false; continue }
    matched.add(key)
    if (event.data.message?.source?.provider !== route.provider || event.data.message?.source?.model !== route.model) valid = false
    const value = event.data.usage
    if (!value || !count(value.inputTokens) || !count(value.outputTokens)) { valid = false; continue }
    for (const field of usageKeys) {
      if (value[field] !== undefined && !count(value[field])) valid = false
      else usage[field] += value[field] ?? 0
    }
  }
  return { usage, valid: valid && matched.size === requests.size }
}
function calls(snapshot, name) {
  return snapshot.sessions.flatMap(s => eventsOf(s).filter(e => e.type === 'tool/call' && e.data?.name === name))
}
function safeSnapshot(harness) {
  const result = harness.snapshot()
  if (!result || !Array.isArray(result.sessions) || !Array.isArray(result.tasks)) fail('invalid-observation')
  // Capture immutable stage boundaries; the native histories remain in disposable memory/home only.
  return structuredClone(result)
}

/** The optional second argument is an offline harness dependency seam, never a CLI option. */
export async function runModelVerification(options = {}, { createHarness = createNativeHarness } = {}) {
  const config = validate(options)
  const started = Date.now()
  const requests = new Set()
  let harness, stopped = false, capHit = false, stageRecord, stageStart, stageRequestStart = 0, stageUsageStart
  const report = { ok: false, provenance: {
    packageVersion: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    gitCommit: null, sourceSha256: productFingerprint(), packageSha256: config.packageSha256 ?? null,
    hostVersion: null, nodeVersion: process.version, provider: config.provider, model: config.model,
  }, requestCap: config.requestCap, stageTimeoutMs: config.stageTimeoutMs, requests: 0,
  usage: Object.fromEntries(usageKeys.map(key => [key, 0])), durationMs: 0, stages: [], failure: null }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 })
  if (git.status === 0 && /^[0-9a-f]{40}$/.test(git.stdout.trim())) report.provenance.gitCommit = git.stdout.trim()
  const workspace = mkdtempSync(join(tmpdir(), 'taskforce-model-work-'))
  const onRequest = ({ agentId, turn, step }) => {
    if (stopped) fail('stopped')
    if (requests.size >= config.requestCap) { capHit = true; stopped = true; harness?.cancel(); fail('request-cap') }
    const key = `${agentId}:${turn}:${step}`
    if (requests.has(key)) { stopped = true; fail('duplicate-request') }
    requests.add(key)
  }
  try {
    writeModelFixture(workspace)
    harness = await createHarness({ ...config, workspace, packageRoot: ROOT, onRequest })
    report.provenance.hostVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(harness.hostVersion) ? harness.hostVersion : null
    if (report.provenance.hostVersion !== '0.2.0-rc.2') fail('host-version')
    let workerId
    for (const stage of MODEL_STAGES) {
      const before = safeSnapshot(harness)
      const beforeRequests = requests.size
      const beforeRequestKeys = new Set(requests)
      const beforeUsage = accounting(before, requests, config).usage
      const beforeFiles = workspaceFingerprint(workspace)
      stageStart = Date.now()
      stageRequestStart = beforeRequests
      stageUsageStart = beforeUsage
      stageRecord = { name: stage.name, ok: false, requests: 0, usage: Object.fromEntries(usageKeys.map(key => [key, 0])), durationMs: 0, newWorkers: 0, reuse: 0, rework: 0, facts: 0, accepted: 0, independentChecks: 0, strictVerified: false }
      report.stages.push(stageRecord)
      await deadline(() => harness.runStage(stage), config.stageTimeoutMs, () => { stopped = true; harness.cancel() })
      const after = safeSnapshot(harness)
      const total = accounting(after, requests, config)
      report.usage = total.usage
      if (capHit) fail('request-cap')
      if (!total.valid || requests.size === beforeRequests) fail('usage-or-runtime-error')
      if (after.settled !== true) fail('unsettled-tree')
      const workers = after.sessions.filter(s => s.id !== harness.rootId)
      const newWorkers = workers.filter(s => !before.sessions.some(old => old.id === s.id)).length
      const newTasks = after.tasks.filter(t => !before.tasks.some(old => old.id === t.id))
      const reuseCalls = calls(after, 'task_child_send').slice(calls(before, 'task_child_send').length)
      const reuse = reuseCalls.filter(e => {
        try { const args = typeof e.data.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments; return args?.target_id === workerId } catch { return false }
      }).length
      const rework = calls(after, 'task_reject').length - calls(before, 'task_reject').length
      Object.assign(stageRecord, { requests: requests.size - beforeRequests, durationMs: Date.now() - stageStart,
        usage: Object.fromEntries(usageKeys.map(key => [key, total.usage[key] - beforeUsage[key]])), newWorkers, reuse, rework,
        facts: newTasks.reduce((n, task) => n + (count(task.facts) ? task.facts : 0), 0), accepted: newTasks.filter(t => t.status === 'accepted').length })
      let independentChecks
      if (stage.name === 'readonly') {
        const rootSession = after.sessions.find(s => s.id === harness.rootId)
        const answer = eventsOf(rootSession).filter(e => e.type === 'assistant/message').flatMap(e => e.data.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
        if (workers.length || after.tasks.length || beforeFiles !== workspaceFingerprint(workspace) || !/\b137\b/.test(answer)) fail('readonly-contract')
        independentChecks = 1
      } else {
        if (stage.name === 'repair') {
          if (newWorkers !== 1 || workers.length !== 1 || workers[0].parent !== harness.rootId) fail('repair-worker-count')
          workerId = workers[0].id
        } else if (newWorkers !== 0 || workers.length !== 1 || workers[0].id !== workerId || reuse < 1) fail('reuse-contract')
        if (![...requests].some(key => !beforeRequestKeys.has(key) && key.startsWith(workerId + ':'))) fail('reuse-contract')
        stageRecord.closure = diagnoseModelClosure(after.tasks, newTasks.length, workerId)
        if (!stageRecord.closure.ok) fail('incomplete-acceptance')
        if (stage.name === 'strict' && (newTasks[0].evidence_policy !== 'execution' || newTasks[0].strictVerified !== true)) fail('strict-receipt')
        const result = gradeMoney(workspace, stage.name !== 'repair')
        independentChecks = result.checks
        stageRecord.independentChecks = result.checks
        if (!result.ok) fail('independent-tests')
      }
      Object.assign(stageRecord, { ok: true, durationMs: Date.now() - stageStart, independentChecks, strictVerified: stage.name === 'strict' })
    }
    report.ok = report.stages.length === MODEL_STAGES.length
  } catch (error) {
    report.failure = capHit ? 'request-cap' : ['timeout', 'request-cap', 'duplicate-request', 'host-version', 'usage-or-runtime-error', 'unsettled-tree', 'readonly-contract', 'repair-worker-count', 'reuse-contract', 'incomplete-acceptance', 'strict-receipt', 'independent-tests', 'invalid-observation'].includes(error?.verificationCode) ? error.verificationCode : 'runtime-error'
  } finally {
    stopped = true
    if (harness) {
      try { report.usage = accounting(safeSnapshot(harness), requests, config).usage } catch { /* retain last confirmed counters */ }
    }
    if (stageRecord) {
      stageRecord.requests = requests.size - stageRequestStart
      stageRecord.durationMs = Date.now() - stageStart
      stageRecord.usage = Object.fromEntries(usageKeys.map(key => [key, report.usage[key] - stageUsageStart[key]]))
    }
    const previousExit = process.exitCode
    try {
      if (harness) {
        try { harness.cancel() } catch { report.ok = false; report.failure = 'cleanup-error' }
        try { await harness.dispose() } catch { report.ok = false; report.failure = 'cleanup-error' }
      }
    } finally {
      process.exitCode = previousExit
      rmSync(workspace, { recursive: true, force: true })
    }
    report.requests = requests.size
    report.durationMs = Date.now() - started
    mkdirSync(config.outputDir, { recursive: true })
    writeFileSync(join(config.outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  }
  return report
}

const nativeSessions = tracked => [...tracked.values()].map(agent => ({ id: agent.id,
  parent: agent.session.header.parentSession ?? null, events: agent.session.snapshotEvents() }))
function settlementCounts(sessions) {
  const counts = new Map()
  for (const session of sessions) for (const event of eventsOf(session)) {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'subagent-settled') continue
    const key = JSON.stringify([session.id, event.data.source.senderSessionId])
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** Wait through native asynchronous flush/dispose and the parent's resulting turn.
 * Each newly created activation requires its own delivered notice, including
 * cold reuse of an existing session id and every depth of the descendant tree. */
export async function waitForNativeSettlement({ tracked, rootId, activationCounts, beforeCounts, beforeNotices, isDisposed }) {
  while (!isDisposed()) {
    await Promise.all([...tracked.values()].map(agent => agent.whenIdle()))
    await tick()
    const sessions = nativeSessions(tracked)
    const notices = settlementCounts(sessions)
    const delivered = sessions.filter(s => s.id !== rootId).every(child => {
      const needed = (activationCounts.get(child.id) ?? 0) - (beforeCounts.get(child.id) ?? 0)
      const key = JSON.stringify([child.parent, child.id])
      return needed === 0 || sessions.some(s => s.id === child.parent)
        && (notices.get(key) ?? 0) - (beforeNotices.get(key) ?? 0) >= needed
    })
    if (delivered && [...tracked.values()].every(agent => agent.status === 'idle')) {
      const positions = new Map(sessions.map(s => [s.id, s.events.length]))
      await tick()
      if ([...tracked.values()].every(agent => agent.status === 'idle') && tracked.size === positions.size
        && nativeSessions(tracked).every(s => s.events.length === positions.get(s.id))) return
    }
  }
  fail('unsettled-tree')
}

/** Fixed codes and bounded primitive details only; never copy owner IDs or fact text. */
export function diagnoseModelClosure(tasks, newTaskCount, workerId) {
  const failureCodes = []
  if (newTaskCount !== 1) failureCodes.push('new-task-count')
  if (tasks.some(task => task.status !== 'accepted')) failureCodes.push('task-status')
  if (tasks.some(task => task.owner_session !== workerId)) failureCodes.push('owner-mismatch')
  if (tasks.some(task => task.waived)) failureCodes.push('waiver')
  if (tasks.some(task => task.evidence_policy === 'legacy' && (!count(task.evidence) || task.evidence < 1))) failureCodes.push('legacy-evidence')
  const statuses = ['open', 'claimed', 'submitted', 'accepted', 'rejected', 'cancelled', 'done', 'partial', 'failed']
  return { ok: failureCodes.length === 0, newTaskCount: count(newTaskCount) ? newTaskCount : null,
    taskCount: tasks.length, truncated: tasks.length > 20, failureCodes,
    tasks: tasks.slice(0, 20).map(task => ({ taskId: count(task.id) ? task.id : null,
      status: statuses.includes(task.status) ? task.status : 'unknown', ownerMatches: task.owner_session === workerId,
      evidenceCount: count(task.evidence) ? task.evidence : null, waived: Boolean(task.waived),
      evidencePolicy: ['legacy', 'execution'].includes(task.evidence_policy) ? task.evidence_policy : 'unknown',
      strictVerified: task.strictVerified === true })) }
}

/** Project actual task-store closure metadata without persisting fact content. */
export function observeModelTasks(store, rootId, workspace) {
  const rows = store.handle.prepare('SELECT * FROM task WHERE run_id = ? ORDER BY id').all(rootId)
  return rows.map(row => {
    const facts = store.handle.prepare('SELECT kind, confidence, evidence_path FROM fact WHERE task_id = ? AND run_id = ?').all(row.id, rootId)
    let strictVerified = false
    if (row.evidence_policy === 'execution') {
      try {
        strictExecutionEvidence(store.handle, store.root, row)
        strictVerified = row.verification_command === STRICT_COMMAND && row.verification_cwd === workspace
          && JSON.stringify(JSON.parse(row.verification_files)) === JSON.stringify(STRICT_FILES)
      } catch { /* no verified receipt */ }
    }
    // acceptTask appends the final root decision after transitioning to accepted.
    // Ordinary facts, quoted examples, submit notes and negative waiver language
    // are not waiver evidence. A reopened task uses its latest acceptance audit.
    const acceptance = store.handle.prepare("SELECT statement FROM fact WHERE task_id = ? AND run_id = ? AND kind = 'decision' AND confidence = 'PLAUSIBLE' AND created_by = 'lead' AND (actor_session = ? OR actor_session IS NULL) ORDER BY id DESC LIMIT 1").get(row.id, rootId, rootId)
    const waived = store.handle.prepare('SELECT COUNT(*) AS n FROM execution_waiver WHERE task_id = ? AND run_id = ? AND evidence_generation = ?').get(row.id, rootId, row.evidence_generation).n > 0
      || acceptance?.statement.startsWith('验收通过（人工豁免）：') === true
    return { id: row.id, status: row.status, owner_session: row.owner_session, evidence_policy: row.evidence_policy,
      facts: facts.length, evidence: facts.filter(f => ['CONFIRMED', 'PLAUSIBLE'].includes(f.confidence) && (['fact', 'artifact'].includes(f.kind) || f.evidence_path)).length,
      waived, strictVerified }
  })
}

/** Official profile/registry path only; no custom provider client and no approval bypass. */
export async function createNativeHarness({ installAnchor, packageRoot, workspace, provider, model, onRequest }) {
  const anchor = resolveInstallAnchor({ installAnchor })
  if (installationVersion(anchor) !== '0.2.0-rc.2') fail('host-version')
  const fixture = await controlledProfile(anchor, packageRoot)
  let app, handle
  const tracked = new Map()
  const activationCounts = new Map()
  let disposed = false
  const cancel = () => { for (const agent of tracked.values()) { try { agent.cancel({ kind: 'user' }) } catch { /* continue cancellation of other descendants */ } } }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    const exit = process.exitCode
    const failures = []
    cancel()
    try {
      try { await deadline(() => handle?.dispose(), 10000, cancel) } catch (error) { failures.push(error) }
      try { await deadline(() => app?.shutdown.shutdown(1), 10000, cancel) } catch (error) { failures.push(error) }
    } finally { fixture.dispose(); process.exitCode = exit }
    if (failures.length) throw new AggregateError(failures, 'native cleanup failed')
  }
  try {
    writeFileSync(fixture.overlay, readFileSync(fixture.overlay, 'utf8') + '\n- id: session-title-llm\n  disabled: true\n- id: llm-retry\n  disabled: true\n- id: llm-deepseek\n  config:\n    maxTokens: 4096\n    streamIdleTimeoutMs: 30000\n')
    const { runProfile } = await import(pathToFileURL(join(dirname(anchor), 'lib/profile-boot.js')).href)
    app = await runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web', patchFiles: [fixture.overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
    const { createUserMessage } = await nativeModule(anchor, '@deepseek-ai/dsh-llm')
    const rootId = `taskforce-model-${randomUUID()}`
    app.ctx.on('agent/created', ({ agent }) => {
      tracked.set(agent.id, agent)
      activationCounts.set(agent.id, (activationCounts.get(agent.id) ?? 0) + 1)
    })
    app.ctx.on('agent/request', (payload, next) => {
      onRequest({ agentId: payload.agent.id, turn: payload.turn, step: payload.step })
      return next()
    })
    const registry = app.ctx.get('agentPresets')
    handle = await app.ctx.get('agents').create({ sessionId: rootId, meta: { cwd: workspace },
      agentOptions: { provider, model, maxTokens: 4096 },
      setup: async (ctx, agent) => { await registry.mount(ctx, 'taskforce'); agent.session.append('agent-preset/selected', { agentPreset: 'taskforce' }) } })
    tracked.set(rootId, handle.agent)
    // A reused cold child has the same session id but a fresh Agent. Keep its latest
    // live object; its durable session history contains prior usage and notices.
    const sessions = () => nativeSessions(tracked)
    let settled = true
    async function runStage(stage) {
      settled = false
      const beforeNotices = settlementCounts(sessions())
      const beforeCounts = new Map(activationCounts)
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: stage.prompt }] }))
      await waitForNativeSettlement({ tracked, rootId, activationCounts, beforeCounts, beforeNotices, isDisposed: () => disposed })
      settled = true
    }

    function snapshot() {
      const store = app.ctx.get('taskforceStore')
      const tasks = observeModelTasks(store, rootId, workspace)
      return { sessions: sessions(), tasks, settled }
    }
    return { hostVersion: installationVersion(anchor), rootId, runStage, snapshot, cancel, dispose }
  } catch (error) { try { await dispose() } catch { /* preserve original setup failure */ } throw error }
}

function parseArgs(args) {
  const result = {}
  const flags = { '--install-anchor': 'installAnchor', '--provider': 'provider', '--model': 'model', '--request-cap': 'requestCap', '--stage-timeout-ms': 'stageTimeoutMs', '--output-dir': 'outputDir', '--package-sha256': 'packageSha256' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model-calls') { result.modelCalls = true; continue }
    const key = flags[args[i]]
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new TypeError('Unknown or incomplete model verification option')
    result[key] = ['requestCap', 'stageTimeoutMs'].includes(key) ? Number(args[++i]) : args[++i]
  }
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runModelVerification(parseArgs(process.argv.slice(2)))
    process.stdout.write(JSON.stringify({ ok: report.ok, requests: report.requests, failure: report.failure }) + '\n')
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    // CLI errors never serialize arbitrary native/provider messages.
    process.stderr.write(error instanceof TypeError ? error.message + '\n' : 'Model verification failed\n')
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 1)
}
