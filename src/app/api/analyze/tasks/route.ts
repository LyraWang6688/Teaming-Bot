import { NextRequest, NextResponse } from 'next/server';
import { parseAnalysisInput } from '@/lib/analysis/inputParser';
import { scheduleWebAnalysisTask } from '@/lib/analysis/webAnalysisTaskProcessor';
import {
  createWebAnalysisTask,
  serializeWebAnalysisTask,
} from '@/lib/analysis/webAnalysisTaskStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

export async function POST(request: NextRequest) {
  try {
    const { meetingText, fileName } = await parseAnalysisInput(request);
    const task = await createWebAnalysisTask({ fileName, meetingText });
    scheduleWebAnalysisTask(task.id);

    logRuntimeMonitor('info', 'web_analysis_task', 'task_created', {
      taskId: task.id,
      fileName,
    });

    return NextResponse.json(
      {
        success: true,
        data: serializeWebAnalysisTask(task),
      },
      { status: 202 }
    );
  } catch (error) {
    logRuntimeMonitor('error', 'web_analysis_task', 'task_create_failed', toRuntimeErrorContext(error));
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '创建分析任务失败' },
      { status: 500 }
    );
  }
}
