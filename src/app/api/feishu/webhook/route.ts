/**
 * 飞书 Webhook 接收入口
 *
 * 只做快速验收：URL 验证、基础 token 校验、事件去重、异步入队。
 * 耗时的转录稿获取、LLM 分析和写表由后台异步处理，避免 Webhook 超时。
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  enqueueFeishuWebhookEvent,
  type FeishuWebhookEnvelope,
} from '@/lib/feishu/webhookProcessor';
import {
  getFeishuIntegrationByWebhookToken,
  markFeishuIntegrationWebhookReceived,
} from '@/lib/feishu/integrationStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

async function resolveWebhookIntegration(envelope: FeishuWebhookEnvelope) {
  const actualToken = envelope.token || envelope.header?.token;

  if (!actualToken) {
    return null;
  }

  const integration = await getFeishuIntegrationByWebhookToken(actualToken);
  if (integration) {
    return {
      mode: 'integration' as const,
      integration,
    };
  }

  return null;
}

export async function GET() {
  logRuntimeMonitor('info', 'webhook_entry', 'webhook_health_checked');
  return NextResponse.json({
    success: true,
    service: 'feishu-webhook',
  });
}

export async function POST(request: NextRequest) {
  try {
    const envelope = (await request.json()) as FeishuWebhookEnvelope;
    const eventType = envelope.header?.event_type || envelope.type || null;
    const eventId = envelope.header?.event_id || (envelope.event?.event_id as string | undefined);
    const resolvedWebhook = await resolveWebhookIntegration(envelope);

    logRuntimeMonitor('info', 'webhook_entry', 'webhook_request_received', {
      eventType,
      eventId: eventId || null,
      hasChallenge: Boolean(envelope.challenge),
      isUrlVerification: envelope.type === 'url_verification',
      matchedMode: resolvedWebhook?.mode || 'none',
      integrationId: resolvedWebhook?.integration?.id || null,
    });

    // 飞书 URL 验证事件：原样返回 challenge。
    if (envelope.type === 'url_verification' && envelope.challenge) {
      if (!resolvedWebhook) {
        logRuntimeMonitor('warn', 'webhook_entry', 'webhook_url_verification_rejected', {
          eventType,
          reason: 'invalid_token',
        });
        return NextResponse.json({ error: 'invalid token' }, { status: 401 });
      }

      if (resolvedWebhook.integration) {
        await markFeishuIntegrationWebhookReceived(resolvedWebhook.integration.id, {
          details: {
            source: 'url_verification',
            eventType,
          },
        });
      }

      logRuntimeMonitor('info', 'webhook_entry', 'webhook_url_verification_succeeded', {
        eventType,
        matchedMode: resolvedWebhook.mode,
        integrationId: resolvedWebhook.integration?.id || null,
      });
      return NextResponse.json({ challenge: envelope.challenge });
    }

    if (!resolvedWebhook) {
      logRuntimeMonitor('warn', 'webhook_entry', 'webhook_request_rejected', {
        eventType,
        eventId: eventId || null,
        reason: 'invalid_token',
      });
      return NextResponse.json({ error: 'invalid token' }, { status: 401 });
    }

    const result = await enqueueFeishuWebhookEvent(envelope, resolvedWebhook.integration);
    if (!result.accepted) {
      logRuntimeMonitor('warn', 'webhook_entry', 'webhook_request_rejected', {
        eventType,
        eventId: eventId || null,
        reason: 'missing_event_id',
      });
      return NextResponse.json({ error: 'missing event_id' }, { status: 400 });
    }

    if (resolvedWebhook.integration) {
      await markFeishuIntegrationWebhookReceived(resolvedWebhook.integration.id, {
        details: {
          source: 'event',
          eventType: result.eventType || eventType,
          eventId: result.eventId || eventId || null,
          duplicate: result.duplicate,
        },
      });
    }

    logRuntimeMonitor('info', 'webhook_entry', 'webhook_request_accepted', {
      eventType: result.eventType || eventType,
      eventId: result.eventId || eventId || null,
      duplicate: result.duplicate,
      matchedMode: resolvedWebhook.mode,
      integrationId: resolvedWebhook.integration?.id || null,
    });

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate,
      eventId: result.eventId,
      eventType: result.eventType,
    });
  } catch (error) {
    logRuntimeMonitor('error', 'webhook_entry', 'webhook_request_failed', {
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Webhook 处理失败' },
      { status: 500 }
    );
  }
}
