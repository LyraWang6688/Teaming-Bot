import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { FeishuOpenApiError } from '../common/openapi';
import { mapStatusToChinese } from '../pipeline/status';
import { buildPersistentReportUrl } from '@/lib/reports/reportUrl';
import type { MeetingRecordRow } from '@/lib/db/schema';

import {
  createMeetingRecord,
  findMeetingRecordByMeetingId,
  type FeishuBitableAccess,
  updateMeetingRecordFields,
} from './bitableOpenApi';

/**
 * Base 字段映射：从 Supabase meeting_records 行映射为 Base 记录字段
 *
 * Supabase 是唯一真相源，Base 是展示镜像。所有 Base 写入统一走这个映射。
 * 新增 Base 字段时，在 BaseFieldMap 里加一项，在这里补一行即可。
 *
 * 「创建人」字段为文本类型：写入 authorized_user_name（飞书授权用户姓名），
 * 缺省时回退到 organizerOpenId 字符串。不再使用人员字段格式 [{id}]，
 * 因为平台级独立 Base 应用无法解析集成应用的 open_id。
 */
function mapSupabaseRowToBaseFields(
  row: MeetingRecordRow,
  options?: { orgName?: string | null; organizerName?: string | null }
): Record<string, unknown> {
  const { orgName, organizerName } = options ?? {};
  const fields: Record<string, unknown> = {};

  if (row.feishuMeetingId) fields['会议ID'] = row.feishuMeetingId;
  if (row.topic) fields['会议名称'] = row.topic;

  // 数据来源 = 初始化配置时选择的方向（orgTarget.orgName）
  // 注意：Base「数据来源」是单选字段，必须是该字段已定义的选项之一，且写入字符串而非数组
  if (orgName) fields['数据来源'] = orgName;

  // 创建人 = 会议创建人姓名（文本类型字段）
  // 门槛通过场景下 organizerOpenId = authorizedOpenId，姓名来自 feishu_authorizations
  const creatorName = organizerName || row.organizerOpenId;
  if (creatorName) fields['创建人'] = creatorName;

  // 处理状态：英文 status → 中文显示值
  const processStatus = mapStatusToChinese(row.status);
  if (processStatus) fields['处理状态'] = processStatus;

  // 会议文字稿
  if (row.transcript) fields['会议文字稿'] = row.transcript;

  // 分析摘要
  if (row.analysisSummary) fields['分析摘要'] = row.analysisSummary;

  // 报告链接
  if (row.reportUrl && row.reportPublicId) {
    const persistentUrl = buildPersistentReportUrl(row.reportPublicId);
    if (persistentUrl) {
      fields['报告链接'] = {
        text: '查看报告',
        link: persistentUrl,
      };
    }
  }

  // 错误信息
  if (row.lastErrorMessage) fields['错误信息'] = row.lastErrorMessage;

  return fields;
}

/**
 * 将 Supabase meeting_records 行同步到飞书多维表格
 *
 * 职责：
 * 1. 字段映射（Supabase 列 → Base 字段，集中在此处）
 * 2. upsert 语义（meetingId 已存在则更新，否则创建）
 * 3. 返回 baseRecordId 用于回写 Supabase
 *
 * 使用场景：
 * - 门槛通过后的会议基础信息写入
 * - transcript 获取完成后同步
 * - 分析完成后同步结果
 * - 任务恢复时重新同步
 */
export async function syncMeetingRecordToBase(
  config: FeishuBitableAccess,
  supabaseRecord: MeetingRecordRow,
  options?: { baseRecordId?: string | null; orgName?: string | null; organizerName?: string | null }
): Promise<string | null> {
  const startedAt = Date.now();
  const fields = mapSupabaseRowToBaseFields(supabaseRecord, {
    orgName: options?.orgName ?? config.orgTarget?.orgName,
    organizerName: options?.organizerName,
  });
  if (Object.keys(fields).length === 0) {
    logFeishuMonitor('warn', 'base_sync_empty_fields', {
      userId: config.userId,
      integrationId: config.integrationId,
      meetingRecordId: supabaseRecord.id,
      durationMs: Date.now() - startedAt,
    });
    return options?.baseRecordId ?? supabaseRecord.baseRecordId ?? null;
  }

  try {
    // 优先用传入的 baseRecordId，其次用 Supabase 里存的
    const knownRecordId = options?.baseRecordId ?? supabaseRecord.baseRecordId ?? null;

    if (knownRecordId) {
      // 已知 recordId：直接更新
      await updateMeetingRecordFields(config, knownRecordId, fields);
      logFeishuMonitor('info', 'base_sync_updated', {
        userId: config.userId,
        integrationId: config.integrationId,
        meetingRecordId: supabaseRecord.id,
        baseRecordId: knownRecordId,
        durationMs: Date.now() - startedAt,
      });
      return knownRecordId;
    }

    // 没有 recordId：按 meetingId 查找，存在则更新，否则创建
    const existing = await findMeetingRecordByMeetingId(config, supabaseRecord.feishuMeetingId);
    if (existing) {
      await updateMeetingRecordFields(config, existing.recordId, fields);
      logFeishuMonitor('info', 'base_sync_updated_by_lookup', {
        userId: config.userId,
        integrationId: config.integrationId,
        meetingRecordId: supabaseRecord.id,
        baseRecordId: existing.recordId,
        durationMs: Date.now() - startedAt,
      });
      return existing.recordId;
    }

    const created = await createMeetingRecord(config, fields);
    logFeishuMonitor('info', 'base_sync_created', {
      userId: config.userId,
      integrationId: config.integrationId,
      meetingRecordId: supabaseRecord.id,
      baseRecordId: created.recordId,
      durationMs: Date.now() - startedAt,
    });
    return created.recordId;
  } catch (error) {
    const mapped = error instanceof FeishuOpenApiError ? error : (error instanceof Error ? error : new Error(String(error)));
    logFeishuMonitor('error', 'base_sync_failed', {
      userId: config.userId,
      integrationId: config.integrationId,
      meetingRecordId: supabaseRecord.id,
      meetingId: supabaseRecord.feishuMeetingId,
      durationMs: Date.now() - startedAt,
      ...toErrorContext(mapped),
    });
    throw mapped;
  }
}

/**
 * 仅同步指定字段到 Base（轻量更新，不替换整条记录）
 *
 * 用于 incremental update 场景：例如 transcript 写入后只想更新「会议文字稿」和「处理状态」。
 */
export async function syncPartialFieldsToBase(
  config: FeishuBitableAccess,
  baseRecordId: string,
  partialFields: Record<string, unknown>
): Promise<void> {
  const startedAt = Date.now();
  try {
    await updateMeetingRecordFields(config, baseRecordId, partialFields);
    logFeishuMonitor('info', 'base_partial_sync_succeeded', {
      userId: config.userId,
      integrationId: config.integrationId,
      baseRecordId,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const mapped = error instanceof FeishuOpenApiError ? error : (error instanceof Error ? error : new Error(String(error)));
    logFeishuMonitor('error', 'base_partial_sync_failed', {
      userId: config.userId,
      integrationId: config.integrationId,
      baseRecordId,
      durationMs: Date.now() - startedAt,
      ...toErrorContext(mapped),
    });
    throw mapped;
  }
}
