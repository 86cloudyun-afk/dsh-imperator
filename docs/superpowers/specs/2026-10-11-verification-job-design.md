# 验收promotion即时诊断设计

两固定真实宿主已复现：task_verify请求foreground但默认timeout promotion可返回promoted job；严格receipt正确unknown且拒绝accept，wrapper却丢失job locator和继续检查提示。用户授权增量提升及完整审核、PR合并。

只扩展runTaskVerification本次直接返回值，在完成现有receipt持久化后，从isError:false且kind=promoted/background的真实native union投影 `native_job:{kind,job_id,timeout_ms,scope:'current-owner-process',durable:false}` 和固定恢复next提示。kind仅这两个enum；job_id只保留满足 `[A-Za-z0-9][A-Za-z0-9._:-]{0,255}` 的ID，否则null；timeout_ms仅promoted正的safe integer，否则null。禁止输出output、路径、任意错误/其余union字段。提示只说此调用观察到非foreground，需要发起本次验证的原生会话在其当前进程中检查宿主job_output/job_kill并确认结束后再重新验证；不声称返回时job仍running，不自动kill/poll。scope中的owner指本次调用者，不是await完成后任务的新owner；任务重新分配不转移原生job权限。

仍unknown/verified:false/output_complete:false且不能accept；root调用仍拒绝。native_job为本process/owner瞬时定位，非durable authority，旧DB/state/export/restore不恢复该句柄。不修改executionOutcome或receipt存储schema，原foreground/UNKNOWN_TOOL/error路径不变。

保持命名/DB、Node ^22.23.2 || ^24.19.0、宿主0.2.0-rc.2/0.2.1-alpha.2、60000ms/12000ms、无依赖/schema修改/full-tree关闭。元数据长度固定有界，无raw rendered输出成为成功日志。

验收：两个实际固定宿主promotion有可检查locator，strict acceptance仍拒绝，job明确cleanup settled；foreground无native_job；background/异常jobID/timeout安全投影（256字符ID允许、257拒绝，非法字段null）；await期间owner/generation变化仍保留原调用者的未知观察，不建立新owner权限；持久receipt和diagnostic archive没有新handle；UNKNOWN_TOOL/error行为保持。durable:false不承诺宿主不会保存普通工具结果文本，只表示不是持久执行授权或Imperator归档句柄。
