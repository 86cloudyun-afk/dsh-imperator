/** Scoped, finite lifecycle metadata; never record prompts, reasoning or error text.
 * Verified hook contracts: agent/request and agent/pre-step waterfalls carry
 * the initiating agent; agent/disposed carries {agent}; turn/end is a durable
 * session record. Disposal alone says nothing about crash or tree quiescence. */
import { readFileSync } from 'node:fs'
import { createScopeMembership } from './scope-membership.mjs'
import { sessionEvents } from './guard.mjs'

const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
export const LIFECYCLE_WINDOW = 256

export function attachRecoveryLifecycle(ctx, services) {
  if (typeof ctx.on !== 'function') return
  const owns = createScopeMembership(ctx)
  let hostVersion = null
  try {
    const metadata = ctx.get?.('pluginPackages')?.packageOf?.('@deepseek-ai/dsh-agent', ctx.baseUrl ?? import.meta.url)
    if (metadata?.name === '@deepseek-ai/dsh-agent' && typeof metadata.manifestPath === 'string') {
      hostVersion = JSON.parse(readFileSync(metadata.manifestPath, 'utf8')).version
    }
  } catch { /* unobserved host version stays null */ }
  const observe = (agent, eventType, payload = {}) => {
    // A standalone context with no preset registry has no authority to observe
    // global agents. Native membership plus explicit preset membership handles
    // switched, unloaded and standard agents before any store access.
    let registry
    try { registry = ctx.get?.('agentPresets') } catch { return }
    if (!registry || typeof registry.composedPreset !== 'function') return
    try {
      if (registry.composedPreset(ctx) === undefined || registry.composedPreset(agent?.ctx) === undefined || owns(agent) !== true) return
    } catch { return }
    const sessionId = agent?.session?.header?.id
    if (typeof sessionId !== 'string' || !sessionId.trim()) return
    let identity
    try { identity = services.identity(agent) } catch { /* direct caller scope only */ }
    const authority = { sessionId, runId: identity?.runId ?? null }
    let recovery
    try { recovery = services.recovery() } catch { return }
    if (typeof recovery?.recordLifecycle !== 'function') return
    const metadata = { node_version: process.version, package_version: packageVersion, host_version: hostVersion }
    try {
      const events = sessionEvents(agent.session)
      const truncated = events.length > LIFECYCLE_WINDOW
      for (const event of events.slice(-LIFECYCLE_WINDOW)) {
        if (!['turn/start', 'turn/end'].includes(event?.type)) continue
        if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
          recovery.observationGaps.add('lifecycle_source_coordinate_unavailable')
          continue
        }
        recovery.recordLifecycle({ ...metadata, event_type: event.type, source: 'session_event',
          event_seq: event.seq, turn: event.data?.turn, reason_kind: event.data?.reason?.kind,
          error_code: event.data?.reason?.kind === 'error' ? event.data.reason.error?.code : undefined,
          window_truncated: truncated }, authority)
      }
      recovery.recordLifecycle({ ...metadata, event_type: eventType, source: 'host_hook',
        turn: payload.turn, step: payload.step, window_truncated: truncated,
        error_code: payload.error?.failure?.code ?? payload.error?.code }, authority)
    } catch (error) {
      recovery.observationGaps.add(error?.code === 'E_RECOVERY_CONFLICT' ? 'lifecycle_history_conflict' : 'lifecycle_write_failed')
      try { ctx.logger?.warn?.('taskforce lifecycle observation unavailable; recovery reports an observation gap') } catch { /* optional */ }
    }
  }
  ctx.on('agent/request', async (payload, next) => {
    try {
      const value = await next()
      observe(payload?.agent, 'request/prepared', payload)
      return value
    } catch (error) {
      observe(payload?.agent, 'request/failed', { ...payload, error })
      throw error
    }
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const value = await next()
    observe(payload?.agent, 'agent/pre-step', payload)
    return value
  })
  ctx.on('agent/disposed', payload => observe(payload?.agent, 'agent/disposed', payload))
  ctx.on('agent/error', payload => observe(payload?.agent, 'agent/error', payload))
}
