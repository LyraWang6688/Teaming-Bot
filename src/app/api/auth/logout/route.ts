import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth/session';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

export async function POST() {
  try {
    await destroySession();
    return NextResponse.json({ success: true });
  } catch (error) {
    logRuntimeMonitor('error', 'auth_api', 'logout_failed', toRuntimeErrorContext(error));
    return NextResponse.json(
      { success: false, error: '登出失败' },
      { status: 500 }
    );
  }
}
