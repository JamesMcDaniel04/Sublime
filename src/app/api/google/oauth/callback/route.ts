import { NextResponse, after, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { GOOGLE_SERVICE_SCOPES, exchangeCode, fetchAccountEmail, verifyState } from '@/lib/google/oauth'
import { upsertGoogleConnection } from '@/lib/google/store'
import { scanConnection, shouldScanNangoConnection } from '@/lib/intelligence/connection-scan'
import { triggerAutoBackfills } from '@/lib/activity/auto-backfill'
import { capabilityForProviderConfigKey } from '@/lib/nango/delivery'
import { fromNangoProviderKey } from '@/lib/connectors/registry'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'

/** Google redirects the browser here; org/user context rides in the signed
 *  state (no session assumptions). Every failure 302s back to /integrations
 *  with an error code — never a bare 500 page. */
export async function GET(request: NextRequest): Promise<Response> {
  const redirect = (suffix: string) => NextResponse.redirect(new URL(`/integrations${suffix}`, request.nextUrl.origin))
  const params = request.nextUrl.searchParams
  if (params.get('error')) return redirect(`?error=${encodeURIComponent(params.get('error') ?? 'denied')}`)

  const state = verifyState(params.get('state') ?? '')
  if (!state) return redirect('?error=invalid_state')
  const code = params.get('code')
  if (!code) return redirect('?error=missing_code')

  try {
    const tokens = await exchangeCode(code)
    // Google only returns a refresh token with prompt=consent; without one the
    // connection would die when the access token expires — treat as failure.
    if (!tokens.refreshToken) return redirect('?error=no_refresh_token')
    const accountEmail = await fetchAccountEmail(tokens.accessToken)

    // Scan gating matches the Nango status route: scan when the mirror row is
    // newly connected (or recovering from error), not on every re-auth.
    const previous = await prisma.nangoConnection.findFirst({
      where: { organizationId: state.organizationId, providerConfigKey: state.service, provider: 'google-native', userId: state.userId },
      select: { status: true },
    })

    const { id: googleConnectionId } = await upsertGoogleConnection({
      organizationId: state.organizationId,
      userId: state.userId,
      service: state.service,
      accountEmail,
      scopes: tokens.scope ? tokens.scope.split(' ') : [...GOOGLE_SERVICE_SCOPES[state.service]],
      refreshToken: tokens.refreshToken,
    })

    // Services with a registered ActivitySource (calendar) start their
    // historical backfill the moment the grant lands — the same on-connect
    // learning leg the Nango status route fires for github. No-op for
    // services without an adapter (gmail is send-only by scope policy).
    const runBackfill = () =>
      triggerAutoBackfills(state.organizationId, [
        { connectionId: googleConnectionId, providerConfigKey: state.service },
      ]).catch(() => undefined)
    try {
      after(runBackfill)
    } catch {
      void runBackfill()
    }

    if (shouldScanNangoConnection(previous ?? undefined, true)) {
      const capability = capabilityForProviderConfigKey(state.service)
      if (capability) {
        const runScan = () =>
          scanConnection({
            organizationId: state.organizationId,
            userId: state.userId,
            plane: 'nango',
            connectionRef: capability,
            connectionName: fromNangoProviderKey(state.service).label,
          }).catch((error) => {
            apiLogger.warn('google-oauth: post-connect scan failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        // Fire-and-forget; `after` throws outside a real request scope.
        try {
          after(runScan)
        } catch {
          void runScan()
        }
      }
    }
    return redirect(`?connected=${encodeURIComponent(state.service)}`)
  } catch (error) {
    apiLogger.error('google-oauth: callback failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return redirect('?error=exchange_failed')
  }
}
