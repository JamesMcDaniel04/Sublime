# Native Google OAuth (Gmail First)

**Date:** 2026-07-19
**Status:** Approved

## Goal

Google is blocking Nango's OAuth flow, so Gmail connections must run on our own
verified Google Cloud OAuth client. Build a native Google OAuth layer — Gmail
ships now at full parity (send + intelligence scan); Calendar/Drive can reuse
the same client later by adding scope sets. Nango stays for all non-Google
providers.

## Confirmed constraints (user)

- A verified (or in-review) Google Cloud OAuth client exists.
- Layer is Google-generic, Gmail-first — not a provider-agnostic framework.
- Parity capabilities: `gmail_send_email` tool and the intelligence scan plane
  (`gmail.send` + `gmail.readonly` + `userinfo.email` scopes).

## Architecture

The existing seams make this a low-blast-radius change:

- Every delivery adapter in `src/lib/nango/delivery.ts` accepts an injectable
  `proxy: NangoProxy = (args: { method, endpoint, connectionId,
  providerConfigKey, data?, params? }) => Promise<{ data: unknown }>`.
- The integrations grid, `/api/nango/status`, the tool plane, and the scan
  plane all read the Postgres-mirrored `NangoConnection` table — not Nango's
  API — keyed by `providerConfigKey`.

So the native path implements `NangoProxy` and mirrors its connections into
`NangoConnection`; adapters and read paths stay unchanged.

### Components

1. **`src/lib/google/oauth.ts`** — pure OAuth2 module:
   - `googleOAuthConfigured()`: true when `GOOGLE_OAUTH_CLIENT_ID`,
     `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` are set (read at
     call time, never module load — same rule as `getNangoClient`).
   - `GOOGLE_SERVICE_SCOPES = { 'google-mail': ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email'] }`.
   - `buildAuthUrl({ service, state })`: consent URL with `access_type=offline`,
     `prompt=consent`, `include_granted_scopes=true`.
   - `signState(payload)` / `verifyState(raw)`: HMAC-SHA256 over
     `{ organizationId, userId, service, exp }` keyed from `ENCRYPTION_KEY`
     (10-minute expiry); tamper or expiry ⇒ null.
   - `exchangeCode(code)`, `refreshAccessToken(refreshToken)`,
     `revokeToken(token)` — `fetch` against Google token endpoints with
     timeouts.
2. **Prisma model `GoogleOAuthConnection`** — id (`gconn_` cuid), organizationId,
   userId, service (`google-mail`), accountEmail, scopes (string[]),
   `refreshTokenEnc` (AES-GCM via `src/lib/crypto/secrets.ts`), status,
   lastError, timestamps. Unique on `(organizationId, userId, service,
   accountEmail)`.
   Each row mirrors into `NangoConnection` (`connectionId` = the
   GoogleOAuthConnection id, `providerConfigKey` = service, `provider` =
   `'google-native'`) so every existing read path works unchanged.
3. **Routes**
   - `GET /api/google/oauth/start?service=google-mail` — authed
     (`withAuthenticatedApi`), 302 to consent URL with signed state.
   - `GET /api/google/oauth/callback` — no auth cookie assumptions beyond state
     verification; exchanges the code, fetches userinfo for accountEmail,
     encrypts + stores the refresh token, upserts the mirror row, fires the
     same post-connect scan Nango connections get, then 302 to
     `/integrations?connected=gmail` (or `?error=...`).
   - `DELETE /api/google/oauth/connections/[id]` — authed; revokes at Google
     (best-effort), deletes both rows, purges connection learnings the same
     way the Nango disconnect path does.
4. **`src/lib/google/proxy.ts`**
   - `googleProxy(connectionId): NangoProxy` — decrypts the refresh token,
     mints/caches an access token (in-memory `Map` keyed by connection id, with
     expiry slack), retries exactly once on 401 after a forced refresh, maps
     `endpoint` to `https://gmail.googleapis.com` (falls back to
     `https://www.googleapis.com` for non-Gmail paths), 20s timeout parity
     with the Nango proxy.
   - `proxyForConnection(connection): NangoProxy` — selector used at adapter
     call sites: `provider === 'google-native'` ⇒ native proxy, else the Nango
     default. Refresh failure (revoked/expired grant) marks the mirror row
     `status: 'error'` + `lastError` and surfaces the existing delivery error.
5. **UI (`src/app/integrations/oauth-integrations-grid.tsx`)** — the Gmail
   Connect button navigates to `/api/google/oauth/start?service=google-mail`
   when the status payload reports native mode; otherwise falls back to the
   Nango session-token flow. Disconnect calls the native DELETE for
   `google-native` connections. `/api/nango/status` gains
   `nativeGoogle: boolean` (from `googleOAuthConfigured()`) and skips
   `google-native` rows in any Nango-cloud reconciliation.

### Coexistence & migration

- Existing Nango Gmail connections (if any) keep working through Nango until
  disconnected; new connections always go native when configured.
- No data migration. The `google-native` provider marker is the only
  discriminator.

## Error handling

- Callback errors (state invalid/expired, exchange failure, userinfo failure)
  redirect to `/integrations?error=<code>` — never render a bare 500 page.
- Refresh failures mark status `error` with `lastError`; the grid already
  renders error states for mirrored rows.
- All Google `fetch` calls are timeout-raced (10s token endpoints, 20s proxy),
  mirroring `withTimeout` in delivery.ts.

## Testing

- Unit: state sign/verify round-trip + tamper/expiry rejection; scope sets;
  auth-URL shape; refresh-on-401-once semantics and access-token cache (mocked
  `fetch`); endpoint→URL mapping.
- Route-smoke (throwaway Postgres per the repo verify protocol): start route
  302s with valid signed state embedded; callback with a forged state 302s to
  error; disconnect deletes both rows.
- Existing delivery/actions tests stay green (adapters untouched).

## Out of scope

- Calendar/Drive scope sets (add later to `GOOGLE_SERVICE_SCOPES` + proxy base
  mapping).
- Migrating non-Google providers off Nango.
- Google workspace-wide (domain) delegation.
