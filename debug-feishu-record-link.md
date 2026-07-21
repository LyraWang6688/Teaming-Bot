# [OPEN] Feishu Record Link Debug

## Session
- session_id: `feishu-record-link`
- created_at: `2026-07-21`
- symptom: 点击多维表格中的会议报告链接后，`/api/feishu/record` 报错“当前集成尚未完成 Base 初始化。”

## Observations
- 会议流水线已经完成，`meeting_pipeline_completed` 已出现。
- 多维表格里已经存在对应会议分析记录。
- 日志中 `record_get_failed` 显示：
  - `recordId=recvq18FiEmfZh`
  - `integrationId=e5e1e770-f655-4937-ade9-d4d6f48b55ae`
  - `orgTargetId=null`

## Hypotheses
1. 报告链接生成时没有稳定带上 `orgTargetId`，导致进入 `/api/feishu/record` 时丢参。
2. 报告页或中转 API 解析查询参数时，`orgTargetId` 被错误忽略、覆盖或未透传。
3. `/api/feishu/record` 在缺少 `orgTargetId` 时错误地只走“当前默认 Base 初始化状态”校验，没有回退到通过 `recordId` 反查组织目标。
4. Base 记录写入成功，但链接字段内容被包裹了异常字符或格式化空白，导致前端解析 URL 参数失败。
5. 旧数据结构或页面兼容逻辑仍假设单组织/单 Base，点击报告时没有和新版 `orgTargetId` 模型对齐。

## Next Steps
- 检查报告链接生成位置与写回字段内容。
- 检查报告页与 `/api/feishu/record` 的查询参数解析链路。
- 对照日志确认 `orgTargetId` 是在“生成时缺失”还是“消费时丢失”。

## Evidence
- `meetingPipelineProcessor.ts` 生成报告链接时已写入 `recordId`、`integrationId`、`orgTargetId`。
- `report/page.tsx` 只读取并透传了 `recordId`、`integrationId`，遗漏 `orgTargetId`。
- `/api/feishu/record` 在缺少 `orgTargetId` 时回退到 `createIntegrationBitableAccess()`，从而触发“当前集成尚未完成 Base 初始化。”
- 运行时 `b.mask is not a function` 来自 `ws` 的 `bufferutil.mask()` 路径，表现为 ACK 失败后同一 `eventId` 被飞书重复投递。

## Fix Applied
- `src/app/report/page.tsx`
  - 增加 `orgTargetId` 读取与透传，确保报告页请求 `/api/feishu/record` 时保留组织目标上下文。
- `Dockerfile`
  - 在 `runner` 阶段固定设置 `WS_NO_BUFFER_UTIL=1` 与 `WS_NO_UTF_8_VALIDATE=1`，禁用 `ws` 的可选 native addon 路径。

## Verification
- `GetDiagnostics`：`src/app/report/page.tsx` 无诊断错误。
- `pnpm ts-check`：通过。
