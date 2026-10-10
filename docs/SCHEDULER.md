# Durable scheduler and native evidence ports

The host-only `TaskforceScheduler(store)` queues work and reserves the existing
governor's capacity and resources in the same SQLite transaction. It does not
create agents, deliver input, start processes, publish changes, automatically
retry, or release unknown work. Existing continuable preset dispatch remains
outside this scheduler; full-tree native hard limits are not enabled.

## Trusted queue API

Import from `@local/dsh-taskforce/scheduler`. Every method takes
`(input, runId, authority)`, where authority is the separately supplied trusted
`{ role: 'lead' | 'worker', sessionId }`. These objects are not cryptographic
capabilities. Keep the service reference and its calls outside model arguments.
Root run identity must come from the verified native ancestor chain, never a
new milestone, task label, or arbitrary child root.

- `enqueue({request_key,task_id,generation,mode,kind,resources},runId,authority)`
  records a request. Generation, mode, kind and canonical resources use the
  governor contract. Same key and normalized payload returns current durable
  state; a conflict fails. Workers must own the task and any replay's captured
  owner. This call consumes no governor budget.
- `admitNext({request_key},runId,lead)` examines the oldest queued request.
  Returns `{status:'admitted'|'blocked'|'refused'|'empty',request?,code?,replay}`.
  Admission updates the queue and governor atomically. Capacity/resource
  blockage preserves the FIFO head. Terminal tasks, changed captured owners,
  changed rework generations and stale admission generations refuse that
  request, so the next call can progress. Only a trusted lead admits.
- Admission decision keys are durable and distinct from enqueue keys. Replaying
  any decision returns its historical outcome with `replay:true`, including
  blocked or empty decisions. Use a new decision key for a new scheduling
  evaluation. An admitted decision or replay is **never delivery permission**;
  it may describe a reservation already running, unknown or settled.
- `bind({request_id,generation,session_id},runId,authority)`,
  `markUnknown({request_id,generation,reason},runId,authority)`, and
  `settle({request_id,generation,proof},runId,authority)` delegate to the
  governor inside the same transaction. Real ownership, retry accounting,
  generation checks and settlement requirements remain authoritative.
- `state({after?,limit?},runId,authority)` returns ordered requests with
  `has_more` and `next_after`. Default 25, maximum 100; follow the returned
  sequence cursor. Worker views require both current and captured owner.
  No prompts, raw error messages, resource paths, receipt logs or other-run
  occupants are returned. Responses report resource counts and are bounded
  to 65536 UTF-8 bytes. This is a live keyset view, not a frozen membership
  snapshot; restarting at zero refreshes changed states. An oversized record
  introduced through another host API fails with `E_SCHEDULER_CONFLICT`
  instead of emitting an oversized page or a cursor that cannot advance.

Run/session/request keys are nonblank, preserve whitespace and have a 512-byte
limit; the existing store also limits task run IDs to 200 characters. A request permits at most 64 canonical resource strings of 256 bytes
each. Resource duplicates are removed and sorted. Queue refusals use
`E_SCHEDULER_CONFLICT` or `E_SCHEDULER_STALE`; governor refusals retain their
existing codes. SQLite failures propagate rather than becoming queue success.

`scheduler_request` and `scheduler_decision` are additive tables in the
store-owned database. Initialization is lazy and rollback-aware. Reopening
performs no external effects. Direct governor settlement is reflected by state
readback. Unknown reservations retain slots, writers, locks and retry charges.
Do not dispatch before the outermost transaction has committed.

## Evidence helpers, not an execution adapter

`nativeSchedulerCapabilities({version})` reports six structured H01–H06 entries,
all with `enabled:false`, and `native_enabled:false`. Extra flags and callbacks
cannot turn them on. Versions are pinned to 0.2.0-rc.2 and 0.2.1-alpha.2. The
existing `createNativeGovernorAdapter()` still unconditionally rejects.

`prepareNativeIdentity(ctx,{version,parentAgent,session_id})` reads the actual
live agent registry and durable session headers. It rejects impersonated Agent
objects, missing/cyclic ancestors, a claimed delegated root, occupied live session
IDs and depth above two. It returns a frozen reserved ID, exact parent ID,
root run ID and delegation depth. It neither creates nor sends. Recheck the
same live parent and inherited policy/composition after asynchronous
preparation, and after native create resolves. This small preparation helper
does not prove exclusive input admission or exactly-once delivery.

`flushNativeCheckpoint(ctx,{version,session,persistence})` requires the exact
live session and expected backend. It captures `snapshotEvents()`, requires
`sessions.flush(session) === true`, awaits the backend durability barrier,
opens the same backend in read mode, compares raw header and contiguous prefix,
and always closes the reader. Backend replacement, changed live identity,
missing/incorrect prefix or any flush/read/close failure rejects. The complete
captured prefix is limited to 10000 events and 1 MiB. The returned count,
last sequence and SHA256 contain no log text. They explicitly mark
`terminal:false`, `quiescence_proven:false` and `native_enabled:false`.
Neither that receipt nor an empty prefix proves a terminal result, safe
re-delivery, or process-tree termination.

## Integration and deployment gates

Workflow readiness must be checked inside the governor's new-reservation
transaction, with its dependency-generation capture; bind must recheck before
dispatch. This placement covers direct governor users as well as the scheduler.
Do not install a callback in this class as a substitute for the shared store
gate. Queue initialization does not modify or enable native dispatch.

The remaining official-host gaps and concrete upstream contracts are tracked
in [the host capability proposal](SCHEDULER_HOST_CONTRACT.md). Source review,
offline tests, actual installed-package probes and production acceptance are
different evidence classes. The pinned native probe boots an isolated profile,
prepares and creates an idle real child, flushes and reads its actual persisted
history, disposes handles and shuts down. It forbids model requests. It cannot
validate full native dispatch, crash recovery, process containment or production
behavior while the required upstream seams are absent.
