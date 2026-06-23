import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/supabase/server';

export async function GET() {
  const user = await getAuthenticatedUser();

  return NextResponse.json({
    success: true,
    data: user
      ? {
          id: user.id,
          email: user.email || null,
        }
      : null,
  });
}
