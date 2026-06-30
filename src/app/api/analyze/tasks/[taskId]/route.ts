import { NextRequest, NextResponse } from 'next/server';
import { scheduleWebAnalysisTask } from '@/lib/analysis/webAnalysisTaskProcessor';
import {
  getWebAnalysisTask,
  serializeWebAnalysisTask,
} from '@/lib/analysis/webAnalysisTaskStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

type RouteContext = { params: Promise<{ taskId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const task = await getWebAnalysisTask(taskId);

    if (!task) {
      return NextResponse.json(
        { success: false, error: '分析任务不存在或已过期' },
        { status: 404 }
      );
    }

    if (task.status === 'pending' || task.status === 'analyzing') {
      scheduleWebAnalysisTask(task.id);
    }

    return NextResponse.json({
      success: true,
      data: serializeWebAnalysisTask(task),
    });
  } catch (error) {
    logRuntimeMonitor('error', 'web_analysis_task', 'task_get_failed', toRuntimeErrorContext(error));
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '读取分析任务失败' },
      { status: 500 }
    );
  }
}
