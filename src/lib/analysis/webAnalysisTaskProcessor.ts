import type { AnalysisResult } from '@/types';
import { formatResult } from '@/formatters';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { analyzeMeetingText } from '@/services/analysisService';
import {
  claimWebAnalysisTask,
  completeWebAnalysisTask,
  failWebAnalysisTask,
} from './webAnalysisTaskStore';

const globalForWebAnalysis = globalThis as typeof globalThis & {
  __webAnalysisRunningTasks?: Set<string>;
};

function getRunningTasks(): Set<string> {
  if (!globalForWebAnalysis.__webAnalysisRunningTasks) {
    globalForWebAnalysis.__webAnalysisRunningTasks = new Set<string>();
  }

  return globalForWebAnalysis.__webAnalysisRunningTasks;
}

export async function runWebAnalysisTask(taskId: string): Promise<void> {
  const runningTasks = getRunningTasks();
  if (runningTasks.has(taskId)) {
    return;
  }

  runningTasks.add(taskId);
  const startedAt = Date.now();

  try {
    const task = await claimWebAnalysisTask(taskId);
    if (!task) {
      return;
    }

    logRuntimeMonitor('info', 'web_analysis_task', 'task_started', {
      taskId,
      fileName: task.fileName,
      attemptCount: task.attemptCount,
    });

    const analysis = await analyzeMeetingText(task.meetingText);
    const formatted = (await formatResult(analysis, 'web')) as AnalysisResult;
    await completeWebAnalysisTask(taskId, formatted);

    logRuntimeMonitor('info', 'web_analysis_task', 'task_completed', {
      taskId,
      fileName: task.fileName,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    await failWebAnalysisTask(taskId, error).catch((failureError) => {
      logRuntimeMonitor('error', 'web_analysis_task', 'task_fail_update_failed', {
        taskId,
        ...toRuntimeErrorContext(failureError),
      });
    });

    logRuntimeMonitor('error', 'web_analysis_task', 'task_failed', {
      taskId,
      durationMs: Date.now() - startedAt,
      ...toRuntimeErrorContext(error),
    });
  } finally {
    runningTasks.delete(taskId);
  }
}

export function scheduleWebAnalysisTask(taskId: string): void {
  setTimeout(() => {
    void runWebAnalysisTask(taskId);
  }, 0);
}
