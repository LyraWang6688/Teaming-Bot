/**
 * 宿主报告接收接口。
 *
 * ## 用途
 *
 * AI 宿主（豆包工作 / WorkBuddy）在**本机**完成取数与调 MCP 分析后，
 * 把报告回传到服务器，换一个**带图表的网页报告页**链接。
 *
 * 为什么需要它：报告页（四象限图 + 语义互动网络图 + PDF 导出）在服务器上，
 * 飞书云文档只有纯文本，**复现不了那两张图**。所以卡片按钮的正解是服务器报告页，
 * 飞书文档只当兜底。
 *
 * ## 契约（由 teaming-mcp 的 src/publish.mjs 定义，勿单方面改动）
 *
 * ```
 * POST /api/host/v1/reports
 * Authorization: Bearer <HOST_API_TOKEN>
 * {
 *   "meetingTitle": "...",
 *   "meetingStartedAt": "2026-09-22 11:36",   // 可空
 *   "feishuMeetingId": "7688...",              // 可空
 *   "analysisResult": { ...完整 AnalysisResult... },
 *   "transcript": "...",                        // 可空
 *   "clientRequestId": "...",                   // 幂等键（当前仅记录）
 *   "integrationId": "..."                      // 可空，覆盖默认归属
 * }
 * → 200 { "reportPublicId": "uuid", "reportUrl": "https://.../report/v2/uuid" }
 * ```
 *
 * ## 归属：当前是临时方案，产品化前必须替换
 *
 * `meeting_records` 的 `userId` / `integrationId` 都是 NOT NULL，所以一次上传
 * 必须挂到某个集成上。目前取 `body.integrationId`，缺省回落到
 * `HOST_REPORT_INTEGRATION_ID`。
 *
 * **这意味着：任何持有 token 的调用方都能写入任意集成，服务器无法验证
 * "这份报告真的属于谁"。** 自用阶段（token 只在自己机器上、只连自己的账号）
 * 可以接受；面向真实用户前必须换成可验证的绑定机制（见本篇末尾 TODO）。
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

import { getFeishuIntegrationContextById } from '@/lib/feishu/integration/integrationStore';
import { authorizeHostRequest } from '@/lib/host/hostAuth';
import { touchHostCredential } from '@/lib/host/hostEnrollmentStore';
import { logFeishuMonitor, toErrorContext } from '@/lib/feishu/common/monitor';
import {
  MEETING_REPORT_SCHEMA_VERSION,
  persistMeetingReport,
  updateMeetingRecordTranscript,
  upsertMeetingRecord,
} from '@/lib/reports/meetingReportStore';
import { buildPersistentReportUrl } from '@/lib/reports/reportUrl';
import type { AnalysisResult } from '@/types';

const ROUTE = '/api/host/v1/reports';

function fail(status: number, error: string, hint?: string) {
  return NextResponse.json({ ok: false, error, ...(hint ? { hint } : {}) }, { status });
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  // 鉴权两级：优先「接入码兑换的每用户凭证」，回落全局 HOST_API_TOKEN（自用路径）
  const auth = await authorizeHostRequest(request);
  if (!auth.ok) {
    logFeishuMonitor('warn', 'host_report_unauthorized', { route: ROUTE });
    return fail(auth.status, auth.error, auth.hint);
  }
  if (auth.credential) {
    // 记录"谁在用"，用于排查；写失败不影响上传
    void touchHostCredential(auth.credential.credentialId);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, '请求体不是合法 JSON。');
  }

  const analysisResult = body.analysisResult as AnalysisResult | undefined;
  if (!analysisResult || typeof analysisResult !== 'object') {
    return fail(400, '缺少 analysisResult。', '请传完整的分析结果对象。');
  }

  const meetingTitle = typeof body.meetingTitle === 'string' ? body.meetingTitle.trim() : '';
  const feishuMeetingId = typeof body.feishuMeetingId === 'string' ? body.feishuMeetingId.trim() : '';
  const transcript = typeof body.transcript === 'string' && body.transcript.trim() ? body.transcript : null;

  // 归属由凭证决定——调用方**不能**自己指定（否则任何人填别人的集成就能写数据）
  const integrationId = auth.integrationId;

  const integration = await getFeishuIntegrationContextById(integrationId);
  if (!integration) {
    return fail(404, `集成不存在：${integrationId}`);
  }

  // 宿主不一定有会议 ID；没有就用报告内容哈希造一个稳定标识，
  // 保证同一份报告重复上传会命中同一条记录（幂等），而不是每次新增。
  const meetingId = feishuMeetingId || `host-${createHash('sha256')
    .update(String(body.clientRequestId || ''))
    .update(meetingTitle)
    .update(JSON.stringify(analysisResult.teamState || {}))
    .digest('hex')
    .slice(0, 24)}`;

  try {
    const details = {
      meetingId,
      topic: meetingTitle || null,
      organizerOpenId: null,
      hostOpenId: null,
    };
    const record = await upsertMeetingRecord({ integration, meetingId, details });

    // 逐字稿先写：updateMeetingRecordTranscript 会把 status 置为 analyzing，
    // 必须在 persistMeetingReport（置 completed）之前。没传就不动已有逐字稿。
    if (transcript) {
      await updateMeetingRecordTranscript(record.id, transcript);
    }

    const reportUrl = buildPersistentReportUrl(record.reportPublicId, MEETING_REPORT_SCHEMA_VERSION);
    await persistMeetingReport({
      meetingRecordId: record.id,
      analysis: analysisResult,
      reportUrl,
    });

    logFeishuMonitor('info', 'host_report_received', {
      route: ROUTE,
      integrationId: integration.id,
      meetingId,
      reportPublicId: record.reportPublicId,
      hasTranscript: Boolean(transcript),
      credentialSource: auth.source,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ok: true,
      reportPublicId: record.reportPublicId,
      reportUrl,
    });
  } catch (error) {
    logFeishuMonitor('error', 'host_report_failed', {
      route: ROUTE,
      integrationId: integration.id,
      meetingId,
      ...toErrorContext(error),
    });
    return fail(500, '报告落库失败。', '请查看服务端日志。');
  }
}
