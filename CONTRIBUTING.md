# 贡献指南

> 本文件只记录仓库中**已经存在**的实践——每条都能在代码、CI 或提交历史中找到出处（见文末索引）。
> 不包含治理流程：评审与合并权责属于仓库所有者。

## 1. 项目边界

本仓库是一个 DeepSeek Harness 的 **agent preset**（附带 host 插件）：主会话统御决策、子代理按需执行，
交付物为编排层（事实库、任务板工具、preset 隔离与执行守卫）。

- **不含漏洞利用代码**；面向已授权的测试与演练。
- 集成方式为 bundle patch：`cordis.patch.yml` 只插入 host 半边（两行），
  激活时通过 `ctx.agentPresets.register` 声明 preset，**不往 harness home 写任何文件**。
- 出处：`README.md` 首节与「已知边界」节、`package.json` 的 `dsh.bundle`、`cordis.patch.yml` 注释。

## 2. 本地验证

```sh
npm test                        # 离线闸：无需安装 DSH，宿主集成如实标记 UNVERIFIED
npm run test:integration        # 需要可解析的 DSH 安装（--install-anchor 或 PATH 中 dsh）
npm run test:all -- --install-anchor /absolute/path/to/@deepseek-ai/dsh/package.json
```

- 三个入口都指向 `tools/verify-all.mjs`（`--mode=offline|integration|all`）。
- 离线模式先跑 `tools/verify-*.mjs` 各验证器，再跑 `tools/tests/` 的显式测试清单（见第 4 节）。
- 判读完整体退出码，不看单项输出；**不要用管道看汇总**（管道会吞退出码——CI 用 `set -euo pipefail` 规避）。
- 出处：`package.json` 的 `scripts`、`tools/verify-all.mjs`、`.github/workflows/verify.yml`。

## 3. 两个运行环境（新测试必须同时成立）

| 环境 | 特征 | 可见文件 |
|---|---|---|
| 仓库检出 | 有 `.git`、有 `.github/` | 全部 |
| 解压包（`npm pack` 产物） | 无 `.git`、无 `.github/` | 仅 `files` 白名单：`lib/ tools/ docs/ cordis.patch.yml` + `package.json` + `README.md` |

CI 的 `native-host` job 在**解压包内**执行 `npm run test:all`（`.github/workflows/verify.yml`）。
因此新增测试必须满足：

1. 只依赖上表"解压包"列中存在的文件；必要时先判定环境再断言。
2. 对**仓库专有文件**（如 `.github/`）的断言：解压包内**如实 SKIP 并写明原因**；
   而**源码树里文件缺失必须 fail-closed**。区分依据：包根是否存在 `.git`。
3. 实例（PR #1）：workflow 契约测试初版直接读取 `.github/workflows/verify.yml`，
   在 `native-host` 失败（CI run `36974929232`）；加入 `.git` 判据 + 带原因的 SKIP 后转绿
   （CI run `36975169459`）。同类判据随后复用于 `engines-contract`（PR #3）。

## 4. 新增测试的登记

`tools/verify-all.mjs` 的 `SCRIPTS` 与 `TESTS` 是**显式清单**：新测试文件必须登记进 `TESTS`，
否则不会被任何闸执行。同时同步 `tools/tests/verify-runner.test.mjs` 中的镜像断言
（该镜像用于锁定 runner 行为；其"目录锚定"改进见 PR #2）。

- 出处：`tools/verify-all.mjs` 顶部数组、`tools/tests/verify-runner.test.mjs`。

## 5. PR 规范（现有实践）

- **一事一 PR**：功能 / 修复 / 文档 / 守卫各自独立，便于单独回退与单独验收。
- 描述四段式：**问题 → 改动 → 测试 → 没做什么**（现有 PR #1–#4 均按此结构书写）。
- **守卫类改动必须带变异测试自证**：先制造一次预期失败（改坏被保护的对象 → 断言必须报错），
  再恢复并证明内容逐字节一致。实例：`docs-contract` 守卫的双向变异（改 script 名 → EXIT=1；
  改旗标名 → EXIT=1；恢复后 `diff -q` 一致）——见 PR #4。
- 涉及契约的改动，在描述中引用被守护的对象（验收表/断言/README 节），不新增未落地的承诺。

## 6. 冻结契约（重构/改名不得触碰）

| 层 | 值 | 理由 |
|---|---|---|
| 包名 | `@local/dsh-taskforce` | profile 的 `link:` 依赖与 CI 的 `npm pack` 产物名 |
| preset 标识符 | `taskforce` | 用户配置、`ctx.agentPresets.register` 与验证脚本引用 |
| 显示名 / persona 自称 | `任务部队` | `lib/preset.js` 与运行时状态行；隔离验收有硬断言 |
| 事实库路径 | `$DSH_HOME/taskforce/taskforce.db` | 既有数据所在 |

> 改名只作用于发布门面（仓库名、README 标题、包描述）；技术标识符与运行时可观测字符串一律不动。
> 出处：`README.md`「命名」节（该节是上述内容的规范来源）。

## 7. 提交消息风格

`type(scope): 中文摘要` + 条目化正文（含验证结论与数字）。现有实例：

```
fix(ci): 从 pack.json 解析交付包文件名，消除版本硬编码            (d2b597d)
chore(package): 补 engines.node 机器可读约束 + 矩阵一致性契约守卫   (56c7c24)
test(contract): 文档-实现一致性守卫（npm scripts + CLI flags + 豁免腐烂）
```

- 正文建议包含：动机、改动清单、验证命令与结果（测试计数 / EXIT）、未覆盖项。
- 出处：`git log`（上述 sha 可直接 `git show` 查看完整消息）。

## 8. 三个实测陷阱（2026-10-02）

**`git push … | tail` 会吞退出码。** 实测 `git push … 2>&1 | tail -3` 得到 `PIPE_EXIT=0`，
而推送实际失败（远端未更新）—— 管道退出码取的是 `tail` 的。判推送结果须用重定向：
`git push … > /tmp/push.log 2>&1; echo "EXIT=$?"`，并核对 `git ls-remote` 的实际 sha。
（这是 §2「不要用管道看汇总」的又一实例。）

**HTTPS token 推不动 `.github/workflows/`。** 用 HTTPS token 推送改动 workflow 文件的分支被拒：
`refusing to allow an OAuth App to create or update workflow .github/workflows/verify.yml without workflow scope`。
⇒ **改 workflow 的分支必须走 SSH 推送**（本次用 `git@github.com:…` 成功）；
**HTTPS token 仍可用于开 PR 与只读 API**。

**叠层合并禁用 `-X ours` / `-X theirs` 整文件覆盖。** 实测事故：叠层同步某分支时用 `-X ours`
解决 `lib/tools/index.js` 的冲突，**静默冲掉了另一侧已登记的四个 hint 映射**
（`E_STATUS` / `E_BLOCKERS` / `E_NOT_FOUND` / `E_STORE_INTEGRITY` → 各自的 `HINT_*` 常量），
只留下该侧自己的 `HINT_STORE_FAULT`。**该丢失不报错、不留冲突标记**，直到 CI 上
`code-hint-coverage` 与 `error-code-contract` 两个守卫报出 `not ok` 才被发现
（**`main` 一度为红**，由 PR #24 补回四条映射）。
⇒ **纪律**：多 PR 叠层 / rebase 时**不要用 `-X ours` / `-X theirs` 整文件覆盖** —— 它会丢弃
另一侧对该文件的全部改动且无任何提示。**应按 hunk 逐处判断**（本仓库绝大多数冲突是
"末尾追加型"，取并集即可）；确需整侧取舍时，**必须在提交信息里写明取舍理由**并单独复核。

- 出处：本仓库 2026-10-02 实测。复现（三条均无副作用）：
  ```sh
  # ① 管道 vs 重定向：同一失败推送，管道得 0、重定向得 1
  git push origin refs/heads/__nonexistent__:refs/heads/__nonexistent__ 2>&1 | tail -3; echo "PIPE_EXIT=$?"
  git push origin refs/heads/__nonexistent__:refs/heads/__nonexistent__ > /tmp/p.log 2>&1; echo "REAL_EXIT=$?"
  # ② 在改动 .github/workflows/ 的分支上经 HTTPS 推送 ⇒ remote 拒绝（消息见上）：
  #    git worktree add /tmp/wf -b probe/wf origin/main && cd /tmp/wf
  #    printf '\n# probe\n' >> .github/workflows/verify.yml
  #    git add -A && git commit -m probe && git push origin probe/wf
  # ③ -X ours 的静默丢失：同一文件两侧各有改动时，merge -X ours 只保留当前侧，
  #    另一侧改动全部消失且无冲突标记（判据只能靠合并后的全量验证）：
  #    node tools/verify-all.mjs --mode=offline   # 必须 EXIT=0
  ```

## 附：出处索引

| # | 实践 | 出处 |
|---|---|---|
| 1 | 项目边界 / 不含利用代码 | `README.md` 首节、「已知边界」节 |
| 2 | 本地验证三命令 | `package.json#scripts`、`tools/verify-all.mjs` |
| 3 | 两环境判据（`.git` + SKIP + fail-closed） | `.github/workflows/verify.yml`（native-host job）、PR #1（CI run 36974929232 → 36975169459） |
| 4 | 测试登记与镜像断言 | `tools/verify-all.mjs`、`tools/tests/verify-runner.test.mjs`、PR #2 |
| 5 | 四段式 PR 描述 / 变异自证 | PR #1–#4 描述、PR #4 的变异双向记录 |
| 6 | 冻结契约四要素 | `README.md`「命名」节 |
| 7 | 提交消息风格 | `git log`（d2b597d / 56c7c24 / aabb94e） |
| 8 | 三个实测陷阱（管道吞退出码 / workflow 需 SSH 推送 / `-X ours` 静默丢失） | 本仓库 2026-10-02 实测（见 §8 的复现命令）；`-X ours` 事故由 PR #24 修复（commit 9280e7e） |
