# Durable governor core (0.3 foundation)

`@local/dsh-taskforce/governor` exports `TaskforceGovernor` and
`createNativeGovernorAdapter`. This is a **trusted host API**, never a model tool.
The model-facing tools, preset, host approval, sandbox, and guards are unchanged.
The existing continuable prompt budgets remain **soft discipline** until a verified
execution adapter routes every relevant entry point through admission.

## Scope and guarantees

`new TaskforceGovernor(store)` shares the `TaskforceStore` SQLite connection and
transaction helpers. Additive `governor_run`, `governor_reservation`,
`governor_hold`, and `governor_audit` tables live in the existing
`$DSH_HOME/taskforce/taskforce.db`. Construction is lazy. Every call obtains the
current store-owned connection; closed stores stay closed, and invalidated
connections are reopened only through the store. Do not close its handle yourself.

`BEGIN IMMEDIATE` serializes admission, cumulative accounting, resource holds,
and audit. Cumulative counters derive from retained reservation rows: they cannot
be lost by updating a separate counter. Rollback restores the entire mutation.
`reserved`, `running`, and `unknown` all occupy slots and holds. There is no TTL,
automatic release, queue, native dispatch, automatic delivery, or process reaper.
Nested calls must receive the same trusted **root run ID** from the host; the core
cannot independently reconstruct the native session ancestry.

Default limits per root run:

| Limit | Value | Accounting |
| --- | --- | --- |
| Active total | 6 | Includes writers and all nested admissions |
| Active writers | 2 | Subset of active total |
| Cumulative new | 3 | Never refunded, even for never-started settlement |
| Cumulative retry | 2 per real task ID | Never refunded or reset by a milestone |

`new`, `reuse`, and `retry` are host-classified intents. A retry counts against its
real task; `reuse` consumes active capacity but does not increment `new` or `retry`.
The host must not relabel a new execution as reuse or replace the root run/task
identity to reset a budget. Unknown/milestone/root-run override input fields are
rejected. One active admission per task is a conservative extra restriction:
parallel executions of a single task must wait for proven settlement.

Resources are exact, nonblank, host-established canonical identity strings. Their
order and duplicates do not matter. The reservation's mode applies to every listed
resource. Reads share; a write conflicts with any existing hold on that key, across
**all runs**. Empty resources mean the trusted host requires no shared locks; they
do not exempt work from active limits. The core does not discover filesystem aliases,
prove workspace isolation, or prevent a process from writing outside its declared
resources. The host is responsible for this mapping and enforcement, including
shared Git common directories. The database is not a security boundary against
malicious local writes.

## Trusted identity and API

Every mutation takes `(input, runId, authority)`. `runId` is a nonblank real root
run key, passed separately from input. `authority` is a host-provided
`{ role: 'lead' | 'worker', sessionId }`; it must never be constructed from model
arguments. The role is independent of the real session string: a worker named
`lead` is still a worker. Nonblank session/run/resource/operation keys preserve
surrounding spaces exactly. The caller must already hold a trusted service
reference or equivalent authenticated host channel; these plain JS objects are
not cryptographic capabilities.

Workers must match the task's current real `owner_session`; subsequent operations
and idempotent replays must also match the reservation's captured owner. Reassignment
does not grant the new owner control of an old execution. Leads can manage work in
the supplied run and recover old executions. Cross-run task/reservation access is
rejected. A lead may reserve an unbound task, but binding requires that the store
has since assigned a real owner. Terminal tasks cannot receive new admissions or be bound for dispatch.

- `reserve({ operation_key, task_id, generation, mode, kind, resources }, runId, authority)`:
  `mode` is `read|write`, `kind` is `new|reuse|retry`, and `resources` is a string
  array. `generation` is the **expected current task admission generation**, initially
  `0`. Successful reserve increments it and returns the durable reservation.
  The task's current generation can be read from its latest snapshot reservation;
  it is independent of execution-receipt/evidence generations in the task store.
- `bind({ reservation_id, generation, session_id }, runId, authority)`:
  records the exact current task owner and moves `reserved` to `running`.
  This is the conservative dispatch boundary; call it before effects can start.
  It does not start a session. Same-generation, same-session running bind is
  idempotent. Unknown reservations cannot be rebound or dispatched again.
- `markUnknown({ reservation_id, generation, reason }, runId, authority)`:
  moves reserved/running work to unknown, retaining all capacity and locks.
  A nonblank reason is required. An already-unknown observation is idempotent;
  a settled reservation cannot become unknown.
- `settle({ reservation_id, generation, proof }, runId, authority)`:
  requires a trusted host attestation described below; releases holds and active
  capacity atomically, retaining cumulative counts and reservation/audit history.
- `snapshot(runId)`: reads one consistent transaction and returns `limits`,
  `active_total`, `active_writers`, `created_total`, `unknown_total`, per-task
  `retries`, `reservations`, `holds`, and `audit`. This host diagnostic contains
  full run history; it is not a bounded model-facing board.
- `extendBudget({ reason, max_active?, max_writers?, max_created?, max_retries? }, runId, authority)`:
  trusted lead only. Values are new positive safe-integer limits, not increments.
  At least one must increase and none may decrease. Nonblank reason, before/after
  limits, exact actor and timestamp are committed in the audit. This creates no
  new milestone and resets no cumulative counter.

Reservations return `reservation_id`, `run_id`, `task_id`, `generation`, `state`,
`mode`, `kind`, `session_id` (null before binding), and canonical `resources`.
Operation keys are unique **within a run**. Same key plus identical normalized
request returns its current durable state, including settled/unknown, without a
second charge or audit. Different content is `E_GOVERNOR_CONFLICT`. Replay is
checked before the expected-generation fence, but still after scope/owner checks.
A replay is a lookup result, **never permission to repeat delivery or effects**.

Every transition includes the returned generation. Old generations fail after a
new admission, even if the referenced prior reservation was already settled.
This database fence cannot stop an old OS process; native ownership and recovery
remain blocked. Do not dispatch until the outermost transaction has committed
when composing these calls with another store transaction.

## Settlement and recovery

Allowed proofs through the trusted settlement port:

```js
{ kind: 'never_started' }
{ kind: 'terminal', outcome: 'succeeded' /* or failed/cancelled */,
  quiescent: true, evidence: 'trusted-host-proof-reference' }
```

`never_started` is accepted only for work that was never bound, including an
unbound unknown intent whose host can now prove it never started. Once bound,
terminal outcome **and** quiescence with a nonblank evidence reference are
required. The trusted host must verify durable terminal outcome and quiescence
of the entire execution and its descendant processes before calling this port.
The core only records that attestation; it **does not manufacture or verify OS
process-tree quiescence**. Passing a boolean or a string from model output is not
such a proof and must never reach this API as trusted data.

Cancel requests, idle, store task cancellation, timeouts, missing native sessions,
and the absence of observed activity do not settle anything. Identical settlement
is idempotent; conflicting settlement fails. On reopening, all durable states,
locks, generations and counts remain as recorded. The core neither resumes nor
replays them, and does not relabel running work as safe. The host should conservatively
record uncertain delivery/execution with `markUnknown` and investigate before
settlement. Creating another governor instance does not take recovery ownership
or invalidate a live process.

## Native adapter and errors

`createNativeGovernorAdapter()` always throws `E_SCHEDULER_CAPABILITY`, regardless
of configuration, flags, declared capabilities, or callbacks. It returns a
machine-readable `error.blockers` array with all unresolved capabilities:

| Code | Required evidence |
| --- | --- |
| H01 | Prebound native session identity |
| H02 | Complete managed input admission boundary |
| H03 | Strict durable backend flush and lookup |
| H04 | Subtree and process quiescence proof |
| H05 | Exclusive owner lock and recovery |
| H06 | Trusted workspace identity and isolation |

Core capacity refusals use `E_BUDGET_EXHAUSTED`, resource conflicts use
`E_RESOURCE_BUSY`, stale generations use `E_GOVERNOR_FENCE`, and invalid input,
scope, owner, operation or state conflicts use `E_GOVERNOR_CONFLICT`. SQLite busy
errors preserve the store's `E_STORE_BUSY`; other SQLite failures propagate and
fail admission. No refusal silently queues or dispatches work.
