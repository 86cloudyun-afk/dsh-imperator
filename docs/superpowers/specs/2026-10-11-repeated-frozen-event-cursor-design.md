# Repeated certified frozen event cursor — Task20 adopted design

Formal adoption preserves the historical reviewed body below; the final root normative notice supplies current dependency and authority status.

TASK20 DESIGN: IMMEDIATE REPEAT OF A CERTIFIED FROZEN EVENT ARRAY

Status: DESIGN PREPARATION ONLY. Proposed design selected by this author for
review, not formally adopted. Fresh independent DESIGN review, root full read,
formal adoption, rebind to the accepted16/17/19 product base, and separate CODE GO
are pending. No candidate source, patch, executable probe or test has been written.

Purpose and success
-------------------
Reduce redundant product CPU work on long histories when a caller immediately
rereads the exact same already-certified frozen event array. Preserve all current
cursor/projection results, counters, caller reads, error boundaries, replay rules
and ownership. This is independent of Task18 and is not a native60s deadline fix,
cold-boot acceleration claim or explanation of a paid production failure.

Authoritative research: native-semantics-cost-research/report.txt and its root
full-read receipt SHA256
d058367a4301a7391e979ff38e1844965a79471a3c4227a252bd5c3db9e5c4f8.
The accepted research manifest is
ad0701bd82746cb182790e1d7fb300fe580e6d00ba2d2a130ea2b49bdbe0fe11.
Source is frozen706, not the evolving checkout. SDK facts are copied from sealed
accepted source excerpts; this task makes no new SDK/runtime observation.

Scope
-----
Future product edit: lib/plugins/event-projection.mjs only.
Future behavioral coverage: existing tools/tests/incremental-projection.test.mjs.
Root-owned documentation updates: docs/PERFORMANCE.md and docs/ORCHESTRATION.md,
using the precise cost qualifier below after code acceptance and source rebind.
No new module/export/configuration option/public metric/dependency. No snapshot
cache, helper fixture reuse, SDK trust label, SDK call, SDK edit or adapter.

Existing native tests, including host-boundaries.test.mjs:200-241, remain byte-for-
byte unchanged by Task20. Preserve all native cold boots, named prepareProfile /
composeProfile / runProfile,83 top-level+26 nested/109 TAP obligations,646 original
assertion-bearing lines, CLI/default concurrency/reporter/order, exact SDK rc.2 /
alpha.2 and Node22.23.2/24.19.0 pins,60,000ms native stage,65,000ms collector,
12,000ms targets/watchdogs,both10,000ms harness cleanup budgets,180,000ms model
stage,request cap80 and output cap8192. All other existing limits remain intact.
Private diagnostic-schema Sets and the separate conditional preset-cleanup
finding are excluded. That finding has no proven default-scope rejection.

Current behavior and proof basis
--------------------------------
createEventCursor owns verified and frozenDataArrays WeakSets and a private
previous array. Lines45-57 check the current array/Proxy/iterator contract on every
read. Lines63-72 use own data slots only, except already-certified frozen arrays
which can safely read their fixed slots directly. Lines75-79 compare every prior
reference, including identical accepted frozen arrays. Lines81-96 inspect new
tail events, recursively accept only immutable JSON graphs and check coordinates.
Lines97-99 clear previous on unsafe graph/sequence input. Lines103-105 optionally
certify the frozen outer array, swallowing certification failure. Lines108-110
update private previous and return either original input or a new tail array.

An accepted frozen dense non-Proxy array cannot change its length, prototype or
own data values. Its graph was accepted by immutableJson before certification.
If that array is the immediately preceding successful input and previous still
corresponds to that acceptance, each old-prefix reference comparison must succeed.
Those reads invoke no caller getter. Skipping only that proven-equal loop leaves
the tail empty and every public result unchanged. Same identity alone, shallow
freezing alone, equal length, a matching final event or a prior historical visit
do not prove this predicate.

Selected design: one optional weak identity slot
------------------------------------------------
Add exactly one private per-cursor cache slot holding either undefined or a real
WeakRef to the immediately preceding successfully accepted certified frozen input.
Keep verified, frozenDataArrays and previous otherwise unchanged. There is no
strong field/closure reference to the caller's outer array, no WeakMap of all
visited arrays and no user-supplied identity token.

Read ordering is normative:
1. At read entry, move the weak slot into a local candidate reference and clear
   the stored slot BEFORE the existing Array.isArray normalization. Do not deref
   yet. This invalidates optional metadata even if a revoked Proxy causes the
   original normalization to throw. Do not clear or otherwise repair previous
   on such a throw: the original behavior leaves it unchanged.
2. Run the existing normalization and nativeIteration checks in their existing
   order, with their existing catch and unsafe-input return. No weak eligibility
   check can bypass them, even for an identical previously accepted array.
3. Preserve the original reset calculation, fresh tail allocation, certificate
   lookup and slot accessor. After iteration safety passes, perform a guarded
   dereference of the local candidate. Missing reference, reclaimed target or
   dereference error means an ineligible hint, not an error or a forced reset.
4. Skip ONLY the previous-reference loop when reset is already false, current
   frozenDataArrays certification exists, and the weak target is exactly events.
   The slot is valid only because it came from the immediately previous completed
   cursor acceptance. All other paths run the current complete prefix loop.
5. Keep new-tail validation, coordinate checks, immutable/error fallback, the
   optional Object.isFrozen block, and private-prefix update in their original
   sequence. Do not widen, relocate or remove the Object.isFrozen catch. A normal
   successful read with failed optional outer certification remains successful;
   it simply cannot gain a weak identity hint until certification later succeeds.
6. Prepare the original result object, with its original keys and values, AFTER
   the original private-prefix update. Only then publish a next weak hint as a
   best-effort final operation. Certification must actually be present at this
   point; successful graph validation alone is insufficient. An eligible exact
   repeat can reuse its local WeakRef; a newly accepted certified input may create
   one new WeakRef. Allocation/access errors leave the stored slot undefined and
   must not escape or change the prepared result. Return that prepared result.

The implementation should keep this private logic small and inline with the
existing method. No whole-read Promise/async wrapper, generalized cache subsystem,
public instrumentation, new failure code or rewritten reducer protocol is needed.
Changing comments to describe the narrower prefix-comparison obligation is in
scope for the product file. No global WeakRef/prototype object is mutated.

WeakRef and resource semantics
------------------------------
The target remains caller-owned. The cursor strongly retains only its existing
private event-reference prefix, its existing weak certificates, and one small
WeakRef object. A local dereferenced target is not saved beyond the synchronous
read. On a hit input/events already hold that target; on a distinct-input miss,
dereferencing the old target may also keep that old array alive until the current
job ends. Native WeakRef creation and dereference have this temporary language
behavior, not strong cache ownership across jobs. No deterministic collection
timing or finalization guarantee is asserted.

WeakRef support is an optional performance capability. An absent capability,
failed construction, failed dereference or cleared weak target loses only the
shortcut. The baseline prefix comparison and public results remain available.
At most one new WeakRef is attempted per successfully certified read; immediate
hits reuse their existing reference. Do not repeatedly allocate
inside the per-event loop. A local candidate is discarded after this invocation.

Use real host WeakRef operations inside small guarded optional-operation blocks.
No new module-evaluation dependency on accessing WeakRef is required: acquisition
and publication can be attempted at the read boundaries described above. There
must be no unguarded optional-capability access that introduces a new throw.
This retains the existing documented normal-host-intrinsics contract in
PERFORMANCE.md:9. Arbitrary replacement of language intrinsics or global prototype
pollution is outside certification, with the explicit global iterator check
remaining protected. We do not introduce a generic hostile-intrinsics sandbox.
Unavailable/throwing optional operations still receive the conservative catch
behavior described here; such tests assert fallback, never trust counterfeit
successful WeakRef objects as evidence.

State transitions and failure ordering
--------------------------------------
At every read entry the old hint is consumed. A read that returns via unsafe
iterator/graph/coordinates leaves no hint; the existing previous reset remains.
A read that throws before completion leaves no hint; previous follows only the
old code's updates. A distinct successful input must fully validate its own
relationship to previous before becoming the new hinted input. A successful
reset can publish a new hint only after rebuilding previous and preparing its
result. It never uses a hint from before that reset.

Examples, all public results equal to baseline:
  A -> A: first accepts; second returns reset:false with a fresh empty tail.
  A -> equal-content distinct B -> A: both transitions perform full comparison;
    each returns the baseline incremental result, not a historical-cache result.
  A -> middle-replaced B -> A: each changed transition resets and replays.
  A -> unsafe iterator -> A: unsafe read clears previous; restored safe A resets.
  A -> mutable/shallow-frozen/Proxy/accessor/sequence-invalid B -> A: B follows
    original unsafe replay; next safe A rebuilds according to baseline state.
  A -> revoked Proxy normalization throw -> A: original throw propagates;
    original previous remains A, so the final A returns reset:false/empty after
    full baseline comparison. Optional metadata loss does not force replay.
  certified A -> WeakRef failure -> A: successful cursor results/counters stay
    exactly as before; only potential comparison elision is lost.

Cursor success means cursor.read completed acceptance; it does not promise that
the caller's reducer append/snapshot subsequently succeeded. createEventProjection
is unchanged. If an append or snapshot throws, its old ordering and processedEvents
behavior remain. Policy callbacks run before cursor.read, and reducer callbacks
run after it. The hint is published before those later callbacks exactly as the
private prefix is already committed; no new projection-result cache exists.

The normal cursor path invokes no caller callback during acceptance. Independent
author support considered reentry via inherited seq getters and counterfeit
WeakRef operations; those require global prototype/intrinsic replacement excluded
by the existing contract. No depth guard, outer try/finally or unrelated previous-
state repair is required by this design. If a reviewer identifies a within-
contract reentry path, stop and revise the design before CODE GO.

Projection, policy and ownership invariants
------------------------------------------
createEventProjection retains its current signature/defaults and calls:
policyKey, cursor.read, optional reducer replacement, reducer.append(update.events),
processedEvents addition, and reducer.snapshot, in that order. Every reread still
calls append with a freshly allocated empty tail and then snapshot. No snapshot
result is cached, so custom reducer output, side effects and errors remain current.
processedEvents counts reducer input only; no new counter or interpretation.

Policy changes already instantiate a new cursor, discarding the weak hint. Per-
agent session/scope/ID replacement and ownership-cut changes continue to use their
existing projection replacement paths in working-context/guard; those files are
not edited. ownedSessionEvents returns the same array only for cut0. A positive
cut returns a fresh slice; such distinct arrays keep full prefix validation.
The design must not cache an owned window or assume SDK provenance proves safety.

Actual SDK/case evidence and limitation
--------------------------------------
Captured rc2 session1376-1381 and alpha2 session1450-1455 cache one frozen full
snapshot. Appends invalidate it at rc2:1471-1473 / alpha2:1588-1590 before observer
publication. Restored detached events can remain mutable beneath a frozen outer
snapshot. The same-array optimization requires product certification in both pins.

Unmodified native case host-boundaries:200-241 explicitly rereads the flow cursor
on each of six snapshots and once more at226: seven statically eligible repeats,
27 prior-reference comparisons. It also mutates a detached restored graph under
the same outer identity and requires full replay. These counts describe source
paths only, not observed instrumentation or seconds saved. The larger existing
40,000-event parity fixture is offline, not additional native-stage workload.

Correctness acceptance
-----------------------
TEST-MATRIX.json gives exact future public fixture expectations. Existing tests
remain, including full-prefix replacements, mutable restores, proxies, sparse and
invalid sequences, policy changes, ownership/cut changes and 40,000-event parity.
Add focused transition checks only where existing cases leave a gap: alternating
certified arrays, unsafe or throwing intervening reads, iterator changes after
certification, optional capability/certification fallback, and explicit fresh
tail plus append/snapshot observability through the public reducer interface.

The reference behavior is the accepted pre-Task20 implementation. These are
semantics-preservation tests, so baseline should already pass. Do not invent a
failing assertion about private WeakRef storage, iteration counts or elapsed time
to manufacture a red test. A new baseline failure is a separate finding requiring
root review. The optimization itself is established by reviewed source invariant
and later finite CPU evidence, not by a new public metric or flaky CI threshold.

Performance evidence, separately prepared later
------------------------------------------------
A finite provider-free long-history CPU comparison may be designed after formal
adoption and CODE GO, with a later reviewed measurement-preparation receipt. It
must bind exact accepted baseline and candidate hashes, same measurement source,
exact Node binaries, environment and fixed work counts. Measure elapsed time and
process CPU separately; report every raw sample and no threshold assertion in CI.
Keep repeated exact-frozen reread, distinct equal frozen arrays, append snapshots
and mutable-restored controls separate. Correctness parity gates all scenarios.
No implementation/probe source or execution is prepared by this document.

Source evidence does not establish performance significance. If CPU evidence is
inconclusive or regresses controls, report that result rather than enlarging work
or rerunning indefinitely. A useful long-history enhancement can be judged on its
own; no native60s saving or gate PASS may be inferred or substituted.

Root-owned future documentation qualifier
------------------------------------------
PERFORMANCE.md: replace its blanket full-prefix-per-read statement with this
precise rule after acceptance: distinct or uncertified inputs retain the existing
full-prefix validation path and its original reset/early-exit behavior; an
immediate repeat of the exact already-certified frozen
dense immutable array may reuse that equality proof through weak identity after
current iterator checks. Loss of the weak hint falls back to the original scan.
No O(1) full-step claim: reducer snapshot and other context work still occur.

ORCHESTRATION.md: update both the cursor description at102 and cost boundary
at110. Keep the warning that ordinary mutable-array identity, length
and final coordinates do not prove append-only behavior. Add only the narrow
certified-frozen immediate-repeat exception, and retain full replay for mutable
restored data, proxies, accessors, replacements, invalid coordinates and policy
or ownership changes. Preserve the existing reference-retention and other
per-step cost caveats; do not imply that comparison elision removes copies or
other scans. Keep processedEvents defined as reducer input, not saved comparisons
or total work. Cite new CPU evidence only if separately obtained.

Alternatives not selected
-------------------------
Strong last-array reference: simplest identity field but adds outer-container
retention contrary to the ownership requirement. Reject.
WeakMap generation cache / permanent seen-array set: could encode identity without
strong retention, but adds more metadata and historical-state risk than one
WeakRef slot. No demonstrated advantage; reject for this bounded design.
Trust every frozen array or SDK label: invalid for mutable restored graphs. Reject.
Cache reducer snapshots / skip iterator guard / skip distinct-array prefix checks:
changes current observable behavior or invalidation; reject.
Broader profile/import/schema/cleanup optimizations: independent work, excluded.

Handoff and STOP
-----------------
This design binds frozen706 and captured accepted reports only. Before any future
implementation, rebind all touched and relevant consumer/test/doc sources to the
accepted16/17/19 source base; independently reconcile every changed invariant.
Do not transplant by old line numbers or silently combine earlier profile work.
Fresh independent DESIGN review, root read, formal adoption, CODE GO and any later
runtime/performance preparation are distinct gates. Task16 owns current runtime.


## Root normative adoption and accepted-source rebind

This root notice supersedes preparation-only/pending status labels in the preserved historical design/plan body above. Independent Task20 DESIGN report SHA256 `9a4515d056d14904712a12fd2207d4830c56fa202591ace32bcc324019907eec` and root FULLREAD/rehash receipt `7fd172115c9889a4cde8d53c15575cb14d885e375e0f1b7f1cdecef0f6c87d68` are accepted. Historical frozen706 observations remain historical; no new runtime or native performance result is inferred.

Implementation base is fully accepted Task19 `7930c35165f874337766e98588a2d5478f0e5b79` / tree `e52cbc49fde710ca4f5b7127f1ece0541319503f`, descending from accepted16/17. Task19 acceptance SHA256 `39e27d1b2b7290f802dd5e00e02f3f4f1c489835390613a6064f4472167a6bc1`; Task16 `7cbd2b69e589a8f1b8b1944c088576521c91cd649d760fe0d9ae2e47270c7955`; Task17 `6bc984b96d390063f8b622624726de1528584cdf569e916a8090ed350020c43b`. All13 touched/relevant module, test and cost-document inputs are byte-identical to the independently reviewed frozen706 sources. No cursor certification, prefix ownership, policy/cut/session reset, import or native-test scheduling invariant changed; complete source identities are recorded separately by root. Database caller fixes are accepted separately and do not expand Task20 scope.

Normative product scope remains only event-projection.mjs; behavioral additions stay in the existing incremental-projection test file, preserving its original401-line prefix. Root adds one strict appended-event reference assertion to the independently reviewed preservation draft; both baseline and candidate use that identical strengthened test. There are15 added test instances. Baseline success is required and is never manufactured RED. Optional WeakRef operations, current iterator guard, sequence/graph validation, previous update before result preparation, fresh tails, reducer callbacks/counters and weak ownership retain the reviewed six-step order.

Separate root CODE/runtime GO is still required. Original Node/SDK pins, CLI/default concurrency/reporters, native cases and `60000/12000/2×10000/180000`, request80/output8192, SDK adapter CLOSED and acceptance gates remain unchanged. The finite CPU preparation V2 has independent static review and root read, but future accepted baseline/candidate complete source bindings and both-pin preservation evidence are still required before its one fixed batch. Cost documentation is updated after code acceptance; no native60s cure, GC guarantee or explanation of production stops is claimed.
