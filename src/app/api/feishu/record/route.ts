/**
 * 获取多维表格记录 API
 * 根据 recordId 获取会议记录详情
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFeishuBitableConfig } from '@/lib/feishu/config';
import { getBitableRecord } from '@/lib/feishu/bitableOpenApi';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const recordId = searchParams.get('recordId');
    
    if (!recordId) {
      return NextResponse.json({ error: '缺少 recordId 参数' }, { status: 400 });
    }
    
    const config = getFeishuBitableConfig();
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
