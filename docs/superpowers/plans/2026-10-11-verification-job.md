# 验收promotion即时诊断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将真实promotion的即时job定位与恢复提示返回给执行owner，严格验收保持拒绝。
**Architecture:** 仅verification wrapper返回体投影白名单诊断，原native执行和durable receipt路径不变。
**Tech Stack:** Node ESM、实际DSH Bash/jobs、SQLite、node:test。
**Spec:** `docs/superpowers/specs/2026-10-11-verification-job-design.md`

## Global Constraints

- @local/dsh-taskforce/taskforce/任务部队/$DSH_HOME/taskforce/taskforce.db保持。
- Node ^22.23.2 || ^24.19.0；宿主0.2.0-rc.2/0.2.1-alpha.2；无依赖/schema改变。
- 验收60000ms、cleanup12000ms，full-tree关闭，unknown不能成为成功或允许重复effects。
- 只即时current-owner-process诊断，durable:false；禁止raw output/path字段和自动job控制。

## Review Focus

- promotion即使task_verify传run_in_background:false也可能发生。
- locator从本次真实native union取得，不从rendered content解析。
- 非法/超长ID为job_id:null，background或非法timeout为timeout_ms:null；未批准的原生字段省略，不回显原值，不能变成有效receipt。
- 即时locator不落持久receipt/backup/restore或建立跨owner权限；owner指发起本次调用的原生会话，任务await中重新分配不转移原生job权限。
- 正常foreground与nativeerror/UNKNOWN_TOOL原行为和清理仍一致。

### Task 1: bounded native_job response

**Files:**
- Modify:`lib/tools/verification.js`, `docs/CONTROL.md`
- Test:`tools/tests/execution-receipts.test.mjs`, `tools/tests/host-boundaries.test.mjs`
**Interfaces:**
- Consumes:runTaskVerification的原nativeResult、completedreceipt和同ownerhost调用。
- Produces:仅promoted/background直接返回native_job白名单结构及next；无持久或exports变更。

- [ ] **Step 1: RED** — 精确字段/null投影、foreground/error负控、256/257字符及非string jobID、safe正integer timeout边界、receipt持久不变、owner/generation在await中变化的promoted结果与strict拒绝；在已有anchor-awarehost边界加入两pins真promotion+foreground，cleanup显式kill/wait。
- [ ] **Step 2: Observe RED** — unit+两个实际pins本次locator缺失预期失败，unchanged wrapper，保存日志。
- [ ] **Step 3: Implement** — receipt持久完成后小白名单投影，固定恢复提示；禁止把renderedoutput变为rawlog成功、未知仍未知。
- [ ] **Step 4: GREEN** — unit、两pinsnative边界及sole`npm test`退出0，strict拒绝/正常验收和jobcleanup保持。
- [ ] **Step 5: Commit** — CONTROL解释瞬时定位/owner边界/非durable/重验前检查，owned files提交，外部报告controller独立审核。
