/**
 * 获取多维表格记录 API
 * 根据 recordId 获取会议记录详情
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createOrgTargetBitableAccess,
  createIntegrationBitableAccess,
  getBitableRecord,
} from '@/lib/feishu/bitable/bitableOpenApi';
import { getFeishuIntegrationContextById } from '@/lib/feishu/integration/integrationStore';
import { getOrgTargetContextById } from '@/lib/feishu/projects/projectConfigStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

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

    const integration = await getFeishuIntegrationContextById(integrationId);
    if (!integration) {
      return NextResponse.json({ error: '未找到对应的飞书集成配置' }, { status: 404 });
    }

    const orgTarget = orgTargetId ? await getOrgTargetContextById(orgTargetId) : null;
    if (orgTargetId && !orgTarget) {
      logRuntimeMonitor('warn', 'feishu_record_api', 'report_record_load_org_target_missing', {
        recordId,
        integrationId,
        orgTargetId,
      });
      return NextResponse.json({ error: '未找到对应的组织目标表配置' }, { status: 404 });
    }

    const config = orgTarget
      ? createOrgTargetBitableAccess(integration, orgTarget)
      : createIntegrationBitableAccess(integration);

    logRuntimeMonitor('info', 'feishu_record_api', 'report_record_load_started', {
      recordId,
      integrationId,
      orgTargetId: orgTarget?.id || null,
      projectId: orgTarget?.projectId || null,
      orgKey: orgTarget?.orgKey || null,
      orgName: orgTarget?.orgName || null,
      tableId: orgTarget?.tableId || config.tableId,
      mode: orgTarget ? 'org_target' : 'legacy_integration_base',
    });

    const record = await getBitableRecord(config, recordId);

    logRuntimeMonitor('info', 'feishu_record_api', 'report_record_load_succeeded', {
      recordId,
      integrationId,
      orgTargetId: orgTarget?.id || null,
      projectId: orgTarget?.projectId || null,
      orgKey: orgTarget?.orgKey || null,
      orgName: orgTarget?.orgName || null,
      tableId: orgTarget?.tableId || config.tableId,
    });
    
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
