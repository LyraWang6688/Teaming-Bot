import { NextRequest, NextResponse } from 'next/server';
import { logAuthMonitor, toAuthErrorContext } from '@/lib/platform/authMonitor';
import { getProjectPublicUrl } from '@/lib/platform/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const nextPath = requestUrl.searchParams.get('next') || '/feishu-config';
  const safeNextPath = nextPath.startsWith('/') ? nextPath : '/feishu-config';
  const redirectBaseUrl = getProjectPublicUrl();
  const redirectTargetUrl = new URL(safeNextPath, redirectBaseUrl).toString();

  logAuthMonitor('info', 'callback_received', {
    hasCode: Boolean(code),
    requestOrigin: requestUrl.origin,
    nextPath,
    safeNextPath,
    redirectBaseUrl,
    redirectTargetUrl,
  });

  try {
    if (code) {
      logAuthMonitor('info', 'session_exchange_started', {
        safeNextPath,
      });
      const supabase = await createSupabaseServerClient();
      await supabase.auth.exchangeCodeForSession(code);
      logAuthMonitor('info', 'session_exchange_succeeded', {
        safeNextPath,
      });
    } else {
      logAuthMonitor('warn', 'callback_without_code', {
        safeNextPath,
      });
    }
  } catch (error) {
    logAuthMonitor('error', 'session_exchange_failed', {
      safeNextPath,
      requestOrigin: requestUrl.origin,
      redirectBaseUrl,
      ...toAuthErrorContext(error),
    });
    throw error;
  }

  logAuthMonitor('info', 'callback_redirecting', {
    redirectTargetUrl,
  });

  return NextResponse.redirect(redirectTargetUrl);
}
