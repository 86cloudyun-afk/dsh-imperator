# 已验收任务证据警告 Implementation Plan

> REQUIRED SUB-SKILL superpowers:subagent-driven-development / superpowers:executing-plans；TDD；用户已授权完整修复与reviewmerge。

Goal: 成功验收警告不再指导当前终态任务补写证据。Spec: docs/superpowers/specs/2026-10-11-acceptance-advice-design.md。
Owned2files: lib/store/index.js，tools/tests/store-evidence.test.mjs。ROOT拥有设计/计划/version/README/ledger。前一task10 commit+freshSPEC/QUALITY通过后顺序执行，唯一producer。

- [ ] Test-only RED：realStore legacy task+owner、PLAUSIBLE fact无path、submit/rootaccept；status accepted与basis.with_pointer0，warning应表达已完成/后续任务/提交前；新增带path fact/artifact仍E_TERMINAL，DB状态/facts/generation不改；pointer/waiver/strict现有对照保留。先确认旧建议确实不满足新恢复指引合同，不以helper缺失失败。
- [ ] 最小warning字符串：说明本次已验收、证据可核查性弱，后续任务在提交/验收前记录evidence_path/可用行号；不用当前task补写或auto-reopen建议。Policy/terminal/waiver/事务/返回结构不改。
- [ ] Focused GREEN与sole npmtest，diffcheck/原生产与新测试字节identity/actuallogs；两个owned文件显式commit。
- [ ] Fresh独立任务SPEC PASS先于QUALITY，报告留外部，root最后统一finalgate，不单独付费。

已确认原main存在本遗漏，无法证明本轮paidtimeout触发此warning；保留因果限制。无DDL/依赖/names/NodeSDKpins/limits变化。
