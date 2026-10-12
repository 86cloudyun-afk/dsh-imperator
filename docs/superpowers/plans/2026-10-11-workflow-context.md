# 工作流重启上下文读取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 显式读取重启所需的持久计划和最近审核意见，默认投影保持紧凑。
**Architecture:** 扩展现有state同一读事务及工具Boolean schema；校验持久上下文，整条裁剪旧元数据，保持真实64KiB输出界限。
**Tech Stack:** Node ESM、SQLite同步read transaction、node:test、既有工具注册。
**Spec:** `docs/superpowers/specs/2026-10-11-workflow-context-design.md`

## Global Constraints

- 保留 @local/dsh-taskforce、taskforce、任务部队、$DSH_HOME/taskforce/taskforce.db。
- Node ^22.23.2 || ^24.19.0；宿主0.2.0-rc.2/0.2.1-alpha.2；无新依赖/schema。
- 验收60000ms、cleanup12000ms，full-tree adapter关闭。
- 现有run/完整性/owner/证据/终态/重放栅栏；上下文只读且不建立事实权威。

## Review Focus

- 显式context在重开数据库后无需重新写checkpoint就可取回。
- 历史审核不能误标为当前revision/plan/generation的通过意见。
- 大量Unicode和JSON转义下实际包含ok:true的响应仍≤65536bytes。
- 坏存储只报通用完整性错误，默认未请求context时不额外展开。
- 真实工具schema/dispatcher必须传递Boolean且不能接收调用者伪造run/actor。

### Task 1: 可选恢复上下文

**Files:**
- Modify: `lib/workflow/index.js`, `lib/tools/index.js`, `docs/WORKFLOW.md`
- Test: `tools/tests/workflow-engine.test.mjs`, `tools/tests/nextgen-tool-integration.test.mjs`
**Interfaces:**
- Consumes:现有workflow.state、workflowIntegrity、workflowJSON，持久plan/findings及工具host身份。
- Produces:state({task_id,include_context?:boolean},run)，true额外context:{plan,latest_review}；latest_review.is_current精确比较revision/plan/generation。

- [ ] **Step 1: RED** — 正常真实API保存plan及失败审核findings，重开后要求true完整读取；默认/false对照、无review、历史is_current、跨run/异常存储、工具参数与64KiB多字节边界、total_changes0。
- [ ] **Step 2: Observe RED** — 定向workflow与工具整合命令，保存missing include_context/读取断言失败，不先改实现。
- [ ] **Step 3: Implement** — state可选Boolean和工具schema/传参；严格验证context存储形状/16KiB；同一snapshot中构造latest_review，按旧元数据整条移除保证包含ok字段字节界限，不截断有效plan/findings。
- [ ] **Step 4: GREEN** — 定向两文件及`npm test`退出0，记录counts和输出预算；默认、返工和严格验收回归保持。
- [ ] **Step 5: Commit** — docs/WORKFLOW说明显式context、历史标识和裁剪，owned files提交；报告含实际RED/GREEN和前任务终态栅栏保留。controller独立审核。
