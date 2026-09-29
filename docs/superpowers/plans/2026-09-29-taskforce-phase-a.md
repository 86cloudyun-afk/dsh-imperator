# TaskForce Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复事实库原子性、证据与阻塞校验、插件恢复，并提供可重复执行的独立测试和 CI。

**Architecture:** 保留现有 host 服务、agent 工具和状态机。提取小型 SQLite 事务与证据判据模块，业务动作在同步事务内完成；插件挂载使用带所有权的生命周期记录。此计划实现阶段 A；持久化调度和自动开发分别属于后续 B、C，目标保持有效。

**Tech Stack:** JavaScript ES modules、Node 内置 sqlite/test/assert/child_process、GitHub Actions；不增加运行时 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-29-taskforce-strengthening-design.md`，用户于 2026-09-29 18:25（Asia/Shanghai）以“推进”确认。

**Status:** 用户已选择多代理执行；阶段 A 正在实施、代码待整体审阅，真实 DSH 宿主验收尚未完成。阶段 B/C 仍属后续范围。基线产品代码 `2980601615116f5e3963229a7fbba223f6388a6d`；设计提交 `ea84d77ef8ba5477e030527437e0ea9c8bf275da`。

## Global Constraints

- “主代理负责拆解、分派、核对和汇报，执行工作由子代理承担”是被维护产品的运行原则。
- “现有默认 `maxDepth: 2` 保留”；阶段 A 不改委派层级或新增调度工具。
- “最外层写事务使用 `BEGIN IMMEDIATE`”；事务内不得等待网络、模型或文件处理。
- “REFUTED 记录不计入正常验收依据；解阻塞必须使用同任务的 decision，且不能是 REFUTED。”
- “已落盘的历史 accepted 状态不自动推翻”；保留显式 `waiver_reason` 和跨 run 隔离。
- “真实环境缺失时，交付注明对应验收未完成。”模拟测试不替代真实 boot。
- 已有包声明 `dsh >=0.1.7-rc.2` 保留；阶段 A 的 CI 明确测试 Node 22.23.2 和 24.19.0，不据此声称其他版本全部兼容。

## Review Focus

1. 审计、时间戳或 COMMIT 失败时不遗留半成功裁决；若回滚也失败，不继续使用状态未知的连接。Task 1、2。
2. 两个进程认领同一任务，以及锁持有者迟迟不释放时，不能双成功或无限重试。Task 1、2。
3. 旧库内已有非法解决记录、错误 run 元数据或旧视图时，查询与验收仍一致，历史结论不自动重写。Task 3。
4. 注册未结束就卸载、注册失败后重试、旧实例迟到、disposer 拒绝时，不重复注册也不错误释放新所有者。Task 4。
5. 缺宿主、子测试崩溃/超时、从其他工作目录启动验证时，测试入口如实失败或声明未验证。Task 5。

## 文件与边界

| 文件 | 职责 |
|---|---|
| `lib/store/sqlite.js`（新增） | 配置解析、有限锁等待、同步事务/savepoint、SQLite 错误归类 |
| `lib/store/evidence.js`（新增） | 有效验收依据与有效解决记录的 SQL 判据；只生成固定别名的内部 SQL |
| `lib/store/index.js` | 业务状态机、迁移、查询和服务注册；使用两个新模块 |
| `lib/lifecycle/mount-state.js`（新增） | 跨模块副本的挂载所有权，占位取得与条件释放 |
| `lib/index.js` | 原有 preset 声明、异步注册/卸载生命周期 |
| `lib/tools/index.js` | 新错误码提示与事实/验收工具说明 |
| `tools/tests/helpers.mjs`（新增） | 临时目录、任务夹具和模拟宿主；所有资源清理 |
| `tools/tests/{sqlite,store-atomicity,store-evidence,lifecycle,verify-runner}.test.mjs`（新增） | 对应故障和回归验证，使用 node:test |
| `tools/tests/fixtures/claim-worker.mjs`（新增） | IPC 同步的双进程认领验证，不使用碰运气的 sleep |
| `tools/verify-all.mjs`（新增）、`tools/verify-preset.mjs` | 独立/宿主验证入口和准确的分层结果 |
| `package.json`、`.github/workflows/verify.yml`（新增） | npm 测试命令与 CI |
| `README.md`、`docs/STORE.md`、`docs/RELIABILITY.md`（新增） | 行为变更、配置、故障恢复及宿主验收步骤 |

---

### Task 1: SQLite 事务基础与开库恢复

**Files:** 创建 `lib/store/sqlite.js`、`tools/tests/sqlite.test.mjs`、`tools/tests/helpers.mjs`；修改 `lib/store/index.js` 的构造函数、open/migrate 和 host apply；配置写入 `docs/RELIABILITY.md`。

**Interfaces:**
- `normalizeSqliteOptions(input = {}) -> {busyTimeoutMs:number, journalMode:'preserve'|'wal'}`：默认 1000ms、preserve；等待必须是 0–5000 的整数。非法配置返回 `E_STORE_CONFIG`。
- `configureSqlite(db, options) -> {busyTimeoutMs:number, journalMode:string}`：设置 busy_timeout；preserve 不改现有 journal，wal 必须核对实际结果，否则 `E_STORE_JOURNAL_MODE`。配置在事务之外执行。
- `withWriteTransaction(db, work:()=>T) -> T`：同步返回，最外层 BEGIN IMMEDIATE，嵌套 savepoint。返回 thenable 时回滚并抛 `E_STORE_ASYNC_TRANSACTION`；调用方不得在 work 中安排异步写入。
- `normalizeSqliteError(error) -> Error`：只将 SQLite 主错误码 5/6 映射为 `E_STORE_BUSY`，保留 cause；其他业务错误及错误码原样保留。回滚失败附加 `rollbackError` 与 `transactionStateUnknown:true`，归类时保留这两个字段。不得仅凭 ERR_SQLITE_ERROR 笼统判断锁冲突。
- `new TaskforceStore(root, options = {})`：既有单参数调用兼容；host 配置增加可选 `busyTimeoutMs`、`journalMode`，不会由模型参数指定。
- 测试夹具 `tempStore(t, options = {}) -> TaskforceStore` 创建独立临时目录并通过 `t.after` 关闭/删除；`seedSubmitted(store, runId) -> number` 创建带 PLAUSIBLE artifact 的待验收任务。

- [ ] **1. 写失败测试**，覆盖配置边界、嵌套回滚、有限锁等待和开库失败恢复。核心断言：
  ```js
  assert.deepEqual(normalizeSqliteOptions(), {busyTimeoutMs:1000, journalMode:'preserve'});
  for (const value of [-1, 5001, 1.5, '1000'])
    assert.throws(() => normalizeSqliteOptions({busyTimeoutMs:value}), {code:'E_STORE_CONFIG'});
  // withWriteTransaction 内插入后抛错，COUNT(*) 必须仍为 0。
  // 内层 savepoint 失败被外层捕获：仅撤销内层，外层可正常提交。
  // 外层失败：连同已成功的内层一并回滚。
  // 返回 Promise.resolve()：E_STORE_ASYNC_TRANSACTION，连接无遗留事务。
  ```
  用第二连接持有写锁且 busyTimeoutMs=0，断言立即返回 E_STORE_BUSY、无新行；释放后可成功。模拟 COMMIT/ROLLBACK 失败验证原错误保留、失败连接失效。让迁移中途抛错后检查列/视图未部分提交，清除故障后同一 store 能重新打开。
- [ ] **2. 执行 `node --test tools/tests/sqlite.test.mjs`**，确认因缺少新接口或原有非原子行为而失败。
- [ ] **3. 实现上述模块与接口**。DDL、列迁移、后置视图在同一事务内执行；仅成功后发布 handle 和 migration 统计。开库失败关闭局部 handle。事务辅助层不自行重试；回滚失败由 store 关闭并清空 handle，下一调用重新打开。
- [ ] **4. 重跑该测试及 `node tools/verify-store.mjs`、`node tools/verify-store-v2.mjs`**。新测试全通过，旧测试无失败；原生依赖缺失仍如实 SKIP。测试默认模式不改变已有 WAL 库，显式 WAL 的临时库返回 wal。
- [ ] **5. 提交**：`fix(store): add atomic sqlite transactions and recoverable initialization`。

### Task 2: 任务动作原子化与竞争认领

**Files:** 修改 `lib/store/index.js`、`lib/tools/index.js`；创建 `tools/tests/store-atomicity.test.mjs`、`tools/tests/fixtures/claim-worker.mjs`；更新 `docs/STORE.md`。

**Interfaces:**
- 使用 Task 1 的 `withWriteTransaction`、错误归类与测试夹具。
- 保留现有公开方法签名；所有有写入的方法在检查与写入之间具有同一个事务边界，嵌套动作复用 savepoint。
- `STORE_CODES.conflict = 'E_TASK_CONFLICT'` 用于其他 owner/竞争状态更新失败；终态仍优先 E_TERMINAL，跨 run 仍优先 E_CROSS_RUN。工具层明确区分 E_STORE_BUSY 的有限稍后重试与 E_TASK_CONFLICT 的读板核对。
- `closeTask({task_id,result,note?}, runId)` 增加可选 note；done/partial 转交 submitTask，failed 在取消事务内写 decision。工具 schema 同步增加可选 note，已有调用兼容。

- [ ] **1. 写 `accept_audit_failure_rolls_back_and_is_retryable` 等失败测试**。在临时 SQLite 中通过 trigger 精确注入失败：
  ```js
  const id = seedSubmitted(store, 'run-a');
  store.handle.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON fact WHEN NEW.kind='decision' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.throws(() => store.acceptTask({task_id:id}, 'run-a', 'lead'), /audit failure/);
  assert.equal(store.taskOf({task_id:id}, 'run-a').task.status, 'submitted');
  // 删除 trigger 后重试成功，并且恰好存在一条验收 decision。
  ```
  同样验证 reject、submit(note)、close(failed,note)、recordFact 的时间戳更新失败及 adoptUnassigned 的中途失败。断言状态、事实、时间戳、run 归属全部回滚。验证无附注取消和 done/partial 别名兼容。
- [ ] **2. 添加 IPC 认领竞争测试并运行 `node --test tools/tests/store-atomicity.test.mjs`**。两个已连接进程同时开始认领相同任务，恰好一个成功，另一个 E_TASK_CONFLICT；任务 owner 与赢家一致。测试进程均带超时和清理，锁等待预算允许竞争正常串行。确认基线失败。
- [ ] **3. 将 open/claim/fact/handoff/submit/accept/reject/close/adopt 的检查与写入包进事务**，条件更新核对 changes，认领同 owner 幂等语义保持。新增取消附注内部写入必须绕过终态公开写入限制，但仍使用相同物理 INSERT 入口。
- [ ] **4. 执行新测试及三套 store 验证脚本**。检查错误通过工具层后保留 code 和正确 hint；确认跨 run 与终态拒绝不留记录。不得用删除失败测试的方式通过。
- [ ] **5. 提交**：`fix(store): make task transitions and audit records atomic`。

### Task 3: 统一证据与阻塞判据

**Files:** 创建 `lib/store/evidence.js`、`tools/tests/store-evidence.test.mjs`；修改 `lib/store/index.js`、`lib/tools/index.js`、必要的既有测试夹具及 `docs/STORE.md`。

**Interfaces:**
- `evidenceBasisSql(alias:string) -> string`：只允许内部固定标识符；confidence 在 CONFIRMED/PLAUSIBLE 内，且 kind 是 fact/artifact 或有非空 evidence_path。REFUTED 和畸形历史值均不计入。
- `validResolutionSql(resolverAlias:string, blockerAlias:string) -> string`：同 task、同 run（包括双方 NULL）、resolver.kind=decision、confidence 在 CONFIRMED/PLAUSIBLE 内、resolves_fact_id 指向该 blocker。
- `assertResolutionInput({kind,confidence,resolves_fact_id}) -> void`：提供解决指针却不满足类型/置信度时抛 `E_RESOLUTION_INVALID`；目标存在性、任务归属及 blocker 类型仍由 store 查证。
- 详情 board 新增 `validation_warnings:Array<{code:string,message:string}>`；历史 accepted 缺当前有效依据时使用 `W_EVIDENCE_REVIEW` 提醒核对（可能存在人工豁免），不自动改状态、不假定伪造。

- [ ] **1. 写失败测试**：REFUTED-only 验收抛 E_EVIDENCE_MISSING；同任务有效 decision 才能解决阻塞；非法 artifact/REFUTED 解决写入抛 E_RESOLUTION_INVALID 且无新行。正例中的已确认反证结论是独立有效 fact。
  ```js
  assert.throws(() => store.recordFact({task_id:id, kind:'artifact', statement:'invalid',
    confidence:'REFUTED', resolves_fact_id:blockerId}, run), {code:'E_RESOLUTION_INVALID'});
  assert.throws(() => store.acceptTask({task_id:refutedOnly}, run, 'lead'), {code:'E_EVIDENCE_MISSING'});
  ```
  直接向临时旧库注入非法历史解决记录，断言详情、默认板、stats、statsAllRuns、late_blockers 与 v_run_board 均仍报告阻塞。跨任务/run 的伪关联不能解阻塞；保留老 accepted 状态。验收豁免有现存依据时，审计文案报告真实数量而非固定 0。
- [ ] **2. 执行 `node --test tools/tests/store-evidence.test.mjs`**，确认各缺口在修改前失败。
- [ ] **3. 实现 SQL 判据并替换所有相关查询**。迁移时事务性重建 v_run_board（列形状不变），保留 v_task_board 的历史总阻塞计数语义并写明差别。验收依据、工具描述及 hints 同步更新；不解析自然语言记录推断历史豁免。缺证据路径的有效基础任务保留 warning，不在阶段 A 强制引入阶段 C 的 SHA 审查规则。
- [ ] **4. 重跑新测试和三套 store 脚本**。审查夹具更新清单，说明每项语义变化；既有角色、跨 run、晚到 blocker、重新复核场景继续覆盖。
- [ ] **5. 提交**：`fix(store): reject invalid evidence and blocker resolutions`。

### Task 4: 挂载所有权与异步卸载恢复

**Files:** 创建 `lib/lifecycle/mount-state.js`、`tools/tests/lifecycle.test.mjs`；修改 `lib/index.js`、测试 helper、`docs/RELIABILITY.md`。

**Interfaces:**
- `acquireMount(packageName:string) -> {token:symbol, release:()=>boolean}|null`：使用独立 `Symbol.for('dsh-taskforce.mount-owners')` 的进程级 Map；兼容原有 `Symbol.for('dsh-web.mounted-plugins')` Set 的成员占用，不替换或清空其他插件数据。
- release 只释放当前 token 对应的记录，重复调用返回 false；仅在确认未产生有效注册或已经成功撤销后调用。
- 保留公开 `apply(ctx)`、name、inject。ctx.effect 的清理函数返回待注册/撤销结束的 Promise；注册失败后允许显式重新激活，无后台无限重试。
- 测试 helper `fakePresetHost({register}) -> {ctx, disposeAll:()=>Promise<void>, logs:string[]}`；register 可被测试延迟、拒绝或返回失败 disposer。

- [ ] **1. 写生命周期失败测试**：启用→卸载→启用应 registrations=2、最后 active=1；并发重复启用只注册一次；注册抛错后再次启用成功。覆盖 pending 注册时卸载、迟到回调、重复 dispose、其他包占位未变、不同模块副本共享去重记录。
  ```js
  apply(host.ctx); await registrationSettled;
  await host.disposeAll();
  apply(secondHost.ctx); await secondRegistrationSettled;
  assert.equal(registrations, 2); assert.equal(active, 1);
  ```
  测试用显式 deferred Promise 控制事件顺序。disposer 失败时保留占位并记录错误；不得允许新的重复声明。pending 注册必须结束并成功撤销后才释放占位，防止新旧声明重叠。
- [ ] **2. 执行 `node --test tools/tests/lifecycle.test.mjs`**，确认原 Set 生命周期实现失败。
- [ ] **3. 实现所有权 helper 和 apply 生命周期**。保留 generation 防迟到机制，绑定所有权 token；旧实例清理不能释放新实例。注册返回值不是 disposer 时视为契约异常，保留可能有效的占位并报错，不谎报可恢复。
- [ ] **4. 重跑新测试、`node tools/verify-p3.mjs`、`node tools/verify-scope-guard.mjs`、`node tools/verify-child-control.mjs`**。模拟验证全部通过，真实宿主重启用仍单列待执行门槛。
- [ ] **5. 提交**：`fix(lifecycle): recover preset registration after unload and failure`。

### Task 5: 统一测试入口、CI 与交付验证

**Files:** 创建 `tools/verify-all.mjs`、`tools/tests/verify-runner.test.mjs`、`.github/workflows/verify.yml`；修改 `tools/verify-preset.mjs`、`package.json`、`README.md`、`docs/RELIABILITY.md`。

**Interfaces:**
- `runVerification({mode:'offline'|'integration'|'all',profileDir?,installDir?,runProcess?}) -> {ok:boolean,results:Array<{name,status:'passed'|'failed'|'unverified',exitCode:number|null}>}`。
- offline 顺序运行原有六套独立脚本及 `node --test` 加明确的新测试文件列表；标明宿主集成 unverified，但独立项通过时退出 0。integration/all 缺必需宿主文件、schema 校验器或模块时退出非 0。
- runner 子进程使用 process.execPath、相对 import.meta.url 的绝对文件路径、不经 shell，单进程超时 60 秒并收集失败；纯参数接口允许注入 runProcess 进行 runner 行为测试。
- `verify-preset.mjs` 保留旧的首个 profileDir 位置参数，并增加 `--profile-dir`、`--install-dir`。安装目录默认 `/opt/dsh/install/node_modules`；缺 entryListProblem 必须记为未验证并退出非 0，不能跳过后声称三层全绿。
- npm scripts：`test`=`node tools/verify-all.mjs --mode=offline`；`test:integration` 使用 `--mode=integration`；`test:all` 使用 `--mode=all`。

- [ ] **1. 写 runner 失败测试**。断言独立失败/超时/缺脚本为非零；宿主缺失时 offline 结果标 unverified、integration/all 不可成功；从别的 cwd 运行仍定位本包文件。测试导入 runVerification 不得自动执行整套测试，避免递归。
- [ ] **2. 执行 `node --test tools/tests/verify-runner.test.mjs`**，确认缺失新入口或错误退出语义导致失败。
- [ ] **3. 实现入口和 CI**。工作流在 push/pull_request/workflow_dispatch 运行，ubuntu-24.04、Node 22.23.2/24.19.0 矩阵、contents:read、任务超时 10 分钟，运行 `npm test`。无 npm 依赖时不添加无意义的 npm ci 或锁文件。actions 固定为经官方 tag 核对的 SHA：checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`（v7.0.1），setup-node `820762786026740c76f36085b0efc47a31fe5020`（v7.0.0）。checkout 关闭凭证持久化，不配置发布、自动合并或部署步骤。
- [ ] **4. 完成文档与全面验证**。执行 `npm test`，在当前缺宿主环境执行 `npm run test:integration` 并核对明确的非零/未验证结果；执行 `npm pack --dry-run` 核对新增 lib 文件纳入包。真实 DSH 环境按文档验证 boot roster、提交验收、插件卸载重启用和注册失败恢复，记录版本与日志；没有环境则交付保留未验标记。
- [ ] **5. 提交**：`test: add portable verification runner and reliability CI`。

## 自查与交付约束

- 覆盖映射：规格 4.1→Task 1/2；4.2→Task 3；4.3→Task 4；4.4→Task 5；兼容/恢复要求贯穿 Task 1/3/5。规格 5/6 是后续 B/C 范围，不在本次阶段 A 冒充实现完成。
- 新事务/证据接口的唯一声明分别是 Task 1/3；其他任务直接复用，避免重复实现。基础行为自测不能被集成环境失败替代。
- 执行开始按 using-git-worktrees 流程准备隔离工作区；目前本地是通过连接器读取的快照，没有 .git。必须取得真实仓库历史或通过 GitHub API 构造以已知远端 SHA 为父的提交，不能把快照伪装成原仓库历史。
- 每项先记录实际失败，再做最小实现并验证；不同代码提交的测试结果不能混用。最终审查整个实现差异、测试日志和 PR 的 head SHA。
- 新实现用独立分支/PR；本草稿 PR 先承载设计与计划。合并与真实环境部署须有对应明确授权及验证结果。
- 建议本会话直接执行五项，因 Task 1–3 共用同一事实库接口；完成后进行一次独立整体审查。另一可选方式是逐任务子代理实现与独立审查，审核更密集但上下文和调用成本更高。

## 官方 CI 版本依据

- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)
- [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0)
- 以上 tag 的 commit SHA 已通过对应官方仓库 Git refs API 核对；阶段 A 实施时保持固定 SHA，不自动随最新版漂移。
