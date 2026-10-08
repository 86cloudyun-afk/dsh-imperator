/** Normalize the durable DSH native and PTC records, keeping transport calls
 * distinct from the logical tool calls they contain. No event is mutated. */
export function toolEvent(event) {
  const data = event?.data
  const ptc = event?.type === 'tool/ptc-dispatch-start' || event?.type === 'tool/ptc-dispatch'
  const call = event?.type === 'tool/call' || event?.type === 'tool/ptc-dispatch-start'
  const result = event?.type === 'tool/result' || event?.type === 'tool/ptc-dispatch'
  if (!call && !result) return undefined
  return {
    phase: call ? 'call' : 'result', ptc,
    callId: ptc ? data?.subCallId : (data?.callId != null && data?.message?.source?.callId != null
      && data.callId !== data.message.source.callId ? undefined : data?.callId ?? data?.message?.source?.callId),
    name: data?.name ?? data?.message?.source?.toolName,
    arguments: data?.arguments,
    isError: data?.isError === true || data?.message?.isError === true || data?.error != null,
  }
}

/** Provider call IDs are unique within an execution step, not across the
 * session. Native outcomes retain their original coordinates even when a
 * later step rewrites their content; PTC records inherit the enclosing step.
 * A caller-owned cursor preserves coordinates across fully consumed tails. */
export function* scopedToolEvents(events, cursor = {}) {
  let { turn, step } = cursor
  for (const event of Array.isArray(events) ? events : []) {
    const data = event?.data
    if (event?.type === 'turn/start') {
      turn = data?.turn
      step = undefined
    }
    if (event?.type === 'step/start' || event?.type === 'tool/call') {
      turn = data?.turn ?? turn
      step = data?.step ?? step
    }
    const normalized = toolEvent(event)
    let tool
    if (normalized !== undefined) {
      const coordinates = normalized.ptc ? [turn, step] : [data?.turn ?? turn, data?.step ?? step]
      const key = (id, ptc = normalized.ptc) => typeof id !== 'string' || id.length === 0
        ? undefined : JSON.stringify([ptc ? 'ptc' : 'native', ...coordinates, id])
      tool = { ...normalized, key: key(normalized.callId), rootKey: key(data?.rootCallId, false) }
    }
    yield { event, tool }
    if (event?.type === 'step/end') step = undefined
    if (event?.type === 'turn/end') {
      turn = undefined
      step = undefined
    }
    cursor.turn = turn
    cursor.step = step
  }
}

/** Only wrappers with real inner dispatch records are transparent to echo
 * detection. A standalone run_code syntax/runtime failure still counts. */
export function ptcRootCalls(events) {
  const roots = new Set()
  for (const { tool } of scopedToolEvents(events)) {
    if (tool?.ptc && tool.rootKey !== undefined) roots.add(tool.rootKey)
  }
  return roots
}
