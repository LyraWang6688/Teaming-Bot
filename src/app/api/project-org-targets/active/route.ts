import { NextResponse } from 'next/server';
import { listActiveProjectOrgTargets } from '@/lib/feishu/projects/projectConfigStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

export async function GET() {
  try {
    const result = await listActiveProjectOrgTargets();

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logRuntimeMonitor('error', 'project_org_targets_api', 'active_targets_load_failed', {
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '加载当前项目组织失败。' },
      { status: 500 }
    );
  }
}
