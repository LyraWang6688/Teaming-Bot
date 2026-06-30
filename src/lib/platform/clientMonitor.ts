type ClientMonitorLevel = 'info' | 'warn' | 'error';

type ClientMonitorContext = Record<string, unknown>;

function normalizeContext(context: ClientMonitorContext): ClientMonitorContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined)
  );
}

export function logClientMonitor(
  level: ClientMonitorLevel,
  scope: string,
  event: string,
  context: ClientMonitorContext = {}
) {
  const payload = {
    timestamp: new Date().toISOString(),
    scope,
    event,
    ...normalizeContext(context),
  };

  try {
    console[level](`[Client Monitor] ${JSON.stringify(payload)}`);
  } catch {
    console[level]('[Client Monitor]', payload);
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
