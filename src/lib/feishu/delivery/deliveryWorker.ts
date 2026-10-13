import { assertServerRuntimeEnabled } from '@/lib/platform/serverRuntime';
import { createResilientPoller } from '@/lib/platform/resilientPoller';
/**
 * 交付任务 worker：Base 同步与报告通知两条独立轮询链路
 *
 * - 各自独立的轮询间隔、批量大小（并发槽），互不饿死
 * - 领取器天然承担重启恢复：pending/retry_wait 到期任务 + 租约过期的 running 任务
 * - 轮询异常只记日志并继续下一轮，不退出进程
 *
 * 2026-09-30 事故后改用 createResilientPoller：
 * 原实现把重新排程写在 finally 里，一旦 await 永久挂起就再也不排程，
 * 循环静默死亡。现在排程与单次执行解耦，并由 watchdog 兜底。
 */
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import {
  claimAndProcessBaseSyncTasks,
} from './baseSyncProcessor';
import {
  claimAndProcessNotificationTasks,
} from './notificationProcessor';

const BASE_POLL_INTERVAL_MS = Number(
  process.env.FEISHU_BASE_DELIVERY_POLL_INTERVAL_MS || 5_000
);
const BASE_BATCH_SIZE = Number(process.env.FEISHU_BASE_DELIVERY_BATCH_SIZE || 2);

const NOTIFICATION_POLL_INTERVAL_MS = Number(
  process.env.FEISHU_NOTIFICATION_DELIVERY_POLL_INTERVAL_MS || 5_000
);
const NOTIFICATION_BATCH_SIZE = Number(
  process.env.FEISHU_NOTIFICATION_DELIVERY_BATCH_SIZE || 3
);

/** 单次轮询允许的最长挂起时间；超过即判卡死并由 watchdog 拉起 */
const STALL_THRESHOLD_MS = Number(
  process.env.FEISHU_DELIVERY_WORKER_STALL_THRESHOLD_MS || 5 * 60_000
);

const globalForDeliveryWorker = globalThis as typeof globalThis & {
  __feishuDeliveryWorkerStarted?: boolean;
  __feishuBaseDeliveryPoller?: ReturnType<typeof createResilientPoller>;
  __feishuNotificationDeliveryPoller?: ReturnType<typeof createResilientPoller>;
};

async function pollBaseDelivery() {
  const processed = await claimAndProcessBaseSyncTasks({ limit: BASE_BATCH_SIZE });
  if (processed > 0) {
    logFeishuMonitor('info', 'delivery_base_worker_claimed', { taskCount: processed });
  }
}

async function pollNotificationDelivery() {
  const processed = await claimAndProcessNotificationTasks({
    limit: NOTIFICATION_BATCH_SIZE,
  });
  if (processed > 0) {
    logFeishuMonitor('info', 'delivery_notification_worker_claimed', {
      taskCount: processed,
    });
  }
}

/**
 * 统一恢复入口：启动两条交付链路。
 * 进程重启后到期/租约过期任务由领取器立即重新领取，无需额外 startup 扫描。
 */
export function startDeliveryWorkers() {
  assertServerRuntimeEnabled();
  if (globalForDeliveryWorker.__feishuDeliveryWorkerStarted) {
    return;
  }
  globalForDeliveryWorker.__feishuDeliveryWorkerStarted = true;

  logFeishuMonitor('info', 'delivery_worker_started', {
    basePollIntervalMs: BASE_POLL_INTERVAL_MS,
    baseBatchSize: BASE_BATCH_SIZE,
    notificationPollIntervalMs: NOTIFICATION_POLL_INTERVAL_MS,
    notificationBatchSize: NOTIFICATION_BATCH_SIZE,
    stallThresholdMs: STALL_THRESHOLD_MS,
  });

  const basePoller = createResilientPoller({
    intervalMs: BASE_POLL_INTERVAL_MS,
    stallThresholdMs: STALL_THRESHOLD_MS,
    poll: pollBaseDelivery,
    onPollError: (error) => {
      logFeishuMonitor('error', 'delivery_base_worker_poll_failed', toErrorContext(error));
    },
    onStall: (context) => {
      logFeishuMonitor('error', 'delivery_base_worker_stalled', {
        ...context,
        message: 'Base 同步轮询挂起超时，已释放执行标记并继续调度。',
      });
    },
  });

  const notificationPoller = createResilientPoller({
    intervalMs: NOTIFICATION_POLL_INTERVAL_MS,
    stallThresholdMs: STALL_THRESHOLD_MS,
    poll: pollNotificationDelivery,
    onPollError: (error) => {
      logFeishuMonitor(
        'error',
        'delivery_notification_worker_poll_failed',
        toErrorContext(error)
      );
    },
    onStall: (context) => {
      logFeishuMonitor('error', 'delivery_notification_worker_stalled', {
        ...context,
        message: '通知投递轮询挂起超时，已释放执行标记并继续调度。',
      });
    },
  });

  globalForDeliveryWorker.__feishuBaseDeliveryPoller = basePoller;
  globalForDeliveryWorker.__feishuNotificationDeliveryPoller = notificationPoller;

  basePoller.start();
  notificationPoller.start();
}
