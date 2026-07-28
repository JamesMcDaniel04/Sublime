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
  /**
   * When present, this integration is configured on its own page rather than
   * through a Connect flow — the card navigates here instead. Used by
   * integrations that hold several named connections (Postgres), which no
   * binary Connect/Disconnect card can express.
   */
  configPath?: string
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
  const nativeCapabilities: DeliveryCapability[] = ['gmail', 'calendar', 'sheets', 'drive', 'analytics']
  const withoutNangoGoogle = integrations.filter((integration) => {
    const capability = capabilityForProviderConfigKey(integration.id)
    return !(capability && nativeCapabilities.includes(capability))
      && !integration.id.toLowerCase().includes('calendar')
  })
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
      capability: 'calendar' as DeliveryCapability,
      native: true,
    },
    {
      id: 'google-sheets',
      provider: 'google-sheets',
      name: 'Google Sheets',
      capability: 'sheets' as DeliveryCapability,
      native: true,
    },
    {
      id: 'google-drive',
      provider: 'google-drive',
      name: 'Google Drive',
      capability: 'drive' as DeliveryCapability,
      native: true,
    },
    {
      id: 'google-analytics',
      provider: 'google-analytics',
      name: 'Google Analytics',
      capability: 'analytics' as DeliveryCapability,
      native: true,
    },
    ...withoutNangoGoogle,
  ]
}

/** Postgres has no Nango provider, so its tile is added here unconditionally.
 *  It carries a configPath rather than a Connect flow because one org holds
 *  several named databases. */
const POSTGRES_CHIP: IntegrationChip = {
  id: 'postgres',
  provider: 'postgresql',
  name: 'PostgreSQL',
  native: true,
  configPath: '/integrations/postgres',
}

const withNativeIntegrations = (integrations: IntegrationChip[]): IntegrationChip[] => [
  ...withNativeGoogle(integrations),
  POSTGRES_CHIP,
]

// Lists the integrations enabled on the Nango environment. These are the
// apps a user can connect from the integrations page.
export const GET = withAuthenticatedApi(async () => {
  // Native-only deployments (no Nango key) still offer Gmail and Postgres.
  if (!nangoConfigured()) return { success: true, integrations: withNativeIntegrations([]) }

  const hit = await cacheGet<IntegrationChip[]>(CACHE_KEY)
  if (hit) return { success: true, integrations: withNativeIntegrations(hit) }

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
  return { success: true, integrations: withNativeIntegrations(integrations) }
})
