# FIFO排队意图独立撤回 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 撤回一个未准入的持久排队意图即可恢复FIFO，无需取消业务任务或扩预算。
**Architecture:** 现有scheduler写事务/CAS和decision envelope提供零DDL持久幂等，admission与withdraw均验证action。
**Tech Stack:** Node ESM、真实SQLite、TaskforceScheduler/Governor、operator backup/restore。
**Spec:** `docs/superpowers/specs/2026-10-11-scheduler-withdraw-design.md`

## Global Constraints

- @local/dsh-taskforce/taskforce/任务部队/$DSH_HOME/taskforce/taskforce.db保持。
- Node ^22.23.2 || ^24.19.0；固定宿主0.2.0-rc.2/0.2.1-alpha.2；无新依赖/DDL。
- 验收60000ms、cleanup12000ms，full-tree adapter关闭，原governor额度/计费/holds不变。
- 仅queued未reserved；当前与captured owner/run检查；无外部effects、退款、task取消。

## Review Focus

- admission/withdraw动作间同键不能串用结果或扩大权限。
- 一个并发竞争只有先withdraw或先admit两种串行结局，无幽灵reservation。
- 已withdraw意图不能用新键重复裁决，旧精确键重放无写。
- owner变更后worker无资格借旧请求键重放；lead同run恢复仍可用。
- 旧untaggedadmission决策兼容，跨版本writer限制公开且backup不丢envelope。

### Task 1: host-only withdraw

**Files:**
- Modify:`lib/scheduler/index.js`, `docs/SCHEDULER.md`
- Test:`tools/tests/scheduler.test.mjs`, `tools/tests/operations.test.mjs`（仅新增撤回备份回放）、`tools/tests/fixtures/scheduler-worker.mjs`（只扩展真实分进程竞态驱动，保留默认admit行为）
**Interfaces:**
- Consumes:现有queued row、scheduler_decision、#task当前/捕获owner、BEGIN IMMEDIATE/CAS。
- Produces:withdraw({request_id,request_key},runId,authority)；public {status:'withdrawn',request:<existing view>,replay:boolean}；内部tagged envelope，不变DDL。

- [ ] **Step 1: RED** — 两永久预算head场景、正常FIFO、所有state/owner/key/action边界、lead enqueue未归属→worker claim但captured owner null时worker拒绝/lead允许、rollback、实际两worker分进程连接竞争、操作backup/restore和无写replay；不能用同进程Promise.all模拟竞态。
- [ ] **Step 2: Observe RED** — unchanged产品下missing withdraw预期断言失败保存，原admission正控仍pass。
- [ ] **Step 3: Implement** — 同transaction目标/权限/旧决策、queued且未reserved CAS、新envelope；admitNext校验action后才回放，保持旧admissionresult。state/原enqueue自然输出withdrawn，无governor调用。
- [ ] **Step 4: GREEN** — scheduler/operations定向及sole `npm test`退出0，真实竞争串行结果，原budget/holds/task字节比较保持。
- [ ] **Step 5: Commit** — docs说明API、owner重放规则、head恢复及混合writer限制；owned files提交，外部完整报告controller独立审核。
