# 原生派发结算契约 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development / superpowers:executing-plans；实现前读取对应技能。

Goal: 修复 one-shot 被错误要求 continuable notice，并在首次创建执行者时明确真实跨阶段复用条件。Spec: docs/superpowers/specs/2026-10-11-delegation-settlement-contract-design.md。Architecture: public current-cut own-session mode classifier + shared per-activation obligation，保留完整 native lifecycle/stability；repair prompt 最小前置披露。

Single producer owns tools/verify-model.mjs、tools/model-fixtures.mjs、tools/tests/model-regression.test.mjs、tools/tests/host-boundaries.test.mjs。Root 独占 docs、version、PR；readonly reviewers 不运行项目测试/native/provider。

- [ ] 原四 product 字节/hash 与完整 Git source inventory 保存。test-only 行为 RED：unchanged native waiter 上 actual mounted rc.2 foreground spawn/fork、mixed nested parent/leaf 的错误 notice 等待；至少一个完整原生 RED。保留 held child stream/actual foreground disposal 或 persistence close/parent turn barrier、公开 own identity、real foreground result、real no-notice、实际 child unregister、cancel/shutdown/fixture-cleanup；0paid/provider。每次 native 调用有原有限时，不靠生产三分钟 paid 重复。
- [ ] Controlled RED：own/non-own/inherited、unknown with delivered notice、late descriptor、getter/read throw、unsupported mode/unsafe seq，stage baseline/cold/mixed obligation 与 stability-window mode/new activation；不以 missing export 为唯一 RED。
- [ ] Minimal GREEN：native harness 必接公开 host projection classifier；动态 own identity，不缓存 creation 的 unknown；共用 obligation/status，不改变原 Promise.all/native Promise、observer failure isolation、exact notice pairing、两次 stable tick/全树 gate。one-shot-only 豁免不适用 notice，unknown 有新增 activation fail closed。稳定窗口结束重验 obligation/identity/current activation 与 all idle/events。report 原字段/白名单保持。
- [ ] repair prompt 明确 continuable + 后两阶段 same childId/task_child_send，无新 worker；参数指导只适用于实际提供的字段。grader/后两 prompt/limits/preset/SDK 不变。前台原生 control 后真实继续请求被拒绝，并未新建替代 child。
- [ ] focused GREEN，rc.2/alpha.2 原 continuable/live/cold 真正 parent-delivery 均保留；新增 rc.2 spawn/fork + nested mixed，alpha 真实 schema/control。实际阶段基线后创建，counts 非真空；实际 barrier 释放前不得通过，释放后树结算和所有 Agent/fixture 已清理。记录 local streams/0paid、不泛化 alpha foreground。
- [ ] sole full npm test，git diff --check，全文件已测 byte/executable identity 与 raw artifact SHA 清单；显式四 owned files commit。外部 implementation report 包含所有 RED/GREEN/中间失败、未知历史 paid 因果、新 prompt 样本、公开 classifier 与 scope 限制。
- [ ] fresh task SPEC PASS 保存并通知 root，之后 QUALITY PASS；如有实际 finding 单写者修复并 fresh 重审。root 更新十二项 docs，NEW immutable candidate、四 local gates + 单次 actual paid、whole review、actual PR 六 CI、额外 fresh PR review、match-head normal merge/main 六 CI。
