/** Read/preparation ports only. No native dispatch or capability override is exposed. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const VERSIONS = new Set(['0.2.0-rc.2', '0.2.1-alpha.2'])
const CAPABILITIES = [
  ['H01', 'prebound native session identity', 'identity_preparation', 'Creation/publication and durable delivery fences still require complete integration.'],
  ['H02', 'complete managed input admission boundary', null, 'No verified target-side rejecting seam covers all input and descendant creation routes.'],
  ['H03', 'strict durable backend flush and lookup', 'checkpoint_readback', 'A durable prefix checkpoint does not prove terminal outcome or exactly-once delivery.'],
  ['H04', 'subtree and process quiescence proof', null, 'Range-relative waitForExit can select weaker containment; crash recovery requires supervised ownership.'],
  ['H05', 'exclusive owner lock and recovery', null, 'A session writer lock is not a scheduler-domain process ownership lock.'],
  ['H06', 'trusted workspace identity and isolation', null, 'Canonical resource labels and cwd do not enforce workspace isolation.'],
]
function fail(message) { throw Object.assign(new Error(message), { code: 'E_SCHEDULER_CAPABILITY' }) }
function exact(value, label) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 512) fail(label + ' requires a bounded exact identity')
  return value
}
function pinned(version) { if (!VERSIONS.has(version)) fail('unverified DSH version') }
function service(ctx, name) {
  const value = ctx?.get?.(name)
  if (!value) fail('required native service unavailable: ' + name)
  return value
}

/** Information, never an authorization token; arbitrary claims cannot enable a capability. */
export function nativeSchedulerCapabilities({ version } = {}) {
  const pinnedVersion = VERSIONS.has(version)
  return { version: pinnedVersion ? version : null, pinned_version: pinnedVersion, native_enabled: false,
    capabilities: CAPABILITIES.map(([code, capability, helper, reason]) => ({
      code, capability, enabled: false, helper: pinnedVersion ? helper : null, reason,
    })) }
}

/** Capture actual live ancestry before asynchronous preparation. Does not create or send.
 * The caller must recheck the same parent and policy after preparation/publication. */
export function prepareNativeIdentity(ctx, { version, parentAgent, session_id } = {}) {
  pinned(version)
  const agents = service(ctx, 'agents'), reserved = exact(session_id, 'session_id')
  if (typeof agents.get !== 'function' || agents.get(reserved)) fail('reserved session identity is unavailable')
  const seen = new Set()
  let current = parentAgent, depth = 0, root
  const parentId = exact(parentAgent?.id, 'parentAgent.id')
  while (current) {
    const id = exact(current.id, 'agent.id'), header = current.session?.header
    if (!header || header.id !== id || agents.get(id) !== current || seen.has(id)) fail('broken live ancestor identity')
    seen.add(id)
    if (seen.size > 64) fail('ancestor chain exceeds bound')
    const declared = header.delegationDepth
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) fail('invalid durable delegation depth')
    depth = Math.max(depth, (declared ?? 0) + seen.size - 1)
    const parent = header.parentSession
    if (parent === undefined || parent === null) {
      if (header.origin === 'subagent' || (declared ?? 0) > 0) fail('delegated session lacks an actual root ancestor')
      root = id
      break
    }
    exact(parent, 'parentSession')
    current = agents.get(parent)
    if (!current) fail('ancestor is not live')
  }
  if (!root || depth + 1 > 2) fail('verified delegation depth exhausted')
  return Object.freeze({ session_id: reserved, parent_session_id: parentId, root_run_id: root,
    delegation_depth: depth + 1, native_enabled: false })
}

/** Flush the exact live session and expected backend, then compare a raw stored
 * prefix. This is a persistence receipt only, never terminal/quiescence proof.
 * Full-prefix capture is intentionally bounded and fails instead of sampling. */
export async function flushNativeCheckpoint(ctx, { version, session, persistence } = {}) {
  pinned(version)
  const sessions = service(ctx, 'sessions'), backend = service(ctx, 'sessionPersistence')
  const sameBackend = () => {
    const current = service(ctx, 'sessionPersistence')
    return current === backend || (typeof backend.identity === 'symbol' && current.identity === backend.identity)
  }
  if (!(persistence === backend || (typeof backend.identity === 'symbol' && persistence?.identity === backend.identity))
    || typeof backend.open !== 'function' || typeof backend.flush !== 'function') fail('expected durable backend and flush required')
  const id = exact(session?.header?.id, 'session.header.id')
  if (typeof sessions.get !== 'function' || sessions.get(id) !== session || typeof sessions.flush !== 'function') fail('exact live session required')
  if (!Array.isArray(session.events) || session.events.length > 10000) fail('checkpoint event bound exceeded')
  const expectedText = JSON.stringify({ header: session.header, events: session.events })
  if (Buffer.byteLength(expectedText) > 1048576) fail('checkpoint byte bound exceeded')
  const expected = JSON.parse(expectedText)
  if (expected.events.some((event, index) => event.seq !== index)) fail('checkpoint sequence is not contiguous')
  if (await sessions.flush(session) !== true) fail('no successful session durability listener')
  if (!sameBackend()) fail('backend changed during checkpoint')
  await backend.flush()
  if (!sameBackend() || sessions.get(id) !== session) fail('native identity changed during checkpoint')
  const handle = await backend.open(id, 'read')
  try {
    if (handle.id !== id || handle.access !== 'read' || !isDeepStrictEqual(handle.header, expected.header)) fail('raw stored header identity mismatch')
    const raw = await handle.read(0, expected.events.length)
    const events = Array.isArray(raw) ? raw : raw?.events
    if (!Array.isArray(events) || !isDeepStrictEqual(events, expected.events)) fail('raw stored checkpoint does not match the observed prefix')
    if (!sameBackend()) fail('backend changed during readback')
  } finally {
    await handle.close()
  }
  return Object.freeze({ session_id: id, last_seq: expected.events.length - 1, event_count: expected.events.length,
    digest: createHash('sha256').update(expectedText).digest('hex'),
    terminal: false, quiescence_proven: false, native_enabled: false })
}
