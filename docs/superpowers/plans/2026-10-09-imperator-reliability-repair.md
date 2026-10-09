# Implementation plan — Imperator paging/count/guard repair

Spec: ../specs/2026-10-09-imperator-reliability-repair.md
Base: f808be5a73245c921518aece420f179519470d3e

1. Add meaningful negative regressions in existing real-SQLite board-pagination tests and durable guard-causality tests. Keep production untouched. Push a test-only commit to isolated codex/fix-imperator-paging-and-child-errors. Expected: existing CI fails on E_PAGE_CHANGED, visible fact count and semantic ECHO assertions; inspect job logs rather than infer from status.
2. Implement bounded paired-token mutable pagination, shared visible-fact SQL and registered-tool semantic ECHO handling. Forward schema arguments, update continuation callers and document restart/compatibility behavior. Add edge cases for new resolution, unchanged pending-state transitions, token scope, independent cursors, budgets, and genuine native tool-result content. Expected: full offline and native packed-package verification pass on both supported Node versions.
3. Open PR and attach it to this task. Dispatch a fresh reviewer for the complete base..head change, including token upper bounds, complete fingerprint, new resolver semantics, NULL/foreign parent facts and PTC matching. Repair important findings with failing regression evidence and rerun CI. Expected: no unresolved important findings and successful checks for exact PR head. Merge the authorized reviewed head, then verify merged PR/main and post-merge CI.

Global constraints: preserve existing SQL scope authorization and unpaged host board API; no new model calls, database writes during reads, scheduler/cancel behavior or upstream host upgrade. Current main has no AGENTS.md. Root implements; a fresh independent reviewer performs the final PR review.

Execution ledger:
- Design independently reviewed read-only by child_stop_audit; candidate ceilings must include initially ineligible rows, and resolver IDs are not capped.
- Local executor unavailable; remote branch/CI replace local worktree commands and ignored scratch ledger. This checked-in plan records evidence across compaction.
- Test task: prepared; execution pending.
