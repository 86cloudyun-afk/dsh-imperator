# 原生身份准备的 fork 与有效深度设计

基线main3b88ba73f65379ca77cde0ff2ad2978638ff199b，0.4.1；已有用户执行/审核/PR/合并授权。

两固定真实宿主 Agent 复现：普通fork是独立runtime root，parentSession仅表示seed血缘；prepareNativeIdentity却上溯seed并返回来源run/depth2，来源离线还错误拒绝。实际runtime subagentDepth=2但header无深度时，helper误报nextdepth1。固定SDK有效深度=max(header.delegationDepth,agent.options.subagentDepth)，非法runtime值必须拒绝。

修复仅H01准备接口。保留exact live Agent/header、agents.get(id)===current、reserved ID、64节点界限、cycle与delegated parent live检查。origin=subagent或有效depth>0才继续委派父链；遇第一个普通root停止，即使有seed parent，也不读取该seed。有效depth同时考虑两个来源及实际委派链所需深度，不得降低实际深度；next最多2。缺少真正委派父级、坏值/identity仍E_SCHEDULER_CAPABILITY；不使用deriveIdentity的离线depth1兼容fallback。

没有native dispatch、service替换、模型调用、能力override或适配器启用；所有native_enabled/能力booleans仍false，H01-H06的关闭门槛不改。保持命名/DB、Node ^22.23.2 || ^24.19.0、固定宿主0.2.0-rc.2/0.2.1-alpha.2、60000ms/12000ms、无依赖/schema修改。

验收覆盖普通root/fork（seed在线/离线）、fork真实child/depth2拒绝、runtime-only深度、header/runtime双向不一致与坏值、origin-only委派链、missing/cycle/impersonated live identity/占用reserved ID。至少fork和runtime-only矩阵必须在两固定真实宿主的idle Agent上运行，模型请求0。
