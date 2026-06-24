import { NextRequest, NextResponse } from 'next/server';
import { getProjectPublicUrl } from '@/lib/platform/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const nextPath = requestUrl.searchParams.get('next') || '/feishu-config';
  const safeNextPath = nextPath.startsWith('/') ? nextPath : '/feishu-config';
  const redirectBaseUrl = getProjectPublicUrl();

  if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(new URL(safeNextPath, redirectBaseUrl));
}
