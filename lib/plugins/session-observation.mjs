/** Select session-owned activity from an already-read canonical history.
 * The durable fork cut survives restore; firstLiveSeq does not describe ownership.
 * Keep references and native seq values, and never inspect the inherited prefix.
 * Do not cache slices: restored graphs and even outer array slots can be mutable.
 * Visible context/TODO consumers still need the complete canonical history. */
export function ownedSessionEvents(session, events) {
  try {
    const inheritedEventCount = session?.inheritedEventCount
    const cut = inheritedEventCount === undefined ? 0 : inheritedEventCount
    if (Array.isArray(events) && Number.isSafeInteger(cut) && cut >= 0 && cut <= events.length) {
      return { valid: true, inheritedEventCount: cut,
        events: cut === 0 ? events : Array.prototype.slice.call(events, cut) }
    }
  } catch { /* Unreadable ownership/history is unavailable, never root history. */ }
  return { valid: false, inheritedEventCount: undefined, events: [] }
}
