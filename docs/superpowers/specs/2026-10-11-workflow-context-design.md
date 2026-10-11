# 工作流重启上下文读取设计

基线 main：3b88ba73f65379ca77cde0ff2ad2978638ff199b，0.4.1。持续升级、实现、审核和PR合并已有授权。

计划和审核findings已持久化，却在现有state、board和working-context读取路线均不可恢复。增加现有 `TaskforceWorkflow.state({task_id,include_context:true},run)` 与同名task_workflow_state工具的可选Boolean字段，默认及false输出保持原样；不将其称为数据丢失或既有元数据合同失效。

显式上下文返回 `context:{plan,latest_review}`。plan为完整原计划；latest_review为该任务/run最新审核的元数据和完整findings，空历史为null，并带is_current（比较当前revision_id、plan_version、evidence_generation）。历史审核可读但不作为当前通过证明。默认响应及working-context不新增自动展开，避免上下文增长。

显式上下文读取在现有同一读事务、run/附属完整性门槛后进行。验证存储的plan/list/findings形状及已有16KiB各自JSON上限；坏JSON、坏shape/超限通用E_STORE_INTEGRITY，不回显坏数据。结果实际工具JSON `{ok:true,...result}`最多65536bytes；先移除最旧artifacts/reviews元数据至达标并标history_truncated，不截断合法plan/findings，必要时拒绝超限异常。上下文不证明身份、不恢复owner、不执行命令、不写入、不更改验收结果或证据代际。

保持 Node ^22.23.2 || ^24.19.0、宿主0.2.0-rc.2/0.2.1-alpha.2、命名/DB、60000ms验收/12000ms清理、无新依赖/schema，全树适配器关闭。

验收覆盖重开后精确plan/findings、无review、跨run/混域、非法Boolean和坏存储、历史代际标识、真实工具派发、默认结果不变、最大合法Unicode/转义字节预算及total_changes=0。
