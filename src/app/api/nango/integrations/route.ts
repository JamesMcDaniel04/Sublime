import { getNangoClient, nangoConfigured } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { googleOAuthConfigured } from '@/lib/google/oauth'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { cacheGet, cacheSet } from '@/lib/cache'
import { capabilityForProviderConfigKey, type DeliveryCapability } from '@/lib/nango/delivery'

export const runtime = 'nodejs'

type IntegrationChip = {
  id: string
  provider: string
  name: string
  logo?: string
  /** The scan-plane delivery capability this integration maps to, if any —
   *  powers the per-connection "Learning" toggle on the client (only
   *  connections the scan plane can actually sample have one). */
  capability?: DeliveryCapability
  /** True when connecting goes through our native Google OAuth flow. */
  native?: boolean
}

// The enabled integrations are a property of the Nango ENVIRONMENT (one per
// deployment), identical for every user — but this was a live Nango round-trip
// on every integrations page load. Cache it globally for a few minutes.
const CACHE_KEY = 'nango:integrations'
const CACHE_TTL_MS = 10 * 60 * 1000

/** Google services connect natively (Google blocks Nango's flow). When
 *  configured, native tiles REPLACE any Nango equivalents so there is exactly
 *  one tile per service. Calendar's tile powers meeting-history learning
 *  (the google_calendar ActivitySource). */
function withNativeGoogle(integrations: IntegrationChip[]): IntegrationChip[] {
  if (!googleOAuthConfigured()) return integrations
  const withoutNangoGoogle = integrations.filter(
    (integration) => capabilityForProviderConfigKey(integration.id) !== 'gmail'
      && !integration.id.toLowerCase().includes('calendar'),
  )
  return [
    {
      id: 'google-mail',
      provider: 'google-mail',
      name: 'Gmail',
      capability: 'gmail' as DeliveryCapability,
      native: true,
    },
    {
      id: 'google-calendar',
      provider: 'google-calendar',
      name: 'Google Calendar',
      native: true,
    },
    ...withoutNangoGoogle,
  ]
}

// Lists the integrations enabled on the Nango environment. These are the
// apps a user can connect from the integrations page.
export const GET = withAuthenticatedApi(async () => {
  // Native-only deployments (no Nango key) still offer Gmail.
  if (!nangoConfigured()) return { success: true, integrations: withNativeGoogle([]) }

  const hit = await cacheGet<IntegrationChip[]>(CACHE_KEY)
  if (hit) return { success: true, integrations: withNativeGoogle(hit) }

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
    capability: capabilityForProviderConfigKey(config.unique_key),
  }))

  if (integrations.length) await cacheSet(CACHE_KEY, integrations, CACHE_TTL_MS)
  return { success: true, integrations: withNativeGoogle(integrations) }
})
