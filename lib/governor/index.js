/** Host-only durable admission. Never expose this API as model tool arguments. */
import { randomUUID } from 'node:crypto'
import { workflowAdmission } from '../store/workflow.js'
import { TERMINAL_STATUSES } from '../store/index.js'
import { withReadTransaction, withWriteTransaction } from '../store/sqlite.js'
export { createNativeGovernorAdapter } from './native.js'

const DEFAULTS = Object.freeze({ max_active: 6, max_writers: 2, max_created: 3, max_retries: 2 })
const DDL = `
CREATE TABLE IF NOT EXISTS governor_run (
  run_id TEXT PRIMARY KEY,
  max_active INTEGER NOT NULL, max_writers INTEGER NOT NULL,
  max_created INTEGER NOT NULL, max_retries INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS governor_reservation (
  reservation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id INTEGER NOT NULL,
  operation_key TEXT NOT NULL, payload TEXT NOT NULL, generation INTEGER NOT NULL,
  mode TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  owner_session TEXT, session_id TEXT, settlement TEXT,
  UNIQUE(run_id, operation_key), UNIQUE(task_id, generation)
);
CREATE TABLE IF NOT EXISTS governor_retry_charge (
  reservation_id TEXT PRIMARY KEY, rework_generation INTEGER NOT NULL,
  retry_charge INTEGER NOT NULL, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_governor_run ON governor_reservation(run_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_governor_active_task ON governor_reservation(task_id) WHERE state != 'settled';
CREATE TABLE IF NOT EXISTS governor_hold (
  reservation_id TEXT NOT NULL, resource_key TEXT NOT NULL, mode TEXT NOT NULL,
  PRIMARY KEY(reservation_id, resource_key)
);
CREATE INDEX IF NOT EXISTS idx_governor_resource ON governor_hold(resource_key);
CREATE TABLE IF NOT EXISTS governor_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
  reservation_id TEXT, action TEXT NOT NULL, role TEXT NOT NULL,
  session_id TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
);`

// Shared with read-only diagnostics; initialization remains owned by the host service.
export const GOVERNOR_DDL = DDL

function fail(message, code = 'E_GOVERNOR_CONFLICT') {
  throw Object.assign(new Error(message), { code })
}
function exact(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a nonblank trusted key`)
  return value
}
function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${label} must be a safe integer >= ${min}`)
  return value
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('input must be an object')
  if (Object.keys(input).some(k => !allowed.includes(k))) fail('unrecognized governor input field')
}
function caller(authority) {
  if (!authority || !['lead', 'worker'].includes(authority.role)) fail('trusted lead/worker authority required')
  return { role: authority.role, sessionId: exact(authority.sessionId, 'authority.sessionId') }
}
function changed(result) {
  if (Number(result.changes) !== 1) fail('governor write did not affect exactly one row')
}
function reservation(row) {
  return { reservation_id: row.reservation_id, run_id: row.run_id, task_id: row.task_id,
    generation: row.generation, state: row.state, mode: row.mode, kind: row.kind,
    session_id: row.session_id, resources: JSON.parse(row.payload).resources }
}

export class TaskforceGovernor {
  #store
  #initialized = new WeakSet()
  constructor(store) {
    if (!store || typeof store.open !== 'function') throw new TypeError('TaskforceStore required')
    this.#store = store
  }
  #db() {
    // Never cache the store-owned handle: rollback failure may invalidate it.
    const db = this.#store.open()
    if (!this.#initialized.has(db)) {
      withWriteTransaction(db, () => {
        db.exec(DDL)
        // Old intents did not capture the observed task revision. Preserve all
        // explicit retries plus observable rework, without guessing overlap.
        const legacy = db.prepare(`SELECT r.*, t.evidence_generation, t.run_id AS task_run
          FROM governor_reservation r LEFT JOIN task t ON t.id = r.task_id
          LEFT JOIN governor_retry_charge c USING(reservation_id)
          WHERE c.reservation_id IS NULL ORDER BY r.task_id, r.generation DESC`).all()
        for (const row of legacy) {
          if (row.task_run !== row.run_id) fail('legacy retry accounting task is outside its run')
          const observed = integer(row.evidence_generation, 'task evidence generation')
          const pending = Math.max(0, observed - this.#reworkGeneration(db, row.task_id))
          this.#chargeRetry(db, row.reservation_id, observed, Number(row.kind === 'retry') + pending, 'legacy')
        }
      })
      // A surrounding store transaction may still roll this DDL back.
      if (!db.isTransaction) this.#initialized.add(db)
    }
    return db
  }
  #task(db, id, run, actor, prior) {
    const task = db.prepare('SELECT id, run_id, owner_session, status, evidence_generation FROM task WHERE id = ?').get(id)
    if (!task || task.run_id !== run) fail('task is outside the trusted root run')
    if (actor.role !== 'lead' && (task.owner_session !== actor.sessionId
      || (prior && prior.owner_session !== actor.sessionId))) fail('real task owner required')
    return task
  }
  #limits(db, run) {
    const row = db.prepare('SELECT max_active, max_writers, max_created, max_retries FROM governor_run WHERE run_id = ?').get(run)
    return row ? { ...row } : { ...DEFAULTS }
  }
  #generation(db, id) {
    return db.prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM governor_reservation WHERE task_id = ?').get(id).generation
  }
  #reworkGeneration(db, id) {
    return db.prepare(`SELECT COALESCE(MAX(c.rework_generation), 0) AS generation
      FROM governor_retry_charge c JOIN governor_reservation r USING(reservation_id)
      WHERE r.task_id = ?`).get(id).generation
  }
  #chargeRetry(db, id, observed, charge, source) {
    changed(db.prepare('INSERT INTO governor_retry_charge(reservation_id, rework_generation, retry_charge, source) VALUES (?, ?, ?, ?)')
      .run(id, observed, charge, source))
  }
  #audit(db, run, actor, action, details, id = null) {
    changed(db.prepare('INSERT INTO governor_audit(run_id, reservation_id, action, role, session_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run, id, action, actor.role, actor.sessionId, JSON.stringify(details), new Date().toISOString()))
  }
  #target(db, input, run, actor, allowSettledReplay = false) {
    exact(input.reservation_id, 'reservation_id')
    integer(input.generation, 'generation')
    const row = db.prepare('SELECT * FROM governor_reservation WHERE reservation_id = ? AND run_id = ?').get(input.reservation_id, run)
    if (!row) fail('reservation is outside the trusted root run')
    const task = this.#task(db, row.task_id, run, actor, row)
    // A historical settled replay reads its own row; mutations still need the latest admission.
    const settledReplay = allowSettledReplay && row.state === 'settled'
    if (input.generation !== row.generation || (!settledReplay && row.generation !== this.#generation(db, row.task_id))) fail('stale admission generation', 'E_GOVERNOR_FENCE')
    return { row, task }
  }
  reserve(input, runId, authority) {
    const db = this.#db()
    const run = exact(runId, 'runId'), actor = caller(authority)
    fields(input, ['operation_key', 'task_id', 'generation', 'mode', 'kind', 'resources'])
    const key = exact(input.operation_key, 'operation_key')
    const id = integer(input.task_id, 'task_id', 1), generation = integer(input.generation, 'generation')
    if (!['read', 'write'].includes(input.mode) || !['new', 'reuse', 'retry'].includes(input.kind)) fail('invalid admission mode or kind')
    if (!Array.isArray(input.resources)) fail('trusted resource keys required')
    const resources = [...new Set(input.resources.map(r => exact(r, 'resource key')))].sort()
    const payload = JSON.stringify({ task_id: id, generation, mode: input.mode, kind: input.kind, resources })
    return withWriteTransaction(db, () => {
      const old = db.prepare('SELECT * FROM governor_reservation WHERE run_id = ? AND operation_key = ?').get(run, key)
      const task = this.#task(db, id, run, actor, old)
      // Replays return durable current state and never authorize a second dispatch.
      if (old) {
        if (old.payload !== payload) fail('operation key has a different payload')
        return reservation(old)
      }
      if (generation !== this.#generation(db, id)) fail('stale admission generation', 'E_GOVERNOR_FENCE')
      if (TERMINAL_STATUSES.includes(task.status)) fail('cannot admit a terminal task')
      workflowAdmission(db, task)
      if (db.prepare("SELECT 1 FROM governor_reservation WHERE task_id = ? AND state != 'settled'").get(id)) fail('task already has an active admission')
      const counts = this.#counts(db, run), limits = this.#limits(db, run)
      const observed = integer(task.evidence_generation, 'task evidence generation')
      // Reclaim clears rejected status but not the monotonic store generation.
      // A new/reused executor can still perform task rework. Charge each newly
      // observed revision once, while explicit extra retry intents still count.
      const retryCharge = Math.max(Number(input.kind === 'retry'), observed - this.#reworkGeneration(db, id))
      if (counts.active_total >= limits.max_active
        || (input.mode === 'write' && counts.active_writers >= limits.max_writers)
        || (input.kind === 'new' && counts.created_total >= limits.max_created)
        || (counts.retries[id] ?? 0) + retryCharge > limits.max_retries) fail('run/task admission budget exhausted', 'E_BUDGET_EXHAUSTED')
      for (const resource of resources) {
        if (db.prepare("SELECT 1 FROM governor_hold WHERE resource_key = ? AND (mode = 'write' OR ? = 'write') LIMIT 1").get(resource, input.mode)) fail('resource is held by incompatible work', 'E_RESOURCE_BUSY')
      }
      const rid = randomUUID()
      changed(db.prepare("INSERT INTO governor_reservation(reservation_id, run_id, task_id, operation_key, payload, generation, mode, kind, state, owner_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)")
        .run(rid, run, id, key, payload, generation + 1, input.mode, input.kind, task.owner_session))
      this.#chargeRetry(db, rid, observed, retryCharge, 'admission')
      for (const resource of resources) changed(db.prepare('INSERT INTO governor_hold(reservation_id, resource_key, mode) VALUES (?, ?, ?)').run(rid, resource, input.mode))
      this.#audit(db, run, actor, 'reserve', { operation_key: key, ...JSON.parse(payload), rework_generation: observed, retry_charge: retryCharge }, rid)
      return reservation(db.prepare('SELECT * FROM governor_reservation WHERE reservation_id = ?').get(rid))
    })
  }
  bind(input, runId, authority) {
    const db = this.#db(), run = exact(runId, 'runId'), actor = caller(authority)
    fields(input, ['reservation_id', 'generation', 'session_id'])
    const session = exact(input.session_id, 'session_id')
    return withWriteTransaction(db, () => {
      const { row, task } = this.#target(db, input, run, actor)
      if (TERMINAL_STATUSES.includes(task.status)) fail('cannot bind a terminal task')
      workflowAdmission(db, task)
      const accounting = db.prepare('SELECT rework_generation, source FROM governor_retry_charge WHERE reservation_id = ?').get(row.reservation_id)
      if (!accounting || accounting.source !== 'admission' || accounting.rework_generation !== task.evidence_generation) fail('admission rework generation is unverified or changed', 'E_GOVERNOR_FENCE')
      if (task.owner_session !== session || (actor.role !== 'lead' && actor.sessionId !== session)) fail('binding requires the current real task owner')
      if (row.state === 'running' && row.session_id === session) return reservation(row)
      if (row.state !== 'reserved') fail('only a reserved intent may be bound; unknown is not redispatched')
      changed(db.prepare("UPDATE governor_reservation SET state = 'running', session_id = ?, owner_session = ? WHERE reservation_id = ?").run(session, session, row.reservation_id))
      this.#audit(db, run, actor, 'bind', { generation: row.generation, session_id: session }, row.reservation_id)
      return reservation({ ...row, state: 'running', session_id: session })
    })
  }
  markUnknown(input, runId, authority) {
    const db = this.#db(), run = exact(runId, 'runId'), actor = caller(authority)
    fields(input, ['reservation_id', 'generation', 'reason'])
    const reason = exact(input.reason, 'reason')
    return withWriteTransaction(db, () => {
      const { row } = this.#target(db, input, run, actor)
      if (row.state === 'settled') fail('settled admission cannot become unknown')
      if (row.state === 'unknown') return reservation(row)
      changed(db.prepare("UPDATE governor_reservation SET state = 'unknown' WHERE reservation_id = ?").run(row.reservation_id))
      this.#audit(db, run, actor, 'markUnknown', { generation: row.generation, reason }, row.reservation_id)
      return reservation({ ...row, state: 'unknown' })
    })
  }
  settle(input, runId, authority) {
    const db = this.#db(), run = exact(runId, 'runId'), actor = caller(authority)
    fields(input, ['reservation_id', 'generation', 'proof'])
    fields(input.proof, ['kind', 'outcome', 'quiescent', 'evidence'])
    const proof = input.proof
    let normalized
    if (proof.kind === 'never_started') {
      fields(proof, ['kind'])
      normalized = { kind: 'never_started' }
    } else if (proof.kind === 'terminal' && ['succeeded', 'failed', 'cancelled'].includes(proof.outcome) && proof.quiescent === true) {
      normalized = { kind: 'terminal', outcome: proof.outcome, quiescent: true, evidence: exact(proof.evidence, 'trusted quiescence evidence') }
    } else fail('settlement requires trusted never_started or terminal plus quiescence evidence')
    const settlement = JSON.stringify(normalized)
    return withWriteTransaction(db, () => {
      const { row } = this.#target(db, input, run, actor, true)
      if (row.state === 'settled') {
        if (row.settlement !== settlement) fail('settlement conflicts with durable proof')
        return reservation(row)
      }
      if (proof.kind === 'never_started' && row.session_id !== null) fail('bound dispatch requires terminal and quiescence evidence')
      changed(db.prepare("UPDATE governor_reservation SET state = 'settled', settlement = ? WHERE reservation_id = ?").run(settlement, row.reservation_id))
      const expected = JSON.parse(row.payload).resources.length
      if (Number(db.prepare('DELETE FROM governor_hold WHERE reservation_id = ?').run(row.reservation_id).changes) !== expected) fail('resource release was incomplete')
      this.#audit(db, run, actor, 'settle', { generation: row.generation, proof: normalized }, row.reservation_id)
      return reservation({ ...row, state: 'settled', settlement })
    })
  }
  #counts(db, run) {
    const rows = db.prepare('SELECT r.task_id, r.state, r.kind, r.mode, c.retry_charge FROM governor_reservation r LEFT JOIN governor_retry_charge c USING(reservation_id) WHERE r.run_id = ?').all(run)
    const counts = { active_total: 0, active_writers: 0, created_total: 0, unknown_total: 0, retries: {} }
    for (const row of rows) {
      if (row.retry_charge === null) fail('reservation lacks durable retry accounting; reopen governor to migrate')
      if (row.state !== 'settled') { counts.active_total++; if (row.mode === 'write') counts.active_writers++ }
      if (row.state === 'unknown') counts.unknown_total++
      if (row.kind === 'new') counts.created_total++
      if (row.retry_charge) counts.retries[row.task_id] = (counts.retries[row.task_id] ?? 0) + row.retry_charge
    }
    return counts
  }
  snapshot(runId) {
    const db = this.#db(), run = exact(runId, 'runId')
    return withReadTransaction(db, () => ({
      run_id: run, limits: this.#limits(db, run), ...this.#counts(db, run),
      reservations: db.prepare('SELECT * FROM governor_reservation WHERE run_id = ? ORDER BY rowid').all(run).map(reservation),
      holds: db.prepare('SELECT h.* FROM governor_hold h JOIN governor_reservation r USING(reservation_id) WHERE r.run_id = ? ORDER BY h.reservation_id, h.resource_key').all(run).map(r => ({ ...r })),
      retry_charges: db.prepare('SELECT c.* FROM governor_retry_charge c JOIN governor_reservation r USING(reservation_id) WHERE r.run_id = ? ORDER BY r.rowid').all(run).map(r => ({ ...r })),
      audit: db.prepare('SELECT * FROM governor_audit WHERE run_id = ? ORDER BY id').all(run).map(r => ({ ...r, details: JSON.parse(r.details) })),
    }))
  }
  extendBudget(input, runId, authority) {
    const db = this.#db(), run = exact(runId, 'runId'), actor = caller(authority)
    fields(input, ['reason', ...Object.keys(DEFAULTS)])
    const reason = exact(input.reason, 'reason')
    if (actor.role !== 'lead') fail('budget extension requires trusted lead authority')
    return withWriteTransaction(db, () => {
      const before = this.#limits(db, run), after = { ...before }
      for (const key of Object.keys(DEFAULTS)) {
        if (input[key] !== undefined) {
          after[key] = integer(input[key], key, 1)
          if (after[key] < before[key]) fail('budget extension cannot reduce limits')
        }
      }
      if (!Object.keys(DEFAULTS).some(k => after[k] > before[k])) fail('budget extension must increase a limit')
      changed(db.prepare('INSERT INTO governor_run(run_id, max_active, max_writers, max_created, max_retries) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET max_active=excluded.max_active, max_writers=excluded.max_writers, max_created=excluded.max_created, max_retries=excluded.max_retries')
        .run(run, after.max_active, after.max_writers, after.max_created, after.max_retries))
      this.#audit(db, run, actor, 'extendBudget', { reason, before, after })
      return { ...after }
    })
  }
}
