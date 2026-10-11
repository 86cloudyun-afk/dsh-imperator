# SQLite TEXT 读取保真设计（第十五项）

## 已确认问题与本项范围

官方 Node 22.23.2 下，公开 `recordFact` 接受 `left\u0000right`（真实 NUL），SQLite 保存完整十个字符，看板却读回 `left`。同一探针在 Node 24.19.0 保留全文。原始 RED、24 对照及文件指纹保存在外部 `node22-root-probes-706/root-runtime-proof.json`，SHA256 `85098c0ee64cef73685453f729fb5ca788c843d08f5d81639ceab2da431c8a74`。原始证据保持不变。

修复三个已接受的字段在十二个既有业务读取点上的有效 Unicode 保真：七处 `fact.statement`，三处 workflow state 的 producer/reviewer 元数据，两处 workflow acceptance 的相同字段。继续接受原本合法的 NUL 文本，读取现有数据库，不改写存储。原 Node22 context 历史剪裁断言因截断少算了48954个JSON字节；保留这些原始 NUL 用例作为回归。

前置产品基线 `706295d7f1e43490f41baa04f13ee87faf10b278`，第十四项 fresh SPEC→root全文核对→QUALITY 已通过。本设计只包含 A+B。完整身份比较、调度/治理/恢复引用另列第十六项，迁移预检 fingerprint 另列第十七项，原生测试耗时另列第十八项；这三项仍是发布前必须处理的已知缺口。本项不宣称全库 TEXT、全身份或任意 native handle 查询已经修复。

## 读取机制

在每个选定的静态 SELECT 保留原字段，并追加一项明确的内部 companion：

```sql
CASE WHEN typeof(f.statement)='text' THEN
  CASE WHEN instr(f.statement,char(0))>0
       THEN json_quote(f.statement) ELSE NULL END
  ELSE NULL END AS __imperator_nul_statement
```

producer/reviewer 使用同一表达式，但列引用、字段与 companion 名由对应静态调用点明确给出。只为实际 TEXT 且包含 NUL 的值调用 `json_quote`；普通文本和非 TEXT 的 companion 为 SQL NULL。不得解析原字段是否“看起来像 JSON”。不得对外部SQL做解析、猜测或重写，不新增通用数据库代理/查询框架，不注册 JS SQLite 函数，不 patch `DatabaseSync` 或 SDK。

严格解码：NULL companion 原样保留原值；非 NULL 必须为字符串，`JSON.parse` 必须成功并返回含真实 NUL 的字符串。缺失字段、格式/类型错误、解析异常、没有 NUL、布局错误均抛已有 `E_STORE_INTEGRITY`，固定无数据消息 `SQLite 文本读取证据无效`，不回退为截断原值。正常 SQL/unsafe INTEGER/busy/事务错误维持原传播与包装。恢复字段并去掉 synthetic companion 后，才可 spread、clip、做错误文本、身份比较、writer lookup 或测量 UTF-8 JSON 字节数。

八个明确投影使用 native object row，在静态无冲突 alias 下恢复字段并删除 companion；缺失 get 保持 undefined，空 all 保持空数组。四个既有 wildcard 使用受限位置桥，防止 legacy 同名列被覆盖/删除：

1. 保留原 `f.*`/`*`，只在末尾追加固定数量 companion，原 SQL、WHERE/JOIN/排序/CTE/绑定/limit 保留。
2. 在该局部持有的 StatementSync 上调用公开 `columns()` 和 `setReturnArrays(true)`。前 N 列为原 wildcard，尾部是固定 companion；目标原字段必须唯一存在，行长与 metadata 必须吻合。
3. 仅把原 N 列按原 metadata 名称/顺序重建为 null-prototype 对象，普通 writable/enumerable/configurable own data properties。按位置恢复目标字段，discard 尾部而不按名字删除真实列。保留真实 `__proto__`、`constructor`、数字键及 companion 同名 legacy 列。
4. 不改变 BigInt 读取设置，不转换 BLOB/NULL/numeric，不吞掉 unknown legacy 列的 unsafe INTEGER 错误。不让数组模式或 companion 逃逸到公共结果。不为任意重复 original alias、PRAGMA、DML、RETURNING 提供适配。

共享 primitive 位于既有 `lib/store/sqlite.js`。位置桥只在 F5/F7/W4/W5 使用；八个明确投影不扩大为通用位置适配器。内部静态SQL片段与 decoder 可以复用，但调用点本身仍明确列出 companion、目标字段和模式。此限制将在第十六项独立设计中重新明确扩展范围，不能自动授权其它查询。

## 完整调用点

行号以706基线为准，改动后按方法与查询内容识别。

| ID | 文件及读取点 | 字段 | 解码时机 |
|---|---|---|---|
| F1 | store/index.js:833 #factRows | statement | detail 映射前 |
| F2 | store/index.js:915 #lateBlockersOf | statement | clip/late_blockers 前 |
| F3 | store/index.js:949 #unresolvedBlockers | statement | clip/E_BLOCKERS 前 |
| F4 | store/index.js:1871 ranked summary outer SELECT | statement | briefFact 前，CTE不变 |
| F5 | store/board-page.js:60 facts history f.* | statement | page row spread 前，位置桥 |
| F6 | store/board-page.js:86 latePage | statement | page/clipFields 前 |
| F7 | store/board-page.js:166 selected latest f.* | statement | factRow 前，位置桥 |
| W1 | workflow/index.js:195 state artifacts | producer_session | artifacts spread/字节测量前 |
| W2 | workflow/index.js:196 state reviews | reviewer_session | reviews spread/字节测量前 |
| W3 | workflow/index.js:200 latest review | reviewer_session | latest spread/字节测量前 |
| W4 | store/workflow.js:264 acceptance artifact * | producer_session | owner equality 前，位置桥 |
| W5 | store/workflow.js:265 acceptance review * | reviewer_session | writer lookup/owner equality 前，位置桥 |

无新 data-read 查询，不增 per-row/per-task 查询；保留既有 read snapshot、排序、limit+1、cohort/count/cursor、批量/索引与事务边界。fact 其它 metadata 以及 task title/note 的输出保真不在本项范围，必须在后续清单中保留，不能描述成全项目问题已解决。

## 先验证机制，再改产品

独立 DESIGN SPEC 通过、root全文读完并核对后，唯一执行者首先在外部冻结 standalone public `node:sqlite` 探针。不得先修改产品再假设桥可行。分别串行使用官方22.23.2、24.19.0，为 UTF-8/UTF-16LE/UTF-16BE 在建表前设 encoding、写入、关闭、重开，验证六种实际组合：

- 普通/空/JSON样式/反斜杠文本，NUL首中尾/重复/单独，中文/emoji/组合字符/CRLF/U+0001；NULL/INTEGER/REAL/BLOB。ordinary 与 nontext 类型和值保持原样，实际 NUL 恢复原 Unicode。
- BigInt 安全/不安全整数，默认转换错误对照，setReadBigInts=true 下精确值；undefined get/empty all。
- 四个 wildcard 布局，真实 companion 同名额外列、`__proto__`/constructor/数字键/extra BLOB/NULL/unsafe INTEGER；对照原 metadata/key/order/prototype/descriptor/原生错误，仅目标文本允许恢复全文。
- public array/columns 保留同名 synthetic 尾部的位置；重复 original target 必须失败；malformed/mistyped/missing/misaligned companion 必须固定 integrity 失败，不回退。

探针不 import 产品/SDK、不 boot native/provider、不改原始 evidence。记录源/二进制 hash、六组合实际结果和仅自己 fixture 的清理。若任一类型/编码/形状/碰撞等价性不通过，停止本方案实施，保留失败并改设计，禁止回退 raw、禁止丢弃旧列或保留命名空间。通过后再进入测试先行产品修复。

## 产品回归与验收

Node22 真实 API 行为 RED 必须来自旧706产品，不以缺失 helper/export 为 RED。新增回归使用既有测试文件或一个加入原 TESTS 清单的专用测试文件；为避免无关runner修改，优先既有文件。写测试→两 runtime 串行 RED/对照→最小实现→同源码两 runtime GREEN。

F1–F7 覆盖公开 detail、ranked summary、facts 翻页、boardPage detail、终态 late blockers/page、reopen reject 与 E_BLOCKERS，以及 selected latest；全文路由精确相等，clip 路由遵循原159/160/161边界与多字节字符。原父/run过滤、顺序/总数/游标/查询预算测试继续通过。

W1–W5 保留原 NUL budget 用例与 JSON 中 NUL plan/findings；state/context 完整 producer/reviewer、65536字节完整 envelope 与一字节溢出、整行最旧剪裁/latest 保留、20条上限、corrupt-context 行为。acceptance 的 prefix producer 必须不能假匹配 ordinary owner；prefix reviewer 的 writer history 不能借截断命中。涉及任务 owner 自身 NUL 的成功路径是第十六项范围，不伪装成本项端到端支持。

直接 raw SELECT 在Node22仍是已知上游截断对照，本项不能断言所有原生SQL查询修复。Unicode语义保真不等于非法TEXT字节或 pre-bind lone-surrogate 字节保真。不能在机制验证前宣称UTF16兼容，不声称同内存成本；NUL escaped temporary representation可能更大，但不改输出/行/时间预算，不预clip编码JSON。

最终两runtime目标suite、Node24全量source由唯一执行者串行运行并封存 before/after 全源码/模式、SDK unchanged、provider0、fixture清理、实际exit/count/skip。fresh实现 SPEC 独立保存并STOP→root全文读完核对→明确QUALITY GO→保存QUALITY并STOP。后续全量Node22、双SDK、模型、whole、PR/main仍独立实测。

不改 DDL、依赖、产品/数据库命名、Node范围/精确pin、DSH pin、grader/prompt、60000/12000/2×10000/180000预算、request80/output8192、acceptance gate 或 SDK full-tree adapter 开关。不重试8237，不把它的FAILED改成PASS，也不归因实际生产停止。

设计依据：外部 proposed-design SHA `a17107744ceca0218545d91df88f8f0f5a3ba53c37f0d82a4f4872fd3218cb93`，inventory `3bc4709909d1e0d0919a5abaefc17199965d04d6a962f34777f4a258f8f506b4`；root读取/212输入与53987 SDK文件+60771模式重核凭证 `71ea0f0f0c33b532e28efcb50aec6eadc741ede518a78665da29428d5f9b8036`。
