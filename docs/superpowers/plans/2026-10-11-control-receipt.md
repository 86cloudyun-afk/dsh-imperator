# 控制回执返回一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已接纳控制效果及时返回真实回执，显式拒绝的文字与持久状态一致。
**Architecture:** 删除未消耗的操作后异步目录读取；活动表同步独立观察。保留操作前直属授权和原 journal/重放链路。
**Tech Stack:** Node ESM、node:test、实际 SQLite 与固定 DSH 接口。
**Spec:** `docs/superpowers/specs/2026-10-11-control-receipt-design.md`

## Global Constraints

- 保留 @local/dsh-taskforce、taskforce、任务部队和 $DSH_HOME/taskforce/taskforce.db。
- Node ^22.23.2 || ^24.19.0；固定宿主0.2.0-rc.2/0.2.1-alpha.2；无新依赖。
- 验收60000ms，cleanup12000ms；full-tree adapter关闭。
- 直属授权、真实Agent、原请求键、journal身份、unknown保守语义和效果次数保持。

## Review Focus

- 操作前目录查询不能被省略或被活动表替代。
- 副作用后取消不允许将accepted转换成明确未执行。
- running/idle/unknown不证明路由或后代进程已停。
- 明确拒绝的新回执与durable rejected重放不能互相矛盾。
- 测试不等待已删除的第二目录barrier而产生自身挂起。

### Task 1: 无冗余后读的控制回执

**Files:**
- Modify: `lib/tools/index.js`, `docs/CONTROL.md`
- Test: `tools/tests/tool-recovery.test.mjs`, `tools/verify-child-control.mjs`（仅确需调整现有后读假设时）
**Interfaces:**
- Consumes: ownChildOf、liveActivityOf、controlIntent/finishControl及同步void interrupt。
- Produces: 既有send/stop结果字段；仅删除无消费异步后读并使state_truth匹配accepted。

- [ ] **Step 1: RED tests** — send/stop使用实际SQLite，副作用/持久outcome barrier后，第二目录永远pending或throw均及时返回；调用者abort后accepted不变，effect=1；拒绝×running/idle/unknown文案不含肯定接纳或已发信号。预flight拒绝、缺agent、重放是正负对照。
- [ ] **Step 2: Observe RED** — 仅新增测试先跑定向name-pattern，保存预期5项失败，测试采用有界Promise race且可清理。
- [ ] **Step 3: Implement** — 只在控制工具结果观察位置调用liveActivityOf；删去无用targetStateOf及不准确注释。拒绝路径的文字以真实accepted分支为先，独立活动态原语义不变。
- [ ] **Step 4: GREEN** — 定向tools/recovery验证及`npm test`，全部退出0，无其他全量验证并行；保留日志/实际counts。
- [ ] **Step 5: Commit** — 更新CONTROL解释授权目录与操作后独立观测，提交仅owned文件，外部报告记录RED/GREEN、身份及兼容void界限。controller随后独立审核。
