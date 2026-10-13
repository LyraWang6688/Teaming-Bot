/**
 * 抗卡死的轮询器。
 *
 * 背景（2026-09-30 生产事故）：
 * 原来的 worker 长这样——
 *
 * ```ts
 * async function poll() {
 *   try { await claim(); }
 *   catch (e) { log(e); }
 *   finally { setTimeout(poll, 3000); }   // ← 重新排程写在 finally 里
 * }
 * ```
 *
 * 一旦 `await` 永远不 settle（例如数据库连接被池化器静默断开、promise 不落地），
 * `finally` 就永远不会执行 → 循环永久死亡，**而且不抛错、不打日志**。
 * 事故中流水线就这样静默停摆 13 天。
 *
 * 这个轮询器把两件事彻底分开：
 *
 * 1. **排程不依赖单次执行**：用固定间隔的 tick 触发，不 await 单次轮询，
 *    所以一次挂起不会再吃掉整个循环。
 * 2. **watchdog 兜底**：另一个定时器盯着"当前这次执行挂了多久"，
 *    超过阈值就记一条告警并**释放标记**，让后续 tick 继续工作。
 *
 * 配上 pg Pool 的超时后，被放弃的那次执行通常也很快会因超时而自行结束；
 * watchdog 是第二道防线。
 */

type Timer = ReturnType<typeof setTimeout>;

export type ResilientPollerSnapshot = {
  running: boolean;
  inFlight: boolean;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  stalledCount: number;
};

export type ResilientPollerOptions = {
  /** 两次轮询的间隔 */
  intervalMs: number;
  /**
   * 单次轮询允许的最长挂起时间；超过即判定为卡死。
   * 默认取 intervalMs * 20，最少 60 秒。
   */
  stallThresholdMs?: number;
  /**
   * watchdog 自身的检查频率。默认 intervalMs * 5，限制在 1~60 秒。
   * 仅在需要更灵敏的卡死检测（或测试）时覆盖。
   */
  watchdogIntervalMs?: number;
  /**
   * 是否在 start() 后立刻执行一次。默认 true。
   *
   * 对间隔很长的 worker（例如 6 小时的令牌刷新、24 小时的健康检查）尤其重要——
   * 否则部署后要等一整个间隔才会有第一次执行。
   */
  runImmediately?: boolean;
  poll: () => Promise<void>;
  onPollError: (error: unknown) => void;
  onStall: (context: { heldMs: number; stalledCount: number; stallThresholdMs: number }) => void;
};

export type ResilientPoller = {
  start: () => void;
  stop: () => void;
  snapshot: () => ResilientPollerSnapshot;
};

export function createResilientPoller(options: ResilientPollerOptions): ResilientPoller {
  const { intervalMs, poll, onPollError, onStall } = options;
  const stallThresholdMs =
    options.stallThresholdMs ?? Math.max(intervalMs * 20, 60_000);

  let tickTimer: Timer | null = null;
  let watchdogTimer: Timer | null = null;
  let running = false;
  let inFlight = false;
  let inFlightSince = 0;
  let lastStartedAt: number | null = null;
  let lastCompletedAt: number | null = null;
  let stalledCount = 0;

  async function runOnce(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    inFlightSince = Date.now();
    lastStartedAt = inFlightSince;

    try {
      await poll();
    } catch (error) {
      onPollError(error);
    } finally {
      inFlight = false;
      inFlightSince = 0;
      lastCompletedAt = Date.now();
    }
  }

  function scheduleTick(): void {
    tickTimer = setTimeout(() => {
      // 刻意不 await：排程与单次执行解耦，单次挂起不能再阻断后续调度。
      void runOnce();
      if (running) scheduleTick();
    }, intervalMs);
  }

  function startWatchdog(): void {
    const checkIntervalMs =
      options.watchdogIntervalMs ??
      Math.max(Math.min(Math.floor(intervalMs * 5), 60_000), 1_000);
    watchdogTimer = setInterval(() => {
      if (!inFlight || inFlightSince === 0) return;
      const heldMs = Date.now() - inFlightSince;
      if (heldMs < stallThresholdMs) return;

      stalledCount += 1;
      onStall({ heldMs, stalledCount, stallThresholdMs });
      // 释放卡死的标记，让后续 tick 继续工作。
      // 被放弃的那个 promise 会在连接/查询超时后自行结束。
      inFlight = false;
      inFlightSince = 0;
    }, checkIntervalMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      // 先排程再立刻执行一次（默认），避免长间隔 worker 部署后要等一整个间隔。
      scheduleTick();
      if (options.runImmediately !== false) {
        void runOnce();
      }
      startWatchdog();
    },
    stop() {
      running = false;
      if (tickTimer) clearTimeout(tickTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      tickTimer = null;
      watchdogTimer = null;
    },
    snapshot() {
      return { running, inFlight, lastStartedAt, lastCompletedAt, stalledCount };
    },
  };
}
