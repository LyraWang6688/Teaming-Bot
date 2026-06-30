import { sanitizeMonitorContext } from './monitorRedaction';

type AuthMonitorLevel = 'info' | 'warn' | 'error';

type AuthMonitorContext = Record<string, unknown>;

function normalizeContext(context: AuthMonitorContext): AuthMonitorContext {
  return Object.fromEntries(
    Object.entries(sanitizeMonitorContext(context)).filter(([, value]) => value !== undefined)
  );
}

export function logAuthMonitor(
  level: AuthMonitorLevel,
  event: string,
  context: AuthMonitorContext = {}
) {
  const payload = {
    timestamp: new Date().toISOString(),
    scope: 'auth_callback',
    event,
    ...normalizeContext(context),
  };

  try {
    console[level](`[Auth Monitor] ${JSON.stringify(payload)}`);
  } catch {
    console[level]('[Auth Monitor]', payload);
  }
}

export function toAuthErrorContext(error: unknown): AuthMonitorContext {
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
