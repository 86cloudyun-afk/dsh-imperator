# 隔离原生 fixture 清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 隔离验证工具正确释放原生启动遗留的全局监听器，保留应用清理与故障判定。
**Architecture:** 集中独占 boot 范围，启动完成时捕获四事件的确切新增 raw callbacks，在应用 teardown 后由 fixture 幂等释放。
**Tech Stack:** Node 内建 EventEmitter、实际两 pins DSH profile boot、现有 controlledProfile。
**Spec:** `docs/superpowers/specs/2026-10-11-native-fixture-cleanup-design.md`

## Global Constraints

- 固定 names/DB、Node/DSH pins、无 runtime 依赖/schema 改变；60000ms 验收、12000ms cleanup，不提高 listener limit。
- 不改安装 SDK，不关闭警告，不从迟到的差集猜测回调归属，不删除无关 callbacks。
- 生产 SDK 缺陷仍存在，本任务仅用于独占隔离验证进程；full-tree 始终关闭。
- 保留前面功能任务的全部测试与实现；root 管理 version/README/最终研究记录。

## Review Focus

- once wrappers、重复注册、启动后 sentinel 均保留；引用差集支持重复数。
- 竞争controlledProfile创建在环境/目录变更前拒绝，token覆盖整个fixture lifetime，旧dispose不可覆盖后续fixture；每fixture一次boot，失败启动也捕获，异常基数不猜测清理。
- 捕获诊断失败不能丢失返回应用的 teardown 路径；原有 rejected/hanging cleanup 非零闸不被吞掉。
- 应用shutdown/flush/dispose时监听器仍有效；cleanup timeout保留非零升级，Promise未settled不声称恢复成功，回调保留到实际teardown结算或进程退出。所有callers以nested finally保留exit hook/exitCode及原setup/cleanup失败。

### Task 1: 隔离 boot 范围与所有调用方

**Files:**
- Modify: `tools/host-runtime.mjs`, `tools/verify-model.mjs`, `tools/verify-host.mjs`, `tools/verify-isolation.mjs`
- Test/Modify: `tools/tests/host-runtime.test.mjs`, `tools/tests/host-boundaries.test.mjs`, `tools/tests/scheduler-native.test.mjs`
- Modify: `docs/DELIVERY.md`（仅隔离验证器资源范围说明，历史版本和模型证据保留）
**Interfaces:**
- Consumes: actual `runProfile`、process rawListeners、既有 application teardown。
- Produces: `controlledProfile(...).runProfile(options)` 实际应用；内部 boot scope 捕获并清理自己的回调，fixture.dispose 仍恢复环境/临时目录。

- [ ] **Step 1: RED** — test-only 原生teardown回调增长、失败启动、fixture创建await时竞争、旧dispose重放、成功app+异常基数可teardown、setup/teardown错误加fixture诊断仍保留原错误，以及baseline/once/重复/sentinel控制；使用现有代码路径先复现，不让缺失 helper/import 错误成为唯一 RED。
- [ ] **Step 2: Observe RED** — 保存真实重复启动两 pins 的有界失败与未改 production 源码证明。
- [ ] **Step 3: Implement** — 集中实际 boot wrapper、独占闸和引用/重复数捕获；逐一迁移启动与nested-finally清理调用方；正常应用清理后才释放，timeout保留至settlement/exit，异常诊断固定且不掩盖原始失败。
- [ ] **Step 4: GREEN** — 定向 unit、两 pins 各 12 实际 boot/teardown、existing failure/hang cleanup 与 scheduler native；保留无请求/stream 证明和临时目录清理；最后 sole `npm test`。
- [ ] **Step 5: Commit** — owned files 显式提交；外部完整报告/identity/RED/GREEN 交给 fresh 独立 spec/quality 审核。
