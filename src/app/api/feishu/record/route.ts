/**
 * 获取多维表格记录 API
 * 根据 recordId 获取会议记录详情
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createIntegrationBitableAccess,
  getBitableRecord,
} from '@/lib/feishu/bitableOpenApi';
import { getFeishuIntegrationContextById } from '@/lib/feishu/integrationStore';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const recordId = searchParams.get('recordId');
    const integrationId = searchParams.get('integrationId');
    
    if (!recordId) {
      return NextResponse.json({ error: '缺少 recordId 参数' }, { status: 400 });
    }

    if (!integrationId) {
      return NextResponse.json(
        { error: '缺少 integrationId 参数，无法定位对应租户的飞书集成。' },
        { status: 400 }
      );
    }

    const integration = await getFeishuIntegrationContextById(integrationId);
    if (!integration) {
      return NextResponse.json({ error: '未找到对应的飞书集成配置' }, { status: 404 });
    }

    const config = createIntegrationBitableAccess(integration);
    const record = await getBitableRecord(config, recordId);
    
    return NextResponse.json({
      success: true,
      data: record,
      // 兼容旧首页读取逻辑；新报告页只读取 data.analysisData。
      record: {
        ...record,
        analysisJson: record.analysisData,
      },
    });
    
  } catch (error: unknown) {
    console.error('获取记录失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取记录失败' },
      { status: 500 }
    );
  }
}
