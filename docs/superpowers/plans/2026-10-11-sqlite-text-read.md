# 第十五项实施计划：十二处 SQLite TEXT 保真读取

设计为 [sqlite-text-read-design](../specs/2026-10-11-sqlite-text-read-design.md)。顺序执行，唯一运行/产品写者；其它代理只能 read-only review/design。root已授权完整修复、PR审核并在所有门槛完成后合并，不再次请求例行确认。

1. 独立 DESIGN SPEC 审核固定规范、计划、原始 Node22 RED、proposal/inventory、原706受影响读取。保存报告与输入hash并STOP；root全文读取重核，明确GO才开始。
2. 保存完整源码/SDK基线。外部冻结 public node:sqlite 机制探针，串行22.23.2/24.19.0运行六编码组合、四 wildcard 碰撞/原型/类型/error、严格decoder故障矩阵。任何机制FAIL立即STOP，保留证据，不修改产品、不扩大fallback/框架。
3. 在现有 sqlite/store/board/workflow测试文件增加真实API回归，不改原NUL预算fixture。旧产品Node22运行并得到语义RED，Node24对照与本项允许失败分开记录；缺少新helper不是行为RED。已有公开fact探针保存不重跑。
4. 最小实现：sqlite.js静态字段companion与strict decoder；四明确wildcard位置桥，其它八处nativeobjects。按F1–F7/W1–W5表逐项追加投影并在最早consumer前恢复；仅授权 lib/store/sqlite.js、lib/store/index.js、lib/store/board-page.js、lib/store/workflow.js、lib/workflow/index.js与直接相关既有tests。root拥有文档/版本/PR，执行者不改其它功能。
5. 串行运行两个准确runtime的目标suite；确认所有原Node22 history_truncated回归恢复、字节budget与行排序/游标/查询counts未改；Node24全source、git diff --check。机制疑虑或失败才增验证，不盲目重复全量。raw nativeSQL截断和其它字段缺口诚实记录。
6. 明确stage所有自有文件并commit；保存commit/tree/fingerprint、完整 before/after bytes+Git执行位+filesystem modes、命令exit/TAP实际PASS/skip/时长、SDK未改、fixture清理、provider0、RED和GREEN归属。不运行新模型、不推送/合并。封存报告+manifest并STOP。
7. fresh独立实现SPEC→保存并STOP→root读全/重核→明确QUALITY GO→保存QUALITY并STOP。修正发现时保留原FAIL，再新的RED/GREEN+fresh审核。
8. root随后串行第十六项身份比较与第十七项preflight、处理第十八项native耗时；全部设计/实现审核后冻结新candidate，原四localgate+准确Node22验证、一次有具体变更依据的新模型、whole、actualPR六CI、额外freshPR审核、expected-head merge、actualmain六CI。现PR69保持draft，8237保持FAILED。
