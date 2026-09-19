import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { FeishuOpenApiError } from '../common/openapi';
import { FEISHU_PROCESS_STATUS } from '../pipeline/status';
import type { MeetingRecordRow } from '@/lib/db/schema';

import {
  createMeetingRecord,
  findMeetingRecordByMeetingId,
  type FeishuBitableAccess,
  updateMeetingRecordFields,
} from './bitableOpenApi';
import {
  type BusinessFieldEntries,
  type BusinessFieldKey,
  forceRefreshFieldBindings,
  isFieldNameNotFoundError,
  resolveBusinessFields,
  resolveFieldName,
} from './fieldBinding';

/**
 * 将 Supabase 的英文 status 映射为 Base 「处理状态」字段的中文值。
 *
 * Base 只展示终态：
 * - 已完成：Supabase status='completed'
 * - 分析失败：Supabase status='failed'（LLM 分析未成功）
 * - 写入失败：Supabase status='base_sync_failed'（LLM 分析成功但 Base 同步失败）
 *
 * 中间态（meeting_ended/fetching_transcript/analyzing/gated_skipped）
 * 只保留在 Supabase，不写入 Base，符合「Supabase 是真相源，Base 是展示镜像」原则。
 */
function mapSupabaseStatusToBaseTerminalStatus(supabaseStatus: string | null): string | null {
  if (supabaseStatus === 'completed') return FEISHU_PROCESS_STATUS.completed;            // '已完成'
  if (supabaseStatus === 'failed') return FEISHU_PROCESS_STATUS.failed;                  // '分析失败'
  if (supabaseStatus === 'base_sync_failed') return FEISHU_PROCESS_STATUS.baseSyncFailed;  // '写入失败'
  return null;
}

/**
 * 将 Supabase 的 analysis_zone 枚举值映射为 Base「团队氛围」单选字段的中文标签。
 *
 * Zone 由 V2 引擎代码推导（decision.ts deriveZone），永远是 5 个枚举值之一。
 * Base「团队氛围」是单选字段，已在飞书 Base 界面手动配置好 5 个选项：
 * 学习区 / 舒适区 / 焦虑区 / 冷漠区 / 证据不足
 */
function mapAnalysisZoneToBaseStatus(zone: string | null): string | null {
  if (!zone) return null;
  const zoneLabelMap: Record<string, string> = {
    'Learning': '学习区',
    'Comfort': '舒适区',
    'Anxiety': '焦虑区',
    'Apathy': '冷漠区',
    'Difficult to Judge': '证据不足',
  };
  return zoneLabelMap[zone] ?? null;
}

/**
 * 业务字段映射：从 Supabase meeting_records 行映射为「业务 key -> 值」
 *
 * 这里的 key 不直接等于任何一期 Base 的中文字段名；真实字段名由 fieldBinding
 * 在运行时按 field_id 解析（运营改名不影响写入）。新增 Base 字段时：
 * 1. 在 fieldBinding.BASE_BUSINESS_FIELD_SPECS 登记业务 key 与约定字段名
 * 2. 在这里补一个赋值
 *
 * 「会议owner」（creator）为文本类型：写入 authorized_user_name（飞书授权用户姓名），
 * 缺省时回退到 organizerOpenId 字符串。不使用人员字段格式 [{id}]，
 * 因为平台级独立 Base 应用无法解析集成应用的 open_id。
 *
 * 「会议分类」（meeting_category）直接镜像 analysis_result.metadata.meetingType
 * （LLM 生成的自由文本，含「混合型会议」「会议性质暂未判断」等占位值，按业务确认原样写入）。
 */
function mapSupabaseRowToBusinessFields(
  row: MeetingRecordRow,
  options?: { orgName?: string | null; organizerName?: string | null }
): BusinessFieldEntries {
  const { orgName, organizerName } = options ?? {};
  const fields: BusinessFieldEntries = {};

  if (row.feishuMeetingId) fields.meeting_id = row.feishuMeetingId;
  if (row.topic) fields.meeting_name = row.topic;

  const meetingType = row.analysisResult?.metadata?.meetingType;
  if (meetingType) fields.meeting_category = meetingType;

  // direction = 初始化配置时选择的方向（orgTarget.orgName），必须是 Base 已配置的单选选项
  if (orgName) fields.direction = orgName;

  // creator = 会议创建人姓名（文本类型字段「会议owner」）
  // 门槛通过场景下 organizerOpenId = authorizedOpenId，姓名来自 feishu_authorizations
  const creatorName = organizerName || row.organizerOpenId;
  if (creatorName) fields.creator = creatorName;

  // 处理状态：Base 只展示终态（已完成/分析失败/写入失败），中间态只存 Supabase
  const baseProcessStatus = mapSupabaseStatusToBaseTerminalStatus(row.status);
  if (baseProcessStatus) fields.process_status = baseProcessStatus;

  if (row.transcript) fields.transcript = row.transcript;
  if (row.analysisSummary) fields.analysis_summary = row.analysisSummary;

  // 团队氛围：从 analysis_zone 枚举映射成中文单选标签
  const baseZoneStatus = mapAnalysisZoneToBaseStatus(row.analysisZone);
  if (baseZoneStatus) fields.zone = baseZoneStatus;

  // 报告链接：直接镜像 Supabase reportUrl 字段（已是 /report/v2/{uuid} 或 /report/{uuid}）
  // 不在这里重新生成 URL，避免 V1 报告被错误写成 V2 路径
  if (row.reportUrl) {
    fields.report_url = {
      text: '查看报告',
      link: row.reportUrl,
    };
  }

  if (row.lastErrorMessage) fields.error_info = row.lastErrorMessage;

  return fields;
}

type PersistResult = { recordId: string; mode: 'updated' | 'updated_by_lookup' | 'created' };

/**
 * 把已解析为真实字段名的 fields 落到 Base：
 * 已知 recordId 直接更新；否则按会议ID查找更新；都没有则创建。
 */
async function persistFieldsToBase(
  config: FeishuBitableAccess,
  fields: Record<string, unknown>,
  knownRecordId: string | null,
  meetingId: string
): Promise<PersistResult> {
  if (knownRecordId) {
    await updateMeetingRecordFields(config, knownRecordId, fields);
    return { recordId: knownRecordId, mode: 'updated' };
  }

  const meetingIdFieldName = await resolveFieldName(config, 'meeting_id');
  const existing = await findMeetingRecordByMeetingId(config, meetingId, meetingIdFieldName);
  if (existing) {
    await updateMeetingRecordFields(config, existing.recordId, fields);
    return { recordId: existing.recordId, mode: 'updated_by_lookup' };
  }

  const created = await createMeetingRecord(config, fields);
  return { recordId: created.recordId, mode: 'created' };
}

/**
 * 写入一层自愈：遇 1254045 FieldNameNotFound（运营改了字段名等）时，
 * 强制刷新 field_id→field_name 缓存后用最新字段名重试一次。
 */
async function writeWithFieldBindingRetry(
  config: FeishuBitableAccess,
  businessFields: BusinessFieldEntries,
  knownRecordId: string | null,
  meetingId: string
): Promise<PersistResult> {
  let resolvedFields = await resolveBusinessFields(config, businessFields);

  try {
    return await persistFieldsToBase(config, resolvedFields, knownRecordId, meetingId);
  } catch (error) {
    if (!isFieldNameNotFoundError(error)) throw error;

    logFeishuMonitor('warn', 'base_sync_field_name_not_found_refresh', {
      userId: config.userId,
      integrationId: config.integrationId,
      meetingId,
      ...toErrorContext(error instanceof Error ? error : new Error(String(error))),
    });

    await forceRefreshFieldBindings(config);
    resolvedFields = await resolveBusinessFields(config, businessFields);
    return persistFieldsToBase(config, resolvedFields, knownRecordId, meetingId);
  }
}

/**
 * 将 Supabase meeting_records 行同步到飞书多维表格
 *
 * 职责：
 * 1. 字段映射（Supabase 列 → 业务 key → field_id 解析出的当前字段名，集中在此处）
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
  const businessFields = mapSupabaseRowToBusinessFields(supabaseRecord, {
    orgName: options?.orgName ?? config.orgTarget?.orgName,
    organizerName: options?.organizerName,
  });
  if (Object.keys(businessFields).length === 0) {
    logFeishuMonitor('warn', 'base_sync_empty_fields', {
      userId: config.userId,
      integrationId: config.integrationId,
      meetingRecordId: supabaseRecord.id,
      durationMs: Date.now() - startedAt,
    });
    return options?.baseRecordId ?? supabaseRecord.baseRecordId ?? null;
  }

  const knownRecordId = options?.baseRecordId ?? supabaseRecord.baseRecordId ?? null;

  try {
    const result = await writeWithFieldBindingRetry(
      config,
      businessFields,
      knownRecordId,
      supabaseRecord.feishuMeetingId
    );
    logFeishuMonitor('info', `base_sync_${result.mode}`, {
      userId: config.userId,
      integrationId: config.integrationId,
      meetingRecordId: supabaseRecord.id,
      baseRecordId: result.recordId,
      durationMs: Date.now() - startedAt,
    });
    return result.recordId;
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
 * 仅同步指定业务字段到 Base（轻量更新，不替换整条记录）
 *
 * 入参是业务 key（如 transcript / creator），真实字段名由 fieldBinding 解析。
 * 用于 incremental update 场景：例如 transcript 写入后只更新「会议文字稿」和「会议owner」。
 */
export async function syncPartialFieldsToBase(
  config: FeishuBitableAccess,
  baseRecordId: string,
  partialBusinessFields: BusinessFieldEntries
): Promise<void> {
  const startedAt = Date.now();

  const update = (fields: Record<string, unknown>) =>
    updateMeetingRecordFields(config, baseRecordId, fields);

  try {
    let resolvedFields = await resolveBusinessFields(config, partialBusinessFields);

    try {
      await update(resolvedFields);
    } catch (error) {
      if (!isFieldNameNotFoundError(error)) throw error;

      logFeishuMonitor('warn', 'base_partial_sync_field_name_not_found_refresh', {
        userId: config.userId,
        integrationId: config.integrationId,
        baseRecordId,
        ...toErrorContext(error instanceof Error ? error : new Error(String(error))),
      });

      await forceRefreshFieldBindings(config);
      resolvedFields = await resolveBusinessFields(config, partialBusinessFields);
      await update(resolvedFields);
    }

    logFeishuMonitor('info', 'base_partial_sync_succeeded', {
      userId: config.userId,
      integrationId: config.integrationId,
      baseRecordId,
      keys: Object.keys(partialBusinessFields) as BusinessFieldKey[],
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
