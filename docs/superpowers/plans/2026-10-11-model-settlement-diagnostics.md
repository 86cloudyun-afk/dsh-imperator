# 有界结算进度诊断 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL superpowers:subagent-driven-development / superpowers:executing-plans；实现前读取对应技能，按task逐项完成。

Goal: 定位真实模型验收timeout之前的结算等待边界，不改变任何验收控制、工作负载或限制。Architecture: native waiter原控制流旁维护有限进度，harness只读snapshot，runner白名单投影并在deadline取消前冻结。Spec: docs/superpowers/specs/2026-10-11-model-settlement-diagnostics-design.md。

Task 1 owned paths: tools/verify-model.mjs；tools/tests/model-regression.test.mjs；tools/tests/host-boundaries.test.mjs。不得改host-runtime、SDK、persona、model-fixtures、version/README/rootledger。Single producer，readonly reviewers不运行并行tests/provider/native。

- [ ] Test-only behavioral RED: runner report缺pre-cancelprogress；实际controlledpromise waiter在maintenance-idle、缺notice、duplicate A不覆盖missing B、nested/coldreuse/parentreawake/stability变动时观察不到正确边界。不只用缺export/import形成RED。保存fullrawlog及全部productionGitblob unchanged proof。
- [ ] Minimal additive implementation: phase/counters与原predicate一致，原whenIdlePromise传入原Promise.all；侧观察拒绝被处理、cohort隔离；safe fixed report schema，unknown/getter异常显示settlement=null，normal/phase/Promise观察/timeout四类诊断异常均隔离，不改变既有invalid-observation与cleanup-error优先级；lastRequestElapsedMs定义明确；timeoutProgress取消前冻结，即使观察异常cancel仍执行、既有timeout/cleanup失败不被掩盖；无earlyaccept/新CLI。
- [ ] Focused GREEN: 所有oldmodelregression保留，验证actualfailure、privacy marker、unsafeinteger/getter/unknownkeys、oldharness兼容、beforecancel冻结与lateusage。控制barrier决定因果点而非sleep猜测；保留原stabletick。
- [ ] Sequential native GREEN both exactanchors: inspectNative仅注册sentinel/barriers；runStage基线之后mountedcontinuable subagent的真实rootloop→child→flush/dispose→SDK真实notice→parentwake→settle；断言requiredNotices>0及父actualnotice delta，不得用基线前create/resume真空通过；原child coldreuse经task_child_send新activation需新notice（同session不同真实Agent对象，非零requireddelta）；signal-aware heldlocalstream/tool路径实际cancel和cleanup。通过公开services/seams，不手工fabricatednotice充当fullpath证明，不改SDK/privateemitter；本地stream sentinel0paid calls；保存actualAgent/notice/phase对照、shutdown/fixture已清理、rawlogs/sourceidentity。保持60000 child、12000nativecleanup、paid两个10000。
- [ ] Sole npm test、git diff --check；完整新production+tests已验byteidentity证明。Owned3files显式commit，外部implementation report所有RED/GREEN/中间失败和限制；不保存credentials/rawconversation。
- [ ] Fresh task SPEC PASS then QUALITY PASS；必要修复重新审查；root再调度下一任务。

Root之后更新release docs并构建NEW immutable package。旧d389四localPASS和paidFAIL均保留，不复用productfp；新finalsource/oneCPU/native两pins+有明确诊断目的单次实际paid全部复验，然后whole和额外PRreview/actual6jobs/expectedheadmerge/main实际验证。
