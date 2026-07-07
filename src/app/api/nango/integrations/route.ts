import { getNangoClient } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { cacheGet, cacheSet } from '@/lib/cache'

export const runtime = 'nodejs'

type IntegrationChip = { id: string; provider: string; name: string; logo?: string }

// The enabled integrations are a property of the Nango ENVIRONMENT (one per
// deployment), identical for every user — but this was a live Nango round-trip
// on every integrations page load. Cache it globally for a few minutes.
const CACHE_KEY = 'nango:integrations'
const CACHE_TTL_MS = 10 * 60 * 1000

// Lists the integrations enabled on the Nango environment. These are the
// apps a user can connect from the integrations page.
export const GET = withAuthenticatedApi(async () => {
  const hit = await cacheGet<IntegrationChip[]>(CACHE_KEY)
  if (hit) return { success: true, integrations: hit }

  let configs
  try {
    ;({ configs } = await getNangoClient().listIntegrations())
  } catch (error) {
    throw nangoApiError(error)
  }

  const integrations: IntegrationChip[] = configs.map((config) => ({
    id: config.unique_key,
    provider: config.provider,
    name: config.display_name || config.provider,
    logo: config.logo,
  }))

  if (integrations.length) await cacheSet(CACHE_KEY, integrations, CACHE_TTL_MS)
  return { success: true, integrations }
})
