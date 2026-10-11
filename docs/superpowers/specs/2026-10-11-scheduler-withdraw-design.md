# FIFO排队意图独立撤回设计

基线main3b88ba73f65379ca77cde0ff2ad2978638ff199b，0.4.1。用户授权持续工程升级及完整审核/PR/合并。

当前FIFO合同正确保留被预算/资源阻塞的队首，但累计new/retry预算永久耗尽时只能提升预算或取消业务任务清头。添加host-only `TaskforceScheduler.withdraw({request_id,request_key},runId,authority)`，仅将queued且reservation_id=null的意图改为withdrawn。保留原任务、队列序号/payload/键和全部governor计费/容量/locks，不派发、不退款、不隐式跳过FIFO。

同run可信lead可撤回；worker须同时匹配task当前owner和queue captured owner。精确旧withdraw键+目标在当前scope/owner检查后只读重放；lead可恢复同run先前worker操作，新的/接管worker无资格重放旧owner记录。另一target/action同key冲突；withdrawn使用另一个新key拒绝。已经admitted/reserved/unknown/settled/refused的请求不能新撤回，不释放reservation。

复用现有scheduler_decision JSON result保存内部 `{action:'withdraw',request_id,result}` envelope，不改DDL。admitNext的旧untagged决策继续读取，但同键withdraw envelope必须拒绝；withdraw拒绝admission或其他target envelope。不要用前缀拼键代替action绑定。此schema不变但写入者/读取者须协调升级，旧binary不支持新增withdraw决策；文档明确混合writer版本限制。

同一BEGIN IMMEDIATE内检查目标/当前与captured授权、检查决策、CAS queued且未reserved→withdrawn、插入决策；任何持久失败全回滚。首次返回正常public withdrawal结果；replay显式标识但不泄露内部envelope。state/原enqueue精确重放可看到withdrawn，分页仍有界。

保持所有既有命名、Node/宿主pins、依赖/schema、60000ms验收/12000ms清理、产品预算以及关闭的full-tree adapter。doctor及backup/restore须完整保留/识别原行和新决策值，不变日志权威。

验收：两种累计预算队首撤回后tail可准入且业务task不变；暂时受阻仍FIFO至显式撤回；跨run/current+captured owner、各已准入state、新键/同target/跨action冲突、重开只读回放、decision故障rollback、两连接admit-vs-withdraw与same-key竞争、state/原enqueue、doctor+backup+restore。
