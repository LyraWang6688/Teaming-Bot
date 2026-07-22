import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getFeishuIntegrationCheckStatus,
  getLatestFeishuAuthorization,
  getUserFeishuIntegrationDetail,
  updateUserFeishuIntegration,
  upsertFeishuIntegrationCheckStatus,
  writeAuditLog,
} from '@/lib/feishu/integration/integrationStore';
import { getEnabledOrgTargetContextById } from '@/lib/feishu/projects/projectConfigStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getCurrentUser } from '@/lib/auth/session';
import { stopListener } from '@/lib/feishu/events/eventListenerManager';

const updateIntegrationSchema = z.object({
  name: z.string().trim().min(1).optional(),
  selectedOrgTargetId: z.string().uuid().nullable().optional(),
});

type RouteContext = {
  params: Promise<{
    integrationId: string;
  }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    logRuntimeMonitor('warn', 'integration_api', 'integration_detail_rejected_unauthenticated');
    return NextResponse.json(
      { success: false, error: '请先登录后再查看飞书集成配置。' },
      { status: 401 }
    );
  }

  const { integrationId } = await context.params;
  try {
    const integration = await getUserFeishuIntegrationDetail(user.id, integrationId);
    if (!integration) {
      logRuntimeMonitor('warn', 'integration_api', 'integration_detail_missing', {
        userId: user.id,
        integrationId,
      });
      return NextResponse.json(
        { success: false, error: '未找到对应的飞书集成配置。' },
        { status: 404 }
      );
    }

    const [authorization, checks] = await Promise.all([
      getLatestFeishuAuthorization(integrationId),
      getFeishuIntegrationCheckStatus(integrationId),
    ]);

    logRuntimeMonitor('info', 'integration_api', 'integration_detail_loaded', {
      userId: user.id,
      integrationId,
      hasAuthorization: Boolean(authorization),
      hasChecks: Boolean(checks),
    });

    return NextResponse.json({
      success: true,
      data: {
        integration,
        authorization,
        checks,
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'integration_api', 'integration_detail_failed', {
      userId: user.id,
      integrationId,
      ...toRuntimeErrorContext(error),
    });
    throw error;
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    logRuntimeMonitor('warn', 'integration_api', 'integration_update_rejected_unauthenticated');
    return NextResponse.json(
      { success: false, error: '请先登录后再更新飞书集成配置。' },
      { status: 401 }
    );
  }

  const parsed = updateIntegrationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    logRuntimeMonitor('warn', 'integration_api', 'integration_update_validation_failed', {
      userId: user.id,
      issueCount: parsed.error.issues.length,
      firstIssue: parsed.error.issues[0]?.message,
    });
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || '参数不完整' },
      { status: 400 }
    );
  }

  const { integrationId } = await context.params;
  try {
    const currentIntegration = await getUserFeishuIntegrationDetail(user.id, integrationId);
    if (!currentIntegration) {
      return NextResponse.json(
        { success: false, error: '未找到对应的飞书集成配置。' },
        { status: 404 }
      );
    }

    let selectedTarget:
      | Awaited<ReturnType<typeof getEnabledOrgTargetContextById>>
      | null = null;

    if (typeof parsed.data.selectedOrgTargetId === 'string') {
      const authorization = await getLatestFeishuAuthorization(integrationId);
      if (authorization?.status !== 'authorized') {
        return NextResponse.json(
          { success: false, error: '飞书用户授权尚未完成，请先完成第二步。' },
          { status: 409 }
        );
      }
      selectedTarget = await getEnabledOrgTargetContextById(parsed.data.selectedOrgTargetId);
      if (!selectedTarget) {
        logRuntimeMonitor('warn', 'integration_api', 'organization_target_select_rejected_unavailable', {
          userId: user.id,
          integrationId,
          selectedOrgTargetId: parsed.data.selectedOrgTargetId,
        });
        return NextResponse.json(
          { success: false, error: '所选组织当前不可用，请刷新后重新选择。' },
          { status: 400 }
        );
      }
    }

    const integration = await updateUserFeishuIntegration(user.id, integrationId, {
      ...parsed.data,
      ...(Object.prototype.hasOwnProperty.call(parsed.data, 'selectedOrgTargetId')
        ? { status: 'draft', setupStep: 'organization', initializedAt: null }
        : {}),
    });

    if (!integration) {
      logRuntimeMonitor('warn', 'integration_api', 'integration_update_missing', {
        userId: user.id,
        integrationId,
      });
      return NextResponse.json(
        { success: false, error: '未找到对应的飞书集成配置。' },
        { status: 404 }
      );
    }

    logRuntimeMonitor('info', 'integration_api', 'integration_update_succeeded', {
      userId: user.id,
      integrationId,
      updatedFieldCount: Object.keys(parsed.data).length,
    });

    if (Object.prototype.hasOwnProperty.call(parsed.data, 'selectedOrgTargetId')) {
      stopListener(integrationId);
      logRuntimeMonitor('info', 'integration_api', 'organization_target_selected', {
        userId: user.id,
        integrationId,
        orgTargetId: parsed.data.selectedOrgTargetId || null,
        projectId: selectedTarget?.projectId || null,
        orgKey: selectedTarget?.orgKey || null,
        orgName: selectedTarget?.orgName || null,
        tableId: selectedTarget?.tableId || null,
      });

      await upsertFeishuIntegrationCheckStatus({
        integrationId,
        baseStatus: 'pending',
        permissionStatus: 'pending',
        minuteSubscriptionStatus: 'pending',
        eventSubscriptionStatus: 'pending',
        lastErrorType: null,
        lastErrorMessage: null,
        details: {
          reason: 'organization_target_changed',
          selectedOrgTargetId: parsed.data.selectedOrgTargetId || null,
        },
      });
      await writeAuditLog({
        userId: user.id,
        integrationId,
        action: 'integration.organization.selected',
        result: 'success',
        summary: parsed.data.selectedOrgTargetId ? '选择飞书集成所属组织' : '清除飞书集成所属组织',
        metadata: {
          orgTargetId: parsed.data.selectedOrgTargetId || null,
          projectId: selectedTarget?.projectId || null,
          orgKey: selectedTarget?.orgKey || null,
          orgName: selectedTarget?.orgName || null,
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: integration,
    });
  } catch (error) {
    logRuntimeMonitor('error', 'integration_api', 'integration_update_failed', {
      userId: user.id,
      integrationId,
      ...toRuntimeErrorContext(error),
    });
    throw error;
  }
}
