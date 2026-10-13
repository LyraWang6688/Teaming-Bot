/**
 * 主动刷新 worker：按固定间隔调用 tokenRefreshSweeper。
 *
 * 复用 `resilientPoller`——排程与单次执行解耦，单次挂起不会杀死循环。
 * （这正是 2026-09-30 事故的教训：原来的 `finally { setTimeout }` 写法
 *   一旦 await 永久挂起就再也不排程，且不打任何日志。）
 *
 * 间隔默认 6 小时，可用 FEISHU_TOKEN_REFRESH_SWEEP_INTERVAL_MS 覆盖。
 * 注意：单纯缩短间隔不会增加 API 调用量——只有"剩余有效期不足窗口"
 * 的授权才会真正触发续期，其余都会被跳过。
 */

import { assertServerRuntimeEnabled } from '@/lib/platform/serverRuntime';
import { createResilientPoller, type ResilientPoller } from '@/lib/platform/resilientPoller';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import {
  DEFAULT_REFRESH_WINDOW_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  sweepExpiringAuthorizations,
} from '../integration/tokenRefreshSweeper';

const SWEEP_INTERVAL_MS = Number(
  process.env.FEISHU_TOKEN_REFRESH_SWEEP_INTERVAL_MS || DEFAULT_SWEEP_INTERVAL_MS
);
const REFRESH_WINDOW_MS = Number(
  process.env.FEISHU_TOKEN_REFRESH_WINDOW_MS || DEFAULT_REFRESH_WINDOW_MS
);
/** 单次扫描允许的最长挂起时间；超过即判卡死并由 watchdog 拉起 */
const STALL_THRESHOLD_MS = Number(
  process.env.FEISHU_TOKEN_REFRESH_STALL_THRESHOLD_MS || 10 * 60_000
);

const globalForTokenRefreshWorker = globalThis as typeof globalThis & {
  __feishuTokenRefreshWorkerStarted?: boolean;
  __feishuTokenRefreshPoller?: ResilientPoller;
};

export function startFeishuTokenRefreshWorker() {
  assertServerRuntimeEnabled();
  if (globalForTokenRefreshWorker.__feishuTokenRefreshWorkerStarted) {
    return;
  }
  globalForTokenRefreshWorker.__feishuTokenRefreshWorkerStarted = true;

  const poller = createResilientPoller({
    intervalMs: SWEEP_INTERVAL_MS,
    stallThresholdMs: STALL_THRESHOLD_MS,
    poll: async () => {
      await sweepExpiringAuthorizations({ windowMs: REFRESH_WINDOW_MS });
    },
    onPollError: (error) => {
      logFeishuMonitor('error', 'token_refresh_worker_poll_failed', toErrorContext(error));
    },
    onStall: (context) => {
      logFeishuMonitor('error', 'token_refresh_worker_stalled', {
        ...context,
        snapshot: poller.snapshot(),
        message: '主动刷新扫描挂起超时，已释放执行标记并继续调度。',
      });
    },
  });

  globalForTokenRefreshWorker.__feishuTokenRefreshPoller = poller;
  poller.start();

  logFeishuMonitor('info', 'token_refresh_worker_started', {
    sweepIntervalMs: SWEEP_INTERVAL_MS,
    refreshWindowMs: REFRESH_WINDOW_MS,
    stallThresholdMs: STALL_THRESHOLD_MS,
  });
}

/** 供运维/诊断读取调度器运行状态 */
export function getFeishuTokenRefreshWorkerHealth() {
  const poller = globalForTokenRefreshWorker.__feishuTokenRefreshPoller;
  if (!poller) {
    return {
      started: Boolean(globalForTokenRefreshWorker.__feishuTokenRefreshWorkerStarted),
      poller: null,
    };
  }
  return { started: true, poller: poller.snapshot() };
}
