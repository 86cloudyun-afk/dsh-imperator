# TaskForce DSH 0.2 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已复现的任务部队执行限制、委派、PTC 状态和重派恢复缺陷，提供可重复的 DSH 0.2.0-rc.2 宿主验收，并提交 PR。

**Architecture:** 沿用 host 服务、preset 和 SQLite；小幅扩展 trusted claim 接口，不引入新调度状态机。离线回归与真实宿主验收分别报告。

**Tech Stack:** Node 22/24、ES modules、node:test、node:sqlite、官方 DSH 0.2.0-rc.2。

**Spec:** `docs/superpowers/specs/2026-09-30-taskforce-dsh-0.2-upgrade-design.md`

## Global Constraints

- 生产包零新增外部依赖。
- `claimTask(input, runId, actor?)` 保留旧调用行为；模型参数不授权 actor。
- 只允许 trusted lead 在 rejected 状态换 owner；其余 owner、终态、跨 run 规则保持。
- 保留原生事件和 settlement channel；取消和未知结算不计作创建成功。
- 原生宿主测试不调用模型，不需要 API key，不输出凭据，完整清理临时运行资源。
- 发布项目版本 `0.2.0`，DSH 声明 `>=0.2.0-rc.2`。

## Review Focus

- 外层 `run_code` 成功不能掩盖内层连续错误；原生工具成功仍应重置错误链。
- 崩溃日志尾只有 PTC start 时不可声称已完成，失败调用不增加存活子代理数。
- 模型伪造 actor、不同 child 在活跃任务上抢 owner、跨 run 和审计失败必须被拒绝或回滚。
- 主会话改为 PTC 后保留执行 guard；child 保有现有执行工具与 depth 2，权限不被放宽。
- 缺少宿主、损坏 Config、挂载失败、清理失败和生命周期恢复失败不得计为验收通过。

### Task 1: 执行边界与委派配置

**Files:** `lib/preset.js`、`lib/plugins/orchestrator-scope.mjs`、`tools/tests/host-boundaries.test.mjs`、相关既有 scope 验证。

**Interfaces:** 保持现有 scope 的 `apply()` 与导出；preset 新增 native presentation 行，两个委派行增加 worker persona，fork 增加 maxDepth 2。native probe 使用实际 Config、SubagentRuntime、prompt composition 和 PTC runtime，不调用模型。

- [ ] 写出主会话 reserved transport 绕过失败用例，确认当前实际文件写入未被拦截；写 child prompt 和 fork depth 的宿主失败断言。
- [ ] 运行上述用例，核对失败来自已复现的行为。
- [ ] 实现 native presentation、guard-only `run_code` 拦截、worker persona、fork depth 2；更新过时的 child-control 说明。
- [ ] 覆盖 child 放行、实际 /tmp 文件保持不存在、无凭据依赖、原 scope 行为。
- [ ] 运行针对性测试与 `npm test`，提交 `fix: enforce TaskForce execution and delegation boundaries`。

### Task 2: PTC 持久事件兼容

**Files:** `lib/plugins/working-context.mjs`、`lib/plugins/guard.mjs`、可选 `lib/plugins/tool-events.mjs`、`tools/tests/ptc-events.test.mjs`。

**Interfaces:** `foldSubagentFlow()` 和 `foldGuardSignal()` 返回结构保持；规范化辅助函数只读取持久事件，不修改 Session。

- [ ] 写 PTC 成功委派、失败/取消、无结算 start、混合原生/PTC、三次相同内层失败被外层成功包裹的回归用例。
- [ ] 运行，确认工作状态漏计和 echo 漏检均为失败。
- [ ] 按 root/sub-call id 配对内层事件；外层 transport 不参与内层成功/错误链，保留原生结果语义。
- [ ] 运行 targeted 测试与 `npm test`，提交 `fix: fold native and PTC tool events consistently`。

### Task 3: trusted lead 重派恢复

**Files:** `lib/store/index.js`、`lib/tools/index.js`、`tools/tests/store-reassignment.test.mjs`、`docs/STORE.md`。

**Interfaces:** `claimTask(input={}, runId, actor)` 仅 `actor === 'lead'` 允许 rejected owner 改变；task_claim 从 trusted identity 决定第三参数。原 handoff API 不改变归属。

- [ ] 写重启后 reject → lead 换 child 的失败用例；附 child 伪造 actor、active owner、终态与跨 run 用例。
- [ ] 确认当前恢复失败为 E_TASK_CONFLICT。
- [ ] 换 owner 时同事务写状态、decision 和 handoff；注入审计 INSERT 失败，确保状态与全部审计一起回滚。
- [ ] 验证原 owner 幂等与原 handoff 行为，运行 targeted 测试和 `npm test`，提交 `fix: allow audited lead reassignment after task rejection`。

### Task 4: 可重复真实宿主验收与交付

**Files:** `tools/verify-host.mjs`、宿主解析/fixture 辅助文件、`tools/verify-preset.mjs`、`tools/verify-all.mjs`、runner 回归、CI、`package.json`、README 与 RELIABILITY/CONTROL/CONTEXT 文档。

**Interfaces:** 新增 `--install-anchor <package.json>`；可从 PATH 的 dsh 发现 npm 安装。保留已有 profile/install 参数的显式选择及缺宿主失败规则。宿主验收启动隔离官方 profile，返回 roster、任务工具闭环、卸载重启用、注册失败恢复和清理结果。

- [ ] 用真实可启动 profile 复现旧校验器的模块解析误报；写缺 anchor、错误安装、损坏 Config 与宿主失败的回归断言。
- [ ] 使用官方运行时解析快照和 Config 验证，避免把解析/shape 检查说成真实 boot。
- [ ] 以隔离 home、port 0、关闭浏览器及 URL 输出运行真实 host；使用真实 agent handle 调用任务工具和验收生命周期，不发送模型输入。
- [ ] 集成 Task 1 的 native 边界/prompt/depth 用例，运行本轮全部测试；CI 固定安装官方 0.2.0-rc.2。
- [ ] 更新版本、文档与复现证据，说明真实验证范围；提交 `test: verify TaskForce against a real DSH 0.2 host`。
- [ ] 全分支独立审查；修复重要问题并重新验证，提交 GitHub 分支与 PR。
