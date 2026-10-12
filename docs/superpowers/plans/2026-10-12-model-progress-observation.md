# Model progress observation implementation

Design: [model progress observations](../specs/2026-10-12-model-progress-observation-design.md).

The preceding actual candidate failed MODEL repair at its original deadline.
The next iteration improves diagnosis; it does not claim to fix that timeout.
The design received independent static SPEC and QUALITY review before edits.

- [x] Preserve the failed report, command, exact source/package binding and
  scoped cleanup evidence. Release only the proven permanently paused collector.
- [x] Independently review the failure facts and relevant source. Distinguish
  pre-cancel running work from later idle state and unmatched assistant messages
  from settlement notices.
- [x] Review the bounded observation design and its noninterference requirements.
- [x] Add a meaningful failing offline case against the unchanged verifier.
- [x] Implement local coordinates, bounded tables and separated event tails,
  reusing owned event associations and bounded parsing.
- [x] Capture phase-labelled observations and validate the optional primitive
  hook without changing existing diagnostic schemas or verifier verdicts.
- [x] Verify offline regressions on both pinned Node versions, retaining failures
  and exact command/output evidence.
- [ ] Extend genuine native concurrency, cold reuse, cancellation and PTC
  checks; exercise fresh accepted control and accepted replay without paid calls.
- [ ] Perform independent implementation SPEC and QUALITY review and fix findings.
- [ ] Freeze the reviewed candidate and run the original source, packed,
  single-CPU and dual-host gates; inspect actual logs and cleanup evidence.
- [ ] Consider one purpose-specific actual model sample on the new candidate,
  retaining all original limits and independent grading.
- [ ] Update the PR, complete CI, perform a fresh premerge review, merge against
  the reviewed head, and verify the actual main commit and CI.

No repeated paid call on the failed candidate, timeout extension, automatic
submission/acceptance, additional waiver, SDK change or new production tracing
service is part of this plan.

The implementation handoff preserves all 22 offline attempts, including the
initial admission-incomplete RED and corrected failures. The final complete
model regression file passed 329 cases on each pinned Node version with zero
failures or skips. The four native fixture extensions are saved and unexecuted;
fresh implementation review, native verification and release gates remain open.

The first independent implementation SPEC found stale refresh authority and
missing terminal-accounting observations. Both blockers were repaired after
meaningful RED cases on the v1 verifier. All six repair runs are retained; the
final complete offline file passed 332 cases on each pinned Node version with
zero failures or skips. Accounting, stage gates and native Promise inputs stay
unchanged. Fresh complete implementation SPEC and QUALITY remain pending.

Complete implementation SPEC then passed on those repaired bytes. The next
independent QUALITY review found one further omission: a failed disposal
identity read made legacy diagnostics unavailable but left observation coverage
complete. The existing authority-loss path now covers that catch. A healthy
owned-session regression failed on the prior verifier on both pinned hosts;
the final complete offline file passed 333 cases on each, with zero failures
or skips. All four runs and the failed review are retained. Fresh complete
SPEC and QUALITY, genuine native execution and release gates remain pending.
