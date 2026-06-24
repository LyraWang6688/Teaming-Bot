import {
  claimDueMeetingPipelineTasks,
  failMeetingPipelineTask,
} from './meetingPipelineTaskStore';
import { logFeishuMonitor, toErrorContext } from './monitor';
import { runMeetingPipelineTask } from './webhookProcessor';
import type { FeishuProcessStatus } from './status';

const WORKER_POLL_INTERVAL_MS = Number(
  process.env.FEISHU_MEETING_WORKER_POLL_INTERVAL_MS || 3_000
);
const WORKER_BATCH_SIZE = Number(process.env.FEISHU_MEETING_WORKER_BATCH_SIZE || 5);
const WORKER_LOCK_TTL_MS = Number(
  process.env.FEISHU_MEETING_WORKER_LOCK_TTL_MS || 20 * 60_000
);

const globalForMeetingWorker = globalThis as typeof globalThis & {
  __feishuMeetingWorkerStarted?: boolean;
  __feishuMeetingWorkerTimer?: ReturnType<typeof setTimeout>;
};

async function pollMeetingPipelineTasks() {
  try {
    const tasks = await claimDueMeetingPipelineTasks({
      limit: WORKER_BATCH_SIZE,
      staleLockBefore: new Date(Date.now() - WORKER_LOCK_TTL_MS),
    });

    if (tasks.length > 0) {
      logFeishuMonitor('info', 'meeting_pipeline_worker_claimed', {
        taskCount: tasks.length,
        taskIds: tasks.map((task) => task.id),
      });
    }

    for (const task of tasks) {
      try {
        await runMeetingPipelineTask(task.id);
      } catch (error) {
        logFeishuMonitor('error', 'meeting_pipeline_worker_task_failed', {
          taskId: task.id,
          integrationId: task.integrationId,
          meetingId: task.feishuMeetingId,
          ...toErrorContext(error),
        });

        await failMeetingPipelineTask(task.id, {
          currentStage: task.currentStage as FeishuProcessStatus,
          attemptCount: task.attemptCount,
          errorType: error instanceof Error ? error.name : 'MeetingPipelineWorkerError',
          errorMessage: error instanceof Error ? error.message : '任务执行器执行失败',
        });
      }
    }
  } catch (error) {
    logFeishuMonitor('error', 'meeting_pipeline_worker_poll_failed', toErrorContext(error));
  } finally {
    globalForMeetingWorker.__feishuMeetingWorkerTimer = setTimeout(
      pollMeetingPipelineTasks,
      WORKER_POLL_INTERVAL_MS
    );
  }
}

export function startFeishuMeetingPipelineWorker() {
  if (globalForMeetingWorker.__feishuMeetingWorkerStarted) {
    return;
  }

  globalForMeetingWorker.__feishuMeetingWorkerStarted = true;
  logFeishuMonitor('info', 'meeting_pipeline_worker_started', {
    pollIntervalMs: WORKER_POLL_INTERVAL_MS,
    batchSize: WORKER_BATCH_SIZE,
    lockTtlMs: WORKER_LOCK_TTL_MS,
  });

  globalForMeetingWorker.__feishuMeetingWorkerTimer = setTimeout(
    pollMeetingPipelineTasks,
    0
  );
}
