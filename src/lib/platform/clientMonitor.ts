import { sanitizeMonitorContext } from './monitorRedaction';

type ClientMonitorLevel = 'info' | 'warn' | 'error';

type ClientMonitorContext = Record<string, unknown>;

function normalizeContext(context: ClientMonitorContext): ClientMonitorContext {
  return Object.fromEntries(
    Object.entries(sanitizeMonitorContext(context)).filter(([, value]) => value !== undefined)
  );
}

export function logClientMonitor(
  level: ClientMonitorLevel,
  scope: string,
  event: string,
  context: ClientMonitorContext = {}
) {
  const payload = {
    ...normalizeContext(context),
    timestamp: new Date().toISOString(),
    scope,
    event,
  };

  try {
    console[level](`[Client Monitor] ${JSON.stringify(payload)}`);
  } catch {
    console[level]('[Client Monitor]', payload);
  }

  if (typeof window !== 'undefined') {
    void fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, ...payload }),
      keepalive: true,
    }).catch(() => {
      // Client log reporting must never affect the user workflow.
    });
  }
}

export function toClientErrorContext(error: unknown): ClientMonitorContext {
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
