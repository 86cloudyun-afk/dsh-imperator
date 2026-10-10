/** Durable observations and controlled recovery. No external effects or same-UID isolation. */
import { randomUUID } from 'node:crypto'
import { withReadTransaction, withWriteTransaction } from './sqlite.js'

export const RECOVERY_MAX_BYTES = 16384
export const RECOVERY_DDL = `
CREATE TABLE IF NOT EXISTS lifecycle_event (
 id INTEGER PRIMARY KEY, run_id TEXT, session_id TEXT NOT NULL,
 event_key TEXT NOT NULL, event_type TEXT NOT NULL, source TEXT NOT NULL,
 event_seq INTEGER, turn INTEGER, step INTEGER, reason_kind TEXT, error_code TEXT,
 node_version TEXT, package_version TEXT, host_version TEXT,
 process_instance TEXT NOT NULL, window_truncated INTEGER NOT NULL DEFAULT 0,
 observed_at TEXT NOT NULL, UNIQUE(session_id,event_key)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_run ON lifecycle_event(run_id,id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_caller ON lifecycle_event(session_id,run_id,id);
CREATE TABLE IF NOT EXISTS control_operation (
 id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
 caller_session TEXT NOT NULL, request_key TEXT NOT NULL,
 run_id TEXT, task_id INTEGER, evidence_generation INTEGER,
 action TEXT NOT NULL CHECK(action IN ('send','stop')),
 target_id TEXT NOT NULL, payload_hash TEXT NOT NULL, process_instance TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','unknown')),
 message_id TEXT, error_code TEXT, created_at TEXT NOT NULL, ended_at TEXT,
 UNIQUE(caller_session, request_key)
);
CREATE INDEX IF NOT EXISTS idx_control_run ON control_operation(run_id,id);
CREATE INDEX IF NOT EXISTS idx_control_caller ON control_operation(caller_session,run_id,id);
CREATE TABLE IF NOT EXISTS task_event (
 id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, run_id TEXT,
 kind TEXT NOT NULL, source TEXT NOT NULL, actor_session TEXT,
 status TEXT NOT NULL, previous_status TEXT, owner_session TEXT,
 evidence_generation INTEGER NOT NULL, history_complete INTEGER NOT NULL,
 observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_event_run ON task_event(run_id,id);
CREATE INDEX IF NOT EXISTS idx_task_event_task ON task_event(task_id,run_id,id);
CREATE TABLE IF NOT EXISTS task_checkpoint (
 id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, run_id TEXT,
 actor_session TEXT NOT NULL, owner_session TEXT, evidence_generation INTEGER NOT NULL,
 summary TEXT NOT NULL, next_action TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_run ON task_checkpoint(run_id,id);
CREATE INDEX IF NOT EXISTS idx_checkpoint_task ON task_checkpoint(task_id,run_id,id);
INSERT INTO task_event(task_id,run_id,kind,source,actor_session,status,previous_status,owner_session,evidence_generation,history_complete,observed_at)
 SELECT t.id,t.run_id,'baseline','database_snapshot',NULL,t.status,NULL,t.owner_session,t.evidence_generation,0,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM task t WHERE NOT EXISTS(SELECT 1 FROM task_event e WHERE e.task_id=t.id);
CREATE TRIGGER IF NOT EXISTS recovery_task_insert AFTER INSERT ON task BEGIN
 INSERT INTO task_event(task_id,run_id,kind,source,actor_session,status,previous_status,owner_session,evidence_generation,history_complete,observed_at)
 VALUES(NEW.id,NEW.run_id,'transition','database_change',NULL,NEW.status,NULL,NEW.owner_session,NEW.evidence_generation,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS recovery_task_update AFTER UPDATE ON task
 WHEN NEW.status IS NOT OLD.status OR NEW.owner_session IS NOT OLD.owner_session OR NEW.evidence_generation IS NOT OLD.evidence_generation BEGIN
 INSERT INTO task_event(task_id,run_id,kind,source,actor_session,status,previous_status,owner_session,evidence_generation,history_complete,observed_at)
 VALUES(NEW.id,NEW.run_id,'transition','database_change',NULL,NEW.status,OLD.status,NEW.owner_session,NEW.evidence_generation,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
`

const PROCESS_INSTANCE = (globalThis[Symbol.for('dsh-taskforce.process-instance')] ??= randomUUID())
const now = () => new Date().toISOString()
const fail = (code, message) => Object.assign(new Error(message), {
  code, hint: '读取 recovery/timeline 核对持久记录；未知外部效果不得自动重试。归属或完整性错误交由主控核对。'
})
function text(value, field, max = 256, optional = false) {
  if (optional && (value === undefined || value === null)) return null
  if (typeof value !== 'string' || !value.trim() || value.includes(String.fromCharCode(0)) || Buffer.byteLength(value) > max) {
    throw fail('E_RECOVERY_INPUT', field + ' must be nonempty text without NUL within ' + max + ' UTF-8 bytes')
  }
  return value // Preserve exact trusted identities, including surrounding whitespace.
}
function integer(value, field, optional = false) {
  if (optional && (value === undefined || value === null)) return null
  if (!Number.isSafeInteger(value) || value < 1) throw fail('E_RECOVERY_INPUT', field + ' must be a positive integer')
  return value
}
function page(input = {}) {
  const limit = input.limit ?? 25
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('E_RECOVERY_INPUT', 'limit must be 1–100')
  return { limit, cursor: integer(input.cursor, 'cursor', true) }
}
const runScope = run => run === undefined || run === null ? null : text(run, 'run_id')
const actorScope = actor => {
  if (typeof actor?.sessionId !== 'string' || !actor.sessionId.trim()) throw fail('E_RECOVERY_SCOPE', 'trusted direct caller is required')
  return text(actor.sessionId, 'trusted sessionId')
}
const publicOperation = row => ({
  id: row.id, operation_id: row.operation_id, caller_session: row.caller_session,
  run_id: row.run_id, task_id: row.task_id, evidence_generation: row.evidence_generation,
  action: row.action, target_id: row.target_id, process_instance: row.process_instance,
  status: row.status, message_id: row.message_id, error_code: row.error_code,
  created_at: row.created_at, ended_at: row.ended_at,
})
const publicEvent = row => ({ ...row, history_complete: row.history_complete === 1 })
const bytes = value => Buffer.byteLength(JSON.stringify(value))
function bounded(value, keys) {
  // Reserve one row in every section, including JSON escaping, omission flags,
  // the success envelope, and cursor growth. Never erase the sole row.
  const empty = { ...value, ...Object.fromEntries(keys.map(key => [key, []])) }
  const rowBudget = Math.floor((RECOVERY_MAX_BYTES - bytes({ ok: true, ...empty }) - 128) / keys.length)
  if (rowBudget < 256) throw fail('E_RECOVERY_INPUT', 'metadata exceeds recovery output budget')
  for (const key of keys) value[key] = value[key].map(row => {
    if (bytes(row) <= rowBudget) return row
    const projected = { ...row, omitted_fields: [...(row.omitted_fields ?? [])] }
    if ('summary' in projected || 'next_action' in projected) {
      for (const field of ['summary', 'next_action']) {
        if (typeof projected[field] === 'string') {
          projected[field] = null
          if (!projected.omitted_fields.includes(field)) projected.omitted_fields.push(field)
        }
      }
      projected.context_omitted = true
    }
    while (bytes(projected) > rowBudget) {
      const field = Object.keys(projected).filter(field => typeof projected[field] === 'string')
        .sort((a, b) => bytes(projected[b]) - bytes(projected[a]))[0]
      if (field === undefined) throw fail('E_RECOVERY_INPUT', 'row metadata exceeds recovery output budget')
      projected[field] = null
      if (!projected.omitted_fields.includes(field)) projected.omitted_fields.push(field)
    }
    value.truncated = true
    return projected
  })
  while (bytes({ ok: true, ...value }) > RECOVERY_MAX_BYTES) {
    const key = keys.filter(key => value[key]?.length > 1).sort((a, b) => bytes(value[b]) - bytes(value[a]))[0]
    if (!key) throw fail('E_RECOVERY_INPUT', 'metadata exceeds recovery output budget')
    value[key].pop()
    value.truncated = true
    if (value.continuation) value.continuation[key] = value[key].at(-1).id
    if (key === 'events') value.next_cursor = value.events.at(-1).id
  }
  return value
}

/** The store owns initialization and the current reconnectable connection. */
export class TaskforceRecovery {
  constructor(store) {
    this.store = store
    this.processInstance = PROCESS_INSTANCE
    this.observationGaps = new Set()
  }
  /** Host-only allowlisted observation. Session coordinates deduplicate replay. */
  recordLifecycle(input, authority) {
    const session = actorScope(authority), run = runScope(authority?.runId)
    const eventType = input?.event_type, source = input?.source
    const terminal = ['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked']
    if (!['turn/start', 'turn/end', 'request/prepared', 'request/failed', 'agent/pre-step', 'agent/disposed', 'agent/error'].includes(eventType)
      || !['session_event', 'host_hook'].includes(source)) throw fail('E_RECOVERY_INPUT', 'unknown lifecycle observation')
    const coordinate = value => Number.isSafeInteger(value) && value >= 0 ? value : null
    const seq = coordinate(input.event_seq)
    if (source === 'session_event' && seq === null) throw fail('E_RECOVERY_INPUT', 'durable lifecycle observation requires source sequence')
    const reason = terminal.includes(input.reason_kind) ? input.reason_kind : null
    const code = ['UNKNOWN', 'ABORTED', 'UNAUTHORIZED', 'NOT_RESUMABLE', 'UNKNOWN_TOOL', 'INVALID_ARGS', 'E_STORE_BUSY'].includes(input.error_code) ? input.error_code : null
    const version = value => typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) && value.length <= 64 ? value : null
    const eventKey = source === 'session_event' ? 'seq:' + seq : 'hook:' + randomUUID()
    const values = [eventType, source, seq, coordinate(input.turn), coordinate(input.step), reason, code]
    const db = this.store.open()
    return withWriteTransaction(db, () => {
      const prior = db.prepare('SELECT * FROM lifecycle_event WHERE session_id=? AND event_key=?').get(session, eventKey)
      if (prior) {
        const original = [prior.event_type, prior.source, prior.event_seq, prior.turn, prior.step, prior.reason_kind, prior.error_code]
        if (JSON.stringify(original) !== JSON.stringify(values)) throw fail('E_RECOVERY_CONFLICT', 'durable lifecycle coordinate changed')
        return { id: prior.id, replayed: true }
      }
      const row = db.prepare('INSERT INTO lifecycle_event(run_id,session_id,event_key,event_type,source,event_seq,turn,step,reason_kind,error_code,node_version,package_version,host_version,process_instance,window_truncated,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(run, session, eventKey, ...values, version(input.node_version), version(input.package_version),
          version(input.host_version), this.processInstance, input.window_truncated === true ? 1 : 0, now())
      return { id: Number(row.lastInsertRowid), replayed: false }
    })
  }

  beginControl(input, authority) {
    const caller = actorScope(authority)
    const run = runScope(authority?.runId)
    const key = text(input?.request_key, 'request_key', 256)
    const action = input?.action
    if (!['send', 'stop'].includes(action)) throw fail('E_RECOVERY_INPUT', 'invalid control action')
    const target = text(input.target_id, 'target_id')
    const hash = text(input.payload_hash, 'payload_hash', 64)
    if (!/^[a-f0-9]{64}$/.test(hash)) throw fail('E_RECOVERY_INPUT', 'payload_hash must be SHA-256')
    const taskId = integer(input.task_id, 'task_id', true)
    const db = this.store.open()
    return withWriteTransaction(db, () => {
      let generation = null
      if (taskId !== null) {
        if (run === null) throw fail('E_RECOVERY_SCOPE', 'task attribution requires a verified run')
        const task = this.store.taskOf(taskId, run).task
        if (authority?.isRoot !== true && task.owner_session !== caller) throw fail('E_RECOVERY_SCOPE', 'task attribution requires root or current owner')
        generation = task.evidence_generation
      }
      const prior = db.prepare('SELECT * FROM control_operation WHERE caller_session=? AND request_key=?').get(caller, key)
      if (prior) {
        if (prior.action !== action || prior.target_id !== target || prior.payload_hash !== hash
          || prior.run_id !== run || prior.task_id !== taskId) throw fail('E_RECOVERY_CONFLICT', 'request key already describes another operation')
        return { ...publicOperation(prior), invoke: false, replayed: true, durable: true }
      }
      const operationId = randomUUID()
      db.prepare('INSERT INTO control_operation(operation_id,caller_session,request_key,run_id,task_id,evidence_generation,action,target_id,payload_hash,process_instance,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(operationId, caller, key, run, taskId, generation, action, target, hash, this.processInstance, 'pending', now())
      return { operation_id: operationId, invoke: true, replayed: false, durable: true, status: 'pending' }
    })
  }
  finishControl(input, authority) {
    const caller = actorScope(authority)
    const operationId = text(input?.operation_id, 'operation_id')
    const status = input?.status
    if (!['accepted', 'rejected', 'unknown'].includes(status)) throw fail('E_RECOVERY_INPUT', 'invalid control outcome')
    const messageId = text(input.message_id, 'message_id', 256, true)
    // Error text is never persisted; even unknown provider codes are excluded.
    const errorCode = ['UNAUTHORIZED', 'NOT_RESUMABLE', 'ABORTED', 'E_CHILD_SERVICE'].includes(input.error_code) ? input.error_code : null
    const db = this.store.open()
    return withWriteTransaction(db, () => {
      const row = db.prepare('SELECT * FROM control_operation WHERE operation_id=? AND caller_session=?').get(operationId, caller)
      if (!row) throw fail('E_RECOVERY_SCOPE', 'operation not found in direct caller scope')
      if (row.status !== 'pending') {
        if (row.status !== status || row.message_id !== messageId || row.error_code !== errorCode) throw fail('E_RECOVERY_CONFLICT', 'operation outcome is immutable')
        return { ...publicOperation(row), replayed: true, durable: true }
      }
      db.prepare('UPDATE control_operation SET status=?,message_id=?,error_code=?,ended_at=? WHERE id=? AND status=?')
        .run(status, messageId, errorCode, now(), row.id, 'pending')
      return { ...publicOperation(db.prepare('SELECT * FROM control_operation WHERE id=?').get(row.id)), replayed: false, durable: true }
    })
  }
  checkpoint(input, runId, trustedActor) {
    const run = runScope(runId), caller = actorScope(trustedActor)
    const taskId = integer(input?.task_id, 'task_id')
    const summary = text(input.summary, 'summary', 4096)
    const nextAction = text(input.next_action, 'next_action', 2048, true)
    const db = this.store.open()
    return withWriteTransaction(db, () => {
      const task = this.store.taskOf(taskId, run).task
      if (trustedActor?.isRoot !== true && task.owner_session !== caller) throw fail('E_RECOVERY_SCOPE', 'checkpoint requires root or current owner')
      const row = db.prepare('INSERT INTO task_checkpoint(task_id,run_id,actor_session,owner_session,evidence_generation,summary,next_action,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(taskId, run, caller, task.owner_session, task.evidence_generation, summary, nextAction, now())
      return { checkpoint_id: Number(row.lastInsertRowid), task_id: taskId, owner_session: task.owner_session,
        evidence_generation: task.evidence_generation, evidence: false, context_source: 'model_authored' }
    })
  }
  timeline(input = {}, runId) {
    const run = runScope(runId), { limit, cursor } = page(input)
    const taskId = integer(input.task_id, 'task_id', true), db = this.store.open()
    return withReadTransaction(db, () => {
      if (taskId !== null) this.store.taskOf(taskId, run)
      const events = db.prepare('SELECT e.* FROM task_event e JOIN task t ON t.id=e.task_id AND t.run_id IS e.run_id WHERE e.run_id IS ?'
        + (taskId === null ? '' : ' AND e.task_id=?') + (cursor === null ? '' : ' AND e.id<?') + ' ORDER BY e.id DESC LIMIT ?')
        .all(run, ...(taskId === null ? [] : [taskId]), ...(cursor === null ? [] : [cursor]), limit + 1).map(publicEvent)
      const more = events.length > limit
      if (more) events.pop()
      return bounded({ events, next_cursor: more ? events.at(-1)?.id ?? null : null, truncated: more,
        history_complete: false, observation_gaps: ['Earlier host lifecycle events may be unavailable; task transitions do not prove process quiescence.'] }, ['events'])
    })
  }
  inspect(input = {}, runId, directCaller) {
    const run = runScope(runId), { limit } = page(input)
    const caller = run === null ? actorScope(directCaller) : null
    const taskId = integer(input.task_id, 'task_id', true)
    const operationCursor = integer(input.operation_cursor, 'operation_cursor', true)
    const checkpointCursor = integer(input.checkpoint_cursor, 'checkpoint_cursor', true)
    const lifecycleCursor = integer(input.lifecycle_cursor, 'lifecycle_cursor', true)
    const db = this.store.open()
    return withReadTransaction(db, () => {
      if (taskId !== null) {
        if (run === null) throw fail('E_RECOVERY_SCOPE', 'unattributed controls cannot inspect tasks')
        this.store.taskOf(taskId, run)
      }
      const operations = db.prepare('SELECT o.* FROM control_operation o WHERE o.run_id IS ?'
        + (run === null ? ' AND o.caller_session=?' : '')
        + (taskId === null ? '' : ' AND o.task_id=?')
        + ' AND (o.task_id IS NULL OR EXISTS(SELECT 1 FROM task t WHERE t.id=o.task_id AND t.run_id IS o.run_id))'
        + (operationCursor === null ? '' : ' AND o.id<?') + ' ORDER BY o.id DESC LIMIT ?')
        .all(run, ...(run === null ? [caller] : []), ...(taskId === null ? [] : [taskId]),
          ...(operationCursor === null ? [] : [operationCursor]), limit + 1).map(publicOperation)
      const checkpoints = run === null ? [] : db.prepare('SELECT c.* FROM task_checkpoint c JOIN task t ON t.id=c.task_id AND t.run_id IS c.run_id WHERE c.run_id IS ?'
        + (taskId === null ? '' : ' AND c.task_id=?') + (checkpointCursor === null ? '' : ' AND c.id<?') + ' ORDER BY c.id DESC LIMIT ?')
        .all(run, ...(taskId === null ? [] : [taskId]), ...(checkpointCursor === null ? [] : [checkpointCursor]), limit + 1)
        .map(row => ({ ...row, evidence: false, context_source: 'model_authored' }))
      const lifecycle = db.prepare('SELECT id,run_id,session_id,event_type,source,event_seq,turn,step,reason_kind,error_code,node_version,package_version,host_version,process_instance,window_truncated,observed_at FROM lifecycle_event WHERE run_id IS ?'
        + (run === null ? ' AND session_id=?' : '') + (lifecycleCursor === null ? '' : ' AND id<?') + ' ORDER BY id DESC LIMIT ?')
        .all(run, ...(run === null ? [caller] : []), ...(lifecycleCursor === null ? [] : [lifecycleCursor]), limit + 1)
        .map(row => ({ ...row, window_truncated: row.window_truncated === 1 }))
      const windowTruncated = db.prepare('SELECT 1 FROM lifecycle_event WHERE run_id IS ?'
        + (run === null ? ' AND session_id=?' : '') + ' AND window_truncated=1 LIMIT 1').get(run, ...(run === null ? [caller] : [])) !== undefined
      const continuation = { operations: null, checkpoints: null, lifecycle: null }
      let truncated = false
      for (const [key, rows] of Object.entries({ operations, checkpoints, lifecycle })) {
        if (rows.length > limit) { rows.pop(); continuation[key] = rows.at(-1)?.id ?? null; truncated = true }
      }
      const integrity = { mismatched_events: 0, mismatched_checkpoints: 0, mismatched_controls: 0 }
      if (run !== null) {
        for (const [table, key] of [['task_event', 'mismatched_events'], ['task_checkpoint', 'mismatched_checkpoints'], ['control_operation', 'mismatched_controls']]) {
          integrity[key] = Number(db.prepare('SELECT COUNT(*) n FROM ' + table + ' r JOIN task t ON t.id=r.task_id WHERE t.run_id IS ? AND r.run_id IS NOT t.run_id'
            + (taskId === null ? '' : ' AND t.id=?')).get(run, ...(taskId === null ? [] : [taskId])).n)
        }
      }
      const pendingVerification = run === null ? 0 : Number(db.prepare("SELECT COUNT(*) n FROM execution_receipt e JOIN task t ON t.id=e.task_id AND t.run_id IS e.run_id WHERE e.run_id IS ? AND e.status IN ('pending','unknown')"
        + (taskId === null ? '' : ' AND e.task_id=?')).get(run, ...(taskId === null ? [] : [taskId])).n)
      return bounded({ operations, checkpoints, lifecycle, lifecycle_scope: run === null ? 'direct_caller' : 'run', continuation, truncated, scope_integrity: integrity,
        pending_verification: pendingVerification, effects_replayed: 0, tree_quiescent: null,
        observation_gaps: ['No automatic outcome reconciliation: pending/unknown does not prove failure.',
          'No host exit or process-tree observation is implied by store reopening.',
          'host_entrypoint_unobserved', ...this.observationGaps,
          ...(windowTruncated ? ['lifecycle_window_truncated'] : [])] }, ['operations', 'checkpoints', 'lifecycle'])
    })
  }
  diagnosticBundle(input = {}, runId) {
    const run = runScope(runId)
    if (run === null) throw fail('E_RECOVERY_SCOPE', 'diagnostic export requires a verified run')
    const db = this.store.open()
    return withReadTransaction(db, () => {
      const state = this.inspect(input, run), timeline = this.timeline(input, run)
      const checkpointMetadata = state.checkpoints.map(({ id, task_id, actor_session, owner_session, evidence_generation, created_at, omitted_fields }) =>
        ({ id, task_id, actor_session, owner_session, evidence_generation, created_at,
          ...(omitted_fields ? { omitted_fields: omitted_fields.filter(field => !['summary', 'next_action'].includes(field)) } : {}) }))
      return bounded({ format: 1, generated_at: now(), run_id: run,
        operations: state.operations, checkpoints: checkpointMetadata, events: timeline.events, lifecycle: state.lifecycle,
        scope_integrity: state.scope_integrity, pending_verification: state.pending_verification,
        truncated: state.truncated || timeline.truncated, observation_gaps: state.observation_gaps,
        omitted: ['prompts', 'reasoning', 'messages', 'commands', 'environment', 'raw_errors', 'paths', 'logs', 'checkpoint_context', 'request_keys', 'payload_hashes'] },
      ['operations', 'checkpoints', 'events', 'lifecycle'])
    })
  }
}
