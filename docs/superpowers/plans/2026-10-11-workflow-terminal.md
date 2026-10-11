# 工作流终态一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拒绝已收口任务的首次普通工作流修改，同时保留只读重放和主控显式重新复核。

**Architecture:** 在 TaskforceWorkflow 共享同步写事务中读取任务、验证精确重放，再检查权威任务终态。复用现有错误和终态集合，避免新 schema。

**Tech Stack:** Node ESM、node:test、node:sqlite、现有 TaskforceStore/TaskforceWorkflow。

**Spec:** `docs/superpowers/specs/2026-10-11-workflow-terminal-design.md`

## Global Constraints

- 保留 @local/dsh-taskforce、taskforce、任务部队和 $DSH_HOME/taskforce/taskforce.db。
- Node ^22.23.2 || ^24.19.0；固定宿主 0.2.0-rc.2 / 0.2.1-alpha.2。
- deadline 60000ms、cleanup 12000ms；无新依赖，全树原生适配器保持关闭。
- run、真实角色/owner、证据代际、完整性、精确重放、严格回执、输出预算栅栏保持。

## Review Focus

- 取消与迟到审核分别提交于同一数据库上的两个连接时，新审核不得写终态。
- 旧请求精确重放在取消/重新打开数据库后仍只读；新键不得冒充重放。
- 终态读取与显式 returnForRework 重新复核仍可用。
- 角色、跨 run 或不一致附属记录不能借终态检查绕过原栅栏。
- 旧版本/历史预算/严格证据与活动工作流正常推进保持。

### Task 1: 终态工作流变更栅栏

**Files:**
- Modify: `lib/workflow/index.js`
- Modify: `docs/WORKFLOW.md`
- Test: `tools/tests/workflow-engine.test.mjs`

**Interfaces:**
- Consumes: 现有 TaskforceStore.TERMINAL_STATUSES、TaskforceWorkflow.#mutate、workflowReplay。
- Produces: 已收口任务的新普通工作流变更返回 E_TERMINAL；精确旧请求重放返回原结果；无新 API。

- [ ] **Step 1: Write failing tests** — 正常 create→approve→claim→verify→artifact→close(failed) 后，取消前版本的新审核 E_TERMINAL；create→close(failed) 后新 approve E_TERMINAL。比较完整 flow/review/decision 行，并在重开/第二连接情形验证无写入。覆盖全部现有终态、新键与精确旧键、活动正控及显式重新复核后正常批准。
- [ ] **Step 2: Verify RED** — `node --test tools/tests/workflow-engine.test.mjs`；在实现未改时观察新增取消场景的预期失败并保存全日志。
- [ ] **Step 3: Implement** — 在 lib/workflow/index.js 共享变更事务内，在成功精确重放之后、版本/工作变更之前，复用权威终态集合拒绝新变更。保持显式重新复核独立通道及原完整性读取。
- [ ] **Step 4: Verify GREEN** — 同一定向命令及 `npm test` 全量退出0，记录 counts、fail/cancel/skip、HEAD/tree 和 RED/GREEN 证据。无其他全量验证同时运行。
- [ ] **Step 5: Document and commit** — docs/WORKFLOW.md 明确终态新变更拒绝、精确重放及显式重新复核；提交 `fix(workflow): 阻止终态任务被迟到审核推进`。提交仅上述文件。完整报告保存外部 task-1-report.md，由 controller 独立审核、创建 PR、复审与合并。
