/**
 * 事件投递健康检查 worker：按固定间隔调用 integrationDeliveryHealth 扫描。
 *
 * 复用 `resilientPoller`（排程与单次执行解耦，单次挂起不会杀死循环）。
 * 间隔默认 24 小时，可用 FEISHU_DELIVERY_HEALTH_INTERVAL_MS 覆盖。
 *
 * 动机见 `integrationDeliveryHealth.ts` 顶部：飞书 2026-10-26 起，
 * 用户未授权或不在应用可用范围内时事件将不再投递，且**无法补发**。
 * 所以必须能在事件停止投递之前就发现征兆。
 */

import { assertServerRuntimeEnabled } from '@/lib/platform/serverRuntime';
import { createResilientPoller, type ResilientPoller } from '@/lib/platform/resilientPoller';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import {
  DEFAULT_EXPIRING_SOON_DAYS,
  DEFAULT_QUIET_DAYS,
  sweepIntegrationDeliveryHealth,
} from './integrationDeliveryHealth';

const HEALTH_INTERVAL_MS = Number(
  process.env.FEISHU_DELIVERY_HEALTH_INTERVAL_MS || 24 * 60 * 60 * 1000
);
const EXPIRING_SOON_DAYS = Number(
  process.env.FEISHU_DELIVERY_HEALTH_EXPIRING_SOON_DAYS || DEFAULT_EXPIRING_SOON_DAYS
);
const QUIET_DAYS = Number(
  process.env.FEISHU_DELIVERY_HEALTH_QUIET_DAYS || DEFAULT_QUIET_DAYS
);
const STALL_THRESHOLD_MS = Number(
  process.env.FEISHU_DELIVERY_HEALTH_STALL_THRESHOLD_MS || 10 * 60_000
);

const globalForHealthWorker = globalThis as typeof globalThis & {
  __feishuDeliveryHealthWorkerStarted?: boolean;
  __feishuDeliveryHealthPoller?: ResilientPoller;
};

export function startFeishuDeliveryHealthWorker() {
  assertServerRuntimeEnabled();
  if (globalForHealthWorker.__feishuDeliveryHealthWorkerStarted) {
    return;
  }
  globalForHealthWorker.__feishuDeliveryHealthWorkerStarted = true;

  const poller = createResilientPoller({
    intervalMs: HEALTH_INTERVAL_MS,
    stallThresholdMs: STALL_THRESHOLD_MS,
    poll: async () => {
      await sweepIntegrationDeliveryHealth({
        expiringSoonDays: EXPIRING_SOON_DAYS,
        quietDays: QUIET_DAYS,
      });
    },
    onPollError: (error) => {
      logFeishuMonitor('error', 'event_delivery_health_worker_poll_failed', toErrorContext(error));
    },
    onStall: (context) => {
      logFeishuMonitor('error', 'event_delivery_health_worker_stalled', {
        ...context,
        snapshot: poller.snapshot(),
        message: '事件投递健康检查挂起超时，已释放执行标记并继续调度。',
      });
    },
  });

  globalForHealthWorker.__feishuDeliveryHealthPoller = poller;
  poller.start();

  logFeishuMonitor('info', 'event_delivery_health_worker_started', {
    healthIntervalMs: HEALTH_INTERVAL_MS,
    expiringSoonDays: EXPIRING_SOON_DAYS,
    quietDays: QUIET_DAYS,
    stallThresholdMs: STALL_THRESHOLD_MS,
  });
}

export function getFeishuDeliveryHealthWorkerHealth() {
  const poller = globalForHealthWorker.__feishuDeliveryHealthPoller;
  if (!poller) {
    return {
      started: Boolean(globalForHealthWorker.__feishuDeliveryHealthWorkerStarted),
      poller: null,
    };
  }
  return { started: true, poller: poller.snapshot() };
}
