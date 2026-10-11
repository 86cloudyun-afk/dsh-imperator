# fork继承观测归属纠正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 父fork历史不计为child失败、派发或lifecycle，同时保留完整可见context历史与restore own活动。
**Architecture:** 共享owned-window工具读取持久inheritedEventCount，在guard/flow/lifecycle活动入口选owned后缀，visiblecontext/TODO继续现有读取路线。
**Tech Stack:** Node ESM、现有incrementalprojection、真实固定SDK Session、SQLite lifecycle。
**Spec:** `docs/superpowers/specs/2026-10-11-fork-observation-design.md`

## Global Constraints

- 保留@local/dsh-taskforce/taskforce/任务部队/$DSH_HOME/taskforce/taskforce.db。
- Node^22.23.2||^24.19.0；宿主0.2.0-rc.2/0.2.1-alpha.2；无依赖/schema改变。
- 验收60000ms、cleanup12000ms，full-tree关闭；不把warning证据解释为已证实生产shutdown。
- scope/未知effects/ACK/reset/restore/真实seq/append-only旧audit保持；completevisiblecontext去重/supersede/TODO语义保持。

## Review Focus

- inheritedEventCount与firstLiveSeq在restore时不同，不能丢旧own事件。
- slicing所有visiblecontext会让父状态投影继续可见却无法被supersede。
- 切点坏值/变化、mutable或accessor历史不能让已认证prefix保留旧活动结果。
- own子会话六失败仍能触发真实ECHO，unknowneffect仍断开明确失败链。
- fork继承大前缀时处理owned后缀而不重复扫描/复制全部继承历史。

### Task 1: owned observation window

**Files:**
- Create:`lib/plugins/session-observation.mjs`（小型owned-window helper，命名可与实现公共函数一致）
- Modify:`lib/plugins/guard.mjs`, `lib/plugins/working-context.mjs`, `lib/plugins/lifecycle.mjs`, `docs/CONTEXT.md`, `docs/RECOVERY.md`
- Test:`tools/tests/incremental-projection.test.mjs`, `tools/tests/lifecycle-recovery.test.mjs`, `tools/tests/host-boundaries.test.mjs`（使用现有登记文件，不新增TESTS清单）
**Interfaces:**
- Consumes:现有sessionEvents数组、Session.inheritedEventCount、createEventProjection和recordLifecycle。
- Produces:小型owned-window结果events/valid；guard/flow/lifecycle使用own活动；完整canonical visible context读取维持。

- [ ] **Step 1: RED** — 三独立manifestation及root/freshchild/ownappend/restore/ACK/unknown等控制，坏切点/变化与mutable reset，visible inheritedcontext去重/supersede/compaction不变。真实SQLite对比child own seq与父seq，原source未改。
- [ ] **Step 2: Observe RED** — 定向unit与两pins nativeSession案例预期owned计数/新指导/错误lifecycle失败，保存完整日志。
- [ ] **Step 3: Implement** — 共享验证切点与owned后缀，入口分别使用owned活动和fullvisiblecontext，不增加deprecatedAPI调用；lifecycle非法切点固定gap，不改旧行。重构不得冲掉前任务控制修复。
- [ ] **Step 4: GREEN** — 定向三文件/两pins anchor边界及sole `npm test`，全部退出0；记录处理own事件数、root parity、scope/reset和实际cleanup。
- [ ] **Step 5: Commit** — CONTEXT/RECOVERY说明own与visible差别、历史audit界限；ownedfiles提交，外部完整报告controller独立审核。
