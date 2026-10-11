# 原生身份准备纠正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** H01准备返回真实独立fork run和不被低估的有效委派深度。
**Architecture:** 只在严格live委派链上合并持久与runtime深度；普通根的seed血缘不参与委派。
**Tech Stack:** Node ESM、实际固定DSH Agent、现有H01同步helper及node:test。
**Spec:** `docs/superpowers/specs/2026-10-11-native-identity-design.md`

## Global Constraints

- @local/dsh-taskforce/taskforce/任务部队/$DSH_HOME/taskforce/taskforce.db保持。
- Node ^22.23.2 || ^24.19.0；固定宿主0.2.0-rc.2/0.2.1-alpha.2；无新依赖/schema。
- 验收60000ms、cleanup12000ms、委派上限2，全树adapter和全部能力false。
- exact live Agent/parent/64链/cycle/占用ID栅栏；不复制离线祖先fallback。

## Review Focus

- 普通fork即使seed父离线也应独立准备。
- runtime depth只能提高，不能降低header和实际链所需深度。
- origin-only委派的实际链不能因缺depth字段被计为root。
- 同ID重构对象或新proxy不能替代真实live Agent对象。
- 纯helper成功不意味着H02-H06或native adapter已满足。

### Task 1: H01委派链与深度

**Files:**
- Modify:`lib/scheduler/dsh-host.js`, `docs/SCHEDULER_HOST_CONTRACT.md`
- Test:`tools/tests/scheduler.test.mjs`, `tools/tests/scheduler-native.test.mjs`
**Interfaces:**
- Consumes:actual Agent.session.header、Agent.options、native agents.get、现有prepareNativeIdentity签名。
- Produces:同shape只读prepared identity；正确root_run_id/delegation_depth，native_enabled始终false。

- [ ] **Step 1: RED** — 完整shape矩阵与现有真实native测试中fork/runtimedepth案例，保持无模型、cleanup watchdog。
- [ ] **Step 2: Observe RED** — 先保存purefixture及两pinsnative预期run/depth失败，产品helper未改。
- [ ] **Step 3: Implement** — 严格验证两depth来源，按真正委派关系上溯，普通root立即停止；保守合并声明和链长，所有拒绝/false声明保持。
- [ ] **Step 4: GREEN** — scheduler定向、两pinsnative同命令、sole `npm test`全量退出0；不增加deadline，不弱化现有清理。
- [ ] **Step 5: Commit** — 文档区分seed/fork与委派、runtime depth、准备信息与关闭adapter；仅owned files，外部完整报告和controller独立审核。
