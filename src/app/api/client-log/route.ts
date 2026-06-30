import { NextRequest, NextResponse } from 'next/server';
import { logRuntimeMonitor } from '@/lib/platform/runtimeMonitor';

type ClientLogPayload = {
  level?: 'info' | 'warn' | 'error';
  scope?: string;
  event?: string;
  timestamp?: string;
  [key: string]: unknown;
};

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as ClientLogPayload | null;
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ success: false, error: 'invalid client log payload' }, { status: 400 });
  }

  const level = payload.level === 'error' ? 'error' : payload.level === 'info' ? 'info' : 'warn';
  const scope = typeof payload.scope === 'string' ? payload.scope : 'client';
  const event = typeof payload.event === 'string' ? payload.event : 'client_log';
  const context: Record<string, unknown> = { ...payload };
  delete context.level;
  delete context.scope;
  delete context.event;

  logRuntimeMonitor(level, 'client_log', event, {
    clientScope: scope,
    ...context,
  });

  return NextResponse.json({ success: true });
}
