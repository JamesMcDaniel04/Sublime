import { createClient } from '@supabase/supabase-js'
import { getSupabaseConfig } from './config'

export class SupabaseAdminConfigurationError extends Error {
  constructor() {
    super('SUPABASE_SERVICE_ROLE_KEY is not configured')
    this.name = 'SupabaseAdminConfigurationError'
  }
}

export function createAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) throw new SupabaseAdminConfigurationError()
  return createClient(getSupabaseConfig().url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
}
