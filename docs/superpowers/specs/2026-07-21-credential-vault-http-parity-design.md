# Reusable Credential Vault + HTTP Node n8n-Parity

**Date:** 2026-07-21
**Status:** Approved (design)

## Goal

Harden flow nodes so users can (1) configure a full, real API request on the
HTTP node at n8n parity, and (2) save credentials **once** and reuse them from
any node in any flow across the workspace. Credentials are a first-class,
org-scoped vault — not typed inline, not per-flow. The feature must be
**functional end to end**: the node sends real outbound requests with the saved
credential injected server-side; the vault has real CRUD; secrets are really
encrypted and never leak into graph JSON, run rows, logs, or client payloads.

This is a UX/behaviour parity effort, not a visual clone. Every control must do
what it says — a saved Bearer credential attached to a node must produce a real
`Authorization: Bearer …` on the wire.

## Confirmed decisions (user)

- **Mechanism: both.** Phase 1 = static credential vault + HTTP-node parity.
  Phase 2 = a runtime "authenticate" node that fetches/refreshes dynamic tokens
  into the same vault. Both are referenced identically (by `credentialId`).
- **Phase 1 auth schemes (the "Core 5"):** Basic, Bearer, Header (single custom
  header, e.g. `X-API-Key`), Query (API key in query param), and Custom
  (multiple headers/query params). Deferred: OAuth2 → Phase 2; Digest, OAuth1 →
  future/never.
- **Scope/sharing:** org-shared by default; creator can mark a credential
  personal. Mirrors the `userId`-nullable pattern of `McpConnection`.
- **No inline secret tokens.** Credentials attach through a structured picker
  (`credentialId`). `{{secret.*}}` is explicitly rejected. The existing
  `{{step.*}}` token editor stays — that references prior-step *data*, the
  analog of n8n expressions, and is unrelated to secrets.
- **"Predefined Credential Type"** in the node = the existing connection path
  (today: MCP connections, via the current `connectionId` resolver). We do
  **not** rebuild n8n's catalog of hundreds of service presets. Surfacing Nango
  connections here is a possible follow-on (it needs a Nango-token resolver the
  HTTP path doesn't have today) and is not required for Phase 1.

## Architecture

The codebase already carries the two invariants this feature depends on:

- **Secrets discipline.** Tokens are resolved server-side at fetch time and
  injected into the outbound request only — never persisted. `redactHttpStepInput`
  / `redactAuthHeaders` (`src/features/flows/http.ts`) and the redacted-view
  pattern of `redactConfig` (`src/lib/crypto/secrets.ts`) enforce it today.
- **Encryption at rest.** `encryptSecret` / `decryptSecret` (AES-256-GCM via
  `ENCRYPTION_KEY`, required in production) already back `McpConnection.authConfig`
  and `IntegrationSecret.authConfig`.

So the vault is **additive**: a new table + a new `src/lib/credentials/` module,
plus a new resolve→inject call in the existing HTTP block of
`execute-flow.ts`. No existing auth path changes; the current McpConnection
`connectionId` path keeps working as "Predefined".

### Components

1. **Prisma model `Credential`** (`credentials` table)

   ```prisma
   model Credential {
     id             String    @id @default(cuid())
     organizationId String    @db.Uuid
     userId         String?   // null = org-shared; set = personal to creator
     name           String
     type           String    // basic | bearer | apiKeyHeader | apiKeyQuery | custom
     authConfig     Json      @default("{}") // encrypted secret fields + plaintext metadata
     allowedDomains String[]  @default([])   // egress allow-list; [] = all (warned in UI)
     isActive       Boolean   @default(true)
     createdById    String?
     lastUsedAt     DateTime?
     createdAt      DateTime  @default(now())
     updatedAt      DateTime  @updatedAt

     organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
     user         User?        @relation(fields: [userId], references: [id], onDelete: Cascade)

     @@unique([organizationId, userId, name])
     @@index([organizationId, isActive])
     @@index([organizationId, userId, isActive])
     @@map("credentials")
   }
   ```

   `authConfig` per type — secret fields encrypted with `encryptSecret`,
   metadata plaintext:
   - `basic` → `{ username, password(enc) }`
   - `bearer` → `{ token(enc) }`
   - `apiKeyHeader` → `{ headerName, key(enc) }`
   - `apiKeyQuery` → `{ queryParam, key(enc) }`
   - `custom` → `{ headers: [{name, value(enc)}], query: [{name, value(enc)}] }`

   Postgres treats NULL as distinct in unique keys (same as `McpConnection`), so
   **org-shared name uniqueness is enforced in the API layer**, not the DB.

2. **`src/lib/credentials/` module** — the functional core.
   - `config.ts` — `buildCredentialConfig(type, input)` / `mergeCredentialConfig`
     / `redactCredential` (a `redactConfig`-style safe view: `hasPassword: true`,
     never a value). Reuses `encryptSecret`/`decryptSecret`; handles per-value
     encryption for `custom`.
   - `scope.ts` — `credentialScope(orgId, userId)` → the org-shared-plus-own
     `where` clause (mirrors `mcpConnectionScope`).
   - `resolve.ts` — `resolveCredential({ credentialId, organizationId, userId, requestUrl })`:
     load in-scope + active row → **enforce `allowedDomains` against
     `requestUrl`'s host (throw a plain-English error on mismatch)** → decrypt →
     return a typed **injection plan**, not a raw string. Best-effort async
     `lastUsedAt` touch.

     ```ts
     type InjectionPlan = { headers?: Record<string,string>; query?: Record<string,string> }
     ```

     - `basic` → `{ headers: { authorization: 'Basic ' + base64(user:pass) } }`
     - `bearer` → `{ headers: { authorization: 'Bearer ' + token } }`
     - `apiKeyHeader` → `{ headers: { [headerName]: key } }`
     - `apiKeyQuery` → `{ query: { [queryParam]: key } }`
     - `custom` → merged headers + query
   - `apply.ts` — `applyCredentialPlan(request, plan)`: apply to the outbound
     `RequestInit`. **Precedence: a user-provided value always wins** — the plan
     fills a header/query key only when the request doesn't already carry a
     non-empty value for it (generalizes today's `withBearerAuthorization`).
   - Errors reuse the existing `HTTP_CONNECTION_UNAVAILABLE`-style plain-language
     shape (`CREDENTIAL_UNAVAILABLE`, `CREDENTIAL_DOMAIN_BLOCKED`).

3. **HTTP node config + execution**
   - New config fields (all back-compatible; absent = today's behaviour):
     `authMode: 'none' | 'predefined' | 'generic'`, `credentialId?` (generic
     vault ref), keeping existing `connectionId?` (predefined MCP/Nango ref);
     `sendQuery` / `sendHeaders` / `sendBody` booleans (default derived from
     whether the field is non-empty, so existing flows are unchanged).
   - `execute-flow.ts` HTTP block (`~L678`): after `prepareHttpRequest`, if
     `authMode==='generic' && credentialId` → `resolveCredential({… requestUrl:
     request.url})` → `applyCredentialPlan`; else keep the existing
     `connectionId` (predefined) path. The SSRF guard `assertPublicUrl` still
     runs on every hop; `allowedDomains` is the credential-scoped complement.
   - No new persisted secrets: `credentialId`, header *names*, and query *keys*
     are non-secret; injected *values* live only in the transient request.
     `redactHttpStepInput` still redacts user-typed auth headers.

4. **Credentials vault API** (`withAuthenticatedApi`, org-scoped)
   - `GET /api/credentials` — list redacted (org-shared + own).
   - `POST /api/credentials` — create (rejects duplicate org-shared name).
   - `GET /api/credentials/[id]` — redacted detail.
   - `PUT /api/credentials/[id]` — update; `mergeCredentialConfig` preserves
     omitted secret fields (re-enter to change).
   - `DELETE /api/credentials/[id]`.
   - Writes emit `AuditEvent` (create/update/delete).

5. **UI**
   - **Credentials manager** (Settings → Credentials, alongside Connections):
     list, create/edit modal with type-specific masked fields, sharing toggle
     (org-shared ↔ personal), `allowedDomains` editor, delete. Redacted reads
     only; secret inputs are write-only + masked.
   - **HTTP node step-card** — n8n-parity Parameters surface:
     - **Import cURL** button → client-side parser fills method/URL/headers/
       query/body (no schema change).
     - **Authentication** select: `None` / `Predefined Credential Type`
       (existing MCP/Nango connections) / `Generic Credential Type` → auth-type
       select (Basic/Bearer/Header/Query/Custom) → credential picker + inline
       **"Set up credential"** (opens the manager's create modal, preselecting
       type) and a pencil to edit.
     - **Send Query Parameters / Send Headers / Send Body** enable-toggles over
       the existing structured editors; body-type select unchanged.
     - **Options** — fill the small gaps toward n8n (response: include
       headers/status, response format; never-error = existing `failOnHttpError`
       inverse; redirects, timeout, retries, pagination already exist).

### Coexistence & migration

- New table via `prisma migrate`. No data migration.
- Existing HTTP `connectionId` (predefined) path untouched and still resolves
  McpConnection tokens.
- `sendHeaders/sendQuery/sendBody` default to `true` whenever the matching field
  is non-empty, so every existing flow behaves exactly as before.

## Error handling

- `resolveCredential` throws plain-language errors surfaced on the run step:
  missing/out-of-scope/inactive credential (`CREDENTIAL_UNAVAILABLE`), or a
  request URL whose host isn't in `allowedDomains` (`CREDENTIAL_DOMAIN_BLOCKED`)
  — the secret is never sent to a non-allowed host.
- Vault API: 404 on out-of-scope id (no cross-org existence leak); 409 on
  duplicate org-shared name; 400 on unknown `type` / malformed `authConfig`.
- `ENCRYPTION_KEY` absent in production already hard-fails in `secrets.ts`;
  the vault inherits that.

## Testing

Functionality is the acceptance bar — tests must prove real requests carry the
credential and that secrets never persist.

- **Unit:** `resolveCredential` per type (correct header/query injection);
  scope isolation (org-shared vs personal vs cross-org denial); `allowedDomains`
  allow + block; `applyCredentialPlan` precedence (user value wins);
  `buildCredentialConfig`/`merge`/`redactCredential` round-trip and
  never-leak-secret; the cURL parser.
- **Route-smoke** (throwaway Postgres, repo `verify` skill): `/api/credentials`
  CRUD with seeded auth (create → list redacted → update → delete; duplicate
  name → 409; cross-org id → 404).
- **End-to-end injection:** a flow run whose HTTP node references a vault
  credential hits a stub server and asserts (a) the inbound request carried the
  correct auth header/param, and (b) the persisted `FlowRunStep.input` contains
  **no** secret and no injected auth value.

## Later phases (out of scope for Phase 1)

- **Phase 2 — runtime auth node.** A new `authenticate` step type that runs a
  configured token request, extracts the token, and **upserts a managed
  `Credential`** (new types `oauth2ClientCreds` and `managedToken`, with
  `expiresAt`) referenced by id from any node/flow — same resolver, same
  injection path, with resolver-side auto-refresh (mirrors
  `ensureFreshConnectionToken`). Full OAuth2 (client-credentials +
  authorization-code redirect) lands here.
- **Never/until-asked:** Digest Auth, OAuth1 (request signing), external secret
  vaults, and per-credential ACLs beyond org/personal.
