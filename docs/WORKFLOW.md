# Coding workflows and dependency gates

TaskforceWorkflow is a durable host-only service over the existing TaskforceStore connection. Its methods record decisions and evidence; they do not start agents, execute commands, publish branches, create PRs, or merge.

The coding template defaults to execution evidence. Ordinary openTask calls retain their legacy default. Existing tasks may adopt a workflow only while untouched and open. Creation requires the current strict executionPolicy contract: a trusted root session, its existing absolute working directory, a nonempty list of existing files and a fixed command. Missing future outputs are rejected. There is no implicit manifest update or policy downgrade.

## API

Import TaskforceWorkflow from lib/workflow/index.js and instantiate it with the store. Every mutation receives input, runId, trustedActor separately. Trusted actor is {sessionId,isRoot,cwd?}; real IDs retain whitespace. Root session ID must equal run ID. Model fields never supply this identity.

- create({task_id? OR title,template?:'coding',plan:{objective,scope,non_goals,deliverables},dependencies?,verification_files,verification_command,max_reworks?:2,request_key}, runId, actor).
- setDependencies({task_id,prerequisite_task_ids,expected_version,request_key}, runId, root).
- approvePlan({task_id,expected_version,request_key}, runId, root).
- recordArtifact({task_id,expected_version,request_key}, runId, currentWorker).
- recordReview({task_id,revision_id,requirements_result,quality_result,findings,expected_version,request_key}, runId, reviewer). Results are pass/fail/unverified; findings are bounded strings.
- returnForRework({task_id,reason,expected_version,request_key}, runId, root).
- state({task_id}, runId) and ready({limit?:25}, runId).

A request key is unique within its run. Equal payload and actual actor replay the original result, even after subsequent state changes; different content or identity conflicts. These receipts never authorize an external action. expected_version provides optimistic concurrency.

Stages are plan, implement, test, review, lead_acceptance, completed. Root approval leaves plan. An actual verification intent enters test and invalidates the current revision. A valid artifact enters review; a passing independent review enters lead_acceptance. Public store.acceptTask completes the workflow atomically with task acceptance. A failing/unverified review remains in review for root return. Root rework uses the existing task rejection and evidence generation; it also supports explicit return of active workflow tasks. It clears the current revision and preserves history. Returning a plan before its first approval keeps stage=plan and increments the rework/evidence generation; explicit approvePlan is still required before claim or admission.

## Dependency and evidence enforcement

Dependencies are same-run and acyclic, with at most 64 direct prerequisites. They freeze at plan approval. Claim and governor admission require accepted prerequisites without unresolved blockers or ownership-integrity defects. Admission/claim captures each prerequisite's evidence generation. Submit and acceptance recheck that generation; reject/reaccept upstream cannot revive old downstream evidence. Root must return the downstream task for a new generation. Readiness also checks the complete prerequisite closure: an accepted intermediate with stale ancestor fences cannot qualify downstream work. Each visited workflow header and attached record must belong to the same run; ordinary accepted legacy prerequisites remain supported. The traversal memoizes within one SQLite snapshot, rejects cycles, and caps the closure at 256 workflows and 16384 edges. Only the task being admitted may capture missing fences; ancestor fences are never recreated by checking readiness. Blocked dependencies never release governor holds or automatically cancel work.

Artifact input has no receipt, snapshot, hash, author or exit-code fields. The service reads the actual latest strict receipt, rechecks real source bytes and persisted log digests, and records its snapshot and logs as immutable provenance. Every artifact gets a new revision ID, including A-to-B-to-A changes. Existing artifact rows are never replaced.

Reviews bind that revision, plan version and evidence generation. Reviewer identity comes from the host. Current or historical assigned writers cannot review their own workflow; labels and later turns do not change identity. Acceptance repeats the independent-session and latest-receipt checks inside the shared store transaction. Missing/stale reviews, modified sources, missing/tampered logs, pending or failed latest receipts, unresolved dependencies and workflow waivers fail closed. Acceptance and rejection retain exact request replay receipts.

Writer tracking covers sessions bound through the store. It does not prove that unrestricted filesystem processes or unregistered contributors never wrote a file. Independent session identity is not a guarantee that model judgments are correct. Native managed entry remains disabled: official H01-H06 enforcement, target ingress and process-tree quiescence still require independently verified host capabilities. This core must not be described as automatic full-tree execution.

## Bounds and migration

There are at most 256 workflows per run, 64 prerequisites, 512 ordinary workflow mutation decisions per task and 0–8 configured reworks. Default reworks are 2. Input JSON is capped at 32768 UTF-8 bytes, plans at 16384, persisted/API results at 65536; overflowing artifact provenance fails without partial writes. State shows the latest 20 artifacts/reviews with an explicit history_truncated flag. Ready returns at most 100 compact rows. No cross-run listing is provided.

All tables are additive and created in the store migration transaction after existing schema migration. Existing task/fact/handoff rows and owner/run identifiers are not rewritten. Workflow child rows are checked against their parent run; dependency targets are checked too. Integrity errors never include foreign row contents. Reopening the store reconstructs state without external effects.

Do not run an older writer against a database containing governed workflows: the old program does not know these gates. Rollback requires matching software and a verified database backup. Service isolation does not prevent local processes with database/file permissions from bypassing the API.

## Verification and integration hooks

tools/tests/workflow-engine.test.mjs covers strict creation, DAG cycles including concurrent SQLite connections, dependency invalidation, public-store bypass prevention, real execution-derived artifacts, reviewer identity, replay/version conflicts, bounded rework, audit rollback, restart and scope corruption. Verification uses real Node syntax-check processes and actual SQLite; it is not paid-model or production-host acceptance.

lib/store/workflow.js exports WORKFLOW_DDL and synchronous shared helpers:

- workflowClaim(db, task, realOwner) before the claim transition.
- workflowAdmission(db, task) inside governor.reserve before reservation writes.
- workflowSubmit(db, task) before submission, including idempotent resubmission.
- workflowVerificationStarted(db, task) in the persisted execution-intent transaction.
- workflowStartDecision(db, task, args, actor, action) before normal accept/reject status checks; matching replay returns its stored result.
- workflowAccept(db, root, task, args, actor) before acceptance.
- workflowFinishDecision(db, task, args, actor, action, result) before commit.

All helpers are no-ops for ordinary tasks. Workflow/task/audit mutations share SQLite transactions. Governor admission generation remains distinct from task evidence_generation.
