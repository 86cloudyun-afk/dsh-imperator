/** Incremental replay is safe only for immutable JSON event graphs. A frozen
 * array alone is insufficient: DSH restored seeds can contain mutable data. */
export function createEventCursor() {
  const verified = new WeakSet()
  let previous

  const immutableJson = (value, visiting = new WeakSet()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object') return false
    if (verified.has(value)) return true
    if (visiting.has(value) || !Object.isFrozen(value)) return false
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(value)
    // JSON arrays have dense own indices and length, without extra properties.
    if (array && (keys.length !== value.length + 1
      || keys.some(key => key !== 'length' && (typeof key !== 'string'
        || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) return false
    visiting.add(value)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (array && key === 'length') continue
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
        || !immutableJson(descriptor.value, visiting)) return false
    }
    visiting.delete(value)
    verified.add(value)
    return true
  }

  return {
    read(input) {
      const events = Array.isArray(input) ? input : []
      let reset = previous === undefined || events.length < previous.length
      // Every old identity is checked, including the middle. This is O(n),
      // even when the reducer below only needs to process the appended tail.
      if (!reset) {
        for (let i = 0; i < previous.length; i += 1) {
          if (previous[i] !== events[i]) { reset = true; break }
        }
      }
      let immutable = true
      try {
        for (let i = reset ? 0 : previous.length; i < events.length; i += 1) {
          if (!immutableJson(events[i])) { immutable = false; break }
          const seq = events[i]?.seq
          const priorSeq = i === 0 ? undefined : events[i - 1]?.seq
          // Legacy JSON fixtures may omit seq entirely. If present, retain
          // only contiguous native coordinates, never infer from the last ID.
          if ((seq !== undefined && !Number.isSafeInteger(seq))
            || (i > 0 && (seq !== undefined || priorSeq !== undefined) && seq !== priorSeq + 1)) {
            immutable = false
            break
          }
        }
      } catch { immutable = false }
      if (!immutable) {
        previous = undefined
        return { reset: true, events }
      }
      const tail = reset ? events : events.slice(previous.length)
      // Own the prefix array: callers may append, reorder or truncate theirs.
      previous = events.slice()
      return { reset, events: tail }
    },
  }
}

/** Shared replay driver. Counters report reducer input events, not prefix
 * comparisons, JSON certification work, or snapshot computation costs. */
export function createEventProjection(createReducer, policyKey = () => '') {
  let cursor = createEventCursor()
  let reducer
  let policy
  let processedEvents = 0
  return {
    get processedEvents() { return processedEvents },
    read(events) {
      const nextPolicy = policyKey()
      if (nextPolicy !== policy) {
        cursor = createEventCursor()
        policy = nextPolicy
      }
      const update = cursor.read(events)
      if (update.reset) reducer = createReducer()
      reducer.append(update.events)
      processedEvents += update.events.length
      return reducer.snapshot()
    },
  }
}

export { createGuardProjection } from './guard.mjs'
export { createFlowProjection } from './working-context.mjs'
