import { sanitizeMonitorContext } from '@/lib/platform/monitorRedaction';

type MonitorLevel = 'info' | 'warn' | 'error';

type MonitorContext = Record<string, unknown>;

function normalizeContext(context: MonitorContext): MonitorContext {
  return Object.fromEntries(
    Object.entries(sanitizeMonitorContext(context)).filter(([, value]) => value !== undefined)
  );
}

export function logFeishuMonitor(
  level: MonitorLevel,
  event: string,
  context: MonitorContext = {}
) {
  const payload = {
    ...normalizeContext(context),
    timestamp: new Date().toISOString(),
    scope: 'feishu_pipeline',
    event,
  };

  try {
    console[level](`[Feishu Monitor] ${JSON.stringify(payload)}`);
  } catch {
    console[level]('[Feishu Monitor]', payload);
  }
}

function describeError(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}: ${error.message}${code === undefined ? '' : ` (code=${String(code)})`}`;
  }
  return String(error);
}

/**
 * 把错误转成可上报的上下文。
 *
 * 生产事故复盘（2026-09-30）：drizzle 抛出的错误 message 只有 `Failed query: <SQL>`，
 * 真正的原因（连接被池化器断开、超时等）挂在 `error.cause` 上。
 * 此前不记录 cause，导致日志里永远看不到真实原因，只能看到一句 "Failed query"。
 */
export function toErrorContext(error: unknown): MonitorContext {
  if (error instanceof Error) {
    const context: MonitorContext = {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };

    const code = (error as { code?: unknown }).code;
    if (code !== undefined) context.errorCode = String(code);

    // 顺着 cause 链最多展开 3 层
    const chain: string[] = [];
    let current: unknown = (error as { cause?: unknown }).cause;
    for (let depth = 0; depth < 3 && current; depth += 1) {
      const described = describeError(current);
      if (!described) break;
      chain.push(described);
      current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
    }
    if (chain.length > 0) context.errorCause = chain.join(' <- ');

    return context;
  }

  return {
    errorMessage: String(error),
  };
}
