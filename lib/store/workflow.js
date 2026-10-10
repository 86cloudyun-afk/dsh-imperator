/** Synchronous workflow gates shared by the public store and governor.
 * The host supplies identities. This API is not a same-UID filesystem sandbox. */
import { createHash } from 'node:crypto'
import { validResolutionSql } from './evidence.js'
import { strictExecutionEvidence } from './execution.js'

export const WORKFLOW_DDL = `
CREATE TABLE IF NOT EXISTS workflow (
 task_id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, template TEXT NOT NULL,
 stage TEXT NOT NULL, row_version INTEGER NOT NULL, plan_version INTEGER NOT NULL,
 plan TEXT NOT NULL, revision_id INTEGER, max_reworks INTEGER NOT NULL, rework_count INTEGER NOT NULL,
 created_by_session TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_run ON workflow(run_id,task_id);
CREATE TABLE IF NOT EXISTS task_dependency (
 task_id INTEGER NOT NULL, prerequisite_task_id INTEGER NOT NULL, run_id TEXT NOT NULL,
 created_by_session TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,prerequisite_task_id)
);
CREATE INDEX IF NOT EXISTS idx_dependency_prerequisite ON task_dependency(prerequisite_task_id,task_id);
CREATE TABLE IF NOT EXISTS task_dependency_fence (
 task_id INTEGER NOT NULL, run_id TEXT NOT NULL, evidence_generation INTEGER NOT NULL,
 prerequisite_task_id INTEGER NOT NULL, prerequisite_generation INTEGER NOT NULL,
 PRIMARY KEY(task_id,evidence_generation,prerequisite_task_id)
);
CREATE TABLE IF NOT EXISTS workflow_writer (
 task_id INTEGER NOT NULL, run_id TEXT NOT NULL, evidence_generation INTEGER NOT NULL,
 session_id TEXT NOT NULL, PRIMARY KEY(task_id,evidence_generation,session_id)
);
CREATE TABLE IF NOT EXISTS workflow_artifact (
 id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, run_id TEXT NOT NULL,
 plan_version INTEGER NOT NULL, evidence_generation INTEGER NOT NULL,
 producer_session TEXT NOT NULL, receipt_id TEXT NOT NULL, snapshot TEXT NOT NULL,
 logs TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_artifact ON workflow_artifact(task_id,id);
CREATE TABLE IF NOT EXISTS workflow_review (
 id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, run_id TEXT NOT NULL,
 revision_id INTEGER NOT NULL, plan_version INTEGER NOT NULL, evidence_generation INTEGER NOT NULL,
 reviewer_session TEXT NOT NULL, requirements_result TEXT NOT NULL, quality_result TEXT NOT NULL,
 findings TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_review ON workflow_review(task_id,id);
CREATE TABLE IF NOT EXISTS workflow_decision (
 id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, run_id TEXT NOT NULL,
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, action TEXT NOT NULL,
 actor_session TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
 result TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(run_id,request_key)
);
CREATE INDEX IF NOT EXISTS idx_workflow_decision ON workflow_decision(task_id,id);
`

export function workflowError(code, message) { throw Object.assign(new Error(message), { code }) }
export function workflowText(value, label, max = 200) {
 if (typeof value !== 'string' || !value.trim() || value.length > max) workflowError('E_WORKFLOW_INPUT', label + ' must be bounded nonblank text')
 return value
}
export function workflowInteger(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
 if (!Number.isSafeInteger(value) || value < min || value > max) workflowError('E_WORKFLOW_INPUT', label + ' is out of bounds')
 return value
}
export function workflowActor(actor, root = false) {
 if (!actor || typeof actor.isRoot !== 'boolean' || typeof actor.sessionId !== 'string' || !actor.sessionId.trim() || actor.sessionId.length > 200
   || (root && actor.isRoot !== true)) workflowError('E_WORKFLOW_ROLE', 'trusted real session identity and required role are necessary')
 return actor
}
export function workflowFields(input, allowed) {
 if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) workflowError('E_WORKFLOW_INPUT', 'unsupported workflow input')
 workflowJSON(input, 32768)
}
export function workflowJSON(value, max = 65536) {
 let result
 try { result = JSON.stringify(value) } catch { workflowError('E_WORKFLOW_INPUT', 'workflow payload must be serializable') }
 if (typeof result !== 'string' || Buffer.byteLength(result) > max) workflowError('E_WORKFLOW_INPUT', 'workflow payload exceeds byte budget')
 return result
}
function canonical(value, depth = 0) {
 if (depth > 12) workflowError('E_WORKFLOW_INPUT', 'workflow payload nesting exceeds limit')
 if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1))
 if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k], depth + 1)]))
 return value
}
export function workflowHash(action, args, actor) {
 return createHash('sha256').update(workflowJSON(canonical({ action, args, sessionId: actor.sessionId, isRoot: actor.isRoot }))).digest('hex')
}
export function workflowTask(db, taskId, run) {
 workflowText(run, 'runId'); workflowInteger(taskId, 'task_id')
 const task = db.prepare('SELECT * FROM task WHERE id=?').get(taskId)
 if (!task || task.run_id !== run) workflowError('E_CROSS_RUN', 'task is unavailable in this run')
 return task
}
export function workflowIntegrity(db, task) {
 // Detached workflow stores may predate recovery. When present, task-linked
 // recovery rows obey the same ownership gate; unassigned controls do not join.
 const recoveryTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('task_event','task_checkpoint','control_operation')").all().map(row => row.name)
 for (const table of ['fact', 'handoff', 'execution_receipt', 'execution_waiver', 'task_dependency', 'task_dependency_fence', 'workflow_writer', 'workflow_artifact', 'workflow_review', 'workflow_decision', ...recoveryTables]) {
  if (db.prepare('SELECT 1 FROM ' + table + ' WHERE task_id=? AND run_id IS NOT ? LIMIT 1').get(task.id, task.run_id)) {
   workflowError('E_STORE_INTEGRITY', 'workflow has inconsistent attached record ownership')
  }
 }
 for (const table of ['task_dependency', 'task_dependency_fence']) {
  if (db.prepare('SELECT 1 FROM ' + table + ' d LEFT JOIN task t ON t.id=d.prerequisite_task_id WHERE d.task_id=? AND (t.id IS NULL OR t.run_id IS NOT d.run_id) LIMIT 1').get(task.id)) {
   workflowError('E_STORE_INTEGRITY', 'workflow has inconsistent dependency ownership')
  }
 }
}
export function workflowOf(db, task) {
 const row = db.prepare('SELECT * FROM workflow WHERE task_id=?').get(task.id)
 if (!row) return null
 if (row.run_id !== task.run_id) workflowError('E_STORE_INTEGRITY', 'workflow ownership is inconsistent')
 workflowIntegrity(db, task)
 return row
}
export function workflowReplay(db, run, action, args, actor) {
 workflowText(args.request_key, 'request_key')
 const hash = workflowHash(action, args, actor)
 const prior = db.prepare('SELECT request_hash,result FROM workflow_decision WHERE run_id=? AND request_key=?').get(run, args.request_key)
 if (!prior) return null
 if (prior.request_hash !== hash) workflowError('E_WORKFLOW_REPLAY', 'request key already has a different payload or identity')
 return JSON.parse(prior.result)
}
export function workflowVersion(flow, args) {
 if (args.expected_version !== flow.row_version) workflowError('E_WORKFLOW_VERSION', 'workflow version changed; read state before retrying')
}
export function workflowAudit(db, task, action, args, actor, before, result) {
 const encoded = workflowJSON(result)
 db.prepare('INSERT INTO workflow_decision(task_id,run_id,request_key,request_hash,action,actor_session,from_version,to_version,result,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run(task.id, task.run_id, args.request_key, workflowHash(action, args, actor), action, actor.sessionId, before,
   db.prepare('SELECT row_version FROM workflow WHERE task_id=?').get(task.id).row_version, encoded, new Date().toISOString())
 return result
}
export function workflowDependencies(db, task, capture = false, allowMissing = false) {
 // The current SQLite snapshot is the cache boundary. Accepted intermediates
 // must still satisfy their own historical fences; checking them never creates
 // replacement fences or changes the meaning of an earlier acceptance.
 const active = new Set(), checked = new Map()
 let workflowCount = 0, edgeCount = 0
 const visit = (current, prerequisite) => {
  if (active.has(current.id)) workflowError('E_STORE_INTEGRITY', 'workflow dependency graph contains a cycle')
  if (checked.has(current.id)) return checked.get(current.id)
  active.add(current.id)
  const flow = workflowOf(db, current)
  if (!flow) workflowIntegrity(db, current)
  if (flow && ++workflowCount > 256) workflowError('E_STORE_INTEGRITY', 'workflow dependency closure exceeds the run bound')
  if (prerequisite) {
   const blockers = db.prepare("SELECT 1 FROM fact b WHERE b.task_id=? AND b.run_id=? AND b.kind='blocker' AND NOT EXISTS (SELECT 1 FROM fact r WHERE " + validResolutionSql('r', 'b') + ') LIMIT 1').get(current.id, current.run_id)
   if (current.status !== 'accepted' || blockers) workflowError('E_WORKFLOW_DEPENDENCY', 'workflow prerequisite is not accepted without blockers')
  }
  const deps = db.prepare('SELECT prerequisite_task_id FROM task_dependency WHERE task_id=? AND run_id=? ORDER BY prerequisite_task_id LIMIT 65').all(current.id, current.run_id)
  edgeCount += deps.length
  if (deps.length > 64 || edgeCount > 256 * 64 || (!flow && deps.length)) workflowError('E_STORE_INTEGRITY', 'workflow dependency bounds or ownership are inconsistent')
  for (const dep of deps) {
   const upstream = workflowTask(db, dep.prerequisite_task_id, current.run_id)
   const fence = db.prepare('SELECT prerequisite_generation FROM task_dependency_fence WHERE task_id=? AND evidence_generation=? AND prerequisite_task_id=?')
    .get(current.id, current.evidence_generation, upstream.id)
   if (fence && fence.prerequisite_generation !== upstream.evidence_generation) workflowError('E_WORKFLOW_DEPENDENCY', 'workflow prerequisite generation changed; explicit rework required')
   const captureHere = !prerequisite && capture
   if (!fence && !captureHere && !(!prerequisite && allowMissing)) workflowError('E_WORKFLOW_DEPENDENCY', 'workflow dependency generation has not been captured')
   visit(upstream, true)
   if (!fence && captureHere) db.prepare('INSERT INTO task_dependency_fence(task_id,run_id,evidence_generation,prerequisite_task_id,prerequisite_generation) VALUES(?,?,?,?,?)')
    .run(current.id, current.run_id, current.evidence_generation, upstream.id, upstream.evidence_generation)
  }
  const ids = deps.map(d => d.prerequisite_task_id)
  active.delete(current.id)
  checked.set(current.id, ids)
  return ids
 }
 return visit(task, false)
}
export function workflowAdmission(db, task) {
 const flow = workflowOf(db, task)
 if (!flow) return
 if (flow.stage === 'plan' || flow.stage === 'completed') workflowError('E_WORKFLOW_STAGE', 'workflow plan must be approved before admission')
 workflowDependencies(db, task, true)
}
export function workflowClaim(db, task, ownerSession) {
 const flow = workflowOf(db, task)
 if (!flow) return
 workflowText(ownerSession, 'real owner session')
 workflowAdmission(db, task)
 db.prepare('INSERT OR IGNORE INTO workflow_writer(task_id,run_id,evidence_generation,session_id) VALUES(?,?,?,?)')
  .run(task.id, task.run_id, task.evidence_generation, ownerSession)
}
export function workflowSubmit(db, task) {
 const flow = workflowOf(db, task)
 if (!flow) return
 // Leave rejected/terminal status semantics to the public store, including
 // completed decision replay. Active submissions require a real claimed owner.
 if (['open','claimed','submitted'].includes(task.status)
   && (!['implement','test','review','lead_acceptance'].includes(flow.stage)
     || typeof task.owner_session !== 'string' || !task.owner_session.trim())) {
  workflowError('E_WORKFLOW_STAGE', 'workflow submission requires an approved plan and a bound real owner')
 }
 workflowDependencies(db, task)
}
/** Current and actually delivered same-generation failures require root return. */
export function workflowDeliveryGate(db, task, flow, action) {
 // Older writers could clear revision_id or replace a failed artifact without
 // advancing the generation. Preserve that delivered history across upgrades;
 // unrelated/orphan revision references are not an earlier delivery.
 const failed = db.prepare(`SELECT 1 FROM workflow_review r
  WHERE r.task_id=? AND r.run_id=? AND r.plan_version=? AND r.evidence_generation=?
   AND (r.requirements_result IS NOT 'pass' OR r.quality_result IS NOT 'pass')
   AND (r.revision_id=? OR EXISTS (SELECT 1 FROM workflow_artifact a
    WHERE a.id=r.revision_id AND a.task_id=r.task_id AND a.run_id=r.run_id
     AND a.plan_version=r.plan_version AND a.evidence_generation=r.evidence_generation)) LIMIT 1`)
  .get(task.id, task.run_id, flow.plan_version, task.evidence_generation, flow.revision_id)
 const frozen = action === 'replace' && ['review','lead_acceptance'].includes(flow.stage)
 if (failed || frozen) {
  const code = action === 'accept' ? 'E_WORKFLOW_EVIDENCE' : action === 'review' ? 'E_WORKFLOW_REVIEW' : 'E_WORKFLOW_STAGE'
  workflowError(code, 'delivery is frozen; explicit root return within the rework budget is required')
 }
}
export function workflowVerificationStarted(db, task) {
 const flow = workflowOf(db, task)
 if (!flow) return
 if (flow.stage === 'plan' || flow.stage === 'completed') workflowError('E_WORKFLOW_STAGE', 'workflow is not ready for verification')
 workflowDeliveryGate(db, task, flow, 'replace')
 workflowDependencies(db, task)
 db.prepare("UPDATE workflow SET stage='test',revision_id=NULL,row_version=row_version+1,updated_at=? WHERE task_id=?")
  .run(new Date().toISOString(), task.id)
}
export function workflowStartDecision(db, task, args, actor, action) {
 const flow = workflowOf(db, task)
 if (!flow) return null
 workflowActor(actor, true)
 if (actor.sessionId !== task.run_id) workflowError('E_WORKFLOW_ROLE', 'root identity must match the exact run')
 const prior = workflowReplay(db, task.run_id, action, args, actor)
 if (prior) return { replay: true, result: prior }
 workflowVersion(flow, args)
 if (action === 'accept' && args.waiver_reason !== undefined && args.waiver_reason !== null) workflowError('E_WORKFLOW_EVIDENCE', 'coding workflows do not permit acceptance waivers')
 if (action === 'reject' && flow.rework_count >= flow.max_reworks) workflowError('E_WORKFLOW_BUDGET', 'workflow rework budget is exhausted')
 return { replay: false, flow }
}
export function workflowAccept(db, root, task, args, actor) {
 const flow = workflowOf(db, task)
 if (!flow) return
 workflowActor(actor, true)
 if (actor.sessionId !== task.run_id) workflowError('E_WORKFLOW_ROLE', 'root identity must match the exact run')
 workflowDependencies(db, task)
 workflowDeliveryGate(db, task, flow, 'accept')
 const receipt = strictExecutionEvidence(db, root, task)
 const artifact = db.prepare('SELECT * FROM workflow_artifact WHERE id=? AND task_id=? AND run_id=?').get(flow.revision_id, task.id, task.run_id)
 const review = db.prepare('SELECT * FROM workflow_review WHERE task_id=? AND run_id=? ORDER BY id DESC LIMIT 1').get(task.id, task.run_id)
 const writer = review && db.prepare('SELECT 1 FROM workflow_writer WHERE task_id=? AND session_id=? LIMIT 1').get(task.id, review.reviewer_session)
 if (flow.stage !== 'lead_acceptance' || !artifact || !review || writer || review.reviewer_session === task.owner_session
   || artifact.evidence_generation !== task.evidence_generation || artifact.plan_version !== flow.plan_version
   || artifact.receipt_id !== receipt.receipt_id || artifact.producer_session !== task.owner_session
   || artifact.snapshot !== JSON.stringify(receipt.snapshot) || artifact.logs !== JSON.stringify(receipt.logs)
   || review.revision_id !== artifact.id || review.plan_version !== flow.plan_version || review.evidence_generation !== task.evidence_generation
   || review.requirements_result !== 'pass' || review.quality_result !== 'pass') workflowError('E_WORKFLOW_EVIDENCE', 'current artifact and independent passing review are required')
}
export function workflowFinishDecision(db, task, args, actor, action, result) {
 const flow = workflowOf(db, task)
 if (!flow) return result
 if (action === 'accept') {
  db.prepare("UPDATE workflow SET stage='completed',row_version=row_version+1,updated_at=? WHERE task_id=?").run(new Date().toISOString(), task.id)
 } else {
  // Returning an unapproved plan invalidates evidence without approving it.
  const stage = flow.stage === 'plan' ? 'plan' : 'implement'
  db.prepare("UPDATE workflow SET stage=?,revision_id=NULL,rework_count=rework_count+1,row_version=row_version+1,updated_at=? WHERE task_id=?").run(stage, new Date().toISOString(), task.id)
 }
 return workflowAudit(db, task, action, args, actor, flow.row_version, result)
}
