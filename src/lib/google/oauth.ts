/**
 * Native Google OAuth — replaces Nango for Google providers (Google blocks
 * Nango's flow). Auth-code + refresh against OUR verified OAuth client.
 * Env is read at call time so builds succeed without configuration.
 */
import crypto from 'crypto'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
const STATE_TTL_MS = 10 * 60 * 1000
const TOKEN_TIMEOUT_MS = 10_000

export const GOOGLE_SERVICE_SCOPES = {
  // gmail.send only: it is a "sensitive" scope, so app verification skips the
  // annual CASA security assessment that any "restricted" scope (e.g.
  // gmail.readonly) would trigger. Add read scopes only alongside a shipped
  // feature that uses them.
  'google-mail': [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  // calendar.readonly powers the Calendar ActivitySource (historical meetings
  // feed the org's usage-pattern ledger); calendar.events adds event
  // read/write for the calendar delivery tools. Both are "sensitive" scopes
  // (same verification class as gmail.send — no CASA assessment). Existing
  // connections must reconnect to grant the added events scope.
  'google-calendar': [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  // spreadsheets is a "sensitive" scope: full read/write of sheet contents,
  // no CASA assessment.
  'google-sheets': [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  // drive.file is per-file access (files this app creates or the user picks)
  // and is NON-sensitive. The broad drive/drive.readonly scopes are
  // "restricted" — they trigger the annual CASA assessment; do not add them
  // without that review budgeted.
  'google-drive': [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
} as const

export type GoogleOAuthService = keyof typeof GOOGLE_SERVICE_SCOPES

export function googleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID
      && process.env.GOOGLE_OAUTH_CLIENT_SECRET
      && process.env.GOOGLE_OAUTH_REDIRECT_URI,
  )
}

function requireEnv(name: 'GOOGLE_OAUTH_CLIENT_ID' | 'GOOGLE_OAUTH_CLIENT_SECRET' | 'GOOGLE_OAUTH_REDIRECT_URI'): string {
  // Trimmed: stray whitespace pasted into deployment env (e.g. a trailing
  // newline) URL-encodes into the consent request, which Google rejects as
  // an OAuth policy violation.
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Native Google OAuth is not configured. Please set ${name}`)
  return value
}

// ── Signed state (CSRF + context transport through Google) ──────────────────

function stateKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY is required for Google OAuth state signing')
  return crypto.createHash('sha256').update(`google-oauth-state:${raw}`).digest()
}

type StatePayload = { organizationId: string; userId: string; service: GoogleOAuthService }

export function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS })).toString('base64url')
  const mac = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyState(raw: string): StatePayload | null {
  const [body, mac] = raw.split('.')
  if (!body || !mac) return null
  const expected = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')
  const macBuf = Buffer.from(mac)
  const expectedBuf = Buffer.from(expected)
  if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as StatePayload & { exp: number }
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null
    if (!(parsed.service in GOOGLE_SERVICE_SCOPES)) return null
    if (!parsed.organizationId || !parsed.userId) return null
    return { organizationId: parsed.organizationId, userId: parsed.userId, service: parsed.service }
  } catch {
    return null
  }
}

// ── Consent URL ─────────────────────────────────────────────────────────────

export function buildAuthUrl(input: { service: GoogleOAuthService; state: string }): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', requireEnv('GOOGLE_OAUTH_CLIENT_ID'))
  url.searchParams.set('redirect_uri', requireEnv('GOOGLE_OAUTH_REDIRECT_URI'))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('access_type', 'offline')
  // Force the consent screen so Google returns a refresh token on every
  // connect (it omits one on silent re-approval).
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('scope', GOOGLE_SERVICE_SCOPES[input.service].join(' '))
  url.searchParams.set('state', input.state)
  return url.toString()
}

// ── Token endpoints ─────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

async function tokenRequest(params: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  const response = await withTimeout(
    fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }),
    TOKEN_TIMEOUT_MS,
    label,
  )
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail = typeof data.error === 'string' ? data.error : `status ${response.status}`
    throw new Error(`${label} failed: ${detail}`)
  }
  return data
}

export async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number; scope: string }> {
  const data = await tokenRequest(
    {
      code,
      client_id: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      redirect_uri: requireEnv('GOOGLE_OAUTH_REDIRECT_URI'),
      grant_type: 'authorization_code',
    },
    'Google code exchange',
  )
  return {
    accessToken: String(data.access_token ?? ''),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresIn: Number(data.expires_in ?? 0),
    scope: String(data.scope ?? ''),
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await tokenRequest(
    {
      refresh_token: refreshToken,
      client_id: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      grant_type: 'refresh_token',
    },
    'Google token refresh',
  )
  return { accessToken: String(data.access_token ?? ''), expiresIn: Number(data.expires_in ?? 0) }
}

export async function fetchAccountEmail(accessToken: string): Promise<string> {
  const response = await withTimeout(
    fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } }),
    TOKEN_TIMEOUT_MS,
    'Google userinfo',
  )
  if (!response.ok) throw new Error(`Google userinfo failed: status ${response.status}`)
  const data = (await response.json()) as { email?: string }
  if (!data.email) throw new Error('Google userinfo returned no email')
  return data.email
}

/** Best-effort revocation — a failed revoke must not block disconnect. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await withTimeout(
      fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' }),
      TOKEN_TIMEOUT_MS,
      'Google token revoke',
    )
  } catch {
    // Ignored: the row is deleted regardless; Google GC's the grant.
  }
}
