/**
 * 流水线任务 payload 的解析（纯函数，无副作用，单独成模块以便测试）。
 *
 * `meeting_pipeline_tasks.payload` 是一个宽松的 jsonb 包，
 * 不同阶段会往里写不同字段。这里集中处理"读"的部分，
 * 避免各调用点各写一遍取值逻辑。
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 组织目标：写于入队阶段 */
export function getTargetFromPayload(payload: Record<string, unknown>): string | undefined {
  const target = asRecord(payload.target);
  return asString(target.orgTargetId);
}

/** 事件到达时间：写于入队阶段，用于端到端耗时观测 */
export function getEventReceivedAtFromPayload(
  payload: Record<string, unknown>
): string | undefined {
  const telemetry = asRecord(payload.telemetry);
  return asString(telemetry.eventReceivedAt);
}

/**
 * 是否抑制卡片推送——只写多维表格、不打扰用户。
 *
 * 标记写在 `payload.delivery.suppressNotification`（严格等于布尔 true，
 * 字符串 "true" 不算，避免 SQL 里手写成字符串导致误判）。
 *
 * 用途：补历史积压时，报告照常分析、照常写入 Base，
 * 但通知任务以 `cancelled` 入队——留痕可查、不发送，
 * 之后一句 UPDATE 就能把它改回 pending 补推。
 */
export function isNotificationSuppressedFromPayload(
  payload: Record<string, unknown>
): boolean {
  const delivery = asRecord(payload.delivery);
  return delivery.suppressNotification === true;
}
