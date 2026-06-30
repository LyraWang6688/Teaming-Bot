export function getRequestTraceContext(request: Request): {
  setupTraceId?: string;
} {
  const setupTraceId = request.headers.get('x-setup-trace-id')?.trim();
  return {
    setupTraceId: setupTraceId || undefined,
  };
}
