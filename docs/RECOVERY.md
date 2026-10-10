# Recovery journal and checkpoints

Recovery records observations; it never replays effects, executes verification, changes ownership, waives evidence or accepts tasks. The store uses its current reconnectable SQLite connection and synchronous transactions.

Integrated child send/stop persists an intent before host invocation. Host acceptance is persisted before subsequent activity queries. A repeated request_key (or the same trusted turn/step/rootCallId/callId when no key is supplied) returns the original operation without invoking the host. A conflicting payload under the same key is rejected. Callers must reuse a key to check an ambiguous retry, not generate a replacement key. Detached legacy adapters without the recovery store retain their control capability and explicitly report durable:false, durability:"unavailable"; they have no replay protection.

The operation contains trusted direct caller, child, optional verified run/task, captured task generation, process instance, action, timestamps and outcome. Message content, stop reason, raw errors and arbitrary provider error codes are never journaled. A payload digest checks replay consistency and is excluded from diagnostics. Pending or unknown does not prove delivery failure. A crash after host acceptance and before outcome persistence can leave pending forever; explicit human investigation is required. Opening a second connection or restarting never marks another process abandoned.

Missing live agents are unknown. Explicit idle is an instantaneous observation. Stop acceptance and idle never establish process-tree quiescence; tree_quiescent remains null.

## Product tools

- task_checkpoint(task_id, summary, next_action?) stores up to4096/2048 UTF-8 bytes of model-authored recovery context, current owner and generation. Only the same-run root or actual owner can write it. It is not evidence and never restores authority.
- task_board(view="timeline", task_id?, limit?, cursor?) returns descending task transitions with a continuation cursor.
- task_board(view="recovery", task_id?, limit?, operation_cursor?, checkpoint_cursor?) returns controls and checkpoints, unresolved verification count, integrity counts and observation gaps. Use continuation.operations/checkpoints for each independent section.
- task_child_send/task_child_stop accept optional request_key, bounded to256 UTF-8 bytes. Keys share the caller's namespace across actions; matching replay never authorizes a second effect.

A broken root ancestry does not disable direct-child control. Unattributed operations are visible only through a trusted direct-caller scope, including the recovery view's fallback. They never become visible in every run or get guessed into the caller's root.

## Host interfaces

TaskforceRecovery(store) exports beginControl(input, authority), finishControl(input, authority), checkpoint(input, runId, trustedActor), timeline(input, runId), inspect(input, runId, directCaller?), diagnosticBundle(input, runId). Construct with new; TaskforceStore exposes its instance as store.recovery. authority.sessionId/runId/isRoot are supplied separately from model input.

RECOVERY_DDL is applied inside the existing store migration transaction. SQLite triggers append task_event rows atomically with state/owner/generation changes. These rows deliberately record actor_session:null and source:"database_change": owner is not actor, and a direct SQL update does not prove a host identity. Existing task mutation facts retain trusted actor attribution where applicable; checkpoints and control records have explicit trusted actors. Older tasks receive kind:"baseline", history_complete:false. Task history does not claim to capture host turn/error/exit events; missing lifecycle evidence is reported.

Adoption carries only NULL audit attached to originally NULL tasks in the same transaction, refuses already-assigned recovery audit, and preserves legacy adoption result keys. Mismatched recovery rows are hidden, counted, and block store acceptance through existing integrity checks. Detached control records without task attribution remain direct-caller scoped.

## Limits and evidence

Recovery pages default to25 rows, accept1–100 and fit16384 UTF-8 bytes including metadata. Sections expose truncation and continuation. IDs/keys cap at256 bytes; payload hashes are64 hex characters. Checkpoint summaries are included only in authorized recovery views. diagnosticBundle excludes them and allowlists metadata: IDs, counts, timestamps, statuses and the small fixed error-code set. It excludes prompts, reasoning, messages, commands, environment, raw errors, paths, logs, request keys and payload hashes. No export uploads anything.

The journal is an API boundary, not protection against same-UID database modification. No production crash cause is inferred from synthetic tests. Host turn-end reasons, agent error events, deployment versions and actual exit/supervisor observations must be collected from the real host to diagnose an incident; this release does not fabricate them.
