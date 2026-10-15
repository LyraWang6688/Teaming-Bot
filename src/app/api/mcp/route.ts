/**
 * MCP over HTTP —— 让宿主不必安装任何东西就能用这套工具。
 *
 * ## 为什么要它（2026-10-15 决定）
 *
 * stdio 版的 MCP 要求用户在**自己电脑上**装 npm 包、配连接器。对非技术用户偏重。
 * 而宿主里能填一个 URL 的现在越来越多（Claude Desktop 等已支持远程 MCP）。
 * 有了远程端点，用户只要**一个 URL + 一个接入码**。
 *
 * ## 与另外两个入口的关系
 *
 * 三个入口并行，按宿主能力选，**调的是同一套服务器能力**：
 *
 *   · MCP / stdio  → 本地分析（逐字稿不出本机），需要装包
 *   · MCP / HTTP   → 服务器分析，只要 URL        ★本文件
 *   · Skill / curl → 服务器分析，只要 bash+curl
 *
 * ## 暴露哪些工具
 *
 * **只暴露服务器能独立完成的**。需要用户本机飞书能力的（`list_meetings` /
 * `analyze_meeting`）不在这里提供——按 ADR-003，取数本来就该由宿主用
 * **自己的**飞书身份做，服务器只做分析。
 *
 *   teaming_doctor              服务状态 + 这个 token 的归属
 *   teaming_analyze_transcript  传逐字稿，在服务器分析
 *   teaming_read_report         读某场会已生成的报告摘要
 *   teaming_report_card         生成统一格式的卡片 JSON（不发送）
 *
 * ## 协议
 *
 * MCP streamable HTTP：
 *   · 单端点 `POST /api/mcp`，JSON-RPC 2.0
 *   · `Accept` 允许 `application/json` —— 本实现一律用 JSON 响应，
 *     不启用 SSE：所有工具都在请求内跑完，没有服务端推送需求。
 *   · **无状态**：不签发 `Mcp-Session-Id`。规范允许无状态服务端；
 *     不引入 session 就少一类状态、少一类 bug。宿主每次请求都带 Bearer。
 *
 * ## 认证
 *
 * 与 `/api/host/v1/*` 同一套：`Authorization: Bearer <host token>`。
 * 归属由 token 决定，调用方不能指定——见 hostAuth 的说明。
 */
import { NextRequest, NextResponse } from 'next/server';

import { analyzeMeetingText } from '@/services/analysisService';
import { authorizeHostRequest } from '@/lib/host/hostAuth';
import { touchHostCredential } from '@/lib/host/hostEnrollmentStore';
import { getFeishuIntegrationContextById } from '@/lib/feishu/integration/integrationStore';
import { logFeishuMonitor, toErrorContext } from '@/lib/feishu/common/monitor';
import {
  getMeetingRecordByIntegrationAndMeeting,
  persistMeetingReport,
  updateMeetingRecordTranscript,
  upsertMeetingRecord,
} from '@/lib/reports/meetingReportStore';
import { buildPersistentReportUrl } from '@/lib/reports/reportUrl';
import { MEETING_REPORT_SCHEMA_VERSION } from '@/lib/reports/meetingReportStore';
import { listActiveProjectOrgTargets } from '@/lib/feishu/projects/projectConfigStore';
import { enqueueBaseSyncTask } from '@/lib/feishu/delivery/baseSyncTaskStore';
import { AbcGateError } from '@/lib/analysis/abcGate';
import { createHash } from 'node:crypto';

const ROUTE = '/api/mcp';

/** 协议版本：客户端传什么就回什么，未传则用这个 */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'teaming', version: '0.2.0' };

/** 分析可能跑 20~90 秒 */
export const maxDuration = 120;

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> };

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}
/** 工具执行结果：MCP 约定 content 是数组，文本放在 text 里 */
function toolText(id: JsonRpcId, text: string, isError = false) {
  return rpcResult(id, { content: [{ type: 'text', text }], isError });
}

const TOOLS = [
  {
    name: 'teaming_doctor',
    description:
      '体检：这个接入码是否可用、归属到哪个集成、服务器能否分析。'
      + '排查"为什么调不通"时先跑它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'teaming_analyze_transcript',
    description:
      '**由你（宿主）提供逐字稿**，服务器做团队动力分析并生成报告页。'
      + '本工具不碰飞书——取数请用你自己的飞书能力。'
      + '什么时候用：你已经导出了妙记的文字转录稿，要出四部分分析报告。'
      + '注意：不接受 AI 摘要或会议纪要，只认成员原始发言。',
    inputSchema: {
      type: 'object',
      properties: {
        transcript: { type: 'string', description: '妙记导出的文字转录稿原文' },
        title: { type: 'string', description: '会议标题（可选，用于报告命名）' },
        feishuMeetingId: {
          type: 'string',
          description: '这场会的 meeting_id 或 minute_token。**强烈建议传**：它是幂等键，'
            + '不传就只能用逐字稿哈希，而同一场会每次导出的文本常有细微差异，会被当成两场。',
        },
      },
      required: ['transcript'],
      additionalProperties: false,
    },
  },
  {
    name: 'teaming_read_report',
    description:
      '读某场会已经生成的报告摘要（四部分结论）。用于"上次那场会结论是什么"。'
      + '需要 feishuMeetingId；报告页链接也一并返回。',
    inputSchema: {
      type: 'object',
      properties: {
        feishuMeetingId: { type: 'string', description: '这场会的 meeting_id 或 minute_token' },
      },
      required: ['feishuMeetingId'],
      additionalProperties: false,
    },
  },
  {
    name: 'teaming_report_card',
    description:
      '取一份报告的**飞书交互卡片 JSON**——本产品统一的消息卡片样式。'
      + '**本工具不发送任何消息**，只把卡片交给你，由你用**自己的**飞书能力投递。'
      + '卡片样式固定（蓝色标题栏 + 一行会议名称 + 一个按钮），不要自己设计。',
    inputSchema: {
      type: 'object',
      properties: {
        feishuMeetingId: { type: 'string', description: '这场会的 meeting_id 或 minute_token' },
      },
      required: ['feishuMeetingId'],
      additionalProperties: false,
    },
  },
];

/** 与 stdio 版一致的卡片构造：三样东西，多一个都不要 */
function buildReportCard(meetingTitle: string, reportUrl: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '小组会议动力分析报告 已出炉' },
    },
    elements: [
      { tag: 'markdown', content: `**会议名称：**${meetingTitle}` },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '点击查看报告' },
            url: reportUrl,
          },
        ],
      },
    ],
  };
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  // ── 认证：与 /api/host/v1/* 同一套 host token ──
  const auth = await authorizeHostRequest(request);
  if (!auth.ok) {
    return NextResponse.json(
      rpcError(null, -32001, auth.error),
      { status: auth.status },
    );
  }
  if (auth.credential) void touchHostCredential(auth.credential.credentialId);

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return NextResponse.json(rpcError(null, -32700, '请求体不是合法 JSON'));
  }

  const id = body.id ?? null;
  const method = body.method ?? '';
  const params = body.params ?? {};

  // ── 通知：按规范不返回响应体 ──
  if (method.startsWith('notifications/')) {
    return new NextResponse(null, { status: 202 });
  }

  try {
    // ── 握手 ──
    if (method === 'initialize') {
      const clientProtocol = String((params as { protocolVersion?: unknown }).protocolVersion || '');
      return NextResponse.json(
        rpcResult(id, {
          protocolVersion: clientProtocol || DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: [
            '本服务对已结束的飞书会议做团队动力分析，产出四部分报告。',
            '它是**远程**服务：不碰你的飞书，取数请用你自己的飞书能力导出妙记逐字稿，',
            '再调 teaming_analyze_transcript。',
            '需要飞书会议列表或妙记导出时，用宿主自己的 lark 能力，不要指望这里。',
          ].join('\n'),
        }),
      );
    }

    if (method === 'tools/list') {
      return NextResponse.json(rpcResult(id, { tools: TOOLS }));
    }

    if (method === 'ping') {
      return NextResponse.json(rpcResult(id, {}));
    }

    if (method === 'tools/call') {
      const name = String((params as { name?: unknown }).name || '');
      const args = ((params as { arguments?: unknown }).arguments ?? {}) as Record<string, unknown>;
      return await callTool(id, name, args, auth.integrationId);
    }

    return NextResponse.json(rpcError(id, -32601, `不支持的方法：${method}`));
  } catch (error) {
    logFeishuMonitor('error', 'mcp_http_request_failed', {
      route: ROUTE,
      method,
      durationMs: Date.now() - startedAt,
      ...toErrorContext(error),
    });
    return NextResponse.json(rpcError(id, -32603, `服务器内部错误：${String((error as Error)?.message || error)}`));
  }
}

/** 工具调用 */
async function callTool(
  id: JsonRpcId,
  name: string,
  args: Record<string, unknown>,
  integrationId: string,
): Promise<NextResponse> {
  const integration = await getFeishuIntegrationContextById(integrationId);
  if (!integration) {
    return NextResponse.json(toolText(id, `集成不存在：${integrationId}`, true));
  }

  // ── 体检 ──
  if (name === 'teaming_doctor') {
    const info = {
      ready: true,
      identity: 'host_token',
      integration_id: integration.id,
      integration_name: integration.name ?? null,
      project_id: integration.projectId ?? null,
      endpoints: {
        analyze: 'POST /api/host/v1/analyze',
        mcp: 'POST /api/mcp',
      },
      hint: '取数请用你自己的飞书能力；本服务只做分析与报告。',
    };
    return NextResponse.json(toolText(id, JSON.stringify(info, null, 2)));
  }

  const meetingId = typeof args.feishuMeetingId === 'string' ? args.feishuMeetingId.trim() : '';

  // ── 读报告 / 取卡片 ──
  if (name === 'teaming_read_report' || name === 'teaming_report_card') {
    if (!meetingId) {
      return NextResponse.json(
        toolText(id, '缺少 feishuMeetingId。请传这场会的 meeting_id 或 minute_token。', true),
      );
    }
    const found = await getMeetingRecordByIntegrationAndMeeting(integration.id, meetingId);
    if (!found || !found.reportPublicId) {
      return NextResponse.json(
        toolText(id, `这场会还没有报告：${meetingId}。请先用 teaming_analyze_transcript 生成。`, true),
      );
    }
    const reportUrl =
      found.reportUrl || buildPersistentReportUrl(found.reportPublicId, MEETING_REPORT_SCHEMA_VERSION);

    if (name === 'teaming_read_report') {
      return NextResponse.json(
        toolText(
          id,
          JSON.stringify(
            {
              meeting_id: meetingId,
              topic: found.topic ?? null,
              status: found.status,
              zone: found.analysisZone ?? null,
              report_url: reportUrl,
              report: found.analysisResult ?? null,
            },
            null,
            2,
          ),
        ),
      );
    }

    const card = buildReportCard(found.topic || '（未命名会议）', reportUrl);
    return NextResponse.json(
      toolText(
        id,
        JSON.stringify(
          {
            ok: true,
            report_url: reportUrl,
            card,
            how_to_send: 'msg_type=interactive，content=JSON.stringify(card)。原样发送，不要改结构。',
            deliver_to: '★ 发给【当前对话用户自己】。用你自己的飞书能力找会话，不要用别的身份。',
          },
          null,
          2,
        ),
      ),
    );
  }

  // ── 分析 ──
  if (name === 'teaming_analyze_transcript') {
    const transcript = typeof args.transcript === 'string' ? args.transcript.trim() : '';
    if (!transcript) {
      return NextResponse.json(
        toolText(id, '缺少 transcript。请传妙记导出的文字转录稿原文，不要传 AI 摘要。', true),
      );
    }

    const contentHash = createHash('sha256').update(transcript).digest('hex').slice(0, 24);
    const effectiveMeetingId = meetingId || `host-${contentHash}`;

    // 幂等命中
    const existing = await getMeetingRecordByIntegrationAndMeeting(integration.id, effectiveMeetingId);
    if (existing?.analysisResult && existing.status === 'completed' && existing.reportPublicId) {
      return NextResponse.json(
        toolText(
          id,
          JSON.stringify(
            {
              ok: true,
              reused: true,
              meeting_id: effectiveMeetingId,
              report_url:
                existing.reportUrl
                || buildPersistentReportUrl(existing.reportPublicId, MEETING_REPORT_SCHEMA_VERSION),
              zone: existing.analysisZone ?? null,
            },
            null,
            2,
          ),
        ),
      );
    }

    let analysis;
    try {
      analysis = await analyzeMeetingText(transcript, { abcGate: true });
    } catch (error) {
      if (error instanceof AbcGateError) {
        return NextResponse.json(
          toolText(
            id,
            [
              '这场会与「ABC 向善公益实战营」无关，服务端已跳过分析。',
              `理由：${error.message}`,
              '**不要重试**——判据是会议内容，重试结果一样。如实告诉用户"这场会不在分析范围内"即可。',
            ].join('\n'),
            true,
          ),
        );
      }
      return NextResponse.json(toolText(id, `分析失败：${String((error as Error)?.message || error)}`, true));
    }

    const record = await upsertMeetingRecord({
      integration,
      meetingId: effectiveMeetingId,
      details: {
        meetingId: effectiveMeetingId,
        topic: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null,
        organizerOpenId: null,
        hostOpenId: null,
      },
    });
    await updateMeetingRecordTranscript(record.id, transcript);
    const reportUrl = buildPersistentReportUrl(record.reportPublicId, MEETING_REPORT_SCHEMA_VERSION);
    await persistMeetingReport({ meetingRecordId: record.id, analysis, reportUrl });

    // 归属后置：项目取当前活跃期，方向留空交给运营侧
    try {
      const { project, targets } = await listActiveProjectOrgTargets();
      const activeTarget = targets[0] ?? null;
      if (project?.bitableAppToken && project.bitableTableId && activeTarget) {
        await enqueueBaseSyncTask({
          meetingRecordId: record.id,
          integrationId: integration.id,
          userId: integration.userId,
          projectId: project.id,
          orgTargetId: activeTarget.id,
          orgName: null,
          appToken: project.bitableAppToken,
          tableId: project.bitableTableId,
          requestedVersion: record.dataVersion ?? 1,
          skipDirection: true,
        });
      }
    } catch (error) {
      logFeishuMonitor('warn', 'mcp_http_base_sync_failed', {
        route: ROUTE,
        meetingRecordId: record.id,
        ...toErrorContext(error),
      });
    }

    return NextResponse.json(
      toolText(
        id,
        JSON.stringify(
          {
            ok: true,
            reused: false,
            meeting_id: effectiveMeetingId,
            report_url: reportUrl,
            zone: analysis.teamState?.zone ?? null,
            zone_label: analysis.teamState?.zoneLabel ?? null,
            meeting_type: analysis.metadata?.meetingType ?? null,
            participant_count: analysis.metadata?.participantCount ?? null,
            hint: '把 report_url 原样贴给用户；要卡片就用 teaming_report_card。',
          },
          null,
          2,
        ),
      ),
    );
  }

  return NextResponse.json(toolText(id, `没有这个工具：${name}`, true));
}

/**
 * 不启用 SSE：所有工具都在请求内跑完。
 *
 * 规范允许服务端只用 JSON 响应。若将来需要流式进度（分析要 90 秒，宿主可能想
 * 看到中间状态），再在这里加 `text/event-stream` 分支。
 */
export async function GET() {
  return NextResponse.json(
    rpcError(null, -32600, '本端点只接受 POST（MCP streamable HTTP，无 SSE 模式）'),
    { status: 405 },
  );
}
