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
    callId: ptc ? data?.subCallId : data?.callId ?? data?.message?.source?.callId,
    name: data?.name ?? data?.message?.source?.toolName,
    arguments: data?.arguments,
    isError: data?.isError === true || data?.message?.isError === true || data?.error != null,
  }
}

/** Only wrappers with real inner dispatch records are transparent to echo
 * detection. A standalone run_code syntax/runtime failure still counts. */
export function ptcRootCalls(events) {
  return new Set(events.filter(event => event?.type === 'tool/ptc-dispatch-start' || event?.type === 'tool/ptc-dispatch')
    .map(event => event.data?.rootCallId).filter(id => id != null))
}
