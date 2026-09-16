/**
 * 获取会议记录 API
 * 根据 recordId 从 Supabase 获取会议记录详情
 */

import { NextRequest, NextResponse } from 'next/server';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getMeetingRecordByLegacyReference } from '@/lib/reports/meetingReportStore';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const recordId = searchParams.get('recordId');
    const integrationId = searchParams.get('integrationId');
    const orgTargetId = searchParams.get('orgTargetId');

    if (!recordId) {
      return NextResponse.json({ error: '缺少 recordId 参数' }, { status: 400 });
    }

    if (!integrationId) {
      return NextResponse.json(
        { error: '缺少 integrationId 参数，无法定位对应租户的飞书集成。' },
        { status: 400 }
      );
    }

    if (!orgTargetId) {
      return NextResponse.json(
        { error: '缺少 orgTargetId 参数，无法定位对应组织。' },
        { status: 400 }
      );
    }

    const persisted = await getMeetingRecordByLegacyReference(integrationId, recordId);
    if (persisted?.analysisResult) {
      logRuntimeMonitor('info', 'feishu_record_api', 'legacy_report_loaded_from_database', {
        recordId,
        integrationId,
        orgTargetId,
        reportPublicId: persisted.reportPublicId,
        meetingRecordId: persisted.id,
      });
      return NextResponse.json({
        success: true,
        data: {
          recordId,
          meetingId: persisted.feishuMeetingId,
          processStatus: persisted.status,
          summary: persisted.analysisSummary,
          reportUrl: persisted.reportUrl,
          analysisData: persisted.analysisResult,
          analysisSchemaVersion: persisted.analysisSchemaVersion,
          reportPublicId: persisted.reportPublicId,
        },
      });
    }

    logRuntimeMonitor('info', 'feishu_record_api', 'report_not_ready', {
      recordId,
      integrationId,
      orgTargetId,
      meetingRecordId: persisted?.id,
      status: persisted?.status,
    });

    return NextResponse.json({
      success: false,
      data: {
        recordId,
        meetingId: persisted?.feishuMeetingId,
        processStatus: persisted?.status || 'pending',
        message: '会议分析尚未完成，请稍后重试。',
      },
    });
  } catch (error: unknown) {
    const { searchParams } = new URL(request.url);
    logRuntimeMonitor('error', 'feishu_record_api', 'record_get_failed', {
      recordId: searchParams.get('recordId'),
      integrationId: searchParams.get('integrationId'),
      orgTargetId: searchParams.get('orgTargetId'),
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取记录失败' },
      { status: 500 }
    );
  }
}
