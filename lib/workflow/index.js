/** Durable, host-only coding workflow. Methods record state; none dispatch or publish. */
import { withReadTransaction, withWriteTransaction } from '../store/sqlite.js'
import { executionPolicy, strictExecutionEvidence } from '../store/execution.js'
import { workflowError as fail, workflowText as text, workflowInteger as integer,
 workflowActor as actorOf, workflowFields as fields, workflowJSON as json,
 workflowTask as taskOf, workflowOf, workflowReplay as replay, workflowVersion as version,
 workflowAudit as audit, workflowDependencies as dependencies } from '../store/workflow.js'

const COMMON = ['task_id', 'expected_version', 'request_key']
const now = () => new Date().toISOString()
export class TaskforceWorkflow {
 #store
 constructor(store) {
  if (!store || typeof store.open !== 'function') throw new TypeError('TaskforceStore required')
  this.#store = store
 }
 #db() { return this.#store.open() }
 #scope(run, actor, root = false) {
  text(run, 'runId'); actorOf(actor, root)
  if (actor.isRoot && actor.sessionId !== run) fail('E_WORKFLOW_ROLE', 'root identity must match the exact run')
 }
 #mutate(action, args, run, actor, allowed, root, work) {
  fields(args, [...COMMON, ...allowed]); this.#scope(run, actor, root)
  const db = this.#db()
  return withWriteTransaction(db, () => {
   const task = taskOf(db, args.task_id, run), flow = workflowOf(db, task)
   if (!flow) fail('E_WORKFLOW_STAGE', 'task does not have a workflow')
   const previous = replay(db, run, action, args, actor)
   if (previous) return previous
   version(flow, args)
   if (db.prepare('SELECT COUNT(*) AS n FROM workflow_decision WHERE task_id=?').get(task.id).n >= 512) fail('E_WORKFLOW_BUDGET', 'workflow history mutation budget is exhausted')
   const result = work(db, task, flow)
   return audit(db, task, action, args, actor, flow.row_version, result)
  })
 }
 #bump(db, id, stage, revision) {
  db.prepare('UPDATE workflow SET stage=?,revision_id=?,row_version=row_version+1,updated_at=? WHERE task_id=?').run(stage, revision, now(), id)
 }
 #replaceDependencies(db, task, ids, actor) {
  if (!Array.isArray(ids) || ids.length > 64) fail('E_WORKFLOW_INPUT', 'dependencies must contain at most 64 task IDs')
  const unique = [...new Set(ids.map(id => integer(id, 'prerequisite_task_id')))].sort((a,b) => a-b)
  for (const id of unique) {
   taskOf(db, id, task.run_id)
   if (id === task.id || db.prepare('WITH RECURSIVE reach(id) AS (SELECT prerequisite_task_id FROM task_dependency WHERE task_id=? AND run_id=? UNION SELECT d.prerequisite_task_id FROM task_dependency d JOIN reach r ON d.task_id=r.id WHERE d.run_id=?) SELECT 1 FROM reach WHERE id=? LIMIT 1')
    .get(id, task.run_id, task.run_id, task.id)) fail('E_WORKFLOW_CYCLE', 'dependency graph must remain acyclic')
  }
  db.prepare('DELETE FROM task_dependency WHERE task_id=? AND run_id=?').run(task.id, task.run_id)
  for (const id of unique) db.prepare('INSERT INTO task_dependency(task_id,prerequisite_task_id,run_id,created_by_session,created_at) VALUES(?,?,?,?,?)')
   .run(task.id, id, task.run_id, actor.sessionId, now())
 }
 create(args, run, actor) {
  fields(args, ['task_id','title','template','plan','dependencies','max_reworks','evidence_policy','verification_files','verification_command','request_key'])
  this.#scope(run, actor, true)
  const db = this.#db()
  return withWriteTransaction(db, () => {
   const previous = replay(db, run, 'create', args, actor)
   if (previous) return previous
   if ((args.template ?? 'coding') !== 'coding' || (args.evidence_policy ?? 'execution') !== 'execution') fail('E_WORKFLOW_INPUT', 'coding workflows require execution evidence')
   fields(args.plan, ['objective', 'scope', 'non_goals', 'deliverables'])
   text(args.plan.objective, 'objective', 4096)
   for (const name of ['scope','non_goals','deliverables']) {
    if (!Array.isArray(args.plan[name]) || args.plan[name].length > 64) fail('E_WORKFLOW_INPUT', 'plan lists must be bounded arrays')
    for (const item of args.plan[name]) text(item, name, 512)
   }
   const plan = json(args.plan, 16384), budget = integer(args.max_reworks ?? 2, 'max_reworks', 0, 8)
   if (!Array.isArray(args.verification_files) || args.verification_files.length > 64) fail('E_WORKFLOW_INPUT', 'verification manifest must contain at most 64 files')
   for (const file of args.verification_files) text(file, 'verification file', 512)
   text(args.verification_command, 'verification command', 8192)
   const policy = executionPolicy({ ...args, evidence_policy: 'execution' }, actor)
   if (db.prepare('SELECT COUNT(*) AS n FROM workflow WHERE run_id=?').get(run).n >= 256) fail('E_WORKFLOW_BUDGET', 'run workflow limit reached')
   let task
   if (args.task_id !== undefined) {
    task = taskOf(db, args.task_id, run)
    if (task.status !== 'open' || task.owner !== null || task.owner_session !== null || task.evidence_generation !== 0
      || workflowOf(db, task) || ['fact','handoff','execution_receipt','execution_waiver'].some(table => db.prepare('SELECT 1 FROM ' + table + ' WHERE task_id=? LIMIT 1').get(task.id))) fail('E_WORKFLOW_STAGE', 'only an untouched open task may adopt a workflow')
    db.prepare('UPDATE task SET evidence_policy=?,verification_files=?,verification_command=?,verification_cwd=? WHERE id=?')
     .run(policy.evidence_policy,policy.verification_files,policy.verification_command,policy.verification_cwd,task.id)
   } else {
    const created = this.#store.openTask({ title: text(args.title, 'title', 512), evidence_policy: 'execution',
     verification_files: args.verification_files, verification_command: args.verification_command }, run, actor)
    task = taskOf(db, created.task_id, run)
   }
   const timestamp = now()
   db.prepare("INSERT INTO workflow(task_id,run_id,template,stage,row_version,plan_version,plan,revision_id,max_reworks,rework_count,created_by_session,created_at,updated_at) VALUES(?,?,'coding','plan',1,1,?,NULL,?,0,?,?,?)")
    .run(task.id, run, plan, budget, actor.sessionId, timestamp, timestamp)
   this.#replaceDependencies(db, task, args.dependencies ?? [], actor)
   return audit(db, task, 'create', args, actor, 0, { task_id: task.id, stage: 'plan', row_version: 1, evidence_policy: 'execution' })
  })
 }
 setDependencies(args, run, actor) {
  return this.#mutate('setDependencies', args, run, actor, ['prerequisite_task_ids'], true, (db, task, flow) => {
   if (flow.stage !== 'plan' || task.status !== 'open') fail('E_WORKFLOW_STAGE', 'dependencies are immutable after plan approval')
   this.#replaceDependencies(db, task, args.prerequisite_task_ids, actor)
   this.#bump(db, task.id, flow.stage, flow.revision_id)
   return { task_id: task.id, row_version: flow.row_version + 1, dependencies: [...new Set(args.prerequisite_task_ids)].sort((a,b)=>a-b) }
  })
 }
 approvePlan(args, run, actor) {
  return this.#mutate('approvePlan', args, run, actor, [], true, (db, task, flow) => {
   if (flow.stage !== 'plan') fail('E_WORKFLOW_STAGE', 'only a plan may be approved')
   this.#bump(db, task.id, 'implement', null)
   return { task_id: task.id, stage: 'implement', row_version: flow.row_version + 1 }
  })
 }
 recordArtifact(args, run, actor) {
  return this.#mutate('recordArtifact', args, run, actor, [], false, (db, task, flow) => {
   if (actor.isRoot || actor.sessionId !== task.owner_session) fail('E_WORKFLOW_ROLE', 'artifact requires the real current worker owner')
   if (!['claimed','submitted'].includes(task.status) || ['plan','completed'].includes(flow.stage)) fail('E_WORKFLOW_STAGE', 'workflow is not executing')
   dependencies(db, task)
   const receipt = strictExecutionEvidence(db, this.#store.root, task)
   const result = { task_id: task.id, receipt_id: receipt.receipt_id, snapshot: receipt.snapshot, logs: receipt.logs,
    evidence_generation: task.evidence_generation, row_version: flow.row_version + 1 }
   json(result, 60000)
   const inserted = db.prepare('INSERT INTO workflow_artifact(task_id,run_id,plan_version,evidence_generation,producer_session,receipt_id,snapshot,logs,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(task.id, run, flow.plan_version, task.evidence_generation, actor.sessionId, receipt.receipt_id, JSON.stringify(receipt.snapshot), JSON.stringify(receipt.logs), now())
   result.revision_id = Number(inserted.lastInsertRowid)
   this.#bump(db, task.id, 'review', result.revision_id)
   return result
  })
 }
 recordReview(args, run, actor) {
  return this.#mutate('recordReview', args, run, actor, ['revision_id','requirements_result','quality_result','findings'], false, (db, task, flow) => {
   if (flow.stage !== 'review' || flow.revision_id !== args.revision_id) fail('E_WORKFLOW_REVIEW', 'review must bind the current revision')
   if (actor.isRoot || actor.sessionId === task.owner_session || db.prepare('SELECT 1 FROM workflow_writer WHERE task_id=? AND session_id=? LIMIT 1').get(task.id, actor.sessionId)) fail('E_WORKFLOW_REVIEW', 'reviewer must be a distinct real session with no recorded implementation contribution')
   if (!['pass','fail','unverified'].includes(args.requirements_result) || !['pass','fail','unverified'].includes(args.quality_result)
     || !Array.isArray(args.findings) || args.findings.length > 64) fail('E_WORKFLOW_INPUT', 'bounded review results and findings required')
   for (const finding of args.findings) text(finding, 'finding', 1024)
   const receipt = strictExecutionEvidence(db, this.#store.root, task)
   const artifact = db.prepare('SELECT receipt_id,evidence_generation FROM workflow_artifact WHERE id=? AND task_id=? AND run_id=?').get(flow.revision_id,task.id,run)
   if (!artifact || artifact.receipt_id !== receipt.receipt_id || artifact.evidence_generation !== task.evidence_generation) fail('E_WORKFLOW_REVIEW', 'artifact is stale')
   dependencies(db, task)
   const inserted = db.prepare('INSERT INTO workflow_review(task_id,run_id,revision_id,plan_version,evidence_generation,reviewer_session,requirements_result,quality_result,findings,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(task.id,run,flow.revision_id,flow.plan_version,task.evidence_generation,actor.sessionId,args.requirements_result,args.quality_result,json(args.findings,16384),now())
   const stage = args.requirements_result === 'pass' && args.quality_result === 'pass' ? 'lead_acceptance' : 'review'
   this.#bump(db, task.id, stage, flow.revision_id)
   return { task_id: task.id, review_id: Number(inserted.lastInsertRowid), revision_id: flow.revision_id, stage, row_version: flow.row_version + 1 }
  })
 }
 returnForRework(args, run, actor) {
  fields(args, [...COMMON, 'reason']); this.#scope(run, actor, true)
  text(args.reason, 'reason', 4096)
  return this.#store.rejectTask(args, run, actor)
 }
 state(args, run) {
  fields(args, ['task_id']); text(run, 'runId')
  const db = this.#db()
  return withReadTransaction(db, () => {
   const task = taskOf(db, args.task_id, run), flow = workflowOf(db, task)
   if (!flow) fail('E_WORKFLOW_STAGE', 'task does not have a workflow')
   let blocked = false, blocked_code = null
   try {
    dependencies(db, task, false, flow.stage === 'plan' || ['open','rejected'].includes(task.status))
   } catch (error) {
    if (!['E_WORKFLOW_DEPENDENCY','E_STORE_INTEGRITY','E_CROSS_RUN'].includes(error.code)) throw error
    blocked = true; blocked_code = error.code
   }
   const result = { task_id: task.id, task_status: task.status, stage: flow.stage, row_version: flow.row_version,
    plan_version: flow.plan_version, revision_id: flow.revision_id, evidence_generation: task.evidence_generation,
    max_reworks: flow.max_reworks, rework_count: flow.rework_count, blocked, blocked_code,
    dependencies: db.prepare('SELECT prerequisite_task_id FROM task_dependency WHERE task_id=? AND run_id=? ORDER BY prerequisite_task_id').all(task.id,run).map(r=>r.prerequisite_task_id),
    artifacts: db.prepare('SELECT id AS revision_id,receipt_id,evidence_generation,producer_session,created_at FROM workflow_artifact WHERE task_id=? AND run_id=? ORDER BY id DESC LIMIT 20').all(task.id,run).map(r=>({...r})),
    reviews: db.prepare('SELECT id,revision_id,evidence_generation,reviewer_session,requirements_result,quality_result,created_at FROM workflow_review WHERE task_id=? AND run_id=? ORDER BY id DESC LIMIT 20').all(task.id,run).map(r=>({...r})),
    history_truncated: db.prepare('SELECT (SELECT COUNT(*) FROM workflow_artifact WHERE task_id=?)>20 OR (SELECT COUNT(*) FROM workflow_review WHERE task_id=?)>20 AS value').get(task.id,task.id).value === 1,
    capabilities: { automatic_dispatch: false, publishing: false, native_managed_execution: false } }
   json(result)
   return result
  })
 }
 ready(args = {}, run) {
  fields(args, ['limit']); text(run, 'runId')
  const limit = integer(args.limit ?? 25, 'limit', 1, 100), db = this.#db()
  return withReadTransaction(db, () => {
   const tasks = []
   for (const row of db.prepare("SELECT w.task_id FROM workflow w JOIN task t ON t.id=w.task_id AND t.run_id=w.run_id WHERE w.run_id=? AND w.stage != 'completed' AND t.status IN ('open','claimed','submitted','rejected') ORDER BY w.task_id LIMIT 257").all(run)) {
    if (tasks.length >= limit) break
    const value = this.state({ task_id: row.task_id }, run)
    if (!value.blocked && value.stage !== 'plan') tasks.push({ task_id: value.task_id, stage: value.stage, row_version: value.row_version })
   }
   return { tasks, limit, automatic_dispatch: false }
  })
 }
}
