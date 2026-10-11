> 正式采用的 Task17 规范与计划。实施依赖已独立 SPEC→root 全文复核→fresh QUALITY→root 全文复核通过的 Task16：`b9e29fa0a9331e7d92549104abb0c7338a4bd361` / tree `07ba8417b122966660d6feb269306158a0577f03`，产品 fingerprint `f57db5b1642989053f101e65b066ba2e8d2d223074549e5c29055053c7b76564`。Task16 最终 root receipt 为 `7cbd2b69e589a8f1b8b1944c088576521c91cd649d760fe0d9ae2e47270c7955`。下文保留已审核设计的历史背景和预期，不表示其旧状态仍是当前状态。Task17 设计已独立通过，真实旧706公开 RED 已封存：Node22 三个 suffix-change 语义失败、十二控制通过；Node24 全十五通过。旧 probes、runner、结果和 seals 不重跑、不改写。
>
> R1 为规范义务：no-trigger 正常对照保留真实 task_event history；仅 armed trigger 对照清理旧事件并补偿删除 NEW baseline。R2 为规范义务：seed 关闭/checkpoint 后封存源文件/模式/目录；armed 原源只作非迁移只读检查；真实 TaskforceStore.open 迁移 oracle 只运行在独立 disposable clone。正文旧“先清空 task_event”不得应用于 no-trigger 正常对照。
>
> 最新静态交接为 external `implementation/retained-fingerprint/actual-base-preparation-b9e`，root read receipt `99461401cc753659df920ddbb5aef887fcdf925fbabd905a72af10de7ad48616`。operations 与既有 operations 测试仍与已实测706字节一致；当前 store/helpers 差异已静态核对。实际实施必须绑定本次正式文档采用后的完整 Git 基线、动态文件清单/模式与仅两文件授权改动，不能硬编码204或208个文件。新增 GREEN derivative 完整源码/差异/manifest 须另经 root 全文核对与独占 runtime GO 后执行，禁止复用历史已删除 canonical receipt fixtures。正式采用文档本身不授予 CODE 或 runtime GO。
>
> 仅授权 `lib/operations/index.js` 与既有 `tools/tests/operations.test.mjs` 的有意义回归/控制。局部严格一层 TEXT JSON decoder 使用固定 `E_OPERATIONS_SCHEMA`；保持 qualified 原列 ORDER BY/collation、native 非 TEXT、stream、BigInt/framing/definitions/counts/error boundaries，无新增 DDL/helper/export/dependency。准确 Node22/24 target 的12000ms及项目60000ms等门槛均不变。后续 fresh implementation SPEC→root→fresh QUALITY、整候选/native/model 原始60检查、whole/实际PR六CI/额外合并前审核/match-head合并/actual-main六CI仍必须完成。paid8237 FAILED 不变；不宣称历史生产停止原因已确认。

# 第十七项规范草案：preflight 保留行文本指纹

状态：root 选择的待审核设计草案；尚未提交规范、实施或执行。当前产品基线706，文档基线2edfb6。第十五/十六项先按各自独立审核实施，本项随后串行执行。原Node22 RAW TEXT NUL缺陷真实确认；本项具体preflight反例尚未执行。

## 目标与实际边界

`lib/operations/index.js:451–466` retained仅由preflight before/after调用。它查询全部原表/列、排序、setReadBigInts、逐行JSON数组及既有BigInt replacer+换行SHA256，检测迁移是否保留原值。Node22截断可能把 `prefix\u0000before` 与 `prefix\u0000after` 都哈希为prefix。修复有效Unicode文本语义，不宣称任意非法TEXT原始字节保真。backup/restore已用完整文件hash、没有调用retained，manifest不用改。

选择proposal Candidate A：对每个原列的已quoted、qualified引用Q，原扫描SELECT改为

```sql
CASE WHEN typeof(Q)='text' THEN json_quote(Q) ELSE Q END AS "__retained_value_0"
```

每原列一个唯一generatedalias，只构造既有schema-driven静态扫描，不解析任意SQL、不代理DatabaseSync。FROM原table加局部alias；ORDER BY仍是原qualified列列表及原collation，绝不排序编码表达式/alias/位置数字。不增加query、列数量、DDL或存储转换；保持table/column/row顺序、重复行、原定义复用及新增迁移列不纳入before等规则。

按original-column顺序读取generatedaliases：JS string严格JSON.parse一次，结果必须string；错误fail closed为已有E_OPERATIONS_SCHEMA，不fallback、不解析innerJSON。非string原样保留NULL/BigInt/Number/Uint8Array。保留现有setReadBigInts、BigInt replacer、JSON数组/换行framing、SHA256、counts、返回schema和source snapshot/cleanup。ordinary正确Node24指纹相同，NUL应恢复完整语义；不承诺新增IEEE浮点位级区别、现有JSON -0/0/nonfinite等价性保持现状。TEXT/BLOB/NULL/empty类别仍区分。

Valid UTF8/UTF16LE/BE以SQLite json_quote语义读取，必须实际建表前设encoding、关闭重开后经真实operations验证才宣称支持。非法encoding字节/lone-surrogate原始字节、hidden/generatedcolumns、schema名的任意异常编码、已有collationtie非确定性不是本项扩大范围。temporaryJSON escape会有额外单行内存/CPU，继续stream而不堆整表，不改任何时间/输出/行预算。

## 真实公开操作RED与对照

唯一执行者使用旧产品正常public store建task、recordFact `prefix\u0000before`，safe run/actor；fixture专属extra AFTER INSERT task_event WHEN NEW.kind='baseline' trigger更新那一fact为 `prefix || char(0) || after` 并删除NEW baseline行，先清空task_event。调用真正operations.preflight及TaskforceStore.open迁移，不能patch migration/DatabaseSync/retained或export私有函数。该trigger只在一次性测试DB，不改产品DDL。

旧22预计错误resolve rows_preserved:true（真实语义RED）、旧24预计拒绝E_OPERATIONS_SCHEMA。实际结果决定结论，若fixture导致别的schema/count失败先排除，不能当目标RED。修复后两runtime均应拒绝。另在独立disposableclone经真实open迁移，用hex(CAST(TEXT AS BLOB))/json_quote等独立oracle证明suffix实际改变、所有其它原始cell/count不变；保留preflight原source DB hash/listing完整不变及私有copy清理证据。

必须对照：before-NUL change旧22也拒绝；identical fullTEXT/no-trigger两个runtime均通过；TEXT→同字节BLOB型变必须拒绝；三encoding有效NUL保留和suffix变化；额外普通表含NULL、emptyTEXT/BLOB、literalJSON-lookingTEXT、内层JSON NUL、BLOB任意字节、正负64-bit端点/近邻BigInt、REALfraction、quoted/generatedalias同名原列、多行/重复行、影响JSON排序的文本。正确ORDER BY原列，不把post-migration新列混入before定义。原source字节/listing保持，失败无secretcell泄露，独立oracle避免旧raw tableRows helper重复bug。

只授权 operations/index.js及直接相关既有operations测试。两准确Node22.23.2/24.19.0目标suite串行、必要Node24全source、diffcheck/源码+模式/SDK/proxyCA/pins/provider0/fixture清理封存commit后STOP。fresh实现SPEC保存STOP→root全文重核→明确QUALITY GO→保存STOP。不自动推/合/paid。原8237FAILED、新完整local/native/model/whole/actualPR/main全部仍required。

保留名称/DB/DDL/依赖/Node/DSH pins、60000/12000/2×10000/180000、request80/output8192、gate/adapter开关。不得把字符语义修复描述成所有物理记录字节校验或已修复backup bug。依据retained proposal与root全文/8fixedinputs凭证daebd46586d7fc04a5b23b6327dd76d4f3e4f062274acf76fe939e0d4d89d663。独立设计审核后才能发布实施规范。
