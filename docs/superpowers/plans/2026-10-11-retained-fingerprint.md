> 正式采用的 Task17 规范与计划。实施依赖已独立 SPEC→root 全文复核→fresh QUALITY→root 全文复核通过的 Task16：`b9e29fa0a9331e7d92549104abb0c7338a4bd361` / tree `07ba8417b122966660d6feb269306158a0577f03`，产品 fingerprint `f57db5b1642989053f101e65b066ba2e8d2d223074549e5c29055053c7b76564`。Task16 最终 root receipt 为 `7cbd2b69e589a8f1b8b1944c088576521c91cd649d760fe0d9ae2e47270c7955`。下文保留已审核设计的历史背景和预期，不表示其旧状态仍是当前状态。Task17 设计已独立通过，真实旧706公开 RED 已封存：Node22 三个 suffix-change 语义失败、十二控制通过；Node24 全十五通过。旧 probes、runner、结果和 seals 不重跑、不改写。
>
> R1 为规范义务：no-trigger 正常对照保留真实 task_event history；仅 armed trigger 对照清理旧事件并补偿删除 NEW baseline。R2 为规范义务：seed 关闭/checkpoint 后封存源文件/模式/目录；armed 原源只作非迁移只读检查；真实 TaskforceStore.open 迁移 oracle 只运行在独立 disposable clone。正文旧“先清空 task_event”不得应用于 no-trigger 正常对照。
>
> 最新静态交接为 external `implementation/retained-fingerprint/actual-base-preparation-b9e`，root read receipt `99461401cc753659df920ddbb5aef887fcdf925fbabd905a72af10de7ad48616`。operations 与既有 operations 测试仍与已实测706字节一致；当前 store/helpers 差异已静态核对。实际实施必须绑定本次正式文档采用后的完整 Git 基线、动态文件清单/模式与仅两文件授权改动，不能硬编码204或208个文件。新增 GREEN derivative 完整源码/差异/manifest 须另经 root 全文核对与独占 runtime GO 后执行，禁止复用历史已删除 canonical receipt fixtures。正式采用文档本身不授予 CODE 或 runtime GO。
>
> 仅授权 `lib/operations/index.js` 与既有 `tools/tests/operations.test.mjs` 的有意义回归/控制。局部严格一层 TEXT JSON decoder 使用固定 `E_OPERATIONS_SCHEMA`；保持 qualified 原列 ORDER BY/collation、native 非 TEXT、stream、BigInt/framing/definitions/counts/error boundaries，无新增 DDL/helper/export/dependency。准确 Node22/24 target 的12000ms及项目60000ms等门槛均不变。后续 fresh implementation SPEC→root→fresh QUALITY、整候选/native/model 原始60检查、whole/实际PR六CI/额外合并前审核/match-head合并/actual-main六CI仍必须完成。paid8237 FAILED 不变；不宣称历史生产停止原因已确认。

# 第十七项实施计划草案

实施规范为[正式 Task17 规范](../specs/2026-10-11-retained-fingerprint-design.md)。先独立设计SPEC/root全文核对与明确GO；第十五、十六项串行完成各自实现审核后才轮到本项，全部local JS/test/native/provider有且只有一个执行者。root将通过审核的同字节规范/计划纳入仓库。

1. 固定ops/迁移/测试原Git source及runtime、SDK、schema/模式/输入hash。保存root-confirmed rawNUL evidence但不重复早期探针。
2. 写真实public preflight suffix-change regression、fixture-onlybaseline trigger、独立clone实际open迁移oracle。旧22语义RED/24对照，同前缀change/no-op/no-triggercontrols，记录source未改、tempcopy清理，排除无关schema/count失败。
3. 最小改operations retained已发现原列的CASE TEXT json_quote/nontext原值projection和严格一层stringdecoder。唯一generatedalias/原qualifiedORDERBY；保留全部原schema/count/stream/BigInt/JSONframing/report/errors/transactions。无新增private retained export/mock数据库/产品DDL。
4. 相同最终源码两runtime目标GREEN，三pre-existing encoding、NULUnicode/storageclass/typechange/quotedidentifier/roworder/BigInt/JSON样式回归；真实suffixcorruption均E_OPERATIONS_SCHEMA，normalpreflight仍PASS。原sourcefile/listing不可变，backupmanifest不改。必要Node24全source、diffcheck；不伪称非法TEXT字节/浮点位级保真。
5. 明确仅stage ops与相关既有tests，commit+before/after文件/模式、实际commands/counts/durations/provider0/fixturecleanup/seal/report后STOP。无paid/SDK/push/merge。
6. fresh独立实现SPEC保存STOP→root全文/重hash→明确QUALITYGO→QUALITY保存STOP；发现则真实RED/GREEN修正并fresh审核。后续fullcandidate/native/model/whole/PR六CI/extraPRreview/expectedheadmerge/actualmain六CI由root执行，不以本项PASS替代。
