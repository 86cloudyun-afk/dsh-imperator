# Repeated certified frozen event cursor — Task20 adopted plan

Formal adoption preserves the historical reviewed body below; the final root normative notice supplies current dependency and authority status.

# Repeated certified frozen event cursor implementation plan

> For future agentic workers: after root's separate CODE GO, use the approved
> implementation workflow (superpowers:subagent-driven-development or
> superpowers:executing-plans). This file is an inert plan, not execution authority.

Goal: reduce repeated long-history prefix comparisons without changing public
cursor/projection behavior or retaining the caller's outer event array strongly.
Architecture: one private optional WeakRef per cursor; consume it at entry,
check it only after existing iteration safety, and republish only after complete
accepted read/result preparation. It proves equality only for the immediate prior
certified immutable input. All other paths remain the baseline path.
Tech stack: existing JavaScript ESM, node:util, native WeakRef and node:test; no new
dependency, SDK integration or public API.
Spec: DESIGN.txt in this directory. Read that file and TEST-MATRIX.json first.

Global constraints
-------------------
DESIGNPREP GO only now; all execution steps below are pending.
Future source base must be rebound AFTER accepted16/17/19.
Product scope: lib/plugins/event-projection.mjs.
Test scope: tools/tests/incremental-projection.test.mjs, preserving all old cases.
Root owns future PERFORMANCE/ORCHESTRATION doc qualifiers.
No new export, option, metric, snapshot cache, SDK label, source adapter or strong
outer-array ownership. No runnable code/probe/patch appears in this plan.
Preserve all original gates, native tests/cold boots, pins, CLI/default concurrency,
reporter/order, assertions, timeouts and provider budgets listed in DESIGN.txt.
Schema membership Sets and preset cleanup are excluded.

Review focus
-------------
1. A cached certificate must not survive intervening unsafe or distinct input as
   an immediate-input proof: fixtures T2/T3/T4 pin these public transitions.
2. A frozen outer array with mutable restored data must replay after mutation:
   existing fixtures plus T5 retain that behavior on the exact same outer object.
3. A changed global iterator must win over a cached identity: T4 retains original
   reset/full-replay behavior and restores the global in finally.
4. Optional weak identity/certification failure cannot add throws or force resets:
   T6/T7 retain baseline results; a revoked Proxy normalization throw is T3.
5. Repeated reads must still allocate new tails and invoke custom reducer append /
   snapshot with their original error/counter order: T1/T8 use public interfaces.

Task A: rebind and adopt the exact source contract
-------------------------------------------------
Files read: accepted16/17/19 versions of the two scoped files, docs/PERFORMANCE.md,
docs/ORCHESTRATION.md, working-context.mjs, guard.mjs, session-observation.mjs and
the unchanged four native test files. No product write until CODE GO.
Consumes: root's accepted-source receipts, this sealed design, fresh independent
DESIGN review and root formal adoption.
Produces: root-reviewed exact source-base binding and reconciled source/test map.

- [ ] Obtain the accepted16/17/19 source artifact identities; verify exact hashes
      and record changes against frozen706 for every touched/relevant input.
- [ ] Reconcile any change to cursor certification, previous-prefix ownership,
      policy/cut/session resets, imports or test scheduling. A material conflict
      returns to design review; line-number adjustment alone is not reconciliation.
- [ ] Verify fresh independent DESIGN review, root full read/formal adoption and
      separate CODE GO identify this exact sealed design and source base.

Task B: preserve behavior and implement the private equality shortcut
-------------------------------------------------------------------
Modify: lib/plugins/event-projection.mjs only.
Tests: tools/tests/incremental-projection.test.mjs only.
Consumes: createEventCursor().read(input) -> {reset,events}; existing private
verified/frozenDataArrays/previous invariants; existing projection reducer API.
Produces: same signatures, same outputs/counters/errors, optional reduced private
comparison work and weak outer-array bookkeeping. No new public interface.

- [ ] Add only missing public fixtures from TEST-MATRIX.json, using existing
      freeze/event/fold helpers. Keep old cases and assertions. Tests do not
      inspect the private WeakRef, count prefix operations or assert elapsed time.
- [ ] Under separately approved finite runtime authority, run the targeted suite
      against the rebound baseline with each exact Node22.23.2 and24.19.0 binary:
      node --test tools/tests/incremental-projection.test.mjs.
      Expected: all existing and new preservation fixtures PASS without skips,
      cancellations or TODOs. A baseline failure is not presumed to justify this
      optimization; report it before implementing.
- [ ] Add the single per-cursor optional weak slot and the normative six-step
      read ordering in DESIGN.txt. Use no new wrapper or callback in the public
      path. Skip only the certified immediate-repeat prefix loop. Preserve the
      existing optional Object.isFrozen branch exactly in order/error behavior.
- [ ] Ensure result construction precedes best-effort weak publication, and both
      optional dereference and reference creation failures fall back without new
      throws or new reset behavior. Reuse a valid existing reference on a hit.
- [ ] Update only nearby implementation comments to explain the weak identity
      exception and unchanged validation obligations. Leave createEventProjection,
      reducer algorithms, callbacks and public metrics untouched.
- [ ] Re-run the targeted suite once per approved exact Node binary, checking
      output parity, all T1-T10 obligations and no new warning/error side effect.
- [ ] Review the diff against the state-transition table and source proof: no
      branch may publish after a fallback/partial read; no stale/historical token
      may establish equality; no new strong outer-reference field may persist.

Task C: review, regression and accurately scoped evidence
--------------------------------------------------------
Consumes: Task B source/test diff and exact baseline/candidate identities.
Produces: reviewed preservation evidence and a root decision about independent
long-history CPU measurement; no native deadline-fix claim.

- [ ] Obtain fresh implementation review focused on source invariants, optional
      capability errors, weak ownership and unchanged projection ordering.
- [ ] Complete the existing offline verification command under approved runtime:
      node tools/verify-all.mjs --mode=offline.
      Expected: existing required stages PASS with original limits; do not add
      concurrency/reporter flags or mutate case selection to obtain a pass.
- [ ] Reuse the original integration/native commands and all native cases without
      edits only when root separately schedules/authorizes that work. The unchanged
      source native command is --test with host-boundaries, host-runtime,
      host-api-contract and scheduler-native test files, retaining the original
      stage60,000ms and collector65,000ms. Existing FAIL evidence remains FAIL;
      targeted parity never substitutes for this complete gate.
- [ ] If root requests CPU evidence, prepare the finite comparison described in
      ANALYSIS.txt as a separate reviewable artifact. No measurement script or
      runtime is supplied here. Run only after its exact preparation is reviewed.
- [ ] Root updates PERFORMANCE/ORCHESTRATION using DESIGN.txt's cost qualifiers,
      retaining source/measurement distinction and every existing safety caveat.
- [ ] Seal reviewed exact source/test hashes and results for root acceptance.
      Commit/push/merge require their existing root integration authority and
      exact accepted source; this design preparation grants none.

Self-review and pending gates
------------------------------
The design fits one product module and one existing behavioral test file. The
test plan is intentionally preservation-oriented: baseline success is expected,
not an artificial red test of private internals. Existing native cases remain
untouched. Review focus maps to explicit matrix rows. Optional WeakRef/GC behavior
is conservative and does not create a runtime reliability dependency.

Fresh independent DESIGN review, root full read/formal adoption, accepted16/17/19
source rebind and separate CODE GO remain pending. No step has been executed.
STOP after sealing this static plan and its supporting evidence.


## Root normative adoption and accepted-source rebind

This root notice supersedes preparation-only/pending status labels in the preserved historical design/plan body above. Independent Task20 DESIGN report SHA256 `9a4515d056d14904712a12fd2207d4830c56fa202591ace32bcc324019907eec` and root FULLREAD/rehash receipt `7fd172115c9889a4cde8d53c15575cb14d885e375e0f1b7f1cdecef0f6c87d68` are accepted. Historical frozen706 observations remain historical; no new runtime or native performance result is inferred.

Implementation base is fully accepted Task19 `7930c35165f874337766e98588a2d5478f0e5b79` / tree `e52cbc49fde710ca4f5b7127f1ece0541319503f`, descending from accepted16/17. Task19 acceptance SHA256 `39e27d1b2b7290f802dd5e00e02f3f4f1c489835390613a6064f4472167a6bc1`; Task16 `7cbd2b69e589a8f1b8b1944c088576521c91cd649d760fe0d9ae2e47270c7955`; Task17 `6bc984b96d390063f8b622624726de1528584cdf569e916a8090ed350020c43b`. All13 touched/relevant module, test and cost-document inputs are byte-identical to the independently reviewed frozen706 sources. No cursor certification, prefix ownership, policy/cut/session reset, import or native-test scheduling invariant changed; complete source identities are recorded separately by root. Database caller fixes are accepted separately and do not expand Task20 scope.

Normative product scope remains only event-projection.mjs; behavioral additions stay in the existing incremental-projection test file, preserving its original401-line prefix. Root adds one strict appended-event reference assertion to the independently reviewed preservation draft; both baseline and candidate use that identical strengthened test. There are15 added test instances. Baseline success is required and is never manufactured RED. Optional WeakRef operations, current iterator guard, sequence/graph validation, previous update before result preparation, fresh tails, reducer callbacks/counters and weak ownership retain the reviewed six-step order.

Separate root CODE/runtime GO is still required. Original Node/SDK pins, CLI/default concurrency/reporters, native cases and `60000/12000/2×10000/180000`, request80/output8192, SDK adapter CLOSED and acceptance gates remain unchanged. The finite CPU preparation V2 has independent static review and root read, but future accepted baseline/candidate complete source bindings and both-pin preservation evidence are still required before its one fixed batch. Cost documentation is updated after code acceptance; no native60s cure, GC guarantee or explanation of production stops is claimed.


## Root implementation acceptance and completed finite measurement

This later root notice supersedes the earlier pending implementation/measurement labels only for the work recorded here. The reviewed baseline `43e484ee64d28af01c5d378422c10cc0dfa578bd` and implementation `8f02d99b1c2ffdd4b62972f9f9d0d8e8e015443b` each passed all35 preservation instances on both exact Node pins. The original Node24 offline command completed all7 stages with2142 total /2122 PASS /20 existing host SKIP /0 FAIL; host integration remains UNVERIFIED. Original401 test-prefix bytes and all15 added preservation instances remain intact. Callable weak-fault fixtures observed three candidate fault paths; two unavailable-capability fixtures were unobserved, and no-target is not a GC measurement.

Fresh SPEC `fd96220472ded914ee36c5fe20f04e8dd54795894eacead1cdb269ffd6edbcd9` was saved STOP, root read/rehash completed, and a fresh explicit QUALITY GO followed. Fresh QUALITY `6630afe299d3cfbbd774fb8aa332af30ed304fb0a7fa062331f2403844240984` was saved STOP and root read/rehash completed. Root accepted Task20 implementation with receipt SHA256 `b2ae336dbdfcd79f6aea2182dfbdca6b2ece4e90967e76c35fa647ce8b105a50`; this is component acceptance, not release acceptance.

After acceptance and the two qualified cost-document updates, both complete215-file variants were frozen. One fixed12-child CPU batch completed without retry:2688 public reads /1920 measured, exact parity and empty stderr throughout. Root FULLPARSE receipt `29207fc2105b60e6e9ae6c2de85170a4fd8e3a6867c700c78335f35e348b7190` independently reconciles the raw evidence. The [measurement report](../research/2026-10-11-repeated-frozen-event-cursor-measurement.md) retains all32 result groups, slower controls and same-job strongly-owned/no-GC limitations. No full native, model, whole-step or production-stop conclusion follows. Original gates and budgets remain unchanged; further runtime needs separate candidate-specific authority.
