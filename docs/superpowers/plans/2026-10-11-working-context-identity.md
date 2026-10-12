# 每步上下文真实身份 Implementation Plan

> REQUIRED SUB-SKILL: superpowers:executing-plans for the sole implementer; controller uses subagent-driven-development with fresh specification then quality review.

**Goal:** 每步上下文与宿主工具的实际 run 一致，恢复被错误遗漏的任务/事实投影。
**Architecture:** 现有轻量 resolver 按每个 Agent 的两个深度源与精确 ID 解析；其余状态投影保持。
**Spec:** docs/superpowers/specs/2026-10-11-working-context-identity-design.md

### Task 1: 身份观测对齐

**Owned files:** lib/plugins/working-context.mjs; docs/CONTEXT.md; tools/tests/context-boundaries.test.mjs; tools/tests/scheduler-native.test.mjs.

- [ ] Read spec and prior fixes. Exact BASE is controller-filled after predecessor independent PASS and planning commit; never change root ledger/version or other paths.
- [ ] Test-only RED before production. Real SQLite context hook for three manifestations and negative controls; preserve old tests. Reuse actual registered runtime-only Agents in existing scheduler native fixture for both pins, no providers/second application; controlled hook scope explicitly disclosed. Include ordinary fork and exact whitespace IDs plus real tool identity parity.
- [ ] Run focused unit and both native pins; retain expected wrong-run/empty projection RED and source proof, not missing imports or helper errors.
- [ ] Minimal resolver correction plus defensive observed cache-ID read: bounded nonblank exact IDs; effective depth per current and ancestor Agent; retain 32-hop/live-header identity/cycle/offline-depth1/error/no legacy rules, no extra cache or shared-module refactor. Preserve fork flow/TODO ownership changes.
- [ ] Focused GREEN both native pins, normal-store readonly/context output assertions and existing parity controls. Final source frozen for one sole npm test. Keep60s/12s watchguards and actual cleanup/zero provider observations.
- [ ] Update CONTEXT with runtime and exact-ID observation scope; stage/commit four owned paths only. Full external implementation-report.md/task-1-report.md/rawlogs/REDGREEN/sourceproof/identity/progress. Controller fresh spec then quality review before later tasks.

Design audit amendments accepted: explicit missing-vs-malformed parent distinction and no agent.id fallback; valid-depth/negative-zero/mixed-source matrix atcaller+ancestor; exactpaddedIDs200/201 realSQLite domains;32lookup/33lookup boundary; sameAgent runtimechange includingafterawaitnext; wholehook currentheader/ID/options andancestorheader/options faults withtiny stateOf observed-ID catch. Do not alter other cache identity/scope/session resets or importtools into production. See context-identity-design-audit.md for verifiedsource rationale.
