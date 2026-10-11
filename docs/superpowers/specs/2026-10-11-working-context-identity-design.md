# 每步上下文的真实 run 身份修复设计

用户已授权持续排查、全部已确认问题修复、Superpowers 实施、独立审核和 PR 合并。本项由固定 272a1fe 的只读交叉审计确认：每步上下文 resolveRunId 只读取 header，且拒绝含边界空白的非空 ID，与现有工具/lifecycle 的实际身份及 H01 已实测运行时深度不一致。原 main 已存在此解析器，本轮前五项没有引入该缺陷。问题只影响观察投影，不据此声称已证明历史生产停止。

修复保持轻量内联解析，并允许 stateOf 对已观察 session ID 作一次局部防御性读取；readable session 对象上的 throwing header/header.id 必须降级，不让可选投影抛出。session对象/scope缓存重置仍保留；不扩展到任意 throwing Agent/session/ctx Proxy，不从带顶层 await 的工具模块导入生产代码，不建立新的身份服务或权限。每个当前/祖先 Agent 都读取其 header 与 options.subagentDepth，按现有工具的有效非负 safe-integer 值取最大深度，origin=subagent 或有效深度>0 标为委派。保留 root/普通 fork 以自身 ID 为 run，seed parent 不表示委派。ID 仍须非空白且长度<=200，但原非空值原样保留，不能 trim 后选中其他 run。

祖先遍历保留当前32-hop边界、seen/cycle检查、parentSession 与实际查得 header.id 精确相等、异常时 undefined/不读 legacy 的降级。遍历必须持有实际 parent Agent，读取其运行时深度；不能在 runtime-only 祖先处提前结束。既有 missing-parent/depth===1 的观察兼容路径保留，按两种来源的有效深度判断；深度>1 无证据及 origin-only 无可证明根时不读 store。H01 的严格 live-parent gate、64-node边界、durable -0限制属于其他接口，不能借本项修改。

每步解析不新增跨步身份缓存；运行时深度或祖先角色变化必须反映到下一次读取。guard/lifecycle/fork owned-event切片、完整可见 TODO/上下文、工具身份与事实权威、分页和工作投影接口均保持。

验收：先 test-only RED 复现 runtime-only当前调用者、runtime-only祖先、非空padded root/child/parent 精确 ID，并比较实际SQLite工作投影的正确scope与隔离domain；读取不写入。负控包括仅空白/超长/非法ID、错parent.id、循环、边界、不可读options/header、缺祖先深度>1不得查询legacy；原root/fork/durablechild/offline-depth1及身份未知的旧状态更新保留。两个固定宿主利用现有原生 scheduler fixture 的真实已注册 Agents/实际 runtime options，再触发真实 working-context hook 的受控 next；如使用明确 scope/hook fixture 必须披露，不能称为完整原生Agent loop。

固定 names/DB、Node和DSH pins、无新依赖/schema/工具或预算、60000ms验收/12000ms清理、full-tree关闭。本项只有工作上下文读投影变化，不派发、不改权限和身份、不迁移旧记录。独立任务spec/quality审核及最终整轮/额外合并前审核分别完成。

设计审核补充：不存在/null或undefined父header的depth-one兼容路径，与present但畸形/不匹配/不可读取的父节点严格分开；不能把统一reader的undefined当作离线根，不复制tools对agent.id的fallback。每个Agent深度按tools有效safe整数过滤，NaN/Infinity/负数/小数/unsafe/string/null忽略，-0按0；一侧有效仍使用有效值，both invalid且无origin为普通root，有origin则保留child。H01较保守限制不迁入。

精确边界测试：padding与未padding scopes同时有不同任务/事实并保留legacy，验证paddedroot/child/祖先/离线parent原值；长度200允许/201拒绝（包括多字节）；32次parent查找到root通过，第33次所需拒绝，不能换成32nodes或64nodes。缺祖先fallback依据当前遍历Agent的effective depth，不能依据最初caller。有效角色比较使用uncached deriveIdentity或fresh activation，仅正控可比身份。

同一个Agent/session/id/scope/events不变时，改变caller或ancestor runtime depth/role，下一step重新解析；至少一次变化发生在受控next内。当前header/ID/options及祖先header/options throwinggetter均测试完整pre-step不查询store/legacy；stateOf防御性ID读取只影响局部cache匹配，无run身份缓存。原可见历史状态按已有无证据规则被替代。真实原生fixture复用actual agents.get/Agent对象，允许新增runtime-only祖先下child覆盖；不以fakeheader/options复制品冒充实际Agent。
