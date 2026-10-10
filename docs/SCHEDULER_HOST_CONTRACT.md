# Official managed-host capability proposal

Status: integration contract proposal, not an implemented upstream API.
This package does not enable official native scheduling by accepting a
capability flag, callback, version string, model attestation or a method name.

Reviewed upstream source is DeepSeek Harness
`d743267388641bc76f17c45ce8b4c231aed1d32c` (master on 2026-10-10, release
0.2.1-alpha.2). The historical 0.2.0-rc.2 package-integrity evidence is in
[the existing B/C research](superpowers/research/2026-09-30-dsh-0.2-bc-host-contracts.md).
GitHub source observations are not installed npm-package or deployment proof.

## Capability assessment

| Code | Existing evidence | Missing guarantee |
| --- | --- | --- |
| H01 | Public create accepts a caller session ID and actual parent Agent; setup precedes publication. The local helper checks the live ancestry and reserved ID. | Bind persisted attempt/owner epoch before effects; correlate exactly one consumed input; recheck policy and generation after create/publication. |
| H02 | Agent send/followup/steer/inject are public. Tool guards constrain callers. | No verified target admission hook covers all input, resume, direct inbox mutation and descendant creation paths. |
| H03 | Public session flush and backend flush/read handles support durable checkpoint comparison. | A prefix checkpoint is not a terminal or durable delivery receipt, and is not process quiescence. |
| H04 | Alpha.2 subprocess handles separate direct outcome and managed-range wait. Linux user-systemd scopes and Windows Jobs are available on supported hosts. | Public strict containment selection, durable native owner recovery, all process-producer coverage and subtree closure; fallback can miss escaped descendants. |
| H05 | JSONL holds a kernel lock for one session writer. | Scheduler-domain process-held ownership and old execution reconciliation after host death, without TTL takeover. |
| H06 | Host can generate canonical path/Git resource keys and independent clones. | Enforced filesystem/process isolation over every native/PTC/tool route; aliases and shared Git metadata remain deployment concerns. |

The H03 helper additionally pins Cordis's internal service tracing identity.
`ctx.get` creates contextual proxies; wrapper equality is not service identity.
Both reviewed releases expose the exact underlying target under
`Symbol.for('cordis.original')`. Installed-host tests verify this contract and
record the Cordis package version and entry hash. A different target refuses;
this internal dependency does not enable native scheduling.

- [alpha.2 traced lookup, lines 233–234](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/vendor/cordis/src/reflect.ts#L233).
- [alpha.2 original-target symbol and proxy, lines 54 and 173–175](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/vendor/cordis/src/utils.ts#L173).
- [rc.2 release original-target proxy, lines 173–175](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/vendor/cordis/src/utils.ts#L173).

Exact alpha.2 source anchors:

- [agent creation contract, lines 100–118 and 171–190](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent/src/index.ts#L100).
- [send mutates inbox then wakes, lines 154–172](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L154);
  [inbox inserted observation follows append, lines 235–240](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/inbox.ts#L235).
- [session flush listener semantics, lines 1305–1334](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/session/src/index.ts#L1305);
  [backend ownership and durability contract, lines 118–180](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-persistence/src/index.ts#L118).
- [range-relative waitForExit, lines 162–195](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/subprocess/subprocess/src/types.ts#L162);
  [private native/fallback selection and weaker guarantee, lines 213–249](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/subprocess/subprocess-local/src/index.ts#L213);
  [crash/platform limits, lines 148–155](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/subprocess/subprocess-local/README.md#L148).
- [session-directory kernel lock, lines 921–942](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-persistence-jsonl/src/index.ts#L921).

## Required host contracts

The following names describe proposed semantics, not callable DSH methods.

**Target admission.** Install a trusted, monotonic denial boundary before
input persistence/wakeup and before create/resume can release queued work.
It must cover UI/API, service messages, followup/steer/inject, direct inbox
changes, spawn/fork, continuation and resumed pending input. Trusted metadata
binds root run, session, attempt generation, owner epoch and input identity.
A model string cannot construct this identity. Unregistered routes refuse
managed work. Disposing the admission owner closes ingress first.

**Durable delivery lookup.** Precommit a delivery intent, atomically associate
consumption with a stable input/turn identifier, and support read-only lookup.
A lost response returns unknown until the backend reconciles it. No retry on
timeout alone. Publishing an agent or seeing an inserted event is insufficient.

**Strict process ownership.** A managed spawn must require native containment
before target execution and reject unavailable containment; no PGID fallback.
Expose an authenticated owner identity and scope semantics in its receipt,
including the supervisor needed for host SIGKILL/OOM/crash. Lookup must establish
the same range is empty, including reparented/setsid descendants. Direct command
exit, cancel acceptance and ordinary waitForExit on an unspecified range cannot
satisfy this contract. Native subtrees must close new admission and drain child
handles before parents; tool implementations cannot escape the process owner.

**Dispatch owner recovery.** Hold an OS-released, non-expiring exclusive lock
for the scheduler coordination domain. After process death, acquiring it does
not establish prior children stopped. Recovery reads original persistence,
matches native owner receipts and reconciles every unknown attempt before
reusing affected resources. No lease timeout, PID absence, synthetic turn closer
or operator retry action automatically releases locks.

**Workspace enforcement.** Resolve workspace/Git common-dir/remote/ref identities
using trusted host data. Write attempts use independent clone/object stores or
take shared metadata write locks. Every filesystem and process producer obeys
the actual sandbox; cwd and tool schema restrictions are insufficient.
Unknown aliases or unverified sandbox capability refuse concurrent guarantees.
Cleanup requires quiescence, never merely an absent registry entry.

## Required integration acceptance

Run each supported OS/profile/version independently. Tests must deliberately
exercise external input from an unrelated session, PTC, UI/API/resume and
descendant materialization races; a pre-step refusal alone is not admission
coverage. Inject lost create/delivery results, backend replacement, listener
success without durable data, flush/read/close failures and persistent unknown
state across restart. Run two dispatch owners concurrently. Kill the host while
an escaped/reparented descendant continues writing and prove resources stay
held until its exact native range is empty. Force native containment unavailable
and ensure rejection occurs before command execution. Exercise path aliases,
worktrees/common-dir conflicts, shared object stores and outside-workspace
effects. A source review, fake adapter or no-model idle-child probe cannot
replace these tests.

The current shipped scheduler core is useful without these guarantees: trusted
hosts can maintain a durable queue and governor reservations, inspect state and
perform explicitly verified settlements. Official native activation remains
blocked until an actual implementation and deployment evidence close every
required capability.
