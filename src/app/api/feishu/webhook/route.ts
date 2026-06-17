/**
 * 飞书 Webhook 接收入口
 *
 * 只做快速验收：URL 验证、基础 token 校验、事件去重、异步入队。
 * 耗时的转录稿获取、LLM 分析和写表由后台异步处理，避免 Webhook 超时。
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  enqueueFeishuWebhookEvent,
  isValidFeishuWebhookToken,
  type FeishuWebhookEnvelope,
} from '@/lib/feishu/webhookProcessor';

export async function GET() {
  return NextResponse.json({
    success: true,
    service: 'feishu-webhook',
  });
}

export async function POST(request: NextRequest) {
  try {
    const envelope = (await request.json()) as FeishuWebhookEnvelope;

    // 飞书 URL 验证事件：原样返回 challenge。
    if (envelope.type === 'url_verification' && envelope.challenge) {
      if (!isValidFeishuWebhookToken(envelope)) {
        return NextResponse.json({ error: 'invalid token' }, { status: 401 });
      }

      return NextResponse.json({ challenge: envelope.challenge });
    }

    if (!isValidFeishuWebhookToken(envelope)) {
      return NextResponse.json({ error: 'invalid token' }, { status: 401 });
    }

    const result = enqueueFeishuWebhookEvent(envelope);
    if (!result.accepted) {
      return NextResponse.json({ error: 'missing event_id' }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate,
      eventId: result.eventId,
      eventType: result.eventType,
    });
  } catch (error) {
    console.error('[Feishu Webhook] 接收失败:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Webhook 处理失败' },
      { status: 500 }
    );
  }
}
