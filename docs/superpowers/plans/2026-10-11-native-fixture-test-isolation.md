# Task 21: Native fixture test isolation implementation plan

> Execute within the root-approved three-file scope. Runtime checks, commits, and publication require the later root workflow; this plan does not grant runtime authority.

**Goal:** Make the controlled-profile ownership test observe its own temporary namespace while retaining its ability to catch a second allocation, incorrect ownership, missing disposal, environment corruption, listener changes, or stale disposal.

**Design:** `docs/superpowers/specs/2026-10-11-native-fixture-test-isolation-design.md`.

**Parent:** C9 `9ea8ba78e8e8dda1e5e73f9db1d705f172796f53`, tree `2995810a5c64b5c952e9dbe63e6c266caba601c3`. Existing product fingerprint: `d7ab0370c75a720e67b2b730f6baf5020288f58c4dc7fecdb8b9bf371ee38683`.

## 1. Preserve the observed failure

- Keep the actual Node 22 V6 C9 evidence immutable: native rc.2 108 pass / 1 fail, 33603.232744 ms, strict directory equality failure in test 69, no 60-second timeout. Source offline completed; HOST 17 and ISOLATION 13 passed; the whole rc.2 command failed; alpha.2 did not start; no MODEL acceptance ran.
- Retain the distinction between the proven shared-directory oracle defect and the unattributed actual extra directory. Historical long execution/subagent stops remain unattributed.
- Bind the approved implementation GO and root failure reconciliation referenced in the design. No old result becomes a new-candidate pass.

## 2. Implement the approved test-only repair

Modify only `tools/tests/host-runtime.test.mjs` and create the two Task 21 documents.

- Save the exact original values or absence of `TMPDIR`, `TMP`, and `TEMP` in a map.
- Create a private `taskforce-profile-owner-test-*` parent before overriding those variables; override all three inside an outer `try`.
- Read matching home names with `readdirSync(fixtureTmp)` and the existing sorted `taskforce-host-` filter.
- Before awaiting the competitor, assert one baseline entry and `join(fixtureTmp, beforeHomes[0], 'home') === ownedHome`, within the existing disposal `try/finally`.
- Preserve every original assertion and disposal operation, including strict equality of the full matching-directory snapshot, raw listeners, stale disposal, home restoration, and telemetry restoration.
- Assert no matching homes remain after profile disposal, before parent removal.
- In the outer `finally`, restore strings unchanged and delete originally absent variables, then remove the private parent.
- Leave helper/core sources, CLI arguments, default concurrency, reporters, SDK pins, and all limits unchanged.

## 3. Freeze and review the static implementation

- Record the clean C9 starting HEAD/tree, approved GO, before-test bytes, exact three after-files, full three-file patch, and current Git scope.
- Verify by static comparison that the surrounding test file and imports are unchanged and all original assertions survive. Check private-parent baseline, assertion/disposal order, and all three absent/string restoration branches.
- Compute the prospective product fingerprint from the original ordered source-path manifest with the same byte framing as `tools/verify-model.mjs`; identify it as an uncommitted source fingerprint, not a runtime result or committed candidate identity.
- Seal evidence under `/workspace/imperator-evidence/20261011/implementation/task21-native-fixture-test-isolation-v1`.
- SAVE STOP for fresh independent SPEC, root full read, fresh QUALITY, and root runtime authorization. This stage runs no Node, npm, tests, SDK/provider code, process probes, or runtime imports and creates no commit.

## 4. Proposed bounded regression schedule — pending separate authorization

The root-reviewed diagnostic adapter should use exact frozen source bytes and the existing pinned Node/SDK inputs. Prepare and review its concrete barriers, arguments, output files, and finite process limits before running it. Do not modify production helpers or install test hooks in them.

1. **Real foreign fixture crossing the snapshot interval.** In an isolated diagnostic execution of the target test, pause after the owned one-entry private baseline. Signal a separate process to acquire a real `controlledProfile()` under the outer temporary parent, then wait for an explicit ready acknowledgment. Verify its root exists outside the private parent and has the real `taskforce-host-` prefix. Keep it alive through competitor rejection and private snapshot equality. Only after that comparison acknowledge release, dispose the foreign fixture, and wait for its terminal result. Preserve all target assertions. The old shared-parent snapshot is expected to see the legitimate added directory; the repaired private snapshot is expected to stay equal. Record the actual observation; do not force either outcome or call the old diagnostic result a gate rerun.
2. **Private extra-directory negative control.** In a separate diagnostic execution, create one real extra `taskforce-host-*` directory inside the private parent after baseline capture. Require the original `assert.deepEqual(homes(), beforeHomes)` to fail with that extra entry while it still exists. Verify the saved raw assertion failure precedes cleanup. Record this expected negative separately from acceptance results; an unexpected success invalidates the regression probe.
3. **Restoration and disposal checks.** Observe exact restoration of all three temporary variables with absent, distinct-string, and mixed initial states, on both normal completion and the intentional negative assertion. Confirm the private empty-home assertion occurs after profile disposal and before parent removal. A failure remains a failure even when final cleanup succeeds.

Use explicit ready/release barriers rather than sleeps. Bound every diagnostic child, retain stdout/stderr and actual exit statuses, and clean only that diagnostic's owned paths. Do not change default file concurrency, relax equality, remove a suspicious directory before the assertion, modify reporter output, or count an intentionally caught assertion as a full native PASS. No provider/model request is needed or authorized by these diagnostics.

## 5. New-candidate gates — pending root scheduling

After the independent review chain and separately authorized diagnostics, the root schedules all required new-candidate source and archive checks plus original full native rc.2 and alpha.2 gates. Keep the original four-file native argv and default concurrency, including all unrelated native tests. Preserve the original 60,000 ms verifier child limit, 12,000 ms native target limit, 65,000 ms standalone diagnostic collector limit, SDK pins `0.2.0-rc.2` / `0.2.1-alpha.2`, and all other recorded caps.

The targeted diagnostics supplement those gates; they do not replace them. Bind every result to the actual new source/archive identity and actual command. Keep SKIP/UNVERIFIED explanations and failures intact. Commit, PR, premerge review, and release decisions remain with the root workflow after evidence review. This static plan and implementation claim no GREEN, MODEL, or release PASS.
