# Task 21: Native fixture test isolation

## Approved scope and evidence

This change repairs the directory-ownership assertion in `tools/tests/host-runtime.test.mjs`, in the test named `controlled fixture creation owns the environment before its first await and old disposal is inert`. The implementation changes that test and adds this design and its implementation plan. Production helpers, native arguments, concurrency, reporters, SDK pins, time limits, and acceptance rules stay unchanged.

The parent candidate is `9ea8ba78e8e8dda1e5e73f9db1d705f172796f53` (C9), tree `2995810a5c64b5c952e9dbe63e6c266caba601c3`. Its actual Node 22 V6 rc.2 native boundary run remains failed: 109 tests, 108 passed, one failed, no cancelled/skipped/todo tests, duration 33603.232744 ms. Test 69 failed at the original line 110 because the shared temporary directory snapshot gained `taskforce-host-CffUz5` alongside the expected `taskforce-host-or3P1j`. This was an assertion failure after 33.603 seconds for the native child, not the 60-second verifier limit. The source offline command completed; the later rc.2 HOST 17 and ISOLATION 13 checks passed, but they do not turn the failed command into a pass. Alpha.2 did not start in this attempt. No MODEL acceptance ran.

The original output and root reconciliation remain immutable. The root reconciliation is `/workspace/imperator-evidence/20261011/root-final-node22-v6-failure-reconciliation-v1/root-failed-attempt-reconciliation-accepted.json`, SHA-256 `5e7f35a4babd22e0c705460e333f460c9b7eca10738caa7404dff8350fc4b4ad`. The implementation authorization is the adjacent `root-task21-static-design-implementation-go.json`, SHA-256 `5ded4c44636d8d486927a718fb57662eadf691e53510b3e3cc12ff166712f375`; it authorizes source changes and explicitly does not authorize runtime execution.

## Defect and ownership boundary

`controlledProfile()` checks the module-local active profile before allocating a directory, mutating the environment, or awaiting native loading. A rejected competitor therefore cannot reach its directory allocation through the current control flow. The old test's `homes()` instead enumerated every `taskforce-host-*` directory under `tmpdir()`. The native verifier runs four test files with the original default file concurrency. Other test processes can legitimately allocate matching directories in that shared parent while this test awaits the rejected competitor. Their allocations are outside this test's ownership.

This establishes an unsound shared-directory assertion without requiring a product leak. The actual extra directory's owner, lifetime, and overlap were not attributed by the evidence. Historical long execution and subagent stops also remain unattributed. This change makes no claim that this assertion explains those stops or the collector's separate stop condition.

## Test contract

Before setting any temporary environment variable, save the exact string-or-absent values of `TMPDIR`, `TMP`, and `TEMP`, and create a uniquely named private parent using the caller's current `tmpdir()`. Set all three variables to the private parent for this test's controlled profiles. Enumerate matching homes explicitly in that parent, so the assertion and the helper's allocation share a bounded namespace.

The first profile must synchronously establish exactly one matching directory before the first await. Assert that the baseline has length one and that `join(fixtureTmp, beforeHomes[0], 'home')` is the active `DSH_HOME`. These assertions sit inside the existing profile-disposal `try/finally`, so a baseline assertion failure still reaches that profile's disposal. This guards against an empty snapshot or an unrelated baseline accidentally satisfying the equality check.

Retain every original assertion: the second active profile rejects with the original message; the active home, full matching-directory snapshot, and raw listener baseline remain equal; disposing an old profile cannot change a current profile's home; and the original `DSH_HOME` and telemetry values are restored. Do not filter out a second directory within the private parent or weaken the strict snapshot equality.

After all three successful profile lifecycles have disposed, assert that the private parent's matching-home list is empty. Evaluate this assertion before removing the private parent. The outer `finally` restores each temporary environment variable to its exact original value, deleting it if originally absent, and then removes the private parent for test hygiene. Removing the parent cannot satisfy or suppress an already failed ownership assertion.

This test remains sequential within its own test file and isolated from the environment of the other native test-file processes. The change does not serialize the four-file native gate or change its arguments, timeout, reporter, or SDK behavior.

## Verification and acceptance

Static review must prove that only the approved three files changed, all original assertions remain, the private baseline is nonempty and owned, and the final empty assertion precedes parent removal. Freeze the exact source bytes and prospective product fingerprint against C9 before fresh independent SPEC review, root full read, fresh QUALITY review, and root authorization for runtime checks.

The bounded runtime proposal must test both sides of the ownership boundary. A separate process should acquire a real controlled profile under the outer temporary parent after the private baseline is captured, acknowledge readiness through an explicit barrier, and retain it until the private snapshot comparison completes. Its real foreign directory must be observed outside the private parent, with no provider request or model stage. The isolated target must still exercise all original assertions. Separately, insert a real additional `taskforce-host-*` directory inside the private parent after the baseline and require the unchanged strict equality assertion to fail with that added entry before cleanup. This deliberate negative result must remain distinct from acceptance gates; catching and recording the expected assertion is not a native-gate pass.

Exercise restoration with each temporary variable absent and with distinct original string values, including mixed cases, on normal completion and the intentional assertion failure. Bound every diagnostic process and release only its owned fixture. Use explicit barriers rather than timing sleeps, leave default native file concurrency intact, and preserve raw outputs and exit statuses. A regression probe must not replace the original full native gate or mask a real leak by removing directories before asserting.

After separate authorization, run the original source/archive checks and full native rc.2 and alpha.2 gates for the new candidate with the original arguments, default limits, reporters, and SDK pins. Any new candidate requires new evidence; C9's failed V6 evidence cannot be relabeled. The static implementation alone provides no runtime, MODEL, or release acceptance.
