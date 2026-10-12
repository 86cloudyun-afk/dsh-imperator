# Model progress observations

## Problem and evidence

The actual MODEL sample for `2ccc06305995db276dce35062d769dd785ad4f8b`
failed. Readonly passed; repair exceeded its 180000 ms deadline with one task
still claimed, four evidence rows, no submission or acceptance, and no
independent repair checks. Reuse and strict stages were not reached.

Before cancellation the report recorded two agents, one running agent, one
pending idle wait, and one missing settlement notice. After cancellation both
agents were idle. These observations do not establish a quiet tree at the
deadline or a lost-notice cause. Final `missing-message` and `stream-error`
diagnostics also lack enough timing to establish whether they preceded cancel.

Three independent investigations found no demonstrated causal source defect.
They identified observable information loss: request coordinates are omitted,
ordinary tool results consume the task detail budget, and send summaries omit
fresh versus replayed control receipts. This change addresses those gaps. It
does not establish the cause of the failed sample or authorize retrying it.

## Scope

Add bounded observations to `tools/verify-model.mjs`, using its existing
authoritative event, stream, task snapshot, and settlement boundaries. Extend
`model-regression.test.mjs` and `host-boundaries.test.mjs` to verify the data and
its observational behavior.

Existing progress and task diagnostic objects remain compatible. Production
tools, scheduling, fixtures, model prompts, dependencies and SDKs are outside
this change.

## Identity and observations

Use numeric run-local agent slots. A known session keeps its slot after cold
restore; a new Agent lifetime gets a distinct lifetime number. Correlate own
events, turns, steps and admitted requests through existing validated identity
and call/result associations. Ambiguous, inherited or unavailable evidence
stays unknown. Raw session IDs, request keys and call IDs remain private.

Keep small tables for agent state, admitted requests, and cached task state.
Request observations distinguish admission, consumed progress, finish, iterator
completion and durable assistant-message presence. Agent observations distinguish
own-turn activity, lifecycle boundaries, original idle waits and direct-parent
notice obligations. Cached task observations state their age and source; they
are not a new acceptance authority.

Keep a reserved task/control tail separate from ordinary event/tool rows.
Project only validated receipt primitives: operation status, durable/replayed
booleans, known target slot, inbox ID presence, and supplied mode/activity
enums. A replay must not borrow omitted fields from an earlier fresh receipt.
Inbox acceptance does not prove dispatch route, target execution or completion.

Freeze a detached observation before timeout cancellation. Label the later
pre-dispose observation separately from the stream state observed after
disposal. Preserve the first observed failure and its phase. A late error does
not acquire an earlier timestamp by inference.

## Bounds and privacy

Limit observation state to 16 agent slots, 256 lifetime registrations, 80
admitted requests, 20 cached tasks, 64 task/control tail rows and 32 ordinary
tail rows per stage. Reuse the collector's existing 4096 event/association
bounds, 65536-byte envelope bound and 2 MiB decoded-envelope budget. Saturated
counters, dropped rows and missing authority require explicit coverage flags;
an empty tail is not proof that no action occurred.

Report only fixed enums, booleans and bounded numeric coordinates. Never save
prompts, reasoning, message content, arguments, result bodies, file paths,
fact text, credentials, raw identity strings or arbitrary error text. Optional
snapshot hooks accept exact detached primitives. Accessors, proxies, inherited
fields, foreign thenables and unsupported shapes are unavailable observations.

## Noninterference

Observation callbacks are synchronous and exception-contained. They reuse an
already occurring observation or bounded parse. They do not read SDK history,
query a store, initiate control, await work, consume extra stream chunks or
replace native Promises. Diagnostic failure cannot grant acceptance or replace
the original failure.

Preserve all four model stages and prompt bytes; request cap 80, output capacity
8192, stage deadline 180000 ms; original provider/model and host pins; auxiliary
rejection before dispatch; child deadline 60000 ms, native cleanup bound
12000 ms and paid cleanup bounds of 10000 ms twice. Preserve provenance,
worker/reuse/settlement/stability checks, no-waiver closure, strict receipts and
independent grader semantics.

## Verification requirements

First show that old report counters cannot distinguish scripted cases with
different request owners or cancellation chronology. Then verify stable local
coordinates through concurrency and cold restore, exact snapshot copies,
inherited/duplicate/orphan/PTC boundaries, reserved capacity after ordinary
noise, fresh versus replayed receipts, missing authority, bounded exhaustion
and marker-free output. Existing acceptance and failure results must agree.

Use both pinned native hosts with local stream seams and zero paid calls to
cross-check real creation after stage baselines, cold replacement, original
idle waits, parent notices and control receipts. Implementation review and
actual verification remain separate from this design approval. A new actual
model sample requires a reviewed new candidate and its original gates; the
failed sample remains immutable.
