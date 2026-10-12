# 控制回执返回一致性设计

基线 main：3b88ba73f65379ca77cde0ff2ad2978638ff199b（0.4.1）。用户已授权完整执行、独立审核、额外合并前审核、PR 与合并。

发送/停止的真实副作用及 durable accepted 行已完成后，现有工具等待第二次 listChildren。两固定宿主 listChildren 都是异步查询，目录故障可让回执永久不返回；调用信号取消也不结束。目录的 after.mode 从未使用。只保留副作用之前的直属子归属查询；操作后直接同步读取 live agents 活动态，不执行第二次目录查询。observed/current_turn 仍三态，缺席是 unknown，明确 idle 才是 inactive；不推断路由或进程树安静。

兼容显式 stop 收据 accepted:false 的路径已正确持久 rejected，但 state_truth 三分支仍声称信号发出且接纳。返回文案必须基于 accepted 分支如实说明拒绝，并单独描述实时活动观测。固定宿主的同步 void 接口继续按未抛错接纳；不扩大未来 Promise 接口支持。

保持授权 preflight、精确调用者 Agent、journal 连续性、原键、pending/unknown/rejected 回放和效果次数。无 schema、依赖、预算、deadline、清理、版本或 full-tree 能力修改。验收保持60000ms、清理12000ms；保持 @local/dsh-taskforce/taskforce/任务部队/taskforce.db 和既有 Node/宿主 pins。

验收：send/stop 在第二目录永不返回的边界也应返回完整 accepted 回执；副作用各一次、仅一次目录授权查询。调用者取消后不得伪造副作用失败或可重复；明确拒绝在 running/idle/unknown 三态均不声称接纳或发信号。直属授权失败依旧零副作用；正控、真实 SQLite 重放、现有独立活动态和完整套件通过。
