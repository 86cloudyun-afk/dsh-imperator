/** Incremental replay is safe only for immutable JSON event graphs. A frozen
 * array alone is insufficient: DSH restored seeds can contain mutable data. */
export function createEventCursor() {
  const verified = new WeakSet()
  const frozenDataArrays = new WeakSet()
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
      let immutable = true
      const tail = []
      // Read own data slots: even a frozen accessor array can change what it
      // returns. Never certify such a container as an append-only prefix.
      const certified = frozenDataArrays.has(events)
      const slot = i => {
        if (certified) return events[i]
        const descriptor = Object.getOwnPropertyDescriptor(events, String(i))
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Event histories require dense data slots')
        }
        return descriptor.value
      }
      try {
        // Full prefix validation remains O(n), including middle replacements.
        if (!reset) {
          for (let i = 0; i < previous.length; i += 1) {
            if (previous[i] !== slot(i)) { reset = true; break }
          }
        }
        for (let i = reset ? 0 : previous.length; i < events.length; i += 1) {
          const event = slot(i)
          if (!immutableJson(event)) { immutable = false; break }
          const seq = event?.seq
          const prior = tail.length ? tail.at(-1) : reset ? undefined : previous.at(-1)
          const priorSeq = prior?.seq
          // Legacy JSON fixtures may omit seq entirely. If present, retain
          // only contiguous native coordinates, never infer from the last ID.
          if ((seq !== undefined && !Number.isSafeInteger(seq))
            || (i > 0 && (seq !== undefined || priorSeq !== undefined) && seq !== priorSeq + 1)) {
            immutable = false
            break
          }
          tail.push(event)
        }
      } catch { immutable = false }
      if (!immutable) {
        previous = undefined
        return { reset: true, events }
      }
      // Frozen data slots cannot later become accessors. Certification saves
      // repeated descriptor allocation, never the full identity comparison.
      if (!certified) {
        try { if (Object.isFrozen(events)) frozenDataArrays.add(events) } catch { /* optional optimization */ }
      }
      // Keep our private prefix after validation; only append verified new
      // references. The caller's mutable outer array is never retained.
      if (reset) previous = tail
      else for (const event of tail) previous.push(event)
      return { reset, events: reset ? events : tail }
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
