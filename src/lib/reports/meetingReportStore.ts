import { and, eq, sql } from 'drizzle-orm';
import type { AnalysisResult } from '@/types';
import { getDb } from '@/lib/db/client';
import {
  meetingRecords,
  type MeetingRecordRow,
} from '@/lib/db/schema';
import type { FeishuIntegrationContext } from '@/lib/feishu/integration/integrationStore';
import type { MeetingDetails } from '@/lib/feishu/meetings/meetingDetailsTypes';

export const MEETING_REPORT_SCHEMA_VERSION = 2;

type UpsertMeetingRecordInput = {
  integration: FeishuIntegrationContext;
  meetingId: string;
  minuteToken?: string | null;
  projectId?: string | null;
  orgTargetId?: string | null;
  baseRecordId?: string | null;
  details?: MeetingDetails | null;
};

type PersistMeetingReportInput = {
  meetingRecordId: string;
  analysis: AnalysisResult;
  reportUrl: string;
};

function meetingDetailsFields(details?: MeetingDetails | null) {
  if (!details) {
    return {};
  }

  return {
    organizerOpenId: details.organizerOpenId,
  };
}

export async function getMeetingRecordByIntegrationAndMeeting(
  integrationId: string,
  meetingId: string
): Promise<MeetingRecordRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(meetingRecords)
    .where(
      and(
        eq(meetingRecords.integrationId, integrationId),
        eq(meetingRecords.feishuMeetingId, meetingId)
      )
    )
    .limit(1);

  return row || null;
}

export async function getMeetingRecordByLegacyReference(
  integrationId: string,
  baseRecordId: string
): Promise<MeetingRecordRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(meetingRecords)
    .where(
      and(
        eq(meetingRecords.integrationId, integrationId),
        eq(meetingRecords.baseRecordId, baseRecordId)
      )
    )
    .limit(1);

  return row || null;
}

export async function getMeetingRecordById(
  meetingRecordId: string
): Promise<MeetingRecordRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(meetingRecords)
    .where(eq(meetingRecords.id, meetingRecordId))
    .limit(1);

  return row || null;
}

/**
 * 绑定报告通知接收人（建通知任务前调用）。
 * - 首次绑定：写入 app_id + open_id + 来源 + verified_at
 * - 已绑定且相同：刷新 verified_at
 * - 已绑定但不同：不覆盖（blocked 不换人原则），返回 false 由上层置任务 blocked
 */
export async function bindMeetingRecordRecipient(
  meetingRecordId: string,
  recipient: { appId: string; openId: string; source: string }
): Promise<{ bound: boolean; current: { appId: string | null; openId: string | null } }> {
  const db = getDb();
  const [existing] = await db
    .select({
      recipientAppId: meetingRecords.recipientAppId,
      recipientOpenId: meetingRecords.recipientOpenId,
    })
    .from(meetingRecords)
    .where(eq(meetingRecords.id, meetingRecordId))
    .limit(1);

  if (!existing) {
    return { bound: false, current: { appId: null, openId: null } };
  }

  if (existing.recipientAppId && existing.recipientOpenId) {
    const same =
      existing.recipientAppId === recipient.appId &&
      existing.recipientOpenId === recipient.openId;
    if (same) {
      await db
        .update(meetingRecords)
        .set({ recipientVerifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(meetingRecords.id, meetingRecordId));
    }
    return {
      bound: same,
      current: { appId: existing.recipientAppId, openId: existing.recipientOpenId },
    };
  }

  await db
    .update(meetingRecords)
    .set({
      recipientAppId: recipient.appId,
      recipientOpenId: recipient.openId,
      recipientSource: recipient.source,
      recipientVerifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(meetingRecords.id, meetingRecordId));

  return {
    bound: true,
    current: { appId: recipient.appId, openId: recipient.openId },
  };
}

export async function getMeetingReportByPublicId(
  reportPublicId: string
): Promise<MeetingRecordRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(meetingRecords)
    .where(eq(meetingRecords.reportPublicId, reportPublicId))
    .limit(1);

  return row || null;
}

export async function upsertMeetingRecord(
  input: UpsertMeetingRecordInput
): Promise<MeetingRecordRow> {
  const db = getDb();
  const detailsFields = meetingDetailsFields(input.details);
  const updateFields = {
    userId: input.integration.userId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.orgTargetId ? { orgTargetId: input.orgTargetId } : {}),
    ...(input.baseRecordId ? { baseRecordId: input.baseRecordId } : {}),
    ...(input.minuteToken ? { minuteToken: input.minuteToken } : {}),
    topic: input.details?.topic ?? null,
    ...detailsFields,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(meetingRecords)
    .values({
      userId: input.integration.userId,
      integrationId: input.integration.id,
      projectId: input.projectId || null,
      orgTargetId: input.orgTargetId || null,
      baseRecordId: input.baseRecordId || null,
      feishuMeetingId: input.meetingId,
      minuteToken: input.minuteToken || null,
      status: 'meeting_ended',
      topic: input.details?.topic ?? null,
      ...detailsFields,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [meetingRecords.integrationId, meetingRecords.feishuMeetingId],
      set: updateFields,
    })
    .returning();

  if (!row) {
    throw new Error('创建或更新会议持久化记录失败。');
  }
  return row;
}

export async function updateMeetingRecordBaseReference(
  meetingRecordId: string,
  baseRecordId: string
): Promise<void> {
  const db = getDb();
  await db
    .update(meetingRecords)
    .set({
      baseRecordId,
      updatedAt: new Date(),
    })
    .where(eq(meetingRecords.id, meetingRecordId));
}

export async function updateMeetingRecordStatus(
  meetingRecordId: string,
  input: {
    status: string;
    transcriptStoredAt?: Date | null;
    errorType?: string | null;
    errorMessage?: string | null;
  }
): Promise<void> {
  const db = getDb();
  await db
    .update(meetingRecords)
    .set({
      status: input.status,
      transcriptStoredAt: input.transcriptStoredAt,
      lastErrorType: input.errorType,
      lastErrorMessage: input.errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(meetingRecords.id, meetingRecordId));
}

/**
 * 更新会议记录的转写稿字段
 *
 * Supabase 作为转写稿的唯一真相源，Base 同步从 Supabase 读取。
 * 返回更新后的完整行，供调用方同步到 Base。
 */
export async function updateMeetingRecordTranscript(
  meetingRecordId: string,
  transcript: string
): Promise<MeetingRecordRow> {
  const db = getDb();
  const [row] = await db
    .update(meetingRecords)
    .set({
      transcript,
      transcriptStoredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(meetingRecords.id, meetingRecordId))
    .returning();

  if (!row) {
    throw new Error('更新会议转写稿失败：会议记录不存在。');
  }
  return row;
}

export async function persistMeetingReport(
  input: PersistMeetingReportInput
): Promise<MeetingRecordRow> {
  const db = getDb();
  const now = new Date();

  // 版本推进：
  // - data_version：每次报告持久化（含恢复重放）+1，作为 Base 镜像的目标版本
  // - report_revision：仅在分析内容实际变化时 +1，作为通知幂等键的一部分
  const [current] = await db
    .select({
      analysisResult: meetingRecords.analysisResult,
    })
    .from(meetingRecords)
    .where(eq(meetingRecords.id, input.meetingRecordId))
    .limit(1);

  const analysisChanged =
    !current?.analysisResult ||
    JSON.stringify(current.analysisResult) !== JSON.stringify(input.analysis);

  const [row] = await db
    .update(meetingRecords)
    .set({
      status: 'completed',
      analysisResult: input.analysis,
      analysisSchemaVersion: MEETING_REPORT_SCHEMA_VERSION,
      dataVersion: sql`${meetingRecords.dataVersion} + 1`,
      ...(analysisChanged
        ? { reportRevision: sql`${meetingRecords.reportRevision} + 1` }
        : {}),
      // 分析摘要：读 teamState.analysis（LLM 第 2 次生成的 100-180 字）
      // V2 引擎下 teamState.analysis 永远有值（主路径 LLM 生成，basic_fallback 硬编码兜底）
      analysisSummary: input.analysis.teamState?.analysis,
      // 会议状态：从 teamState.zone 提取枚举值（Learning/Comfort/Anxiety/Apathy/Difficult to Judge）
      // Base 同步时由 bitableSync.ts 映射成中文单选标签
      analysisZone: input.analysis.teamState?.zone ?? null,
      reportUrl: input.reportUrl,
      analyzedAt: now,
      completedAt: now,
      lastErrorType: null,
      lastErrorMessage: null,
      updatedAt: now,
    })
    .where(eq(meetingRecords.id, input.meetingRecordId))
    .returning();

  if (!row) {
    throw new Error('持久化会议报告失败：会议记录不存在。');
  }
  return row;
}
