# 研究型编排与思考保护

日期：2026-09-30。适用：本次修改后的 TaskForce preset。部署与真实模型效果需要另行验收。

## 目标和本次边界

解决两个明确的机制问题：人格规则把小型只读调查推给新子代理，以及 STALL 启发式信号触发强制收口和推理档位降低。本次修改现有 persona、guard 和离线测试入口，不新增调度器、数据库 schema、工具 API 或模型档位。

主会话亲自承担关键证据调查、备选方案比较、反例检查与最终验收；子代理执行有边界的任务。保留 `orchestrator-scope` 的读写权限边界、continuable、`task_child_send`、事实库验收门槛和 `maxDepth: 2`。没有修改宿主或 Superpowers 插件本身。

## 派发和复核规则

纯只读小任务默认不派代理。需要写入、运行测试或其他执行能力时，先给一个执行者完整的可验收任务，而不是按文件、命令或函数拆成多个代理。派发前记录独立交付物、委派收益、不能复用的理由、依赖、资源、验收和预算。

同任务续作和局部返工优先 `task_child_send`；原执行者确实无法恢复、权限或隔离要求不同，以及需要独立判断时才新建。独立复核不能由执行者自己冒充，但也不等于重新做完整任务。主会话核对原始差异与证据，不能仅复述摘要。

以下是提示词软预算，不是数据库计数器或运行时硬闸门：

| 维度 | 当前纪律 |
|---|---|
| 初始执行者 | 先用 1 个；纯只读小任务为 0。 |
| 只读/写入并发 | 只读至多 6；含写默认至多 2；同资源串行。上限不是目标。 |
| 累计新建 | 每个可验收里程碑默认至多 3 个；达到后由主会话复盘，可记录理由后调整。 |
| 返工 | 同任务默认至多 2 轮后重新评估根因与任务拆分，不自动换人继续试错。 |
| 嵌套 | 默认不主动嵌套；保留深度 2 的宿主能力，必要嵌套计入同一任务预算。 |
| 复用 | 与新建、在飞数分开记录，不能把低并发误当作低启动量。 |

这些数字是可调整的初始纪律，不是经过模型效果实验得出的最优参数。阶段 B 的持久化全树额度、精确运行计数、原子准入和恢复协议仍然未实现；本次不会声称仅靠提示词已经封闭所有派发入口。

## guard 配置和兼容性

`lib/preset.js` 中的现有 guard 行现在显式使用：

```js
config: { stallAction: 'observe', stepDownRequests: 0 }
```

| 配置 | 语义 |
|---|---|
| `stallAction: 'observe'` | STALL 仅写诊断日志，不向模型注入熔断消息，不启动降档窗口，也不占用 ECHO 冷却期。 |
| `stallAction: 'interrupt'` | 保留旧版 STALL 打断行为。独立使用该插件且省略此配置时仍为这个默认值。 |
| `stepDownRequests: 0` | 所有信号都不改写 reasoning effort，ECHO 提示仍保留。 |
| `stepDownRequests: N` | 非负整数；N > 0 时，实际打断才启用有界降档窗口，耗尽恢复；旧版默认仍为 3。 |

非法 `stallAction`、负数或非整数降档次数在激活时拒绝。`enabled: false` 保持原有禁用语义。其他阈值的默认值保持兼容，不将其描述为“健康思考上限”或经过验证的模型能力指标。

观察日志只包含信号统计和档位，不写出推理内容。在同一个 agent 实例内，连续 STALL 只观察一次；信号清除后重新出现可以再次记录。去重状态不是持久日志游标，重启或重建 agent 可能再次记录旧信号。日志功能不可用不阻断会话。

STALL 与 ECHO 可同时成立。观察 STALL 时仍独立检查 ECHO，防止较长推理掩盖已经发生的同参重复工具失败。观察模式不消耗 ECHO 冷却期。ECHO 保留显式错误判据，按下节的调用身份、因果顺序和通知确认规则计数，避免重复回执或乱序结果制造误报。

该 preset 的 guard 配置适用于实际挂载到的代理，包括子代理；本次没有增加按角色改变模型推理档位的路由逻辑。

## 风险和回退

观察模式不能自动终止真正的长推理空转。这是避免误断正常研究的明确取舍；宿主自己的超时、任务取消、成本预算仍须保留。不要因为关闭自动降档就关闭这些控制。

需要恢复旧行为时，将该 guard 行改为 `stallAction: 'interrupt', stepDownRequests: 3`，按部署流程加载并重新验收。不要以修改运行中的角色提示来绕过配置。代码合并本身不代表正在运行的 DSH 已经使用新 preset；本次未执行安装或重启。

本次的 continuable 复用规则不能直接套到阶段 B/C 规格中的 `managed_once`。后者要求新的受管请求与 attempt；没有实现并验证对应生命周期前，不能将两种模式混合后宣称额度完整。

## 验证与效果验收

`tools/tests/deliberate-orchestration.test.mjs` 已接入标准离线 runner，覆盖 persona 合同、preset 显式配置、观察模式、请求对象不变、零次降档、ECHO 不被掩盖、观察去重、logger 故障、agent 隔离、snapshot 事件、参数校验和旧配置恢复。

```bash
node --test tools/tests/deliberate-orchestration.test.mjs
npm test
npm run test:integration
```

这些是代码逻辑及钩子夹具测试，不是对真实模型“思考变深”或“启动减少”的实测。

真实验收应固定模型、路由、代码版本与任务集合，比较旧版和新版的：新建次数、复用次数、独立问题数量、重复调查与返工、耗时和 tokens、测试/审查缺陷，以及主会话决策是否有原始证据、备选方案和失效条件。覆盖简单查询、单点修复、独立并行任务与高风险变更。质量不降低是前提，不以字数、思考时长或代理数量单项判胜。

## 运行时补强：失败因果、通知去重和档位切换

继续优化的范围限于现有 guard；没有把软派发预算升级为硬调度器。

- **同参判断**：递归排序 JSON 对象键，数组顺序和类型保持不变；编码后的 JSON 与对象等价。无法序列化的参数视为未知，不再用通用字符串冒充同一个任务。折叠临时表只保留 SHA-256 签名摘要，不复制每份完整派单文本。
- **调用身份**：只有带有效 callId 的调用与首个匹配结果才能提供失败证据。重复调用/结果去重；孤立结果不计数；缺失或冲突的身份不能冒充“最新调用失败”。同一 callId 对应冲突参数时标记不可信。
- **因果顺序**：连续失败按调用发起顺序的末尾统计，而不是结果到达顺序。新签名、成功结果、未完成或不可信调用打断连续链。因此旧调用晚到的成功不会抹掉较新的三次失败，旧失败也不能越过较新的成功重新触发。
- **通知确认**：新 ECHO 消息的 source 带 `kind: taskforce-guard, signal: echo`。从持久事件流读到该消息后，之前的调用不再用于新一轮失败计数；后续达到阈值的新失败仍可触发。同一 agent 内也记录已通知的末次调用 ID，避免没有新证据时冷却结束后反复提示。
- **档位切换**：路由切换到缺省或数字档位时清除旧字符串档位；未知键不能命中对象原型属性。仍不修改 TaskForce preset 已选择的请求档位。
- **一次折叠**：`foldGuardSignals` 同时产出两个独立信号；观察 STALL 不再为寻找 ECHO 第二次扫描整段事件流。旧 `foldGuardSignal` 的返回形状与 `detectStall` 选择行为保留。

新增 `tools/tests/guard-causality.test.mjs` 接入 `npm test`，覆盖上述边界，并穷举 4 次调用的 16 种成功/失败分布 × 24 种结果到达顺序，共 384 组因果顺序对照。

明确限制：通知确认依赖宿主持久保存并在恢复时提供 source 元数据；旧版本未标注 signal 的历史通知不能自动追认，裁剪掉调用或通知的事件片段不等于完整证据。缺少 callId 时宁可不认定 ECHO，不能用猜测换误报。此通知机制不是权限边界或全局持久额度。不可变历史使用下述增量投影，其他历史仍全量回放；未宣称增量 O(1)、总延迟下降或真实模型效果已验收；STALL、超时和任务取消的既有风险说明仍适用。


## 0.2 原生整合契约

保留主会话只读研究与最终验收、软预算、STALL observe 与零降档。两种委派工具都提供执行者 persona 和显式深度 2，主控 PTC 保留传输 run_code 由执行 guard 阻止，不能把工具隐藏当作授权。

ECHO 仍以调用发起顺序为准；PR #6 原先“旧成功清空新失败”的两个断言被明确改为此契约，场景未删除。调用身份为 native/PTC 命名空间 + turn + step + provider ID；持久通知与运行时去重使用完整身份。对同一步相互矛盾的身份仍保守处理。外层 run_code 仅在存在真实内层事件时透明，折叠仍只遍历输入事件一次。

工作投影保持主分支返回形状：dispatched 是尝试数，delegatedResults 是所有已配对回执数，failedDispatches 单列失败。由这三者与通知计算未结算估计，失败不会残留占位；PTC 自描述回执可用于裁剪历史恢复，但估计仍不等于全树硬额度。


## 0.3 不可变历史增量投影

`createEventCursor().read(events)` 返回 `{ reset, events }`；后者是需要重放的全量历史或新增尾部。只有深冻结的 JSON 事件图可以缓存，验证过的不可变对象用 WeakSet 记忆。普通可变数组可以承载不可变事件，但数组引用相同、长度相同、末尾 seq/callId 相同均不构成追加证明：每次逐项比较整个旧前缀的事件引用；中段替换、重排、缩短或非深冻结输入都全量重放。存在 seq 时要求连续；无 seq 的兼容 JSON 历史仍按完整引用前缀判断。访问器、稀疏数组、循环或非 JSON 对象不能进入快速路径。

`createGuardProjection(options).read(events)` 与 `createFlowProjection(delegationTools, settlement).read(events)` 复用纯函数 `foldGuardSignals` / `foldSubagentFlow` 的 append/snapshot reducer，并保持返回形状。`processedEvents` 是累计传入 reducer 的事件数（包含 reset 重放），不是总操作数。冻结 40000 条事件初读处理 40000 条，原历史重读不增加，追加一条后为 40001；结果与全量 fold 相同。阈值或工具集合变化会使该 projection 重新回放；settlement 是创建时固定的值，变更时创建新 projection。

两个插件分别以 per-agent WeakMap 保存投影；会话对象、session ID、作用域对象变化或观察到离开 preset 时丢弃旧状态，disposed 时释放。DSH 0.2.0-rc.2 正常 append 深冻结新事件，而 restored seed 可在同一 seq、同一快照引用下被就地修改，所以恢复或兼容输入中的可变事件必须每次全量回放。配置重新激活使用新的闭包和缓存；请求档位阈值变化同样重新回放。

工具扫描保留 turn/step cursor，以及 native/PTC 命名空间、原始结果坐标、重复与乱序结果、通知 ID 和 ECHO 确认位置。后到的真实 PTC dispatch 可以回溯标记 run_code wrapper。snapshot 不提交未关闭的当前推理步；因此重复读取不会累计虚假的 STALL。仍使用 STALL observe、`stepDownRequests: 0`，store 与工具权限边界不变。

成本边界：每次仍有 O(n) 前缀引用比较及引用数组复制；首次或新增对象的深冻结认证与 JSON 图大小相关。guard snapshot 仍扫描失败调用尾部，最坏 O(调用数)；todo 和可见 context 去重仍读取相应历史，surface compaction 会重新判断可见性。缓存保留事件引用与调用/通知元数据，空间随历史增长。这里只减少可信不可变历史的重复 reducer 处理，不承诺完整 pre-step 为 O(新增事件)，也不把处理计数当作真实模型延迟或成本测量。

## 0.3 低风险短流程与固定模型回归

低风险只读问题由主会话直接调查；需要执行时，一个可验收任务、一名执行者，把定位、回归、修复和提交组织在一起。只在关键里程碑记录产物与证据，提交后一次主控验收，不要求每步写 fact/decision 或重复复述。续作先 `task_child_send` 复用原执行者；高风险或证据矛盾仍需独立复核。此前「派发前记录」的完整决策摘要用于复杂或高风险任务，简单任务把边界与判据写进任务即可。

这次压缩只改变 persona 和工具说明的表达。可信身份、主会话执行禁令、宿主 approval/sandbox/guards、终态与晚到 blocker、legacy 证据、execution 严格回执、软预算及有效思考契约继续有效。`STALL observe` 和 `stepDownRequests: 0` 不变。持久 governor 的可信宿主 API 已见下述交付说明；未经接线验证的 native managed 派发仍不能宣称受全树硬额度保护。

`tools/verify-model.mjs` 可安全 import；`runModelVerification(options)` 要求 `modelCalls: true`。CLI 必须显式 `--model-calls`，否则在宿主启动前失败。默认 `npm test` 只跑注入离线 harness 的行为回归，不发 provider 请求。

固定四阶段使用同一隔离临时工作区和同一主会话：

| 阶段 | 独立判据 |
|---|---|
| readonly | 读发票回答 137 分；0 子代理、0 任务、工作区不变。 |
| repair | 只新建 1 名直属执行者；1 个 legacy 任务 accepted；外部 grader 检查空数组、整数、小数精度和负数，共 4 项。 |
| reuse | `task_child_send` 指向原执行者且该执行者实际发起模型请求；0 新执行者；新 legacy 任务 accepted；外部 grader 共 8 项（前 4 项、NaN、正负 Infinity 的 TypeError、混合有限数回归）。 |
| strict | 复用原执行者；新 execution 任务 accepted；固定文件清单与命令；重新验证当前源码、宿主日志及本代真实 owner 回执；外部 grader 8 项。 |

repair/reuse 的提示与实际任务 policy 均固定为 `legacy`，便于与原金额修复/续作工作量比较；若观察到其他 policy，即使任务 accepted 且有真实回执也以 `evidence-policy` 失败。第四阶段单独测量 execution 严格闭环，不新增功能要求，以固定 task_verify 完成本阶段测试；真实失败须修正后重验，仍需主控验收和独立 8 项判据。此固定回归不评价模型自主选择证据策略。执行者仍须实际运行测试并保留日志/产物依据，关键里程碑合并记录，提交后主控只读核对证据并一次验收。

grader 在工作区外运行固定断言，不运行模型自行改写的测试来决定最终通过；删除测试、打印成功或提前 exit(0) 都不能替代 grader 完成。strict 固定命令为 `node --test money.test.mjs`，清单为 `money.mjs` 和 `money.test.mjs`。任务豁免不计通过。模型请求错误、工具错误、非正常 turn/end、缺 usage、不完整验收、超额、超时或清理失败均不能标记 `ok: true`。

runner 走官方 `controlledProfile`、registry mount 和 native followup，记录所有真实子代激活并等待各层宿主结算通知及主会话再次空闲。上限默认且最大 80 个全树请求（允许调低），每阶段默认 180000 ms；重试和自动标题模型调用关闭。失败时取消所有跟踪 agent，dispose 主句柄与应用，每步清理最多等待 10 秒，最终清除临时 profile/home/workspace 并还原环境和退出码。

报告只持久化白名单元数据，不保存模型推理、对话、原始工具返回、证据内容或 credentials。任务/会话历史及 native 日志位于运行期间的临时 home，清理后移除。报告含固定阶段名称、数值指标、独立判据结果、固定失败码和版本/摘要；模型原文、异常消息及任意事实陈述不能进入报告。源码指纹覆盖排序后的 `package.json`、`cordis.patch.yml`、`lib/` 与 `tools/` 路径和文件字节；文档、报告和 git 元数据不计入。缓存 tokens 按宿主语义单列，`inputTokens` 是未缓存输入，缺省 cache 字段计 0。报告是单次受控样例，不能独自证明普遍性能提升。

固定金额 fixture 的模块边界：`money.mjs` 必须是自包含的 ES 模块，导出同步 `sumMoney`，仅依赖标准 ECMAScript 内建。静态/动态 import、Node 宿主全局（如 process/Buffer）和异步 `sumMoney` 不在此固定回归的支持范围；`money.test.mjs` 仍可正常使用 node:test。固定阶段提示明确包含该要求。

独立 grader 在一次性子进程中使用新的 `vm.SourceTextModule` realm（子进程启用内建 `--experimental-vm-modules`），不把 host 对象、函数或数组传给模型模块。固定输入数组和拒绝动态导入的 Error 都在该 realm 内创建，字符串/Wasm 代码生成禁用。观察记录、完成协议与 Node process 留在外层 grader；父进程对完整 4/8 项观察记录作固定比较。`process._eval` 即使保留外层 stdin 脚本，也不在模型 realm 中可见。此处仅建立固定纯金额函数与 grader 的普通 JS 模块边界，不宣称 Node vm 是通用安全沙箱，也不提供同 UID 文件系统或 OS 进程隔离。
