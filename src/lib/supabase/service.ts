import { createClient } from '@supabase/supabase-js';
import { getSupabaseServiceRoleKey, getSupabaseUrl } from '@/lib/platform/env';

let serviceClient: ReturnType<typeof createClient> | null = null;

export function createSupabaseServiceClient() {
  if (!serviceClient) {
    serviceClient = createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return serviceClient;
}
