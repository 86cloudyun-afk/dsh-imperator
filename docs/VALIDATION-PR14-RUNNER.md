# PR #14：宿主契约 runner 接线验证

修复基于 `2efb22104d4841cc2bb20efe705e2c388d439e10`，叠层目标为
`test/host-api-contract`。实读当前 main 为
`68b714a0f220d08f2170832c0279b60a1ae9ce94`；PR 元数据中的
`c92245fae646f18de1bbf5f21361003ecb2f9485` 是历史 base。

## 改动及判据

`tools/verify-all.mjs` 的既有 `native boundaries` 调用增加
`host-api-contract.test.mjs`，沿用其 `DSH_INSTALL_ANCHOR` 环境。
两个 runner 回归分别验证 integration / all 的实际子进程参数包含该文件及解析后的 anchor。
不改宿主契约断言、运行时代码、workflow 或离线跳过条件。

all 模式的聚合 `node:test` 仍可跳过三个宿主契约；其后的带 anchor 调用必须真实执行这三条。
因此聚合输出的 SKIP 不能单独代表整个 native 验收结果。

## 本地实测（macOS，Node v22.23.2，既有 DSH 0.2.0-rc.2）

命令中的 `$DSH_ANCHOR` 指向既有 `@deepseek-ai/dsh/package.json`。
测试进程使用 `TMPDIR=/private/tmp`，未更改用户设置或宿主安装。

| 验证 | tests / pass / fail / skip | 退出码 |
|---|---|---|
| runner 回归修复前 | 12 / 10 / 2 / 0 | 1 |
| runner 回归修复后 | 12 / 12 / 0 / 0 | 0 |
| `npm test`（源码离线） | 275 / 270 / 0 / 5 | 0 |
| `npm run test:integration -- --install-anchor "$DSH_ANCHOR"` | native 12 / 12 / 0 / 0 | 0 |
| `npm run test:all -- --install-anchor "$DSH_ANCHOR"`（源码） | 聚合 275 / 270 / 0 / 5；native 12 / 12 / 0 / 0 | 0 |
| 实际 npm pack 解压包中的 test:all | 聚合 275 / 264 / 0 / 11；native 12 / 12 / 0 / 0 | 0 |

三个宿主契约在源码与解压包的带 anchor 调用中均为 **3 pass / 0 fail / 0 skip**。
原生 boot 验证 9 checks、preset isolation 13 checks 均通过，没有模型请求。
源码聚合的 5 skip 为宿主契约 3 条与已有 native 环境测试 2 条；
解压包另有 6 条仓库专用契约 skip（engines、ignore 和 workflow），合计 11 条。

负对照仅在解压副本中将 `typeof scope.scopeOf` 替换为不存在的符号。
原始 runner 的 integration 与 all 均退出 1：native 为 12 / 11 / 1 / 0，
三个宿主契约为 2 pass / 1 fail / 0 skip；all 的聚合部分仍通过，证明失败来自新增的带 anchor 接线。
恢复文件后逐字节核对一致，再跑解压包 test:all 退出 0。

默认 macOS 临时目录的首次基线另有三条既有断言失败：
`resolves explicit npm anchors, legacy modules directories and versioned PATH symlinks`、
`integration runs actual boot separately and cannot hide a boot failure behind contract checks`、
`all mode hands a resolved anchor to verify-store so S33 cannot silently skip`。
原因是 `/var` 与 realpath 的 `/private/var` 不一致；以进程级 TMPDIR 修正验证环境后通过。
沙箱内 native boot 的退出 13 也未算作通过；原生验收在允许 loopback 的进程中重新执行。

## 验收边界

本地证据只覆盖 macOS 开发环境的 Node 22 与上述既有安装；Linux / Node 24 需看本次 draft 的 CI。
该修复针对 PR #14 分支，不代表已经合入或验收当前 main，也不代表最终用户服务器的安装、升级或实际业务验收。
外部原始分支和 main 的所有权保持不变；具体提交、tree 与 CI 收据在叠层 draft 中给出。
