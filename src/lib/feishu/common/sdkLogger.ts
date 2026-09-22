import { logRuntimeMonitor } from '@/lib/platform/runtimeMonitor';

/** Never pass SDK strings/objects to console: Axios embeds headers, bodies and
 * credentials inside both enumerable fields and preformatted strings. Export
 * only numeric codes; detailed business diagnostics live at our API boundary. */
export function createSafeFeishuSdkLogger(requestErrorsHandled = false) {
  function emit(level: 'info' | 'warn' | 'error', args: unknown[]) {
    const entries: unknown[] = [];
    const seen = new WeakSet<object>();
    function visit(value: unknown, depth = 0) {
      if (depth > 8 || entries.length >= 20) return;
      if (value && typeof value === 'object') {
        if (seen.has(value)) return;
        seen.add(value);
      }
      if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1));
      else entries.push(value);
    }
    visit(args);
    const diagnostics = entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return { kind: 'sdk_message' };
      const error = entry as { isAxiosError?: boolean; response?: { status?: unknown; data?: { code?: unknown } }; code?: unknown };
      if (requestErrorsHandled && error.isAxiosError === true) return null;
      return {
        kind: error.isAxiosError ? 'http_error' : 'sdk_error',
        statusCode: typeof error.response?.status === 'number' ? error.response.status : undefined,
        errorCode: typeof error.response?.data?.code === 'number' ? error.response.data.code :
          typeof error.code === 'number' ? error.code : undefined,
      };
    }).filter((entry) => entry !== null);
    if (diagnostics.length) logRuntimeMonitor(level, 'feishu_sdk', 'sdk_diagnostic', { diagnostics });
  }
  return {
    error: (...args: unknown[]) => emit('error', args),
    warn: (...args: unknown[]) => emit('warn', args),
    info: (...args: unknown[]) => emit('info', args),
    debug: (...args: unknown[]) => emit('info', args),
    trace: (...args: unknown[]) => emit('info', args),
  };
}
