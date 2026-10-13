import { assertServerRuntimeEnabled } from '@/lib/platform/serverRuntime';
import { createResilientPoller, type ResilientPoller } from '@/lib/platform/resilientPoller';
import {
  claimDueMeetingPipelineTasks,
  failMeetingPipelineTask,
} from './meetingPipelineTaskStore';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { runMeetingPipelineTask } from './meetingPipelineProcessor';
import type { FeishuProcessStatus } from './status';

const WORKER_POLL_INTERVAL_MS = Number(
  process.env.FEISHU_MEETING_WORKER_POLL_INTERVAL_MS || 3_000
);
const WORKER_BATCH_SIZE = Number(process.env.FEISHU_MEETING_WORKER_BATCH_SIZE || 5);
const WORKER_LOCK_TTL_MS = Number(
  process.env.FEISHU_MEETING_WORKER_LOCK_TTL_MS || 20 * 60_000
);
/** 单次轮询允许的最长挂起时间；超过即判卡死并由 watchdog 拉起 */
const WORKER_STALL_THRESHOLD_MS = Number(
  process.env.FEISHU_MEETING_WORKER_STALL_THRESHOLD_MS || 5 * 60_000
);

const globalForMeetingWorker = globalThis as typeof globalThis & {
  __feishuMeetingWorkerStarted?: boolean;
  __feishuMeetingWorkerPoller?: ResilientPoller;
};

async function pollMeetingPipelineTasks() {
  try {
    for (let slot = 0; slot < WORKER_BATCH_SIZE; slot += 1) {
      const tasks = await claimDueMeetingPipelineTasks({
        limit: 1,
        staleLockBefore: new Date(Date.now() - WORKER_LOCK_TTL_MS),
      });

      if (!tasks.length) break;
      logFeishuMonitor('info', 'meeting_pipeline_worker_claimed', {
        taskCount: tasks.length,
        taskIds: tasks.map((task) => task.id),
      });

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
    }
  } catch (error) {
    logFeishuMonitor('error', 'meeting_pipeline_worker_poll_failed', toErrorContext(error));
  }
}

export function startFeishuMeetingPipelineWorker() {
  assertServerRuntimeEnabled();
  if (globalForMeetingWorker.__feishuMeetingWorkerStarted) {
    return;
  }

  globalForMeetingWorker.__feishuMeetingWorkerStarted = true;

  // 排程与单次执行解耦：单次轮询挂起不再能杀死循环。
  // 详见 src/lib/platform/resilientPoller.ts 里的事故说明。
  const poller = createResilientPoller({
    intervalMs: WORKER_POLL_INTERVAL_MS,
    stallThresholdMs: WORKER_STALL_THRESHOLD_MS,
    poll: pollMeetingPipelineTasks,
    onPollError: (error) => {
      logFeishuMonitor('error', 'meeting_pipeline_worker_poll_failed', toErrorContext(error));
    },
    onStall: (context) => {
      logFeishuMonitor('error', 'meeting_pipeline_worker_stalled', {
        ...context,
        snapshot: poller.snapshot(),
        message: '单次轮询挂起超时，已释放执行标记并继续调度。',
      });
    },
  });

  globalForMeetingWorker.__feishuMeetingWorkerPoller = poller;
  poller.start();

  logFeishuMonitor('info', 'meeting_pipeline_worker_started', {
    pollIntervalMs: WORKER_POLL_INTERVAL_MS,
    batchSize: WORKER_BATCH_SIZE,
    lockTtlMs: WORKER_LOCK_TTL_MS,
    stallThresholdMs: WORKER_STALL_THRESHOLD_MS,
  });
}

/** 供运维/诊断读取 worker 运行状态（是否在跑、上次完成时间、卡死次数） */
export function getFeishuMeetingPipelineWorkerHealth() {
  const poller = globalForMeetingWorker.__feishuMeetingWorkerPoller;
  if (!poller) {
    return { started: Boolean(globalForMeetingWorker.__feishuMeetingWorkerStarted), poller: null };
  }
  return { started: true, poller: poller.snapshot() };
}
