# SQLite TEXT 读取保真设计（第十五项，等宽投影修订草案）

状态：root 已采用本等宽修订，待 fresh 独立 DESIGN SPEC 审核和明确执行 GO；当前不得恢复实施。原追加方案、历史 PASS、旧机制与 230/230 目标证据保留于 Git 和外部封存，不改写历史结果。

## 已确认问题与范围

官方 Node 22.23.2 将合法 SQLite TEXT `left\u0000right` 读成 `left`；24.19.0 保留全文。沿用原第十五项设计的原始 RED、706 基线与十二处调用点范围。原始产品为 `706295d7f1e43490f41baa04f13ee87faf10b278`；本草案读取仓库 HEAD `2edfb6bb5ea02372feac5d7902fb90067b54687d` 及已暂停的九文件未提交实现，不将它当作最终 candidate。

本修订只替换 F5/F7/W4/W5 的 wildcard 追加 companion 机制。其余八个明确投影继续使用 native object + 仅 NUL companion；十二处读取仍只恢复 `fact.statement`、`producer_session`、`reviewer_session`。不扩大为全库 TEXT 或任意 SQL 适配。第十六项十六个身份读取点、第十七项迁移预检 retained fingerprint 仍分别待处理；可在独立设计中复用机制，本项不提前授权。第十八项 native 耗时仍独立。

新增缺陷依据：`review/sqlite-text-design-column-headroom/supplement.txt` 指出合法 N 列 star 在 N 达到实际 column limit 时不能再追加第 N+1 列。root 的 `root-column-headroom-probe/result.json` 已串行实测两个准确 binary：`MAX_COLUMN=2000`，合法 2000 列表及原固定 F7 查询成功，2001 列建表和追加 companion 查询准备失败；等宽候选在九个 ordinary/tag-like/JSON-like/NUL 样本上成功并保留 native object keys/null prototype。此为 standalone 机制证据，不是四调用点或六编码组合的完成证明。

## 八个明确投影：保持原机制

F1/F2/F3/F4/F6/W1/W2/W3 保留原字段并追加静态、无冲突的 companion：

```sql
CASE WHEN typeof(f.statement)='text' THEN
  CASE WHEN instr(f.statement,char(0))>0
       THEN json_quote(f.statement) ELSE NULL END
  ELSE NULL END AS __imperator_nul_statement
```

producer/reviewer 使用对应静态字段及 companion。NULL companion 保留原值；非 NULL 必须为可解析的 JSON 字符串且结果含真实 NUL，否则固定 `E_STORE_INTEGRITY` / `SQLite 文本读取证据无效`。恢复并删除 synthetic companion 后才进入 consumer。缺失 get 保持 undefined，empty all 保持 []。普通 TEXT 不进行 JSON.parse，非 TEXT 类型和值不转换。

## 四个原 wildcard：固定工厂生成等宽投影

在既有 `lib/store/sqlite.js` 提供受限内部 primitive，只有 F5/F7/W4/W5 使用。建议接口固定为：

`prepareSqliteTextProjection(db, field, qualifier, queryFactory) -> { statement, restore }`

`queryFactory(projection?)` 是调用点拥有的同步静态 SQL 工厂；省略 projection 时返回原来的 `SELECT f.*` 或 `SELECT *`，提供 projection 时只替换 SELECT 列表。它不是外部 SQL 输入接口，也不解析、搜索、切割或重写任意 SQL。

1. 在原调用点原 snapshot/事务内，`db.prepare(queryFactory())`，只调用公开 `columns()`；不对原 statement 调用 get/all/iterate/run，也不发 PRAGMA/schema/data 查询。
2. 原 metadata 必须为非空列序列；每列 `name` 必须为字符串，名称唯一，静态 target 必须恰有一个。空名称也是合法 SQLite identifier，不因空字符串而拒绝；不保留内部命名空间。四种原形均为一张表的单一 star。不可适配重复 original alias、多 star、任意表达式/PRAGMA/DML/RETURNING。
3. 按原列顺序产生恰好 N 个表达式。每个 identifier 用双引号包裹，内部 `"` 加倍；qualifier 仅来自调用点固定的 `f`、`workflow_artifact` 或 `workflow_review`。非 target 是该列的直接限定引用。target 使用以下编码表达式，输出 alias 与原名称完全相同。可以为非 target 显式使用相同 alias，但不能改变读取值或增加投影列。
4. `db.prepare(queryFactory(projection))` 得到唯一执行的 statement。其 `columns()` 的长度、每个名称和顺序必须与原 metadata 一致；任何 metadata/布局违约固定 integrity 失败。不缓存 statement 或 schema shape，不在后续 handle DDL 后复用旧列表。
5. 保持 native object row；不调用 setReturnArrays，不重建对象。`restore` 对 undefined 原样返回；对每个 row 验证 native object 形状和原 own-column 集合，严格恢复 target 的 own data value，返回原对象。保持原 null prototype、key 枚举顺序和 writable/enumerable/configurable data descriptors；数字 key 遵循原 JS 枚举规则，不误要求它与 SQL 列顺序相等。不得删除真实 companion 同名列、`__proto__`、`constructor`、数字名或未知扩展列。

编码表达式（`q` 是已安全引用的静态 target 引用）：

```sql
CASE WHEN typeof(q)='text' THEN
  CASE WHEN instr(q,char(0))>0
       THEN 'J'||json_quote(q) ELSE 'T'||q END
  ELSE q END AS "原字段名"
```

所有 target TEXT 都有 transport tag。以 `T`/`J` 开头、看起来像 JSON 或包含字面量 `\\u0000` 的原文本同样先编码，不能与 transport 冲突。`T` 后的内容直接恢复，但必须不含真实 NUL；`T` 自身表示合法空字符串。`J` 后必须经 JSON.parse 成功得到含真实 NUL 的字符串。空编码、未知 tag、T 内 NUL、J 非 JSON/非字符串/无 NUL 均固定 integrity 失败，不回退原始值。禁止通过检查原文本“像 JSON”来判断是否恢复。

非字符串 target 保留 native NULL/Number/BigInt/BLOB 值；非法模拟 transport 类型固定 integrity 失败。不得设置或重置 `setReadBigInts`，不得转换 unknown 列。默认 unsafe INTEGER 转换错误、显式 `setReadBigInts(true)` 的精确 BigInt、原 SQL/busy/事务错误维持原传播与既有包装。只捕获 decoder 的 JSON 解析失败，不把原生准备/执行错误改成 integrity 错误。

## 四个工厂与十二处解码边界

| ID | 原工厂/读取点 | 模式与边界 |
|---|---|---|
| F1 | store/index.js #factRows | statement companion，detail 映射前 |
| F2 | store/index.js #lateBlockersOf | statement companion，clip/late_blockers 前 |
| F3 | store/index.js #unresolvedBlockers | statement companion，clip/E_BLOCKERS 前 |
| F4 | store/index.js ranked summary outer SELECT | statement companion，briefFact 前，CTE 不变 |
| F5 | store/board-page.js historyPage，facts 的 `SELECT f.*` | 等宽 statement，page row spread 前 |
| F6 | store/board-page.js latePage | statement companion，page/clipFields 前 |
| F7 | store/board-page.js selected latest 的 `SELECT f.*` | 等宽 statement，factRow 前 |
| W1 | workflow/index.js state artifacts | producer companion，spread/字节测量前 |
| W2 | workflow/index.js state reviews | reviewer companion，spread/字节测量前 |
| W3 | workflow/index.js latest review | reviewer companion，spread/字节测量前 |
| W4 | store/workflow.js acceptance artifact `SELECT *` | 等宽 producer，owner equality 前 |
| W5 | store/workflow.js acceptance review `SELECT *` | 等宽 reviewer，writer lookup/owner equality 前 |

F5 保留 `FROM fact f JOIN task t ON t.id=f.task_id AND f.run_id IS t.run_id WHERE t.run_id IS ? AND t.id=?`、可选 `AND f.id < ?`、`ORDER BY f.id DESC LIMIT ?` 与 `[run, task_id, cursor?, limit+1]`。handoffs 分支继续其原单次 star prepare/执行，不进入新 primitive；COUNT 不改。

F7 保留 JOIN/run 限制、selected-ID placeholders/binds 和 `f.id=(SELECT MAX(b.id) FROM fact b WHERE b.task_id=t.id AND b.run_id IS t.run_id)`；仅 selected.rows 非空才做两次 prepare，空选中行保持零次。任务选择 CTE、排序/limit、page trimming、cohort/cursor/count 不改。

W4 保留 `FROM workflow_artifact WHERE id=? AND task_id=? AND run_id=?` 及 `[flow.revision_id, task.id, task.run_id]`；W5 保留 `FROM workflow_review WHERE task_id=? AND run_id=? ORDER BY id DESC LIMIT 1` 及 `[task.id, task.run_id]`。保留前置 gate、原事务与 writer SQL/binds；W5 严格恢复完成后才可 writer lookup。

## 准备次数、数据读取和资源边界

每个实际进入的 star site 增加一次 metadata-only prepare；数据执行仍一次。F5 facts 每次 +1（handoffs +0），F7 非空 selected +1（空 +0），W4/W5 分别 +1。不增加每行/每 task 的 data-read，也不改原 read snapshot、事务边界、索引和输出/行/时间预算。不得把 prepare 与已执行数据查询混为同一计数。

既有 `board-batching.test.mjs` 的 `queries <= 4` 测量 legacy `store.board`，不经过 F5/F7；`board-pagination.test.mjs` 的 fresh-empty `queries <= 7` 没有 facts/detail 请求且 selectTasks=false，跳过 F5/F7。两项阈值与原断言必须原样保留。新增测试单独记录 original prepare 的零次执行与 replacement 的一次执行，验证实际 +1/+2 增量；不得过滤旧计数器、缓存绕过计数或更改预算。其它已有 SQL 调用/行数/plan 断言继续通过。

等宽只消除追加结果列的 headroom 要求。生成显式列列表会增加 SQL 字节数、编译工作和临时内存；T 比原普通文本多一个 tag，J 的 JSON 临时表示可能更大。必须记录代表性普通/2000 列 fixture 的原 SQL/生成 SQL UTF-8 字节数及实际 prepare 时间，不以波动计时宣称性能等价。不保证 SQLite SQL_LENGTH/LENGTH/EXPR_DEPTH/内存/编译时间等所有资源极限等价；生成 SQL 若触及原生限额，保留原生错误并记录限制，不静默丢列、缩小列数、保留 namespace 或 fallback raw。非法 TEXT 字节和 pre-bind lone surrogate 字节保真仍不在 Unicode 语义范围内。

## 恢复实施前的证据门槛

先 fresh 独立 DESIGN SPEC → 保存并 STOP → root 全文读取、核验 seal → 明确 GO。历史 PASS、230/230 Node22 旧目标结果与已完成 root 列宽探针保留，但不代替新设计或新 transport 的验证。

唯一 producer 在外部冻结 standalone public `node:sqlite` 探针，不 import 产品/SDK、不 boot provider/native，不改旧证据。先引用并核验已完成双 pin 2000/2001 原查询/append/等宽证据；无需无理由重跑。随后串行官方 22.23.2、24.19.0，在建表前设置 UTF-8/UTF-16LE/UTF-16BE，写入、关闭、重开，完成六个真实组合：

- 八处 companion 与四种等宽 query shape；普通/空/JSON 样式/反斜杠/字面量转义/T/J 前缀；NUL 首中尾/重复/单独，中文/emoji/组合字符/CRLF/U+0001；NULL/INTEGER/REAL/BLOB。
- target 和 unknown 列的 safe/unsafe INTEGER 默认错误对照；最终 statement 的 setReadBigInts=true 精确值；undefined get/empty all。原 metadata prepare 不执行目标值转换，只有执行 statement 触发原生错误。
- 真实 companion 同名、`__proto__`、constructor、数字、空字符串、嵌入双引号/Unicode 的合法列名、extra BLOB/NULL/unsafe INTEGER；逐一对照原 metadata 名称/顺序、keys/prototype/descriptors、原生错误。只允许 target TEXT 恢复为完整值，其他值完全保持原生对照。
- metadata 缺失/重复 target、重复 original names、名称/顺序/数量不匹配；missing/extra/wrong-shape object row；transport 未标记/坏 tag/T 含 NUL/J 坏 JSON/J 非字符串/J 无 NUL；固定无数据 integrity 错误。ordinary T 路径不调用 JSON.parse。
- 四种固定 query shape 在各组合的实际列上限 N 保持 N 个结果列；原查询成功、append 失败、等宽返回并保持所有 unknown 值/错误。加入执行计数，证明原 star 只 prepare；同连接后续合法 ALTER 后重新创建读取仍保留新增列，证明无陈旧 schema cache。

任何机制 FAIL 即 STOP，保留失败，不恢复产品修改；native object 机制若不能满足 shape/type/error 保真，回到设计审核，不自动改 arrays 或 fallback。记录源/二进制 hash、版本、编码/列数、命令/exit、清理和 provider=0/SDK boots=0。

## 产品回归与后续门槛

保持原第十五项全部 F1–F7/W1–W5 公开 API 回归、NUL budget fixture、159/160/161 clip、65536 字节 envelope/一字节溢出、整行最旧剪裁/latest 保留、20 条上限、corrupt-context、prefix producer/reviewer guard。owner 自身 NUL 成功路径仍属于第十六项。保留旧706真实 API RED，不能用缺失 helper 当语义 RED。

新增行为 RED 必须证明当前暂停实现对合法 max-column schema 的公开 F5/F7 读取失败；后续修复用同测试通过。全宽 W4/W5 用 standalone 四形机制加既有 acceptance fixture 证明，不以更改 operations workflow schema 验证规则扩大范围。重写原 star/tail corruption hooks，使它们在真正执行的 replacement object target 上注入并断言 injection 次数；metadata-only star 上安装却从不执行的 hook 不能算 coverage。保留 W5 corruption 的 writerLookups=0、无提交/原状态与事务清理断言。

同源码串行两准确 runtime 目标 suite；Node24 全 source、diff check；封存 before/after bytes+Git 执行位+filesystem mode、实际 exit/count/skip、SDK unchanged、provider0 和 fixture 清理。唯一执行者保存后 STOP；fresh 实现 SPEC → root 全文核对 → 明确 QUALITY GO → QUALITY 保存 STOP。后续全量 Node22、双 SDK、模型、whole、PR/main 仍独立实测。

不改 DDL、依赖、命名、Node 范围/精确 pin、DSH pin、grader/prompt、60000/12000/2×10000/180000 预算、request80/output8192、acceptance gate 或 SDK full-tree adapter 开关。不重试 8237，不改其 FAILED，不归因实际生产停止。PR69 保持 draft，合并由 root 按既有完整流程处理。
