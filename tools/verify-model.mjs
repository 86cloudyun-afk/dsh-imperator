#!/usr/bin/env node
/** Opt-in native model evaluation. Importing this module never boots a host or calls a provider. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { types } from 'node:util'
import { controlledProfile, nativeModule, resolveInstallAnchor, installationVersion } from './host-runtime.mjs'
import { MODEL_STAGES, STRICT_COMMAND, STRICT_FILES, writeModelFixture, gradeMoney } from './model-fixtures.mjs'
import { strictExecutionEvidence } from '../lib/store/execution.js'
import { toolEvent } from '../lib/plugins/tool-events.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL_MAX_OUTPUT_TOKENS = 8192
// Compatibility is proved against these pinned releases, never a future range.
const modelHostVersions = new Set(['0.2.0-rc.2', '0.2.1-alpha.2'])
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
// Literal names only: never trust event tool names, session IDs or error text
// as report strings. Unknown native/plugin tools still fail the same gate.
const diagnosticTools = new Set([
  'bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'str_replace_editor', 'working_directory',
  'run_code', 'job_output', 'job_list', 'job_kill', 'skill', 'subagent', 'fork',
  'send_message', 'interrupt_agent', 'list_agents', 'list_subagent_models',
  'todo_write', 'get_goal', 'create_goal', 'update_goal', 'task_child_stop',
  'subagent_fork', 'ask_user_question', 'exit_plan_mode', 'web_search', 'web_fetch',
  'task_open', 'task_claim', 'task_fact', 'task_submit', 'task_verify', 'task_accept',
  'task_reject', 'task_close', 'task_board', 'task_checkpoint', 'task_child_spawn', 'task_child_fork',
  'task_workflow_create', 'task_workflow_submit', 'task_workflow_state',
  'task_child_send', 'task_child_interrupt', 'task_child_list',
])
// rc.2 ToolFailure.info is persisted as event.data.error by AgentLoop and PTC.
// Only public SDK codes: never parse content, reason, messages or class names.
const diagnosticErrorCodes = new Set([
  'INVALID_ARGS', 'UNKNOWN_TOOL', 'INVALID_TOOL_OUTPUT', 'CODE_RUN_FAILED',
  'ABORTED', 'ABORTED_BEFORE_DISPATCH',
  'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR',
  'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED',
])
// Native results omit tool names. Use explicit native coordinates only; the
// session-local map never shares IDs with another session or PTC dispatch.
function nativeDiagnosticKey(event, tool) {
  const { turn, step } = event.data ?? {}
  return !tool?.ptc && count(turn) && count(step) && typeof tool?.callId === 'string' && tool.callId.length > 0
    ? JSON.stringify([turn, step, tool.callId]) : undefined
}
function diagnosticName(event, tool, calls, eventIndex) {
  if (!tool.ptc && event.data?.callId != null && event.data?.message?.source?.callId != null
    && event.data.callId !== event.data.message.source.callId) return null
  const key = nativeDiagnosticKey(event, tool)
  const matched = key === undefined ? undefined : calls.get(key)
  if (matched === null || (matched && matched.eventIndex >= eventIndex)) return null
  const direct = tool.name
  if (event.data?.name !== undefined && event.data?.message?.source?.toolName !== undefined
    && event.data.name !== event.data.message.source.toolName) return null
  if (matched && direct !== undefined && direct !== matched.name) return null
  const name = matched ? matched.name : direct
  return diagnosticTools.has(name) ? name : null
}
const runtimeCategories = ['step-error', 'native-tool-error', 'ptc-tool-error', 'noncompleted-turn',
  'missing-message', 'missing-usage', 'invalid-usage', 'duplicate-message', 'route-mismatch', 'no-requests', 'pending-stream']
const boundaryCategories = ['auxiliary-call', 'stream-attribution', 'capacity-mismatch', 'stream-error', 'stream-admission-error', 'compaction-error']
runtimeCategories.push(...boundaryCategories)
const durableRuntimeCategories = [...runtimeCategories.slice(0, 4), ...boundaryCategories]
const noncompletedReasons = ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']
function accounting(snapshot, requests, route, { before, previousRequests = new Set(), requireRequests = false } = {}) {
  const usage = Object.fromEntries(usageKeys.map(key => [key, 0]))
  const counts = Object.fromEntries(runtimeCategories.map(key => [key, 0]))
  const errorCounts = Object.fromEntries([...diagnosticErrorCodes, 'unknown'].map(key => [key, 0]))
  const details = []
  let detailCount = 0
  const add = (category, location) => {
    counts[category]++
    detailCount++
    if (details.length < 20) details.push({ category, ...location })
  }
  const scopedRequests = new Set([...requests].filter(key => !previousRequests.has(key)))
  const matched = new Set()
  const offsets = new Map(before?.sessions.map(s => [s.id, eventsOf(s).length]) ?? [])
  for (const [sessionIndex, session] of snapshot.sessions.entries()) {
    const nativeCalls = new Map()
    for (const [eventIndex, event] of eventsOf(session).entries()) {
      if (event.type !== 'tool/call') continue
      const tool = toolEvent(event), key = nativeDiagnosticKey(event, tool)
      if (key !== undefined) nativeCalls.set(key, nativeCalls.has(key) ? null : { name: tool.name, eventIndex })
    }
    for (const [eventIndex, event] of eventsOf(session).entries()) {
      if (eventIndex < (offsets.get(session.id) ?? 0)) continue
      const data = event.data
      const location = { sessionIndex, eventIndex, turn: count(data?.turn) ? data.turn : null,
        step: count(data?.step) ? data.step : null }
      const tool = toolEvent(event)
      if (event.type === 'compaction/summary') add('auxiliary-call', location)
      if (event.type === 'compaction/end' && data?.error !== undefined) add('compaction-error', location)
      if (event.type === 'step/error') add('step-error', location)
      if (tool?.phase === 'result' && tool.isError) {
        const toolName = diagnosticName(event, tool, nativeCalls, eventIndex)
        const errorCode = diagnosticErrorCodes.has(data?.error?.code) ? data.error.code : 'unknown'
        errorCounts[errorCode]++
        add(tool.ptc ? 'ptc-tool-error' : 'native-tool-error', {
          ...location, toolName, unknownTool: toolName === null, errorCode,
        })
      }
      if (event.type === 'turn/end' && data?.reason?.kind !== 'completed') add('noncompleted-turn', {
        ...location, reasonKind: noncompletedReasons.includes(data?.reason?.kind) ? data.reason.kind : 'unknown',
      })
      if (event.type !== 'assistant/message') continue
      const key = `${session.id}:${data?.turn}:${data?.step}`
      if (!scopedRequests.has(key)) continue
      if (matched.has(key)) { add('duplicate-message', location); continue }
      matched.add(key)
      if (data.message?.source?.provider !== route.provider || data.message?.source?.model !== route.model) add('route-mismatch', location)
      const value = data.usage
      if (value == null) { add('missing-usage', location); continue }
      if (!count(value.inputTokens) || !count(value.outputTokens)) { add('invalid-usage', location); continue }
      if (usageKeys.some(field => value[field] !== undefined && !count(value[field]))) add('invalid-usage', location)
      for (const field of usageKeys) if (value[field] === undefined || count(value[field])) usage[field] += value[field] ?? 0
    }
  }
  let requestIndex = 0
  for (const key of requests) {
    if (scopedRequests.has(key) && !matched.has(key)) add('missing-message', { requestIndex })
    requestIndex++
  }
  if (snapshot.streamAccounting) {
    // Native consumed-stream usage is authoritative; assistant events above
    // independently verify durable message/route/usage correspondence.
    for (const field of usageKeys) usage[field] = 0
    for (const [requestIndex, record] of snapshot.streamAccounting.records.entries()) {
      if (!scopedRequests.has(record.key)) continue
      if (!record.ended) add('pending-stream', { requestIndex })
      for (const field of usageKeys) if (count(record.usage?.[field])) usage[field] += record.usage[field]
    }
    for (const category of runtimeCategories) {
      const n = (snapshot.streamAccounting.failures[category] ?? 0) - (before?.streamAccounting?.failures[category] ?? 0)
      if (n > 0) {
        counts[category] += n
        detailCount += n
        if (details.length < 20) details.push({ category })
      }
    }
  }
  if (requireRequests && !scopedRequests.size) add('no-requests', {})
  const failureCodes = runtimeCategories.filter(category => counts[category] > 0)
  return { usage, valid: failureCodes.length === 0,
    runtimeDiagnostics: { failureCodes, counts, errorCounts, details, truncated: detailCount > details.length } }
}
/** Unpaid native probes use the same diagnostic projection as model accounting. */
export function diagnoseModelRuntime(snapshot) {
  return accounting(snapshot, new Set(), {}).runtimeDiagnostics
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

const settlementPhases = new Set(['not-started', 'waiting-idle', 'waiting-notices', 'checking-stability', 'settled'])
const settlementCounters = ['trackedAgents', 'idleAgents', 'runningAgents', 'unknownAgents', 'pendingIdleWaits',
  'requiredNotices', 'deliveredNotices', 'missingNotices']
// Diagnostics are synchronous, optional and strictly primitive. Never invoke a
// foreign thenable or getter, await a snapshot, or serialize arbitrary keys.
function discardDiagnosticPromise(value) {
  if (!types.isPromise(value)) return false
  Promise.prototype.then.call(value, () => {}, () => {})
  return true
}
function projectSettlement(value) {
  try {
    if (discardDiagnosticPromise(value)) {
      // A mistaken async hook must not create an unhandled rejection. Use the
      // native method, not an untrusted .then, and never substitute this Promise.
      return null
    }
    if (!value || typeof value !== 'object' || 'then' in value) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== settlementCounters.length + 1 || keys.some(key => key !== 'phase' && !settlementCounters.includes(key))) return null
    const fields = Object.getOwnPropertyDescriptors(value)
    if (!settlementPhases.has(fields.phase?.value) || settlementCounters.some(key => !count(fields[key]?.value))) return null
    return { phase: fields.phase.value, ...Object.fromEntries(settlementCounters.map(key => [key, fields[key].value])) }
  } catch { return null }
}
function settlementProgress(harness, lastRequestElapsedMs) {
  let settlement = null
  try {
    if (typeof harness?.settlementSnapshot === 'function') settlement = projectSettlement(harness.settlementSnapshot())
  } catch { /* diagnostics never change a stage's outcome or cancellation */ }
  return { lastRequestElapsedMs, settlement }
}

const taskTools = ['task_open', 'task_claim', 'task_fact', 'task_submit', 'task_accept', 'task_reject', 'task_close', 'task_board', 'task_child_send', 'task_child_stop', 'task_verify', 'task_checkpoint', 'task_workflow_create', 'task_workflow_submit', 'task_workflow_state']
const taskCodes = ['E_NO_AGENT', 'E_NO_SESSION', 'E_NO_AGENTS_SERVICE', 'E_TERMINAL', 'E_STATUS', 'E_EVIDENCE_MISSING', 'E_BLOCKERS', 'E_TASK_CONFLICT', 'E_CROSS_RUN', 'E_NOT_FOUND', 'E_CHILD_SERVICE', 'E_CHILD_INPUT', 'E_CHILD_NO_AGENT', 'E_CHILD_NOT_OWN', 'E_CHILD_MISSING', 'E_CHILD_SETTLED', 'E_CHILD_NO_ID', 'E_CONTROL_JOURNAL_UNAVAILABLE', 'E_CONTROL_OUTCOME_UNKNOWN', 'UNAUTHORIZED', 'NOT_RESUMABLE', 'ABORTED', 'unknown']
const taskCounters = ['calls', 'nativeResults', 'ptcResults', 'envelopeOk', 'envelopeError', 'transportError', 'unavailableResults']
const taskRoles = ['root', 'worker', 'unknown']
const taskOutcomes = ['envelope-ok', 'envelope-error', 'transport-error', 'unavailable']
const taskFields = ['observedEvents', 'unattributedResults', 'byTool', 'byRole', 'errorCounts', 'details', 'truncated', 'saturated']
const taskDetailFields = ['toolName', 'role', 'presentation', 'outcome', 'errorCode', 'eventIndex']
const taskCounter = value => count(value) && value <= 65535
const taskCoordinate = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && Buffer.byteLength(value, 'utf8') <= 256
const zeroMap = keys => Object.fromEntries(keys.map(key => [key, 0]))
const taskPromise = Promise
const taskPromisePrototype = Promise.prototype
const taskPromiseThen = Promise.prototype.then
const taskPromiseSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get
const taskApply = Reflect.apply
function discardTaskDiagnosticPromise(value) {
  if (types.isProxy(value) || !types.isPromise(value)) return false
  // Native then ignores an own .then getter, but performs SpeciesConstructor.
  // Refuse a foreign constructor/prototype before that can run user code.
  const constructor = Object.getOwnPropertyDescriptor(value, 'constructor')
  const inheritedConstructor = Object.getOwnPropertyDescriptor(taskPromisePrototype, 'constructor')
  const species = Object.getOwnPropertyDescriptor(taskPromise, Symbol.species)
  if (Object.getPrototypeOf(value) === taskPromisePrototype
    && constructor === undefined && inheritedConstructor?.value === taskPromise
    && species?.get === taskPromiseSpecies) {
    taskApply(taskPromiseThen, value, [() => {}, () => {}])
  }
  return true
}
function emptyTaskDiagnostics() {
  return { observedEvents: 0, unattributedResults: 0,
    byTool: Object.fromEntries(taskTools.map(name => [name, zeroMap(taskCounters)])),
    byRole: zeroMap(taskRoles), errorCounts: zeroMap(taskCodes), details: [], truncated: false, saturated: false }
}
// Validate before copying. Data descriptors only; even a Proxy's reflection
// traps and a foreign thenable's getter must remain untouched.
function diagnosticFields(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) return null
  const fields = Object.getOwnPropertyDescriptors(value)
  if (keys.some(key => !Object.hasOwn(fields[key], 'value'))) return null
  return Object.fromEntries(keys.map(key => [key, fields[key].value]))
}
function projectTaskDiagnostics(value) {
  if (types.isProxy(value)) return null
  if (discardTaskDiagnosticPromise(value)) return null
  const fields = diagnosticFields(value, taskFields)
  if (!fields || !taskCounter(fields.observedEvents) || fields.observedEvents > 4096 || !taskCounter(fields.unattributedResults)
    || typeof fields.truncated !== 'boolean' || typeof fields.saturated !== 'boolean') return null
  const byTool = diagnosticFields(fields.byTool, taskTools)
  const byRole = diagnosticFields(fields.byRole, taskRoles)
  const errorCounts = diagnosticFields(fields.errorCounts, taskCodes)
  if (!byTool || !byRole || !errorCounts || [...Object.values(byRole), ...Object.values(errorCounts)].some(n => !taskCounter(n))) return null
  for (const name of taskTools) {
    const row = diagnosticFields(byTool[name], taskCounters)
    if (!row || Object.values(row).some(n => !taskCounter(n))) return null
    if (!fields.saturated && row.nativeResults + row.ptcResults !== row.envelopeOk + row.envelopeError + row.transportError + row.unavailableResults) return null
    byTool[name] = row
  }
  const details = fields.details
  if (!Array.isArray(details) || types.isProxy(details) || Object.getPrototypeOf(details) !== Array.prototype) return null
  const length = Object.getOwnPropertyDescriptor(details, 'length')?.value
  if (!count(length) || length > 20 || Reflect.ownKeys(details).length !== length + 1) return null
  const copied = []
  for (let index = 0; index < length; index++) {
    const item = Object.getOwnPropertyDescriptor(details, String(index))
    if (!item || !Object.hasOwn(item, 'value')) return null
    const detail = diagnosticFields(item.value, taskDetailFields)
    if (!detail || (detail.toolName !== null && !taskTools.includes(detail.toolName)) || !taskRoles.includes(detail.role)
      || !['native', 'ptc'].includes(detail.presentation) || !taskOutcomes.includes(detail.outcome)
      || (detail.errorCode !== null && !taskCodes.includes(detail.errorCode))
      || (detail.eventIndex !== null && !count(detail.eventIndex))) return null
    copied.push(detail)
  }
  return { observedEvents: fields.observedEvents, unattributedResults: fields.unattributedResults,
    byTool, byRole, errorCounts, details: copied, truncated: fields.truncated, saturated: fields.saturated }
}
function taskDiagnosticHook(harness, name) {
  if (!harness || types.isProxy(harness)) return null
  const field = Object.getOwnPropertyDescriptor(harness, name)
  if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'function' || types.isProxy(field.value)) return null
  return taskApply(field.value, harness, [])
}
function beginTaskDiagnostics(harness) {
  try {
    const result = taskDiagnosticHook(harness, 'beginTaskToolDiagnosticsStage')
    return !discardTaskDiagnosticPromise(result) && result === undefined
  } catch { return false }
}
function taskDiagnostics(harness, native) {
  try {
    const value = projectTaskDiagnostics(taskDiagnosticHook(harness, 'taskToolDiagnosticsSnapshot'))
    return value && { source: native ? 'native-own-published-events' : 'custom-harness-unverified', ...value }
  } catch { return null }
}

// Separate exact primitive projection. No legacy diagnostic schema is widened.
const observationPhases = ['stage-end', 'before-cancel', 'final-before-dispose', 'after-dispose']
const observationFailurePhases = ['before-cancel', 'after-cancel', 'during-dispose', 'after-dispose']
const observationKinds = ['call', 'result', 'turn-start', 'turn-end', 'step-start', 'step-end', 'assistant-message', 'notice', 'other', ...runtimeCategories]
const observationStatuses = ['open', 'claimed', 'submitted', 'accepted', 'rejected', 'cancelled', 'done', 'partial', 'failed', 'unknown']
const observationNumber = value => count(value) && !Object.is(value, -0)
const observationNullable = check => value => value === null || check(value)
const observationEnum = values => value => values.includes(value)
const observationBoolean = value => typeof value === 'boolean'
const observationCoordinate = observationNullable(observationNumber)
const observationSlot = observationNullable(value => observationNumber(value) && value < 16)
const observationTime = observationNullable(value => observationNumber(value) && value <= 2147483647)
const observationCount = value => observationNumber(value) && value <= 65535
function observationRecord(value, schema) {
  const fields = diagnosticFields(value, Object.keys(schema))
  if (!fields || Object.entries(schema).some(([key, check]) => !check(fields[key]))) return null
  return fields
}
function observationArray(value, limit, project) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  if (!observationNumber(length) || length > limit || Reflect.ownKeys(value).length !== length + 1) return null
  const result = []
  for (let i = 0; i < length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i))
    if (!field || !Object.hasOwn(field, 'value')) return null
    const row = project(field.value)
    if (!row) return null
    result.push(row)
  }
  return result
}
const observationControlSchema = {
  status: observationNullable(observationEnum(['pending', 'accepted', 'rejected', 'unknown'])),
  durable: observationNullable(observationBoolean), replayed: observationNullable(observationBoolean), targetSlot: observationSlot,
  inboxIdPresent: observationNullable(observationBoolean), mode: observationNullable(observationEnum(['continuable', 'one-shot', 'unknown'])),
  activityBefore: observationNullable(observationEnum(['running', 'inactive', 'unknown'])),
  currentTurn: observationNullable(observationEnum(['running', 'inactive', 'unknown'])), routeReported: value => value === null || value === false,
}
const observationEventSchema = {
  order: observationCount, elapsedMs: observationTime, agentSlot: observationSlot, lifetime: observationCoordinate,
  seq: observationCoordinate, turn: observationCoordinate, step: observationCoordinate, callOrdinal: observationCoordinate,
  requestIndex: observationNullable(value => observationNumber(value) && value < 80), kind: observationEnum(observationKinds),
  toolName: value => value === null || diagnosticTools.has(value), presentation: observationNullable(observationEnum(['native', 'ptc'])),
  outcome: observationNullable(observationEnum(['call', ...taskOutcomes, 'transport-ok'])),
  errorCode: value => value === null || taskCodes.includes(value) || diagnosticErrorCodes.has(value),
  reasonKind: observationNullable(observationEnum(['completed', ...noncompletedReasons, 'unknown'])),
  senderSlot: observationSlot, failurePhase: observationNullable(observationEnum(observationFailurePhases)), control: value => value === null || !!observationRecord(value, observationControlSchema),
}
function projectObservationEvent(value) {
  const row = observationRecord(value, observationEventSchema)
  return row && { ...row, control: row.control === null ? null : observationRecord(row.control, observationControlSchema) }
}
const observationAgentSchema = {
  agentSlot: value => observationNumber(value) && value < 16, parentSlot: observationSlot, role: observationEnum(['root', 'worker']),
  lifetime: value => observationNumber(value) && value < 256, status: observationEnum(['idle', 'running', 'unknown']),
  turn: observationCoordinate, step: observationCoordinate, lastEvent: observationNullable(observationEnum(observationKinds)),
  lastSeq: observationCoordinate, lastElapsedMs: observationTime, requests: observationCount, turnStarts: observationCount, turnEnds: observationCount,
  lastEndReason: observationNullable(observationEnum(['completed', ...noncompletedReasons, 'unknown'])), pendingIdleWaits: observationCount,
  mode: observationEnum(['continuable', 'one-shot', 'unknown']), activations: observationCount,
  requiredNotices: observationCount, deliveredNotices: observationCount, missingNotices: observationCount,
}
const observationRequestSchema = {
  requestIndex: value => observationNumber(value) && value < 80, stageIndex: observationNumber, agentSlot: observationSlot,
  lifetime: observationCoordinate, turn: observationCoordinate, step: observationCoordinate,
  admittedElapsedMs: observationTime, lastChunkElapsedMs: observationTime, chunks: observationCount,
  usageSeen: observationBoolean, finishSeen: observationBoolean, finishKind: observationNullable(observationEnum(['stop', 'tool-calls', 'unknown'])),
  ended: observationBoolean, complete: observationBoolean, assistantMessageSeen: observationBoolean, assistantSeq: observationCoordinate,
  cancelAlreadyRequested: observationBoolean, firstFailure: observationNullable(observationEnum(runtimeCategories)),
  failurePhase: observationNullable(observationEnum(observationFailurePhases)),
}
const observationTaskSchema = {
  taskId: observationCoordinate, status: observationEnum(observationStatuses), ownerSlot: observationSlot, ownerMatches: observationNullable(observationBoolean),
  evidenceCount: observationNullable(observationCount), waived: observationBoolean, evidencePolicy: observationEnum(['legacy', 'execution', 'unknown']), strictVerified: observationBoolean,
}
function projectModelObservations(value) {
  if (types.isProxy(value) || discardTaskDiagnosticPromise(value)) return null
  const fields = diagnosticFields(value, ['stageIndex', 'phase', 'elapsedMs', 'coverage', 'truncated', 'saturated', 'agents', 'requests', 'tasks', 'taskTail', 'ordinaryTail', 'taskDropped', 'ordinaryDropped', 'firstFailure'])
  if (!fields || !observationNumber(fields.stageIndex) || !observationPhases.includes(fields.phase) || !observationTime(fields.elapsedMs)
    || !['complete', 'partial'].includes(fields.coverage) || !observationBoolean(fields.truncated) || !observationBoolean(fields.saturated)
    || !observationCount(fields.taskDropped) || !observationCount(fields.ordinaryDropped)) return null
  const agents = observationArray(fields.agents, 16, row => observationRecord(row, observationAgentSchema))
  const requests = observationArray(fields.requests, 80, row => observationRecord(row, observationRequestSchema))
  const taskTail = observationArray(fields.taskTail, 64, projectObservationEvent), ordinaryTail = observationArray(fields.ordinaryTail, 32, projectObservationEvent)
  const tasks = diagnosticFields(fields.tasks, ['available', 'observedPhase', 'elapsedMs', 'rows', 'truncated'])
  if (!agents || !requests || !taskTail || !ordinaryTail || !tasks || !observationBoolean(tasks.available)
    || ![null, 'snapshot'].includes(tasks.observedPhase) || !observationTime(tasks.elapsedMs) || !observationBoolean(tasks.truncated)) return null
  const rows = observationArray(tasks.rows, 20, row => observationRecord(row, observationTaskSchema))
  const firstFailure = fields.firstFailure === null ? null : projectObservationEvent(fields.firstFailure)
  if (!rows || (fields.firstFailure !== null && !firstFailure)) return null
  if (fields.phase === 'after-dispose' && (agents.length || rows.length || tasks.available || taskTail.length || ordinaryTail.length)) return null
  return { ...fields, agents, requests, tasks: { ...tasks, rows }, taskTail, ordinaryTail, firstFailure }
}
function modelObservationHook(harness, name, args = []) {
  if (!harness || types.isProxy(harness)) return null
  const field = Object.getOwnPropertyDescriptor(harness, name)
  if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'function' || types.isProxy(field.value)) return null
  return taskApply(field.value, harness, args)
}
function modelObservations(harness, native, phase) {
  try {
    const value = projectModelObservations(modelObservationHook(harness, 'modelObservationSnapshot', [phase]))
    return value && value.phase === phase ? { source: native ? 'native-own-published-events' : 'custom-harness-unverified', ...value } : null
  } catch { return null }
}
function observeModelSide(observer, method, ...args) {
  try { observer?.[method]?.(...args) } catch { /* side observations cannot change native control flow */ }
}

// This private cache never queries native state. Owned publication/stream and
// existing settlement/task reads feed it; snapshots only copy primitive rows.
function createModelObservationCache() {
  const agents = [], requests = []
  let stageIndex = 0, started = Date.now(), lifetimes = 0, order = 0, lost = false, partial = false, saturated = false
  let taskTail = [], ordinaryTail = [], taskDropped = 0, ordinaryDropped = 0, firstFailure = null, failurePhase = 'before-cancel'
  const emptyTasks = () => ({ available: false, observedPhase: null, elapsedMs: null, rows: [], truncated: false })
  let tasks = emptyTasks()
  const elapsed = () => { const n = Date.now() - started; if (!observationNumber(n) || n > 2147483647) { partial = true; return null } return n }
  const increment = (row, key) => { if (row[key] === 65535) saturated = partial = true; else row[key]++ }
  const event = (row, values = {}, reserved = false) => {
    const result = { order, elapsedMs: elapsed(), agentSlot: row?.agentSlot ?? null, lifetime: row?.lifetime ?? null,
      seq: null, turn: row?.turn ?? null, step: row?.step ?? null, callOrdinal: null, requestIndex: null,
      kind: 'other', toolName: null, presentation: null, outcome: null, errorCode: null, reasonKind: null,
      senderSlot: null, failurePhase: null, control: null, ...values }
    if (order === 65535) saturated = partial = true; else order++
    const tail = reserved ? taskTail : ordinaryTail, limit = reserved ? 64 : 32
    if (tail.length === limit) { tail.shift(); partial = true; if (reserved) taskDropped = Math.min(65535, taskDropped + 1); else ordinaryDropped = Math.min(65535, ordinaryDropped + 1) }
    tail.push(result)
    if (result.errorCode !== null || ['envelope-error', 'transport-error'].includes(result.outcome) || runtimeCategories.includes(result.kind)
      || result.kind === 'turn-end' && result.reasonKind !== 'completed') {
      result.failurePhase ??= failurePhase
      if (!firstFailure) firstFailure = { ...result }
    }
    return result
  }
  return {
    lost() { lost = true }, partial() { partial = true },
    created(state, previous) {
      if (lifetimes === 256) { partial = true; return null }
      const row = previous?.observationRow ?? { agentSlot: agents.length, parentSlot: null, role: state.role,
        lifetime: 0, status: 'unknown', turn: null, step: null, lastEvent: null, lastSeq: null, lastElapsedMs: null,
        requests: 0, turnStarts: 0, turnEnds: 0, lastEndReason: null, pendingIdleWaits: 0, mode: 'unknown',
        activations: 0, requiredNotices: 0, deliveredNotices: 0, missingNotices: 0 }
      if (!previous?.observationRow) agents.push(row)
      if (row.pendingIdleWaits) partial = true
      row.parentSlot = state.parentRow?.agentSlot ?? null; row.lifetime = lifetimes++; row.status = 'unknown'; row.turn = row.step = null; row.pendingIdleWaits = 0
      return row
    },
    begin(index) {
      if (!observationNumber(index)) { lost = true; return }
      stageIndex = index; started = Date.now(); taskTail = []; ordinaryTail = []; taskDropped = ordinaryDropped = 0; firstFailure = null; tasks = emptyTasks()
      for (const row of agents) { row.requests = row.turnStarts = row.turnEnds = 0; row.lastEvent = row.lastSeq = row.lastElapsedMs = row.lastEndReason = null }
    },
    cancel() { if (failurePhase === 'before-cancel') failurePhase = 'after-cancel' }, disposing() { failurePhase = 'during-dispose' },
    accounting(value) {
      const fields = observationRecord(value, { stable: observationBoolean, mixed: observationBoolean, truncated: observationBoolean,
        missingCount: observationCount, otherFailures: observationBoolean, missing: value => Array.isArray(value) && !types.isProxy(value) })
      const missing = fields && observationArray(fields.missing, 20, row => observationRecord(row, {
        requestIndex: value => observationNumber(value) && value < 80, matchedEnded: observationBoolean }))
      if (!fields || !missing) { partial = true; return }
      if (fields.mixed || !fields.stable) { partial = true; return }
      if (fields.truncated || fields.otherFailures || missing.length !== fields.missingCount) partial = true
      for (const item of missing) {
        const request = requests[item.requestIndex]
        if (!item.matchedEnded || !request?.ended || !request.complete || request.agentSlot === null || request.lifetime === null) { partial = true; continue }
        if (request.firstFailure !== null) continue
        request.firstFailure = 'missing-message'; request.failurePhase = failurePhase
        event(null, { kind: 'missing-message', requestIndex: item.requestIndex, agentSlot: request.agentSlot,
          lifetime: request.lifetime, turn: request.turn, step: request.step, failurePhase })
      }
    },
    publication(row, kind, seq, turn, step, reasonKind = null, senderSlot = null) {
      if (!row) { partial = true; return }
      row.lastEvent = kind; row.lastSeq = seq; row.lastElapsedMs = elapsed(); row.turn = turn; row.step = step
      if (kind === 'turn-start') increment(row, 'turnStarts')
      if (kind === 'turn-end') { increment(row, 'turnEnds'); row.lastEndReason = reasonKind }
      if (kind === 'assistant-message') for (const request of requests) {
        if (request.agentSlot === row.agentSlot && request.lifetime === row.lifetime && request.turn === turn && request.step === step) {
          request.assistantMessageSeen = true; request.assistantSeq = seq
        }
      }
      event(row, { kind, seq, turn, step, reasonKind, senderSlot })
      if (kind === 'turn-end') row.turn = row.step = null
      if (kind === 'step-end') row.step = null
    },
    tool(row, values, reserved) {
      if (row) { row.lastEvent = values.kind; row.lastSeq = values.seq; row.lastElapsedMs = elapsed() }
      return event(row, values, reserved)
    },
    stream(row, data) {
      const request = requests[data.requestIndex]
      if (data.kind === 'admitted') {
        if (data.requestIndex !== requests.length || requests.length === 80) { partial = true; return }
        requests.push({ requestIndex: data.requestIndex, stageIndex, agentSlot: row?.agentSlot ?? null, lifetime: row?.lifetime ?? null,
          turn: observationNumber(data.turn) ? data.turn : null, step: observationNumber(data.step) ? data.step : null,
          admittedElapsedMs: elapsed(), lastChunkElapsedMs: null, chunks: 0, usageSeen: false, finishSeen: false, finishKind: null,
          ended: false, complete: false, assistantMessageSeen: false, assistantSeq: null, cancelAlreadyRequested: failurePhase !== 'before-cancel', firstFailure: null, failurePhase: null })
        if (row) increment(row, 'requests'); else partial = true
      } else if (data.kind === 'failure') {
        if (request && request.firstFailure === null) { request.firstFailure = data.category; request.failurePhase = failurePhase }
        event(row, { kind: data.category, requestIndex: observationNumber(data.requestIndex) ? data.requestIndex : null, turn: data.turn ?? null, step: data.step ?? null, failurePhase })
      } else if (request) {
        if (data.kind === 'chunk') {
          increment(request, 'chunks'); request.lastChunkElapsedMs = elapsed()
          if (data.chunkType === 'usage') request.usageSeen = true
          if (data.chunkType === 'finish') { request.finishSeen = true; request.finishKind = ['stop', 'tool-calls'].includes(data.finishKind) ? data.finishKind : 'unknown' }
        }
        if (data.kind === 'usage') request.usageSeen = true
        if (data.kind === 'finish') { request.finishSeen = true; request.finishKind = ['stop', 'tool-calls'].includes(data.finishKind) ? data.finishKind : 'unknown' }
        if (data.kind === 'ended') { request.ended = true; request.complete = data.complete === true }
      } else partial = true
    },
    snapshot(phase) {
      if (lost || !observationPhases.includes(phase)) return null
      const after = phase === 'after-dispose'
      return projectModelObservations({ stageIndex, phase, elapsedMs: elapsed(), coverage: partial ? 'partial' : 'complete', truncated: partial, saturated,
        agents: after ? [] : agents, requests, tasks: after ? emptyTasks() : tasks, taskTail: after ? [] : taskTail,
        ordinaryTail: after ? [] : ordinaryTail, taskDropped, ordinaryDropped, firstFailure })
    },
    tasks(rows) {
      tasks = { available: true, observedPhase: 'snapshot', elapsedMs: elapsed(), rows: rows.slice(0, 20), truncated: rows.length > 20 }
      for (const row of tasks.rows) if (row.evidenceCount > 65535) { row.evidenceCount = 65535; saturated = partial = true }
    },
    status(row, status) { if (row) row.status = ['idle', 'running'].includes(status) ? status : 'unknown' },
    idle(row, pending) { if (row) row.pendingIdleWaits = pending },
    obligations(row, values) {
      if (!row) return
      row.mode = ['continuable', 'one-shot'].includes(values.mode) ? values.mode : 'unknown'
      for (const key of ['activations', 'requiredNotices', 'deliveredNotices', 'missingNotices']) {
        if (!observationNumber(values[key])) { lost = true; return }
        if (values[key] > 65535) saturated = partial = true
        row[key] = Math.min(65535, values[key])
      }
    },
  }
}

/** Public Session publications only: no history/store reads, arguments or raw text retained. */
export function createTaskToolDiagnosticsCollector({ rootId, agents }) {
  const sessions = new Map(), observation = createModelObservationCache()
  let callOrdinal = 0
  const observe = work => { try { return work() } catch { observation.lost(); return undefined } }
  const observedAgent = agent => {
    const state = sessions.get(agent?.id)
    if (!state || !state.valid || state.agent !== agent) { observation.partial(); return null }
    return state.observationRow
  }
  const reservedTool = name => taskTools.includes(name) || ['subagent', 'fork', 'subagent_fork', 'send_message', 'interrupt_agent', 'task_child_spawn', 'task_child_fork', 'task_child_interrupt', 'task_child_list'].includes(name)
  const observedResult = (state, record, presentation, outcome, errorCode, seq, control = null) => observe(() => observation.tool(state?.observationRow, {
    kind: 'result', seq, turn: record?.turn ?? state?.turn ?? null, step: record?.step ?? state?.step ?? null,
    callOrdinal: record?.callOrdinal ?? null, toolName: diagnosticTools.has(record?.name) ? record.name : null,
    presentation, outcome, errorCode, control }, reservedTool(record?.name)))
  function observedControl(envelope, state) {
    if (!envelope || typeof envelope !== 'object') return null
    const operation = envelope.operation
    const candidates = [operation?.target_id, envelope.sent?.target_id, envelope.target?.id].filter(value => value !== undefined)
    const id = candidates[0], target = taskCoordinate(id) && candidates.every(value => value === id) ? sessions.get(id) : null
    const inbox = operation && Object.hasOwn(operation, 'message_id') ? operation.message_id : envelope.sent?.message_id
    const literal = (value, choices) => choices.includes(value) ? value : null
    return { status: literal(operation?.status, ['pending', 'accepted', 'rejected', 'unknown']),
      durable: typeof operation?.durable === 'boolean' ? operation.durable : null, replayed: typeof operation?.replayed === 'boolean' ? operation.replayed : null,
      targetSlot: target?.valid && target.parent === state.id ? target.observationRow?.agentSlot ?? null : null,
      inboxIdPresent: inbox === undefined ? null : taskCoordinate(inbox), mode: literal(envelope.target?.mode, ['continuable', 'one-shot', 'unknown']),
      activityBefore: literal(envelope.target?.activity_before, ['running', 'inactive', 'unknown']), currentTurn: literal(envelope.target?.current_turn, ['running', 'inactive', 'unknown']),
      routeReported: envelope.route?.reported === false ? false : null }
  }
  let report = emptyTaskDiagnostics(), unavailable = false, limitedSessions = false, associations = 0, stageCursor = 0, decodedBytes = 0
  const increment = (object, key) => {
    if (object[key] === 65535) report.saturated = true
    else object[key]++
  }
  const detail = (record, presentation, outcome, errorCode, seq) => {
    if (report.details.length === 20) { report.truncated = true; return }
    report.details.push({ toolName: record?.toolName ?? null, role: record?.role ?? 'unknown', presentation, outcome, errorCode,
      eventIndex: count(seq) ? seq : null })
  }
  const unattributed = (presentation, seq) => {
    increment(report, 'unattributedResults'); detail(null, presentation, 'unavailable', null, seq)
  }
  const invalidate = state => { if (state) state.valid = false; unavailable = true; observation.lost() }
  function clearCalls(state) { associations -= state.calls.size + state.ptc.size; state.calls.clear(); state.ptc.clear() }
  function created(session) {
    try {
      if (!session || types.isProxy(session) || !taskCoordinate(session.id)) return
      const id = session.id, prior = sessions.get(id), agent = agents.get(id)
      const parent = session.header?.parentSession ?? null
      const parentState = sessions.get(parent)
      if (id !== rootId && !parentState) return
      if (!agent || agent.session !== session || agent.id !== id || session.header?.id !== id
        || (id === rootId ? parent !== null : !parentState.valid || parentState.closed || agents.get(parent)?.session !== parentState.session)
        || !count(session.inheritedEventCount) || !count(session.seq) || session.seq < session.inheritedEventCount
        || typeof session.isOwnSeq !== 'function') { invalidate(prior); return }
      if (prior) {
        if (!prior.closed || prior.parent !== parent || prior.cut !== session.inheritedEventCount || session.seq < prior.next) { invalidate(prior); return }
        // A cold lifecycle can add unpublished seed/setup suffixes. None of
        // its unresolved prior calls is evidence for a newly published result.
        clearCalls(prior)
      } else if (sessions.size === 16) { limitedSessions = true; report.truncated = true; observation.partial(); return }
      const state = { id, session, agent, parent, cut: session.inheritedEventCount, next: session.seq,
        valid: prior?.valid ?? true, closed: false, role: id === rootId ? 'root' : 'worker', calls: new Map(), ptc: new Map(), turn: null, step: null }
      sessions.set(id, state)
      state.observationRow = observe(() => observation.created({ role: state.role, parentRow: parentState?.observationRow }, prior))
    } catch { unavailable = true; observation.lost() }
  }
  function disposed(session) {
    try { const state = sessions.get(session?.id); if (state?.session === session) state.closed = true } catch { unavailable = true; observation.lost() }
  }
  const callKey = (turn, step, id) => count(turn) && count(step) && taskCoordinate(id) ? JSON.stringify([turn, step, id]) : null
  function retain(map, key, record) {
    if (map.has(key)) { map.get(key).ambiguous = true; return }
    if (associations === 4096) { report.truncated = true; observation.partial(); return }
    associations++; map.set(key, record)
  }
  function recordCall(state, map, key, name, seq, extra = {}) {
    const toolName = taskTools.includes(name) ? name : null
    if (toolName) { increment(report.byTool[toolName], 'calls'); increment(report.byRole, state.role) }
    if (key === null || !taskCoordinate(name)) return
    const ordinal = callOrdinal < 4096 ? callOrdinal++ : null
    if (ordinal === null) observation.partial()
    retain(map, key, { toolName, name, role: state.role, seq, stageCursor, resolved: false, ambiguous: false,
      turn: state.turn, step: state.step, callOrdinal: ordinal, ...extra })
    observe(() => observation.tool(state.observationRow, { kind: 'call', seq, turn: extra.turn ?? state.turn, step: extra.step ?? state.step, callOrdinal: ordinal,
      toolName: diagnosticTools.has(name) ? name : null, presentation: map === state.ptc ? 'ptc' : 'native', outcome: 'call' }, reservedTool(name)))
  }
  function result(state, record, presentation, data, seq, budget, eventData = data) {
    if (!record || record.ambiguous || record.resolved) { unattributed(presentation, seq); if (budget) observedResult(state, null, presentation, 'unavailable', null, seq); return }
    record.resolved = true
    const transportCode = budget && data?.isError === true
      ? observe(() => diagnosticErrorCodes.has(eventData?.error?.code) ? eventData.error.code : 'unknown') ?? null : null
    if (!record.toolName) {
      if (record.name !== 'run_code') unattributed(presentation, seq)
      if (budget) observedResult(state, record, presentation, data?.isError === true ? 'transport-error' : data?.isError === false ? 'transport-ok' : 'unavailable', transportCode, seq)
      return // The native run_code wrapper is never another TaskForce outcome.
    }
    const row = report.byTool[record.toolName]
    increment(row, presentation === 'native' ? 'nativeResults' : 'ptcResults')
    let outcome = 'unavailable', errorCode = null, decodedEnvelope = null
    if (budget && data?.isError === true) outcome = 'transport-error'
    else if (budget && data?.isError === false) {
      const content = data.content
      if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') {
        const text = content[0].text
        if (text.length > 65536) report.truncated = true
        else {
          const bytes = Buffer.byteLength(text, 'utf8')
          if (bytes > 65536 || bytes + decodedBytes > 2097152) report.truncated = true
          else {
            decodedBytes += bytes
            try {
              const envelope = JSON.parse(text)
              if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && Object.hasOwn(envelope, 'ok') && typeof envelope.ok === 'boolean') {
                decodedEnvelope = envelope
                outcome = envelope.ok ? 'envelope-ok' : 'envelope-error'
                if (!envelope.ok) { errorCode = Object.hasOwn(envelope, 'code') && taskCodes.includes(envelope.code) ? envelope.code : 'unknown'; increment(report.errorCounts, errorCode) }
              }
            } catch { /* associated but undecodable */ }
          }
        }
      }
    }
    increment(row, { 'envelope-ok': 'envelopeOk', 'envelope-error': 'envelopeError', 'transport-error': 'transportError', unavailable: 'unavailableResults' }[outcome])
    detail(record, presentation, outcome, errorCode, seq)
    if (budget) observe(() => observedResult(state, record, presentation, outcome, outcome === 'transport-error' ? transportCode : errorCode, seq,
      ['task_child_send', 'task_child_stop'].includes(record.name) ? observedControl(decodedEnvelope, state) : null))
  }
  function published(session, event) {
    let state
    try {
      state = sessions.get(session?.id)
      if (!state) {
        // Beyond the session budget no authority/coordinates are retained.
        // A public result from a further registered direct descendant can
        // only be unavailable; it cannot silently look like full coverage.
        if (limitedSessions && sessions.has(session?.header?.parentSession) && agents.get(session.id)?.session === session
          && (event?.type === 'tool/result' || event?.type === 'tool/ptc-dispatch')) {
          unattributed(event.type === 'tool/result' ? 'native' : 'ptc', event.seq)
        }
        return
      }
      if (!state.valid || state.closed || state.session !== session || agents.get(session.id) !== state.agent
        || state.agent.session !== session || (session.header?.parentSession ?? null) !== state.parent
        || session.inheritedEventCount !== state.cut || !count(event?.seq) || event.seq !== state.next
        || session.seq !== event.seq + 1 || session.isOwnSeq(event.seq) !== true) { invalidate(state); return }
      state.next++
      const budget = report.observedEvents < 4096
      if (budget) increment(report, 'observedEvents'); else { report.truncated = true; observation.partial() }
      const data = event.data
      const observedTurn = count(data?.turn) ? data.turn : state.turn, observedStep = count(data?.step) ? data.step : state.step
      if (event.type === 'turn/start') { state.turn = count(data?.turn) ? data.turn : null; state.step = null }
      if (event.type === 'step/start') { state.turn = count(data?.turn) ? data.turn : null; state.step = count(data?.step) ? data.step : null }
      if (event.type === 'step/end' || event.type === 'turn/end') state.step = null
      if (event.type === 'turn/end') state.turn = null
      if (budget && !['tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type)) observe(() => {
        const kinds = { 'turn/start': 'turn-start', 'turn/end': 'turn-end', 'step/start': 'step-start', 'step/end': 'step-end', 'assistant/message': 'assistant-message',
          'step/error': 'step-error', 'compaction/summary': 'auxiliary-call' }
        const notice = event.type === 'user/message' && data?.source?.kind === 'subagent-settled'
        const sender = notice ? sessions.get(data.source.senderSessionId) : null
        const reason = event.type === 'turn/end' ? ['completed', ...noncompletedReasons].includes(data?.reason?.kind) ? data.reason.kind : 'unknown' : null
        const kind = event.type === 'compaction/end' && data?.error !== undefined ? 'compaction-error' : kinds[event.type] ?? 'other'
        observation.publication(state.observationRow, notice ? 'notice' : kind, event.seq, observedTurn, observedStep, reason,
          sender?.valid && sender.parent === state.id ? sender.observationRow?.agentSlot ?? null : null)
      })
      if (event.type === 'tool/call') {
        if (budget) recordCall(state, state.calls, callKey(data?.turn, data?.step, data?.callId), data?.name, event.seq, { turn: data?.turn, step: data?.step })
        return
      }
      if (event.type === 'tool/result') {
        const message = data?.message, source = message?.source
        const key = callKey(data?.turn, data?.step, source?.callId), record = state.calls.get(key)
        if (!record || source?.kind !== 'tool' || message?.toolCallId !== source.callId
          || data.callId !== undefined && data.callId !== source.callId
          || data.name !== undefined && data.name !== record.name
          || source.toolName !== undefined && source.toolName !== record.name
          || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== record.seq || record.seq >= event.seq) {
          unattributed('native', event.seq); if (budget) observedResult(state, null, 'native', 'unavailable', null, event.seq); return
        }
        result(state, record, 'native', message, event.seq, budget, data); return
      }
      if (event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') return
      const isResult = event.type === 'tool/ptc-dispatch'
      const rootKey = callKey(state.turn, state.step, data?.rootCallId), root = state.calls.get(rootKey)
      if (!root || root.ambiguous || root.resolved || !taskCoordinate(data?.parentCallId) || !taskCoordinate(data?.subCallId) || !taskCoordinate(data?.name)
        || data.turn !== undefined && data.turn !== state.turn || data.step !== undefined && data.step !== state.step) {
        if (isResult) unattributed('ptc', event.seq); return
      }
      const key = JSON.stringify([root.seq, state.turn, state.step, data.rootCallId, data.parentCallId, data.subCallId])
      if (isResult) {
        const record = state.ptc.get(key)
        if (record?.name !== data.name) unattributed('ptc', event.seq)
        else result(state, record, 'ptc', data, event.seq, budget)
        return
      }
      let parentValid = data.parentCallId === data.rootCallId
      if (!parentValid) {
        let matches = 0
        for (const row of state.ptc.values()) if (row.rootSeq === root.seq && row.subCallId === data.parentCallId && !row.ambiguous && !row.resolved) matches++
        parentValid = matches === 1
      }
      if (budget && parentValid) recordCall(state, state.ptc, key, data.name, event.seq, { rootSeq: root.seq, subCallId: data.subCallId })
    } catch { invalidate(state) }
  }
  return { created, disposed, published,
    beginObservations(index) { observe(() => observation.begin(index)) },
    observationSnapshot(phase = 'stage-end') { return observe(() => observation.snapshot(phase)) ?? null },
    noteCancel() { observe(() => observation.cancel()) }, noteDisposing() { observe(() => observation.disposing()) },
    observationUnavailable() { observe(() => observation.partial()) },
    observeAccounting(value) { observe(() => observation.accounting(value)) },
    observeStream(data) { observe(() => observation.stream(observedAgent(data.agent), data)) },
    observeStatus(agent, status) { observe(() => observation.status(observedAgent(agent), status)) },
    observeIdle(agent, pending) { observe(() => observation.idle(observedAgent(agent), pending)) },
    observeObligations(agent, values) { observe(() => observation.obligations(observedAgent(agent), values)) },
    observeTasks(rows) { observe(() => {
      const workers = [...sessions.values()].filter(state => state.valid && state.parent === rootId)
      observation.tasks(rows.slice(0, 21).map(task => ({ taskId: count(task.id) ? task.id : null, status: observationStatuses.includes(task.status) ? task.status : 'unknown',
        ownerSlot: sessions.get(task.owner_session)?.valid ? sessions.get(task.owner_session).observationRow?.agentSlot ?? null : null,
        ownerMatches: workers.length === 1 ? task.owner_session === workers[0].id : null, evidenceCount: count(task.evidence) ? task.evidence : null,
        waived: task.waived === true, evidencePolicy: ['legacy', 'execution'].includes(task.evidence_policy) ? task.evidence_policy : 'unknown', strictVerified: task.strictVerified === true })))
    }) },
    // Reset counters, never revive coverage lost before a Session was retained.
    beginStage() { report = emptyTaskDiagnostics(); report.truncated = limitedSessions; decodedBytes = 0; stageCursor++ },
    snapshot() { try { return unavailable ? null : projectTaskDiagnostics(report) } catch { return null } },
  }
}

/** The optional second argument is an offline harness dependency seam, never a CLI option. */
export async function runModelVerification(options = {}, { createHarness = createNativeHarness } = {}) {
  const config = validate(options)
  const started = Date.now()
  const requests = new Set()
  let harness, stopped = false, capHit = false, runtimeStopped = false, workerId
  let stageRecord, stageStart, stageRequestStart = 0, stageUsageStart, stageBefore, stagePreviousRequests
  let lastRequestElapsedMs = null, stageTaskDiagnosticsReady = false, stageObservationsReady = false
  const readObservations = phase => stageObservationsReady ? modelObservations(harness, createHarness === createNativeHarness, phase) : null
  const readTaskDiagnostics = () => stageTaskDiagnosticsReady ? taskDiagnostics(harness, createHarness === createNativeHarness) : null
  const report = { ok: false, provenance: {
    packageVersion: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    gitCommit: null, sourceSha256: productFingerprint(), packageSha256: config.packageSha256 ?? null,
    hostVersion: null, nodeVersion: process.version, provider: config.provider, model: config.model,
  }, requestCap: config.requestCap, stageTimeoutMs: config.stageTimeoutMs, requests: 0,
  outputCapacity: { configuredMaxTokens: MODEL_MAX_OUTPUT_TOKENS,
    source: createHarness === createNativeHarness ? 'native-stream-boundary' : 'custom-harness-unverified' },
  auxiliaryPolicy: 'reject-before-dispatch',
  usage: Object.fromEntries(usageKeys.map(key => [key, 0])), durationMs: 0, stages: [], failure: null }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 })
  if (git.status === 0 && /^[0-9a-f]{40}$/.test(git.stdout.trim())) report.provenance.gitCommit = git.stdout.trim()
  const workspace = mkdtempSync(join(tmpdir(), 'taskforce-model-work-'))
  const onRequest = ({ agentId, turn, step }) => {
    if (stopped) fail('stopped')
    // A different agent may still have an in-flight request with no usage yet.
    // Only durable failures stop admission; pending concurrent streams do not.
    if (harness) {
      const { runtimeDiagnostics } = accounting(safeSnapshot(harness), requests, config)
      if (durableRuntimeCategories.some(category => runtimeDiagnostics.counts[category] > 0)) {
        runtimeStopped = true; stopped = true; harness.cancel(); fail('usage-or-runtime-error')
      }
    }
    if (requests.size >= config.requestCap) { capHit = true; stopped = true; harness?.cancel(); fail('request-cap') }
    const key = `${agentId}:${turn}:${step}`
    if (requests.has(key)) { stopped = true; fail('duplicate-request') }
    requests.add(key)
    if (stageRecord) lastRequestElapsedMs = Math.max(0, Date.now() - stageStart)
  }
  function recordObservation(after, observationPhase = 'stage-end') {
    const total = accounting(after, requests, config)
    report.usage = total.usage
    report.runtimeDiagnostics = total.runtimeDiagnostics
    if (!stageRecord) return { total }
    // Only an existing fresh stable boundary can prove absent correspondence.
    // onRequest accounting and retained-session/late-stream joins cannot do so.
    try {
      const keys = [...requests]
      const result = modelObservationHook(harness, 'observeModelAccounting', [{
        stable: after.settled === true, mixed: observationPhase === null, truncated: total.runtimeDiagnostics.truncated,
        missingCount: total.runtimeDiagnostics.counts['missing-message'],
        otherFailures: total.runtimeDiagnostics.failureCodes.some(category => category !== 'missing-message'),
        missing: total.runtimeDiagnostics.details.filter(row => row.category === 'missing-message').map(row => {
          const record = after.streamAccounting?.records[row.requestIndex]
          return { requestIndex: row.requestIndex, matchedEnded: record?.ended === true && record.complete === true && record.key === keys[row.requestIndex] }
        }),
      }])
      if (discardTaskDiagnosticPromise(result) || result !== undefined && result !== null) stageObservationsReady = false
    } catch { stageObservationsReady = false }
    stageRecord.progress = settlementProgress(harness, lastRequestElapsedMs)
    stageRecord.taskToolDiagnostics = readTaskDiagnostics()
    if (observationPhase !== null) stageRecord.observations = readObservations(observationPhase)
    const workers = after.sessions.filter(s => s.id !== harness.rootId)
    const newWorkers = workers.filter(s => !stageBefore.sessions.some(old => old.id === s.id)).length
    const newTasks = after.tasks.filter(t => !stageBefore.tasks.some(old => old.id === t.id))
    // Observation only: repair has not established authoritative workerId yet.
    const reuseWorker = stageRecord.name === 'repair'
      ? workers.length === 1 && typeof workers[0].id === 'string' && workers[0].id.length > 0 && workers[0].parent === harness.rootId ? workers[0].id : undefined
      : workerId
    const reuseCalls = calls(after, 'task_child_send').slice(calls(stageBefore, 'task_child_send').length)
    const reuse = reuseCalls.filter(e => {
      try { const args = typeof e.data.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments; return reuseWorker !== undefined && args?.target_id === reuseWorker } catch { return false }
    }).length
    const rework = calls(after, 'task_reject').length - calls(stageBefore, 'task_reject').length
    Object.assign(stageRecord, { requests: requests.size - stageRequestStart, durationMs: Date.now() - stageStart,
      usage: Object.fromEntries(usageKeys.map(key => [key, total.usage[key] - stageUsageStart[key]])), newWorkers, reuse, rework,
      facts: newTasks.reduce((n, task) => n + (count(task.facts) ? task.facts : 0), 0), accepted: newTasks.filter(t => t.status === 'accepted').length,
      runtimeDiagnostics: accounting(after, requests, config, { before: stageBefore, previousRequests: stagePreviousRequests, requireRequests: true }).runtimeDiagnostics })
    if (stageRecord.name !== 'readonly') {
      const observedWorker = stageRecord.name === 'repair' && workers.length === 1 && workers[0].parent === harness.rootId ? workers[0].id : workerId
      stageRecord.closure = diagnoseModelClosure(after.tasks, newTasks.length, observedWorker)
    }
    return { total, workers, newWorkers, newTasks, reuse }
  }
  try {
    writeModelFixture(workspace)
    harness = await createHarness({ ...config, workspace, packageRoot: ROOT, onRequest, onFailure: () => { runtimeStopped = true; stopped = true; harness?.cancel() } })
    report.provenance.hostVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(harness.hostVersion) ? harness.hostVersion : null
    if (!modelHostVersions.has(report.provenance.hostVersion)) fail('host-version')
    for (const stage of MODEL_STAGES) {
      const before = safeSnapshot(harness)
      const beforeRequests = requests.size
      const beforeRequestKeys = new Set(requests)
      const beforeUsage = accounting(before, requests, config).usage
      stageBefore = before
      stagePreviousRequests = beforeRequestKeys
      const beforeFiles = workspaceFingerprint(workspace)
      stageStart = Date.now()
      stageRequestStart = beforeRequests
      stageUsageStart = beforeUsage
      lastRequestElapsedMs = null
      stageTaskDiagnosticsReady = beginTaskDiagnostics(harness)
      try {
        const begun = modelObservationHook(harness, 'beginModelObservationStage', [report.stages.length])
        stageObservationsReady = !discardTaskDiagnosticPromise(begun) && begun === undefined
      } catch { stageObservationsReady = false }
      stageRecord = { name: stage.name, ok: false, requests: 0, usage: Object.fromEntries(usageKeys.map(key => [key, 0])), durationMs: 0, newWorkers: 0, reuse: 0, rework: 0, facts: 0, accepted: 0, independentChecks: 0, strictVerified: false, progress: settlementProgress(harness, lastRequestElapsedMs), timeoutProgress: null, taskToolDiagnostics: readTaskDiagnostics(), timeoutTaskToolDiagnostics: null, observations: null, timeoutObservations: null, postDisposeObservations: null }
      report.stages.push(stageRecord)
      await deadline(() => harness.runStage(stage), config.stageTimeoutMs, () => {
        // Capture a fresh primitive copy before cancellation mutates native state.
        try {
          stageRecord.timeoutProgress = settlementProgress(harness, lastRequestElapsedMs)
          stageRecord.timeoutTaskToolDiagnostics = readTaskDiagnostics()
          stageRecord.timeoutObservations = readObservations('before-cancel')
        }
        finally { stopped = true; harness.cancel() }
      })
      const after = safeSnapshot(harness)
      const { total, workers, newWorkers, newTasks, reuse } = recordObservation(after)
      if (capHit) fail('request-cap')
      if (runtimeStopped || !total.valid || requests.size === beforeRequests) fail('usage-or-runtime-error')
      if (after.settled !== true) fail('unsettled-tree')
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
        if (!stageRecord.closure.ok) fail('incomplete-acceptance')
        if (stage.name !== 'strict' && newTasks[0].evidence_policy !== 'legacy') fail('evidence-policy')
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
    report.failure = capHit ? 'request-cap' : runtimeStopped ? 'usage-or-runtime-error' : ['timeout', 'request-cap', 'duplicate-request', 'host-version', 'usage-or-runtime-error', 'unsettled-tree', 'readonly-contract', 'repair-worker-count', 'reuse-contract', 'incomplete-acceptance', 'evidence-policy', 'strict-receipt', 'independent-tests', 'invalid-observation'].includes(error?.verificationCode) ? error.verificationCode : 'runtime-error'
  } finally {
    stopped = true
    let finalSnapshot
    if (harness) {
      try { finalSnapshot = safeSnapshot(harness); recordObservation(finalSnapshot, 'final-before-dispose') } catch { /* retain last confirmed counters */ }
    }
    if (stageRecord) {
      stageRecord.progress = settlementProgress(harness, lastRequestElapsedMs)
      stageRecord.taskToolDiagnostics = readTaskDiagnostics()
      stageRecord.observations = readObservations('final-before-dispose')
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
    // Cancellation/disposal drains native iterators after the last session
    // snapshot. Read their bounded counters even after disposable storage is
    // gone, so late known usage is retained without reopening that storage.
    if (finalSnapshot && harness?.streamSnapshot) {
      const durationMs = stageRecord?.durationMs
      try {
        const { total } = recordObservation({ ...finalSnapshot, streamAccounting: harness.streamSnapshot() }, null)
        if (report.ok && (runtimeStopped || !total.valid)) { report.ok = false; report.failure = 'usage-or-runtime-error' }
      } catch { report.ok = false; report.failure = 'invalid-observation' }
      if (stageRecord) stageRecord.durationMs = durationMs
    }
    if (stageRecord) stageRecord.postDisposeObservations = readObservations('after-dispose')
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

/** Current, child-owned SDK identity. A fork prefix and a disposed child scope
 * are not authority; the live host projection remains readable after disposal. */
export function nativeSubagentMode(host, agent) {
  try {
    const projection = host.sessionProjections.snapshot(agent.session, ['subagent'])
    if (!projection || types.isProxy(projection)) return 'unknown'
    const values = Object.getOwnPropertyDescriptor(projection, 'values')?.value
    if (!values || types.isProxy(values)) return 'unknown'
    const identity = Object.getOwnPropertyDescriptor(values, 'subagent')?.value
    if (!identity || types.isProxy(identity)) return 'unknown'
    const mode = Object.getOwnPropertyDescriptor(identity, 'mode')?.value
    const seq = Object.getOwnPropertyDescriptor(identity, 'seq')?.value
    return (mode === 'one-shot' || mode === 'continuable') && count(seq)
      && agent.session.isOwnSeq(seq) === true ? mode : 'unknown'
  } catch { return 'unknown' }
}

// Negative evidence has its own private bounds, independent of report budgets.
const lifecycleCreationLimit = 256
const lifecycleHistoryLimit = 4096
const lifecycleCount = value => count(value) && !Object.is(value, -0)
const lifecycleObject = value => value !== null && typeof value === 'object' && !types.isProxy(value)
const lifecycleId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && Buffer.byteLength(value, 'utf8') <= 256
function lifecycleField(object, key) {
  if (!lifecycleObject(object)) throw new Error('unavailable lifecycle evidence')
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('unavailable lifecycle field')
  return descriptor.value
}
function nativeSessionReader(Session) {
  const prototype = Session.prototype
  const keys = ['id', 'seq', 'isOwnSeq', 'snapshotEvents']
  const descriptors = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]))
  return session => {
    if (!lifecycleObject(session) || Object.getPrototypeOf(session) !== prototype) throw new Error('untrusted Session')
    for (const key of keys) {
      const current = Object.getOwnPropertyDescriptor(prototype, key), original = descriptors[key]
      if (Object.hasOwn(session, key) || !current || !original
        || ['get', 'set', 'value', 'writable', 'enumerable', 'configurable'].some(field => current[field] !== original[field])) throw new Error('changed Session API')
    }
    const header = lifecycleField(session, 'header')
    if (!lifecycleObject(header) || ![Object.prototype, null].includes(Object.getPrototypeOf(header))) throw new Error('invalid Session header')
    const id = lifecycleField(header, 'id'), parent = Object.getOwnPropertyDescriptor(header, 'parentSession')
    if (parent && !Object.hasOwn(parent, 'value')) throw new Error('invalid parent identity')
    const cut = lifecycleField(session, 'inheritedEventCount'), firstLive = lifecycleField(session, 'firstLiveSeq')
    const seq = Reflect.apply(descriptors.seq.get, session, [])
    if (!lifecycleId(id) || (parent?.value != null && !lifecycleId(parent.value))
      || ![cut, firstLive, seq].every(lifecycleCount) || cut > firstLive || firstLive > seq
      || Reflect.apply(descriptors.id.get, session, []) !== id) throw new Error('invalid Session boundary')
    return { id, parent: parent?.value ?? null, header, cut, firstLive, seq,
      isOwn: position => Reflect.apply(descriptors.isOwnSeq.value, session, [position]) === true }
  }
}

/** Private weak lifetimes; the exported constructor is an unpaid boundary-test seam.
 * Only complete public evidence can reject. Unknown evidence never grants success. */
export function createNativeLifecycleTracker({ Session, rootId, tracked, agents, sessions, classifyMode, readCreation }) {
  const readSession = nativeSessionReader(Session), records = new WeakMap(), bySession = new WeakMap()
  let active, stopping = false
  const invalidate = record => { if (record) record.valid = false; else if (active) active.complete = false }
  const lineage = (id, parent) => {
    const visited = new Set([id])
    while (parent !== null && visited.size <= lifecycleCreationLimit) {
      if (visited.has(parent)) return false
      visited.add(parent)
      const agent = tracked.get(parent)
      if (!agent || agents.get(parent) !== agent) return false
      const session = lifecycleField(agent, 'session'), value = readSession(session)
      if (lifecycleField(agent, 'id') !== parent || value.id !== parent || sessions.get(parent) !== session) return false
      if (parent === rootId) return value.parent === null
      parent = value.parent
    }
    return false
  }
  const current = record => {
    if (lifecycleField(record.agent, 'id') !== record.id || lifecycleField(record.agent, 'session') !== record.session) throw new Error('replaced Agent identity')
    const value = readSession(record.session)
    if (value.id !== record.id || value.header !== record.header || value.parent !== record.parent
      || value.cut !== record.cut || value.firstLive !== record.firstLive) throw new Error('changed lifetime identity')
    return value
  }
  async function created(payload) {
    let record
    try {
      const agent = lifecycleField(payload, 'agent')
      if (!lifecycleObject(agent)) throw new Error('invalid Agent')
      record = records.get(agent)
      if (record) { invalidate(record); return }
      const session = lifecycleField(agent, 'session'), value = readSession(session)
      if (value.id === rootId || !active || stopping) return
      if (++active.creations > lifecycleCreationLimit || value.seq > lifecycleHistoryLimit) return
      if (lifecycleField(agent, 'id') !== value.id || agents.get(value.id) !== agent || sessions.get(value.id) !== session
        || !lineage(value.id, value.parent)) return
      const previous = bySession.get(session)
      if (previous) { invalidate(previous); return }
      record = { ...value, agent, session, stage: active, next: value.seq, valid: true, ready: false, started: false, closed: false }
      records.set(agent, record); bySession.set(session, record)
      // The native adapter returns only after releasing its exact live lease.
      // Publications during this await continue advancing this record's cursor.
      const proof = await readCreation(session, value)
      if (!record.valid || record.closed || agents.get(value.id) !== agent || sessions.get(value.id) !== session
        || current(record).seq !== record.next || lifecycleField(proof, 'source') !== 'live'
        || lifecycleField(proof, 'header') !== value.header || lifecycleField(proof, 'inheritedEventCount') !== value.cut
        || lifecycleField(proof, 'cursor') !== value.seq - 1) { invalidate(record); return }
      const events = lifecycleField(proof, 'events')
      if (!Array.isArray(events) || types.isProxy(events) || events.length !== value.seq) { invalidate(record); return }
      for (let seq = 0; seq < value.seq; seq++) {
        const event = lifecycleField(events, String(seq)), type = lifecycleField(event, 'type')
        if (lifecycleField(event, 'seq') !== seq || typeof type !== 'string'
          || (seq >= value.firstLive && value.isOwn(seq) && type === 'turn/start')) { invalidate(record); return }
      }
      record.ready = true
    } catch { invalidate(record) }
    // agent/created is serial; neither evidence nor an observation failure vetoes creation.
  }
  function published(session, event) {
    const record = lifecycleObject(session) ? bySession.get(session) : undefined
    if (!record || !record.valid || record.closed) return
    try {
      const value = current(record), seq = lifecycleField(event, 'seq'), type = lifecycleField(event, 'type')
      if (!lifecycleCount(seq) || typeof type !== 'string' || seq !== record.next || value.seq !== seq + 1
        || sessions.get(record.id) !== session || agents.get(record.id) !== record.agent) { invalidate(record); return }
      record.next++
      if (type === 'turn/start' && seq >= record.firstLive && value.isOwn(seq)) record.started = true
    } catch { invalidate(record) }
  }
  function disposed(payload) {
    let record
    try {
      const agent = lifecycleField(payload, 'agent')
      record = lifecycleObject(agent) ? records.get(agent) : undefined
      if (!record || record.closed) return
      record.closed = true
      if (!record.valid || !record.ready || record.started || stopping || record.stage !== active
        || !active.complete || active.failure || current(record).seq !== record.next
        || agents.get(record.id) !== undefined || sessions.get(record.id) !== record.session
        || tracked.get(record.id) !== agent || !lineage(record.id, record.parent)) return
      if (classifyMode(agent) !== 'continuable') return
      active.failure = Object.assign(new Error('unsettled-tree'), { verificationCode: 'unsettled-tree' })
      active.resolve(active.failure)
    } catch { invalidate(record) }
  }
  return {
    created, published, disposed,
    beginStage() {
      const { promise, resolve } = Promise.withResolvers()
      const token = Object.freeze({ failure: promise })
      active = { token, resolve, creations: 0, complete: true, failure: null }
      return token
    },
    endStage(token) { if (active?.token === token) active = undefined },
    cancel() { stopping = true },
  }
}

// The official mounted service is trusted. Invoke its captured public native
// method, never an arbitrary method/accessor from callback evidence. No cold
// query, projection registration, flush or direct deprecated Session read.
export function nativeCreationReader({ Session, SessionQueryEngine, host, sessions }) {
  const readSession = nativeSessionReader(Session)
  const observe = Object.getOwnPropertyDescriptor(SessionQueryEngine.prototype, 'observeSession').value
  const service = host.get('sessionQuery')
  return async (session, expected) => {
    let lease, release
    try {
      const value = readSession(session)
      if (value.seq > lifecycleHistoryLimit || value.seq !== expected.seq || sessions.get(value.id) !== session) return null
      lease = await Reflect.apply(observe, service, [value.id, { projectionMode: 'none' }])
      release = lifecycleField(lease, Symbol.dispose)
      if (typeof release !== 'function' || types.isProxy(release)) throw new Error('invalid observation release')
      if (lifecycleField(lease, 'source') !== 'live' || lifecycleField(lease, 'header') !== expected.header
        || lifecycleField(lease, 'inheritedEventCount') !== expected.cut || lifecycleField(lease, 'cursor') !== expected.seq - 1
        || sessions.get(value.id) !== session) return null
      readSession(session) // Revalidate the native lazy reader and reject own shadows.
      const events = Object.getOwnPropertyDescriptor(lease, 'events')
      if (typeof events?.get !== 'function' || events.set !== undefined || types.isProxy(events.get)) return null
      return { source: 'live', header: expected.header, inheritedEventCount: expected.cut, cursor: expected.seq - 1,
        events: Reflect.apply(events.get, lease, []) }
    } finally {
      // Native live leases only release this observation. Release failure makes
      // the complete read reject, so certified readiness cannot survive it.
      if (lease !== undefined) {
        release ??= lifecycleField(lease, Symbol.dispose)
        if (typeof release !== 'function' || types.isProxy(release)) throw new Error('invalid observation release')
        Reflect.apply(release, lease, [])
      }
    }
  }
}

// The compatibility seam without a classifier keeps its original all-notice
// contract. The actual native harness always supplies the authoritative reader.
function nativeSettlementObligations({ tracked, rootId, activationCounts, beforeCounts, beforeNotices, classifyMode, observation }, sessions) {
  const notices = settlementCounts(sessions)
  let requiredNotices = 0, deliveredNotices = 0, missingNotices = 0, unknown = false
  for (const child of sessions.filter(session => session.id !== rootId)) {
    const activations = Math.max(0, (activationCounts.get(child.id) ?? 0) - (beforeCounts.get(child.id) ?? 0))
    if (activations === 0) {
      observeModelSide(observation, 'observeObligations', tracked.get(child.id), { mode: 'unknown', activations: 0, requiredNotices: 0, deliveredNotices: 0, missingNotices: 0 })
      continue
    }
    let mode = 'unknown'
    try { mode = classifyMode === undefined ? 'continuable' : classifyMode(tracked.get(child.id)) } catch { /* fail closed */ }
    if (mode !== 'one-shot' && mode !== 'continuable') unknown = true
    const needed = mode === 'one-shot' ? 0 : activations
    const key = JSON.stringify([child.parent, child.id])
    const delivered = sessions.some(session => session.id === child.parent)
      ? Math.min(needed, Math.max(0, (notices.get(key) ?? 0) - (beforeNotices.get(key) ?? 0))) : 0
    requiredNotices += needed
    deliveredNotices += delivered
    missingNotices += needed - delivered
    observeModelSide(observation, 'observeObligations', tracked.get(child.id), { mode, activations, requiredNotices: needed, deliveredNotices: delivered, missingNotices: needed - delivered })
  }
  return { requiredNotices, deliveredNotices, missingNotices, ready: !unknown && missingNotices === 0 }
}

function nativeSettlementSnapshot(config, state) {
  try {
    const { tracked } = config
    const agents = [...tracked.values()], sessions = nativeSessions(tracked)
    const result = { phase: state.phase, trackedAgents: agents.length, idleAgents: 0, runningAgents: 0, unknownAgents: 0,
      pendingIdleWaits: state.pending.size, requiredNotices: 0, deliveredNotices: 0, missingNotices: 0 }
    for (const agent of agents) {
      const status = agent.status
      observeModelSide(config.observation, 'observeStatus', agent, status)
      result[status === 'idle' ? 'idleAgents' : status === 'running' ? 'runningAgents' : 'unknownAgents']++
    }
    const { requiredNotices, deliveredNotices, missingNotices } = nativeSettlementObligations(config, sessions)
    Object.assign(result, { requiredNotices, deliveredNotices, missingNotices })
    const projected = projectSettlement(result)
    if (projected === null) observeModelSide(config.observation, 'observationUnavailable')
    return projected
  } catch { observeModelSide(config.observation, 'observationUnavailable'); return null }
}

/** Wait through native asynchronous flush/dispose and the parent's resulting turn.
 * Continuable activations require their own notice at every depth and on cold
 * reuse. One-shot exemption never removes an Agent from the native idle tree. */
export async function waitForNativeSettlement({ tracked, rootId, activationCounts, beforeCounts, beforeNotices, isDisposed, observe, classifyMode, observation }) {
  const config = { tracked, rootId, activationCounts, beforeCounts, beforeNotices, classifyMode, observation }
  const state = { phase: 'not-started', pending: new Set() }
  const read = () => nativeSettlementSnapshot(config, state)
  const publish = () => { try { discardDiagnosticPromise(observe?.(read)) } catch { /* observation cannot affect waiting */ } }
  const phase = value => { state.phase = value; publish() }
  publish()
  while (!isDisposed()) {
    state.phase = 'waiting-idle'
    const cohort = new Set()
    state.pending = cohort
    await Promise.all([...tracked.values()].map(agent => {
      const original = agent.whenIdle()
      try {
        const token = {}
        cohort.add(token)
        observeModelSide(observation, 'observeIdle', agent, 1)
        const finished = () => {
          try { cohort.delete(token); if (state.pending === cohort) { observeModelSide(observation, 'observeIdle', agent, 0); publish() } } catch { /* side observation only */ }
        }
        Promise.prototype.then.call(original, finished, finished)
        publish()
      } catch { /* preserve the exact native Promise and Promise.all outcome */ }
      return original
    }))
    phase('waiting-notices')
    await tick()
    const sessions = nativeSessions(tracked)
    if (nativeSettlementObligations(config, sessions).ready && [...tracked.values()].every(agent => agent.status === 'idle')) {
      const positions = new Map(sessions.map(s => [s.id, s.events.length]))
      const stableAgents = new Map(tracked), stableCounts = new Map(activationCounts)
      phase('checking-stability')
      await tick()
      const current = nativeSessions(tracked)
      if ([...tracked.values()].every(agent => agent.status === 'idle') && tracked.size === positions.size
        && [...tracked].every(([id, agent]) => agent === stableAgents.get(id) && activationCounts.get(id) === stableCounts.get(id))
        && current.every(s => s.events.length === positions.get(s.id))
        && nativeSettlementObligations(config, current).ready) { phase('settled'); return }
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

/** Controlled fixed-fixture boundary, not a production governor. rc.2 marks
 * exact loop envelopes and resolves prepared config before llm/stream. A native
 * agent/request supplies coordinates and signal, never a request count. Only
 * consumption of its matching branded envelope can consume that admission.
 * Helpers (including the unchanged automatic compactor) fail closed. */
export function createModelStreamBoundary({ tracked, provider, model, isAgentLoopRequest, onRequest, onFailure = () => {}, observe }) {
  const pending = new Map(), records = [], failures = {}
  let stopped = false
  const latch = (category, context = {}) => {
    failures[category] = (failures[category] ?? 0) + 1
    observeModelSide({ observe }, 'observe', { kind: 'failure', category, ...context })
    stopped = true
    onFailure()
  }
  const reject = (category, context) => { latch(category, context); fail('usage-or-runtime-error') }
  return {
    observeRequest(payload) {
      pending.set(payload.agent.id, { agent: payload.agent, turn: payload.turn, step: payload.step, signal: payload.signal })
    },
    intercept(options, next) {
      // Capture the matching lifecycle admission at stream construction. Later
      // requests cannot silently reattribute a delayed/unused lazy iterator.
      const admission = pending.get(options.sessionId)
      return (async function* () {
        const context = { agent: admission?.agent, turn: admission?.turn ?? null, step: admission?.step ?? null, requestIndex: null }
        const note = data => observeModelSide({ observe }, 'observe', { ...context, ...data })
        const refuse = category => reject(category, context)
        if (stopped) fail('usage-or-runtime-error')
        if (!isAgentLoopRequest(options)) refuse('auxiliary-call')
        if (!Object.isFrozen(options) || !admission || pending.get(options.sessionId) !== admission
          || tracked.get(options.sessionId) !== admission.agent || options.signal !== admission.signal
          || !count(admission.turn) || !count(admission.step)) refuse('stream-attribution')
        if (options.provider !== provider || options.model !== model) refuse('route-mismatch')
        if (options.maxTokens !== MODEL_MAX_OUTPUT_TOKENS) refuse('capacity-mismatch')
        if (options.signal?.aborted) refuse('stream-error')
        pending.delete(options.sessionId)
        try { onRequest({ agentId: admission.agent.id, turn: admission.turn, step: admission.step }) }
        catch (error) { latch('stream-admission-error', context); throw error }
        const record = { key: `${admission.agent.id}:${admission.turn}:${admission.step}`, complete: false, ended: false, usage: null }
        context.requestIndex = records.length
        records.push(record)
        note({ kind: 'admitted' })
        let exhausted = false, terminal = false, failed = false
        const bad = category => { failed = true; refuse(category) }
        try {
          for await (const chunk of next()) {
            note({ kind: 'chunk' })
            if (terminal) bad('stream-error')
            if (chunk.type === 'usage') {
              const value = chunk.usage
              if (!value || !count(value.inputTokens) || !count(value.outputTokens)
                || usageKeys.some(field => value[field] !== undefined && !count(value[field]))) bad('invalid-usage')
              // SDK BlockAssembler uses the latest cumulative usage frame.
              note({ kind: 'usage' })
              record.usage = Object.fromEntries(usageKeys.filter(field => value[field] !== undefined).map(field => [field, value[field]]))
            }
            if (chunk.type === 'finish') {
              terminal = true
              const finishKind = chunk.reason?.kind
              note({ kind: 'finish', finishKind: ['stop', 'tool-calls'].includes(finishKind) ? finishKind : 'unknown' })
              if (!['stop', 'tool-calls'].includes(finishKind)) bad('stream-error')
            }
            yield chunk
          }
          exhausted = true
          if (!terminal) bad('stream-error')
          if (!record.usage) bad('missing-usage')
          record.complete = true
        } catch (error) {
          if (!failed) { failed = true; latch('stream-error', context) }
          throw error
        } finally {
          // An early return/abort is not a complete consumed response, even if
          // a caller catches it or already saw a usage or terminal frame.
          record.ended = true
          if (!exhausted && !failed) latch('stream-error', context)
          note({ kind: 'ended', complete: record.complete })
        }
      })()
    },
    snapshot: () => structuredClone({ records, failures }),
  }
}

/** Official profile/registry path only; no custom provider client and no approval bypass. */
export async function createNativeHarness({ installAnchor, packageRoot, workspace, provider, model, onRequest, onFailure }, { inspectNative } = {}) {
  const anchor = resolveInstallAnchor({ installAnchor })
  if (!modelHostVersions.has(installationVersion(anchor))) fail('host-version')
  const fixture = await controlledProfile(anchor, packageRoot)
  const emergency = () => fixture.emergencyDispose()
  process.once('exit', emergency)
  let app, handle, lifecycle, taskCollector
  const tracked = new Map()
  const activationCounts = new Map()
  const settlements = new Set()
  let disposed = false
  const cancel = () => {
    observeModelSide(taskCollector, 'noteCancel')
    lifecycle?.cancel()
    for (const agent of tracked.values()) { try { agent.cancel({ kind: 'user' }) } catch { /* continue cancellation of other descendants */ } }
  }
  const drainSettlements = async () => {
    const failures = []
    for (const work of [...settlements]) {
      await work.completion
      settlements.delete(work)
      if (work.error && work.error.verificationCode !== 'unsettled-tree') failures.push(work.error)
    }
    if (failures.length) throw new AggregateError(failures, 'native settlement cleanup failed')
  }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    const exit = process.exitCode
    const failures = []
    cancel()
    observeModelSide(taskCollector, 'noteDisposing')
    try {
      try {
        await deadline(() => fixture.teardown(async () => {
          const results = await Promise.allSettled([handle?.dispose(), drainSettlements()])
          const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
          if (errors.length) throw new AggregateError(errors, 'native teardown failed')
        }), 10000, cancel)
      } catch (error) { failures.push(error) }
      try {
        await deadline(async () => {
          const results = await Promise.allSettled([fixture.shutdown(1), drainSettlements()])
          const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
          if (errors.length) throw new AggregateError(errors, 'native shutdown failed')
        }, 10000, cancel)
      } catch (error) { failures.push(error) }
    } finally {
      try { fixture.dispose() } catch (error) { failures.push(error) }
      finally {
        if (fixture.isDisposed()) process.off('exit', emergency)
        else fixture.whenDisposed.then(() => process.off('exit', emergency))
        process.exitCode = exit
      }
    }
    if (failures.length) throw new AggregateError(failures, 'native cleanup failed')
  }
  try {
    writeFileSync(fixture.overlay, readFileSync(fixture.overlay, 'utf8') + `\n- id: session-title-llm\n  disabled: true\n- id: llm-retry\n  disabled: true\n- id: llm-deepseek\n  config:\n    maxTokens: ${MODEL_MAX_OUTPUT_TOKENS}\n    streamIdleTimeoutMs: 30000\n`)
    app = await fixture.runProfile({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web', patchFiles: [fixture.overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
    const { createUserMessage, isAgentLoopRequest } = await nativeModule(anchor, '@deepseek-ai/dsh-llm')
    const boundary = createModelStreamBoundary({ tracked, provider, model, isAgentLoopRequest, onRequest, onFailure,
      observe: data => observeModelSide(taskCollector, 'observeStream', data) })
    app.ctx.on('llm/stream', (options, next) => boundary.intercept(options, next), { global: true, prepend: true })
    const rootId = `taskforce-model-${randomUUID()}`
    const { Session } = await nativeModule(anchor, '@deepseek-ai/dsh-session')
    const { SessionQueryEngine } = await nativeModule(anchor, '@deepseek-ai/dsh-session-query')
    const agents = app.ctx.get('agents'), sessionStore = app.ctx.get('sessions')
    const classifyMode = agent => nativeSubagentMode(app.ctx, agent)
    lifecycle = createNativeLifecycleTracker({ Session, rootId, tracked, agents, sessions: sessionStore, classifyMode,
      readCreation: nativeCreationReader({ Session, SessionQueryEngine, host: app.ctx, sessions: sessionStore }) })
    app.ctx.on('agent/created', lifecycle.created, { global: true, prepend: true })
    app.ctx.on('session/event', lifecycle.published, { global: true, prepend: true })
    app.ctx.on('agent/disposed', lifecycle.disposed, { global: true, prepend: true })
    const applicationFiber = app.ctx.fiber
    app.ctx.on('internal/status', fiber => {
      if (fiber === applicationFiber && fiber.state === 5) lifecycle.cancel()
    }, { global: true, prepend: true })
    try {
      taskCollector = createTaskToolDiagnosticsCollector({ rootId, agents: app.ctx.get('agents') })
      app.ctx.on('session/created', taskCollector.created, { global: true, prepend: true })
      app.ctx.on('session/event', taskCollector.published, { global: true, prepend: true })
      app.ctx.on('session/disposed', taskCollector.disposed, { global: true, prepend: true })
    } catch { taskCollector = null } // Diagnostics cannot veto native creation.
    app.ctx.on('agent/created', ({ agent }) => {
      if (agent.id !== rootId && !tracked.has(agent.session.header.parentSession)) return
      tracked.set(agent.id, agent)
      activationCounts.set(agent.id, (activationCounts.get(agent.id) ?? 0) + 1)
    })
    app.ctx.on('agent/request', (payload, next) => {
      boundary.observeRequest(payload)
      return next()
    })
    const registry = app.ctx.get('agentPresets')
    handle = await app.ctx.get('agents').create({ sessionId: rootId, meta: { cwd: workspace },
      agentOptions: { provider, model, maxTokens: MODEL_MAX_OUTPUT_TOKENS },
      setup: async (ctx, agent) => { await registry.mount(ctx, 'taskforce'); agent.session.append('agent-preset/selected', { agentPreset: 'taskforce' }) } })
    tracked.set(rootId, handle.agent)
    // Native unpaid verification seam: inspect SDK wiring or drive genuine
    // lifecycles behind a local stream sentinel. Not exposed by the CLI.
    await inspectNative?.({ ctx: app.ctx, root: handle.agent, handle, shutdown: code => fixture.shutdown(code) })
    // A reused cold child has the same session id but a fresh Agent. Keep its latest
    // live object; its durable session history contains prior usage and notices.
    const sessions = () => nativeSessions(tracked)
    let settled = true
    let settlementSnapshot = () => nativeSettlementSnapshot({ tracked, rootId, activationCounts, classifyMode, beforeCounts: new Map(activationCounts), beforeNotices: settlementCounts(sessions()), observation: taskCollector }, { phase: 'not-started', pending: new Set() })
    async function runStage(stage) {
      settled = false
      const beforeNotices = settlementCounts(sessions())
      const beforeCounts = new Map(activationCounts)
      const token = lifecycle.beginStage()
      let work
      try {
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: stage.prompt }] }))
        const original = waitForNativeSettlement({ tracked, rootId, activationCounts, beforeCounts, beforeNotices, classifyMode, observation: taskCollector, isDisposed: () => disposed, observe: read => { settlementSnapshot = read } })
        work = { early: false, error: null }
        work.completion = original.then(() => {}, error => { work.error = error })
        settlements.add(work)
        const failure = await Promise.race([original, token.failure])
        if (failure) { work.early = true; throw failure }
        settled = true
      } finally {
        lifecycle.endStage(token)
        // An early negative result owns the original waiter until disposal.
        // The normal success/error path already awaited that exact work.
        if (work && !work.early) settlements.delete(work)
      }
    }

    function snapshot() {
      const store = app.ctx.get('taskforceStore')
      const tasks = observeModelTasks(store, rootId, workspace)
      observeModelSide(taskCollector, 'observeTasks', tasks)
      return { sessions: sessions(), tasks, settled, streamAccounting: boundary.snapshot() }
    }
    return { hostVersion: installationVersion(anchor), rootId, runStage, snapshot, settlementSnapshot: () => settlementSnapshot(), streamSnapshot: boundary.snapshot,
      beginModelObservationStage: index => taskCollector?.beginObservations(index),
      modelObservationSnapshot: (phase = 'stage-end') => taskCollector?.observationSnapshot(phase) ?? null,
      observeModelAccounting: value => taskCollector?.observeAccounting(value),
      beginTaskToolDiagnosticsStage: () => taskCollector?.beginStage(), taskToolDiagnosticsSnapshot: () => taskCollector?.snapshot() ?? null, cancel, dispose }
  } catch (error) {
    try { await dispose() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'native setup and cleanup failed') }
    throw error
  }
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
