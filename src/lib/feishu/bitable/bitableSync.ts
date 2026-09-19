/**
 * Base 字段映射与落表原语
 *
 * 解耦后本文件不再包含任何「主链路阶段」语义，只做两件事：
 * 1. mapSupabaseRowToBusinessFields：meeting_records 行 → 业务 key -> 值
 * 2. persistResolvedFieldsToBase：已解析的「当前字段名 -> 值」单次写入
 *    （已知 recordId 更新；否则按会议ID查找；找不到创建）
 *
 * 编排（绑定解析、blocked/partial 判定、重试、租约、版本对账）在
 * delivery/baseSyncProcessor.ts 中完成。
 */
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
  resolveFieldName,
} from './fieldBinding';

/**
 * 将 Supabase 的英文 status 映射为 Base 「处理状态」字段的中文值。
 *
 * Base 只展示终态：
 * - 已完成：Supabase status='completed'
 * - 分析失败：Supabase status='failed'（LLM 分析未成功）
 *
 * 中间态（meeting_ended/fetching_transcript/analyzing/gated_skipped）
 * 只保留在 Supabase，不写入 Base，符合「Supabase 是真相源，Base 是展示镜像」原则。
 */
export function mapSupabaseStatusToBaseTerminalStatus(
  supabaseStatus: string | null
): string | null {
  if (supabaseStatus === 'completed') return FEISHU_PROCESS_STATUS.completed;
  if (supabaseStatus === 'failed') return FEISHU_PROCESS_STATUS.failed;
  return null;
}

/**
 * 将 Supabase 的 analysis_zone 枚举值映射为 Base「团队氛围」单选字段的中文标签。
 *
 * Zone 由 V2 引擎代码推导（decision.ts deriveZone），永远是 5 个枚举值之一。
 * Base「团队氛围」是单选字段，已在飞书 Base 界面手动配置好 5 个选项：
 * 学习区 / 舒适区 / 焦虑区 / 冷漠区 / 证据不足
 */
export function mapAnalysisZoneToBaseStatus(zone: string | null): string | null {
  if (!zone) return null;
  const zoneLabelMap: Record<string, string> = {
    Learning: '学习区',
    Comfort: '舒适区',
    Anxiety: '焦虑区',
    Apathy: '冷漠区',
    'Difficult to Judge': '证据不足',
  };
  return zoneLabelMap[zone] ?? null;
}

/**
 * 业务字段映射：从 Supabase meeting_records 行映射为「业务 key -> 值」
 *
 * 这里的 key 不直接等于任何一期 Base 的中文字段名；真实字段名由 fieldBinding
 * 在运行时按 field_id 解析（运营改名不影响写入）。
 *
 * 「会议owner」（creator）为文本类型：写入授权用户姓名，缺省回退 organizerOpenId。
 * 「会议分类」（meeting_category）直接镜像 analysis_result.metadata.meetingType
 * （LLM 生成的自由文本，含「混合型会议」「会议性质暂未判断」等占位值，原样写入）。
 */
export function mapSupabaseRowToBusinessFields(
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
  const creatorName = organizerName || row.organizerOpenId;
  if (creatorName) fields.creator = creatorName;

  // 处理状态：Base 只展示终态（已完成/分析失败），中间态只存 Supabase
  const baseProcessStatus = mapSupabaseStatusToBaseTerminalStatus(row.status);
  if (baseProcessStatus) fields.process_status = baseProcessStatus;

  if (row.transcript) fields.transcript = row.transcript;
  if (row.analysisSummary) fields.analysis_summary = row.analysisSummary;

  // 团队氛围：从 analysis_zone 枚举映射成中文单选标签
  const baseZoneStatus = mapAnalysisZoneToBaseStatus(row.analysisZone);
  if (baseZoneStatus) fields.zone = baseZoneStatus;

  // 报告链接：直接镜像 Supabase reportUrl 字段
  if (row.reportUrl) {
    fields.report_url = {
      text: '查看报告',
      link: row.reportUrl,
    };
  }

  if (row.lastErrorMessage) fields.error_info = row.lastErrorMessage;

  return fields;
}

export type PersistResult = {
  recordId: string;
  mode: 'updated' | 'updated_by_lookup' | 'created';
};

/**
 * 把已解析为真实字段名的 fields 落到 Base（单次写入）：
 * 已知 recordId 直接更新；否则按会议ID查找更新；都没有则创建。
 */
export async function persistResolvedFieldsToBase(
  config: FeishuBitableAccess,
  fields: Record<string, unknown>,
  knownRecordId: string | null,
  meetingId: string
): Promise<PersistResult> {
  if (knownRecordId) {
    await updateMeetingRecordFields(config, knownRecordId, fields);
    return { recordId: knownRecordId, mode: 'updated' };
  }

  const meetingIdFieldName = await resolveFieldName(config, 'meeting_id' as BusinessFieldKey);
  const existing = await findMeetingRecordByMeetingId(config, meetingId, meetingIdFieldName);
  if (existing) {
    await updateMeetingRecordFields(config, existing.recordId, fields);
    return { recordId: existing.recordId, mode: 'updated_by_lookup' };
  }

  const created = await createMeetingRecord(config, fields);
  return { recordId: created.recordId, mode: 'created' };
}
