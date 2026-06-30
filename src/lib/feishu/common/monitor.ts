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

export function toErrorContext(error: unknown): MonitorContext {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }

  return {
    errorMessage: String(error),
  };
}
