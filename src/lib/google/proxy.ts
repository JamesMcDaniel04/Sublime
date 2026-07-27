/**
 * NangoProxy-compatible executor for native Google connections. Delivery
 * adapters keep their exact call shape; only the transport differs: a bearer
 * token minted from the stored refresh token, cached in-memory per connection.
 */
import type { DeliveryConnection, NangoProxy, NangoProxyArgs } from '@/lib/nango/delivery'
import { refreshAccessToken } from './oauth'
import { GOOGLE_NATIVE_PROVIDER, getGoogleConnection, markGoogleConnectionError } from './store'

const PROXY_TIMEOUT_MS = 20_000
const EXPIRY_SLACK_MS = 60_000

type CachedToken = { accessToken: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()

type Hooks = {
  loadConnection: typeof getGoogleConnection extends (input: infer I) => infer R ? (input: I) => R : never
  refresh: typeof refreshAccessToken
  fetchImpl: typeof fetch
  markError: typeof markGoogleConnectionError
}
const defaultHooks: Hooks = {
  loadConnection: (input) => getGoogleConnection(input),
  refresh: refreshAccessToken,
  fetchImpl: fetch,
  markError: markGoogleConnectionError,
}
let hooks: Hooks = { ...defaultHooks }

/** Test seam: swap the DB/token/fetch dependencies without module mocking. */
export const __testHooks = {
  set(next: Partial<Hooks>) {
    hooks = { ...hooks, ...next }
  },
  reset() {
    hooks = { ...defaultHooks }
  },
}

export function clearGoogleTokenCache(): void {
  tokenCache.clear()
}

export function isGoogleNativeProvider(provider: string | null | undefined): boolean {
  return provider === GOOGLE_NATIVE_PROVIDER
}

function baseUrlFor(endpoint: string): string {
  if (endpoint.startsWith('/gmail/')) return 'https://gmail.googleapis.com'
  // Sheets v4 lives on its own host; Drive (incl. /upload) and Calendar ride www.
  if (endpoint.startsWith('/v4/spreadsheets')) return 'https://sheets.googleapis.com'
  // GA4 splits across two hosts that share the /v1beta prefix: property
  // discovery rides the Admin API (accountSummaries only), reports ride the
  // Data API (properties/{id}:runReport et al.).
  if (endpoint.startsWith('/v1beta/accountSummaries')) return 'https://analyticsadmin.googleapis.com'
  if (endpoint.startsWith('/v1beta/properties')) return 'https://analyticsdata.googleapis.com'
  return 'https://www.googleapis.com'
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

type GoogleConnectionRef = { organizationId: string; connectionId: string }

async function accessTokenFor(ref: GoogleConnectionRef, force: boolean): Promise<string> {
  const cached = tokenCache.get(ref.connectionId)
  if (!force && cached && cached.expiresAt > Date.now() + EXPIRY_SLACK_MS) return cached.accessToken
  const connection = await hooks.loadConnection({ organizationId: ref.organizationId, id: ref.connectionId })
  if (!connection) throw new Error(`Google connection ${ref.connectionId} not found`)
  try {
    const { accessToken, expiresIn } = await hooks.refresh(connection.refreshToken)
    tokenCache.set(ref.connectionId, { accessToken, expiresAt: Date.now() + expiresIn * 1000 })
    return accessToken
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Revoked/expired grant: surface on the mirrored row so the grid shows it.
    await hooks.markError({ organizationId: ref.organizationId, id: ref.connectionId }, message).catch(() => undefined)
    throw new Error(`Google token refresh failed for connection ${ref.connectionId}: ${message}`)
  }
}

async function execute(args: NangoProxyArgs, accessToken: string): Promise<Response> {
  const url = new URL(baseUrlFor(args.endpoint) + args.endpoint)
  for (const [key, value] of Object.entries(args.params ?? {})) url.searchParams.set(key, String(value))
  // String data is a raw body (media uploads) — JSON.stringify would wrap it
  // in quotes and corrupt the file. Objects remain JSON.
  const raw = typeof args.data === 'string'
  return withTimeout(
    hooks.fetchImpl(url.toString(), {
      method: args.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(args.data !== undefined ? { 'Content-Type': raw ? args.contentType ?? 'text/plain' : 'application/json' } : {}),
      },
      ...(args.data !== undefined ? { body: raw ? (args.data as string) : JSON.stringify(args.data) } : {}),
    }),
    PROXY_TIMEOUT_MS,
    `Google proxy ${args.method} ${args.endpoint}`,
  )
}

export function googleProxy(ref: GoogleConnectionRef): NangoProxy {
  return async (args) => {
    let response = await execute(args, await accessTokenFor(ref, false))
    if (response.status === 401) {
      // One forced-refresh retry: covers stale cache entries, not revoked grants.
      response = await execute(args, await accessTokenFor(ref, true))
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Google API ${args.method} ${args.endpoint} failed (${response.status}): ${body.slice(0, 300)}`)
    }
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text()
    return { data }
  }
}

/** Adapter call sites: native connections route through googleProxy; an
 *  undefined return means "use the caller's default (Nango) proxy". */
export function proxyForConnection(connection: DeliveryConnection): NangoProxy | undefined {
  return isGoogleNativeProvider(connection.provider) && connection.organizationId
    ? googleProxy({ organizationId: connection.organizationId, connectionId: connection.connectionId })
    : undefined
}
