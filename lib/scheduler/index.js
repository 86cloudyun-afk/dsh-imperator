/** Host-only durable queue. It never creates sessions, sends input, or replays effects. */
import { randomUUID } from 'node:crypto'
import { TaskforceGovernor } from '../governor/index.js'
import { TERMINAL_STATUSES } from '../store/index.js'
import { withReadTransaction, withWriteTransaction } from '../store/sqlite.js'
export { nativeSchedulerCapabilities, prepareNativeIdentity, flushNativeCheckpoint } from './dsh-host.js'

export const SCHEDULER_DDL = `
CREATE TABLE IF NOT EXISTS scheduler_request (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
  request_key TEXT NOT NULL, task_id INTEGER NOT NULL,
  payload TEXT NOT NULL, owner_session TEXT, evidence_generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', reservation_id TEXT UNIQUE,
  refusal_code TEXT, created_at TEXT NOT NULL,
  UNIQUE(run_id, request_key)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue ON scheduler_request(run_id, state, seq);
CREATE TABLE IF NOT EXISTS scheduler_decision (
  run_id TEXT NOT NULL, request_key TEXT NOT NULL,
  actor_session TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, request_key)
);`

function fail(message, code = 'E_SCHEDULER_CONFLICT') { throw Object.assign(new Error(message), { code }) }
function key(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) fail(label + ' must be a bounded nonblank trusted key')
  return value
}
function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(label + ' must be a safe integer')
  return value
}
function fields(input, names) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !names.includes(k))) fail('invalid scheduler input fields')
}
function caller(authority) {
  if (!authority || !['lead', 'worker'].includes(authority.role)) fail('trusted authority required')
  return { role: authority.role, sessionId: key(authority.sessionId, 'authority.sessionId') }
}
function changed(result) { if (Number(result.changes) !== 1) fail('scheduler write did not affect one row') }

export class TaskforceScheduler {
  #store
  #governor
  #initialized = new WeakSet()
  constructor(store) {
    if (!store || typeof store.open !== 'function') throw new TypeError('TaskforceStore required')
    this.#store = store
    this.#governor = new TaskforceGovernor(store)
  }
  #db() {
    const db = this.#store.open()
    if (!this.#initialized.has(db)) {
      withWriteTransaction(db, () => db.exec(SCHEDULER_DDL))
      // An outer transaction can still roll back schema creation.
      if (!db.isTransaction) this.#initialized.add(db)
    }
    return db
  }
  #task(db, id, run, actor, old) {
    const task = db.prepare('SELECT id, run_id, status, owner_session, evidence_generation FROM task WHERE id = ?').get(id)
    if (!task || task.run_id !== run) fail('task is outside the trusted root run')
    if (actor.role !== 'lead' && (task.owner_session !== actor.sessionId || (old && old.owner_session !== actor.sessionId))) fail('current and captured real owner required')
    return task
  }
  #view(db, row) {
    const payload = JSON.parse(row.payload)
    const result = { seq: row.seq, request_id: row.request_id, run_id: row.run_id, task_id: row.task_id,
      generation: payload.generation, state: row.state, mode: payload.mode, kind: payload.kind,
      resource_count: payload.resources.length, reservation_id: row.reservation_id, session_id: null }
    if (row.reservation_id !== null) {
      const reservation = db.prepare('SELECT * FROM governor_reservation WHERE reservation_id = ? AND run_id = ? AND task_id = ?').get(row.reservation_id, row.run_id, row.task_id)
      if (!reservation) fail('scheduler reservation integrity failure')
      result.state = reservation.state
      result.generation = reservation.generation
      result.session_id = reservation.session_id
    }
    if (row.refusal_code !== null) result.code = row.refusal_code
    return result
  }
  enqueue(input, runId, authority) {
    fields(input, ['request_key', 'task_id', 'generation', 'mode', 'kind', 'resources'])
    const run = key(runId, 'runId'), actor = caller(authority), requestKey = key(input.request_key, 'request_key')
    const id = integer(input.task_id, 'task_id', 1), generation = integer(input.generation, 'generation')
    if (!['read', 'write'].includes(input.mode) || !['new', 'reuse', 'retry'].includes(input.kind)) fail('invalid mode or kind')
    if (!Array.isArray(input.resources) || input.resources.length > 64) fail('at most 64 trusted resource keys required')
    const resources = [...new Set(input.resources.map(value => key(value, 'resource', 256)))].sort()
    const payload = JSON.stringify({ task_id: id, generation, mode: input.mode, kind: input.kind, resources })
    const db = this.#db()
    return withWriteTransaction(db, () => {
      const old = db.prepare('SELECT * FROM scheduler_request WHERE run_id = ? AND request_key = ?').get(run, requestKey)
      const task = this.#task(db, id, run, actor, old)
      if (old) {
        if (old.payload !== payload) fail('request key has conflicting content')
        return this.#view(db, old)
      }
      if (TERMINAL_STATUSES.includes(task.status)) fail('cannot queue a terminal task')
      const requestId = randomUUID()
      changed(db.prepare('INSERT INTO scheduler_request(request_id, run_id, request_key, task_id, payload, owner_session, evidence_generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(requestId, run, requestKey, id, payload, task.owner_session, task.evidence_generation, new Date().toISOString()))
      return this.#view(db, db.prepare('SELECT * FROM scheduler_request WHERE request_id = ?').get(requestId))
    })
  }
  admitNext(input, runId, authority) {
    fields(input, ['request_key'])
    const run = key(runId, 'runId'), actor = caller(authority), requestKey = key(input.request_key, 'request_key')
    if (actor.role !== 'lead') fail('queue admission requires trusted lead')
    const db = this.#db()
    return withWriteTransaction(db, () => {
      const prior = db.prepare('SELECT result FROM scheduler_decision WHERE run_id = ? AND request_key = ?').get(run, requestKey)
      if (prior) return { ...JSON.parse(prior.result), replay: true }
      const row = db.prepare("SELECT * FROM scheduler_request WHERE run_id = ? AND state = 'queued' ORDER BY seq LIMIT 1").get(run)
      let result = { status: 'empty' }
      if (row) {
        const task = this.#task(db, row.task_id, run, actor)
        const payload = JSON.parse(row.payload)
        let refusal = null
        if (TERMINAL_STATUSES.includes(task.status) || task.evidence_generation !== row.evidence_generation
          || (row.owner_session !== null && task.owner_session !== row.owner_session)) refusal = 'E_SCHEDULER_STALE'
        if (!refusal) {
          try {
            const reservation = this.#governor.reserve({ operation_key: 'scheduler:' + row.request_id, ...payload }, run, actor)
            changed(db.prepare("UPDATE scheduler_request SET state = 'admitted', reservation_id = ? WHERE request_id = ? AND state = 'queued'")
              .run(reservation.reservation_id, row.request_id))
            row.state = 'admitted'
            row.reservation_id = reservation.reservation_id
            result = { status: 'admitted', request: this.#view(db, row) }
          } catch (error) {
            if (error.code === 'E_GOVERNOR_FENCE') refusal = error.code
            else if (['E_RESOURCE_BUSY', 'E_BUDGET_EXHAUSTED', 'E_GOVERNOR_CONFLICT'].includes(error.code)) {
              result = { status: 'blocked', code: error.code, request: this.#view(db, row) }
            } else throw error
          }
        }
        if (refusal) {
          changed(db.prepare("UPDATE scheduler_request SET state = 'refused', refusal_code = ? WHERE request_id = ? AND state = 'queued'").run(refusal, row.request_id))
          result = { status: 'refused', code: refusal, request: this.#view(db, { ...row, state: 'refused', refusal_code: refusal }) }
        }
      }
      changed(db.prepare('INSERT INTO scheduler_decision(run_id, request_key, actor_session, result, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(run, requestKey, actor.sessionId, JSON.stringify(result), new Date().toISOString()))
      return { ...result, replay: false }
    })
  }
  #transition(method, input, runId, authority, extras) {
    fields(input, ['request_id', 'generation', ...extras])
    const run = key(runId, 'runId'), actor = caller(authority)
    key(input.request_id, 'request_id'); integer(input.generation, 'generation')
    if (method === 'bind') key(input.session_id, 'session_id')
    const db = this.#db()
    return withWriteTransaction(db, () => {
      const row = db.prepare('SELECT * FROM scheduler_request WHERE request_id = ? AND run_id = ?').get(input.request_id, run)
      if (!row || !row.reservation_id) fail('admitted request in trusted root run required')
      this.#task(db, row.task_id, run, actor, row.owner_session === null ? undefined : row)
      const operation = { reservation_id: row.reservation_id, generation: input.generation }
      for (const name of extras) operation[name] = input[name]
      this.#governor[method](operation, run, actor)
      if (method === 'bind' && row.owner_session === null) {
        changed(db.prepare('UPDATE scheduler_request SET owner_session = ? WHERE request_id = ? AND owner_session IS NULL').run(input.session_id, row.request_id))
        row.owner_session = input.session_id
      }
      return this.#view(db, row)
    })
  }
  bind(input, runId, authority) { return this.#transition('bind', input, runId, authority, ['session_id']) }
  markUnknown(input, runId, authority) { return this.#transition('markUnknown', input, runId, authority, ['reason']) }
  settle(input, runId, authority) { return this.#transition('settle', input, runId, authority, ['proof']) }
  state(input, runId, authority) {
    fields(input, ['after', 'limit'])
    const run = key(runId, 'runId'), actor = caller(authority)
    const after = integer(input.after ?? 0, 'after'), limit = integer(input.limit ?? 25, 'limit', 1)
    if (limit > 100) fail('state limit cannot exceed 100')
    const db = this.#db()
    return withReadTransaction(db, () => {
      const rows = db.prepare(`SELECT q.* FROM scheduler_request q JOIN task t ON t.id = q.task_id AND t.run_id = q.run_id
        WHERE q.run_id = ? AND q.seq > ? AND (? = 'lead' OR (q.owner_session = ? AND t.owner_session = ?))
        ORDER BY q.seq LIMIT ?`).all(run, after, actor.role, actor.sessionId, actor.sessionId, limit + 1)
      const requests = []
      // Account for JSON escaping in the trusted run ID as well as each item.
      // Reserve the largest possible cursor so the final response stays bounded.
      let bytes = Buffer.byteLength(JSON.stringify({
        run_id: run, requests: [], has_more: true, next_after: Number.MAX_SAFE_INTEGER,
      }))
      for (const row of rows.slice(0, limit)) {
        const item = this.#view(db, row), size = Buffer.byteLength(JSON.stringify(item))
        if (bytes + size + 1 > 65536) {
          if (requests.length === 0) fail('scheduler state item exceeds response byte limit')
          break
        }
        requests.push(item); bytes += size + 1
      }
      const more = rows.length > requests.length
      return { run_id: run, requests, has_more: more, next_after: more ? requests.at(-1).seq : null }
    })
  }
}
