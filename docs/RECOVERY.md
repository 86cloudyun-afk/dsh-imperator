# Recovery journal and checkpoints

Recovery records observations; it never replays effects, executes verification, changes ownership, waives evidence or accepts tasks. The store uses its current reconnectable SQLite connection and synchronous transactions.

Integrated child send/stop persists an intent before host invocation. Host acceptance is persisted before subsequent activity queries. A repeated request_key (or the same trusted turn/step/rootCallId/callId when no key is supplied) returns the original operation without invoking the host. A conflicting payload under the same key is rejected. Callers must reuse a key to check an ambiguous retry, not generate a replacement key. Detached legacy adapters without the recovery store retain their control capability and explicitly report durable:false, durability:"unavailable"; they have no replay protection.

The operation contains trusted direct caller, child, optional verified run/task, captured task generation, process instance, action, timestamps and outcome. Message content, stop reason, raw errors and arbitrary provider error codes are never journaled. A payload digest checks replay consistency and is excluded from diagnostics. Pending or unknown does not prove delivery failure. A crash after host acceptance and before outcome persistence can leave pending forever; explicit human investigation is required. Opening a second connection or restarting never marks another process abandoned.

Missing live agents are unknown. Explicit idle is an instantaneous observation. Stop acceptance and idle never establish process-tree quiescence; tree_quiescent remains null.

## Product tools

- task_checkpoint(task_id, summary, next_action?) stores up to 4096/2048 UTF-8 bytes of model-authored recovery context, current owner and generation. Only the same-run root or actual owner can write it. It is not evidence and never restores authority.
- task_board(view="timeline", task_id?, limit?, cursor?) returns descending task transitions with a continuation cursor.
- task_board(view="recovery", task_id?, limit?, operation_cursor?, checkpoint_cursor?, lifecycle_cursor?) returns controls, checkpoints and scoped lifecycle observations, unresolved verification count, integrity counts and observation gaps. Use continuation.operations/checkpoints/lifecycle for each independent section.
- task_child_send/task_child_stop accept optional request_key, bounded to 256 UTF-8 bytes. Keys share the caller's namespace across actions; matching replay never authorizes a second effect.

A broken root ancestry does not disable direct-child control. Unattributed operations are visible only through a trusted direct-caller scope, including the recovery view's fallback. They never become visible in every run or get guessed into the caller's root.

## Host interfaces

TaskforceRecovery(store) exports beginControl(input, authority), finishControl(input, authority), checkpoint(input, runId, trustedActor), recordLifecycle(input, authority), timeline(input, runId), inspect(input, runId, directCaller?), diagnosticBundle(input, runId). Construct with new; TaskforceStore exposes its instance as store.recovery. authority.sessionId/runId/isRoot are supplied separately from model input.

RECOVERY_DDL is applied inside the existing store migration transaction. SQLite triggers append task_event rows atomically with state/owner/generation changes. These rows deliberately record actor_session:null and source:"database_change": owner is not actor, and a direct SQL update does not prove a host identity. Existing task mutation facts retain trusted actor attribution where applicable; checkpoints and control records have explicit trusted actors. Older tasks receive kind:"baseline", history_complete:false. Task history and host lifecycle observations have separate sources; neither claims earlier unavailable history is complete.

Adoption carries only NULL audit attached to originally NULL tasks in the same transaction, refuses already-assigned recovery audit, and preserves legacy adoption result keys. Mismatched recovery rows are hidden, counted, and block store acceptance through existing integrity checks. Detached control records without task attribution remain direct-caller scoped.

## Scoped lifecycle observations

The tools plugin installs listeners within its Taskforce preset scope. The observer requires both registered preset membership and the existing trusted scope-membership check before reading sessions or the store. Standard, switched-away, and standalone contexts do not acquire observation authority. Context-owned listeners participate in normal reload/disposal.

Supported middleware records request/prepared, request/failed and agent/pre-step, preserving exact middleware results/errors. Real agent/error and agent/disposed hooks record only finite coordinates and fixed error codes. Hooks scan at most the latest 256 session records for durable turn/start and turn/end records, deduplicated by trusted session ID and sequence. Terminal reason kinds completed, aborted, blocked, error, max-tokens, interrupted and forked are allowlisted (the host union is extensible, so other values stay null). Interrupted and forked can be synthetic history closures, not live loop outcomes; nested abort reasons, provider descriptions, messages, prompts and raw exceptions are excluded. Missing coordinates, truncated windows, conflicting replay and write failures become explicit observation gaps. A recording failure never changes a model request's result.

Lifecycle rows identify the observed session and explicit source (host_hook or session_event); they do not assert a human actor. They include process instance, observed Node/package versions, and a host package version only when native package metadata resolves it. Unknown versions remain null. Broken ancestry records direct-caller-only observations; no root run is guessed. The run recovery view includes lifecycle for the whole run even when task_id filters task-related sections.

Disposal means a disposal hook was observed, not crash, inactivity, or process-tree quiescence. A terminal session record describes its own turn and does not prove descendants stopped. Earlier history, host entrypoint, exit status and supervisor evidence can remain unavailable. Native CI checks real disposal on supported installed hosts; its seeded turn/end record validates the wire shape and collection path, not a production crash or an executed model turn.

## Limits and evidence

Recovery pages default to 25 rows, accept 1–100 and fit 16384 UTF-8 bytes including metadata. Sections expose truncation and continuation. IDs/keys cap at 256 bytes; payload hashes are 64 hex characters. Checkpoint summaries are included only in authorized recovery views. diagnosticBundle excludes them and allowlists metadata: IDs, counts, timestamps, statuses and the small fixed error-code set. It excludes prompts, reasoning, messages, commands, environment, raw errors, paths, logs, request keys and payload hashes. No export uploads anything.

The journal is an API boundary, not protection against same-UID database modification. No production crash cause is inferred from synthetic tests. The recorder collects supported scoped lifecycle observations from the host. A production diagnosis still requires the actual incident's durable records and any missing exit/supervisor evidence.
