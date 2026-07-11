import { createClient } from '@supabase/supabase-js'
import { getSupabaseConfig } from './config'

export function createAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  return createClient(getSupabaseConfig().url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
}
