import { assertServerRuntimeEnabled } from '@/lib/platform/serverRuntime';
/**
 * 交付任务 worker：Base 同步与报告通知两条独立轮询链路
 *
 * - 各自独立的轮询间隔、批量大小（并发槽），互不饿死
 * - 领取器天然承担重启恢复：pending/retry_wait 到期任务 + 租约过期的 running 任务
 * - 轮询异常只记日志并继续下一轮，不退出进程
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

const globalForDeliveryWorker = globalThis as typeof globalThis & {
  __feishuDeliveryWorkerStarted?: boolean;
  __feishuBaseDeliveryTimer?: ReturnType<typeof setTimeout>;
  __feishuNotificationDeliveryTimer?: ReturnType<typeof setTimeout>;
};

async function pollBaseDelivery() {
  try {
    const processed = await claimAndProcessBaseSyncTasks({ limit: BASE_BATCH_SIZE });
    if (processed > 0) {
      logFeishuMonitor('info', 'delivery_base_worker_claimed', { taskCount: processed });
    }
  } catch (error) {
    logFeishuMonitor('error', 'delivery_base_worker_poll_failed', toErrorContext(error));
  } finally {
    globalForDeliveryWorker.__feishuBaseDeliveryTimer = setTimeout(
      pollBaseDelivery,
      BASE_POLL_INTERVAL_MS
    );
  }
}

async function pollNotificationDelivery() {
  try {
    const processed = await claimAndProcessNotificationTasks({
      limit: NOTIFICATION_BATCH_SIZE,
    });
    if (processed > 0) {
      logFeishuMonitor('info', 'delivery_notification_worker_claimed', {
        taskCount: processed,
      });
    }
  } catch (error) {
    logFeishuMonitor(
      'error',
      'delivery_notification_worker_poll_failed',
      toErrorContext(error)
    );
  } finally {
    globalForDeliveryWorker.__feishuNotificationDeliveryTimer = setTimeout(
      pollNotificationDelivery,
      NOTIFICATION_POLL_INTERVAL_MS
    );
  }
}

/**
 * 统一恢复入口：启动两条交付链路。首次轮询 delay=0，
 * 进程重启后到期/租约过期任务立即被重新领取，无需额外 startup 扫描。
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
  });

  globalForDeliveryWorker.__feishuBaseDeliveryTimer = setTimeout(pollBaseDelivery, 0);
  globalForDeliveryWorker.__feishuNotificationDeliveryTimer = setTimeout(
    pollNotificationDelivery,
    0
  );
}
