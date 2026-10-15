/**
 * 宿主「直接分析」接口 —— 自动化通道（ADR-004）。
 *
 * ## 为什么需要它
 *
 * MCP（stdio）在普通对话里工作正常，但**豆包工作的定时任务 / 云电脑拿不到 MCP 工具**
 * （2026-10-15 实测：宿主原文「工具搜索无命中；直接调用返回 Tool not found」）。
 * 而同一个环境里 `Bash + curl` 是可用的（已从服务器 nginx 访问日志证实）。
 *
 * 所以给自动化补一条**不经过宿主工具集**的通道：宿主取好逐字稿，POST 过来分析。
 *
 * ## 与 /api/host/v1/reports 的分工
 *
 *   /reports   宿主**在本机**分析完，把结果回传换报告页  ← MCP 通道用
 *   /analyze   宿主把**逐字稿**发来，在**服务器**分析    ← Skill / curl 通道用 ★本文件
 *
 * ## 契约（与 ADR-004 第十六节一致）
 *
 * ```
 * POST /api/host/v1/analyze
 * Authorization: Bearer <host token>
 * {
 *   "transcript": "…妙记文字转录稿原文…",   // 必填
 *   "title": "…",                            // 可选，用于报告命名
 *   "meetingStartedAt": "2026-10-13 22:13",  // 可选
 *   "feishuMeetingId": "7688…",              // 可选，便于对账
 *   "clientRequestId": "…",                  // 可选，幂等键
 *   "includeAnalysis": true                  // 可选，连同完整分析结果一起返回（默认不带）
 * }
 * → 200 { ok, reportPublicId, reportUrl, zone, zoneLabel, reused, elapsedMs }
 * ```
 *
 * ## 幂等
 *
 * 幂等键 = 逐字稿内容 SHA-256（或用 clientRequestId）。命中已有报告时直接返回，
 * `reused: true`，**不调模型**。这是超时重试的安全网。
 *
 * ## 归属
 *
 * 由 host token 反查得到，**调用方不能指定**（否则任何人填别人的集成就能写数据）。
 * 项目（期数）由入队时按「当前活跃期」决定，方向留空交给运营侧。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

import { analyzeMeetingText } from '@/services/analysisService';
import { AbcGateError } from '@/lib/analysis/abcGate';
import { getFeishuIntegrationContextById } from '@/lib/feishu/integration/integrationStore';
import { authorizeHostRequest } from '@/lib/host/hostAuth';
import { touchHostCredential } from '@/lib/host/hostEnrollmentStore';
import { logFeishuMonitor, toErrorContext } from '@/lib/feishu/common/monitor';
import {
  MEETING_REPORT_SCHEMA_VERSION,
  getMeetingRecordById,
  getMeetingRecordByIntegrationAndMeeting,
  persistMeetingReport,
  updateMeetingRecordTranscript,
  upsertMeetingRecord,
} from '@/lib/reports/meetingReportStore';
import { buildPersistentReportUrl } from '@/lib/reports/reportUrl';
import { listActiveProjectOrgTargets } from '@/lib/feishu/projects/projectConfigStore';
import { enqueueBaseSyncTask } from '@/lib/feishu/delivery/baseSyncTaskStore';

const ROUTE = '/api/host/v1/analyze';

/** 分析可能跑 20~60 秒，宿主应把 HTTP 超时设到 120 秒。 */
export const maxDuration = 120;

function fail(
  status: number,
  type: string,
  code: string,
  message: string,
  hint?: string
) {
  return NextResponse.json(
    { ok: false, error: { type, code, message, ...(hint ? { hint } : {}) } },
    { status }
  );
}

/**
 * 把引擎抛出的普通 Error 映射成内部错误码。
 *
 * 引擎目前只抛带中文消息的 `Error`（没有 code），所以这里按消息特征归类。
 * **这是权宜之计**：理想形态是引擎抛带 code 的类型化错误；但引擎是网页版共用代码，
 * 改它要评估影响面，所以先在接口层做映射。归类错了也不会造成误判——
 * 三种情况都不会重试（都不是"重试就能好"的那类）。
 */
function classifyAnalysisError(error: unknown): { code: string; message: string; status: number } {
  const message = String((error as Error)?.message || error || '分析失败');

  // 用类型判断，不靠消息文本匹配——消息改一个字就会失效
  if (error instanceof AbcGateError) {
    return { code: 'not_abc_related', message, status: 400 };
  }
  if (message.includes('过短')) {
    return { code: 'transcript_too_short', message, status: 400 };
  }
  if (message.includes('发言者') || message.includes('听众')) {
    return { code: 'transcript_not_speaker_lines', message, status: 400 };
  }
  return { code: 'analysis_failed', message, status: 422 };
}

/**
 * 把报告登记进多维表格同步队列（归属后置）。
 *
 * 与 /reports 里的同名逻辑一致：项目 = 当前活跃期，方向留空，失败不影响接口返回。
 * 单独写一份而不是抽公共函数，是因为两处的"报告来源"和日志事件名不同；
 * 真正的共用逻辑在 baseSyncTaskStore，这里只是两行参数拼装。
 */
async function enqueueBaseSync(
  meetingRecordId: string,
  integration: { id: string; userId: string }
): Promise<void> {
  try {
    const { project, targets } = await listActiveProjectOrgTargets();
    const activeTarget = targets[0] ?? null;
    if (!project || !project.bitableAppToken || !project.bitableTableId || !activeTarget) {
      logFeishuMonitor('warn', 'host_analyze_base_sync_skipped', {
        route: ROUTE,
        meetingRecordId,
        reason: !project
          ? 'no_active_project'
          : !project.bitableAppToken || !project.bitableTableId
            ? 'project_missing_base'
            : 'no_org_target',
      });
      return;
    }

    const fresh = await getMeetingRecordById(meetingRecordId);
    await enqueueBaseSyncTask({
      meetingRecordId,
      integrationId: integration.id,
      userId: integration.userId,
      projectId: project.id,
      orgTargetId: activeTarget.id,
      orgName: null,
      appToken: project.bitableAppToken,
      tableId: project.bitableTableId,
      requestedVersion: fresh?.dataVersion ?? 1,
      skipDirection: true,
    });

    logFeishuMonitor('info', 'host_analyze_base_sync_enqueued', {
      route: ROUTE,
      meetingRecordId,
      projectId: project.id,
      projectKey: project.projectKey,
    });
  } catch (error) {
    logFeishuMonitor('error', 'host_analyze_base_sync_failed', {
      route: ROUTE,
      meetingRecordId,
      ...toErrorContext(error),
    });
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  // 鉴权：优先「接入码兑换的每用户凭证」，回落全局 HOST_API_TOKEN（自用路径）
  const auth = await authorizeHostRequest(request);
  if (!auth.ok) {
    logFeishuMonitor('warn', 'host_analyze_unauthorized', { route: ROUTE });
    return fail(auth.status, 'auth', 'unauthorized', auth.error, auth.hint);
  }
  if (auth.credential) {
    void touchHostCredential(auth.credential.credentialId);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, 'request', 'invalid_json', '请求体不是合法 JSON。');
  }

  const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
  if (!transcript) {
    return fail(
      400,
      'transcript',
      'transcript_missing',
      '缺少 transcript。',
      '请传妙记导出的文字转录稿原文；不接受 AI 摘要或会议纪要。'
    );
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const feishuMeetingId =
    typeof body.feishuMeetingId === 'string' ? body.feishuMeetingId.trim() : '';
  const clientRequestId =
    typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';

  /**
   * 是否在响应里带上**完整分析结果**（四部分全文）。
   *
   * 默认不带——绝大多数调用方（Skill、MCP-over-HTTP）只要 reportUrl，
   * 全文几十 KB，白传。
   *
   * 但 `teaming-mcp` 的 stdio 版需要它：那边要用分析结果渲染飞书云文档和摘要，
   * 而 2026-10-15 起它的引擎副本被删掉了（改为只调本接口），
   * 于是它必须从这里拿到全文。
   */
  const includeAnalysis = body.includeAnalysis === true;

  // 归属由凭证决定——调用方**不能**自己指定
  const integration = await getFeishuIntegrationContextById(auth.integrationId);
  if (!integration) {
    return fail(404, 'auth', 'integration_missing', `集成不存在：${auth.integrationId}`);
  }

  // 幂等键：显式 clientRequestId 优先，否则用逐字稿内容哈希。
  // 用内容哈希的好处：宿主超时重试时（它未必带 clientRequestId）也能命中。
  const contentHash = createHash('sha256')
    .update(clientRequestId || transcript)
    .digest('hex')
    .slice(0, 24);
  const meetingId = feishuMeetingId || `host-${contentHash}`;

  try {
    // ── 幂等命中：同一份稿已经分析过，直接返回，不调模型 ──
    const existing = await getMeetingRecordByIntegrationAndMeeting(integration.id, meetingId);
    if (existing?.analysisResult && existing.status === 'completed' && existing.reportPublicId) {
      logFeishuMonitor('info', 'host_analyze_reused', {
        route: ROUTE,
        integrationId: integration.id,
        meetingId,
        reportPublicId: existing.reportPublicId,
      });
      return NextResponse.json({
        ok: true,
        reused: true,
        reportPublicId: existing.reportPublicId,
        reportUrl: existing.reportUrl || buildPersistentReportUrl(existing.reportPublicId, MEETING_REPORT_SCHEMA_VERSION),
        zone: existing.analysisZone,
        zoneLabel: existing.analysisResult?.teamState?.zoneLabel ?? null,
        elapsedMs: Date.now() - startedAt,
        ...(includeAnalysis && existing.analysisResult
          ? { analysisResult: existing.analysisResult }
          : {}),
      });
    }

    // ── 分析（服务器引擎，与网页版完全同一套）──
    // 宿主通道启用 ABC 相关性甄别：用户会开很多种会，只有相关的那批才出报告
    const analysis = await analyzeMeetingText(transcript, { abcGate: true });

    const details = {
      meetingId,
      topic: title || null,
      organizerOpenId: null,
      hostOpenId: null,
    };
    const record = await upsertMeetingRecord({ integration, meetingId, details });

    // 逐字稿先写：它会把 status 置为 analyzing，必须在 persistMeetingReport（置 completed）之前
    await updateMeetingRecordTranscript(record.id, transcript);

    const reportUrl = buildPersistentReportUrl(
      record.reportPublicId,
      MEETING_REPORT_SCHEMA_VERSION
    );
    await persistMeetingReport({
      meetingRecordId: record.id,
      analysis,
      reportUrl,
    });

    // 归属后置：项目取当前活跃期，方向留空交给运营侧。失败不影响本次分析结果。
    await enqueueBaseSync(record.id, integration);

    logFeishuMonitor('info', 'host_analyze_completed', {
      route: ROUTE,
      integrationId: integration.id,
      meetingId,
      reportPublicId: record.reportPublicId,
      zone: analysis.teamState?.zone ?? null,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ok: true,
      reused: false,
      reportPublicId: record.reportPublicId,
      reportUrl,
      zone: analysis.teamState?.zone ?? null,
      zoneLabel: analysis.teamState?.zoneLabel ?? null,
      meetingType: analysis.metadata?.meetingType ?? null,
      durationLabel: analysis.metadata?.durationLabel ?? null,
      participantCount: analysis.metadata?.participantCount ?? null,
      elapsedMs: Date.now() - startedAt,
      ...(includeAnalysis ? { analysisResult: analysis } : {}),
    });
  } catch (error) {
    const mapped = classifyAnalysisError(error);
    logFeishuMonitor(mapped.status >= 500 ? 'error' : 'warn', 'host_analyze_failed', {
      route: ROUTE,
      integrationId: integration.id,
      meetingId,
      code: mapped.code,
      durationMs: Date.now() - startedAt,
      ...toErrorContext(error),
    });
    return fail(
      mapped.status,
      'transcript',
      mapped.code,
      mapped.message,
      mapped.status === 400
        ? '分析只认成员的原始发言（每行形如「姓名 时间 内容」）。请传妙记导出的文字转录稿，不要传 AI 摘要。'
        : undefined
    );
  }
}
