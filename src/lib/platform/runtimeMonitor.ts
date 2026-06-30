import { sanitizeMonitorContext } from './monitorRedaction';

type RuntimeMonitorLevel = 'info' | 'warn' | 'error';

type RuntimeMonitorContext = Record<string, unknown>;

function normalizeContext(context: RuntimeMonitorContext): RuntimeMonitorContext {
  return Object.fromEntries(
    Object.entries(sanitizeMonitorContext(context)).filter(([, value]) => value !== undefined)
  );
}

export function logRuntimeMonitor(
  level: RuntimeMonitorLevel,
  scope: string,
  event: string,
  context: RuntimeMonitorContext = {}
) {
  const payload = {
    ...normalizeContext(context),
    timestamp: new Date().toISOString(),
    scope,
    event,
  };

  try {
    console[level](`[Runtime Monitor] ${JSON.stringify(payload)}`);
  } catch {
    console[level]('[Runtime Monitor]', payload);
  }
}

export function toRuntimeErrorContext(error: unknown): RuntimeMonitorContext {
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
