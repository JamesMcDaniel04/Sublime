# Self-Serve Tenancy & Per-User Klavis Credentials — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorming session with owner)

## Problem

New users who sign up without a pending invitation are blocked from every feature
with **403 "Organization access required"**. The chain:

1. Sign-up creates only a Supabase Auth identity (`src/app/auth/signup/page.tsx`).
2. On the first authenticated request, `provisionUser`
   (`src/lib/supabase/auth-utils.ts:38`) finds no invitation and hits the
   production gate at lines 58–60: `AUTH_ALLOW_JIT_PROVISIONING !== 'true'` →
   returns `null`. No `User` row, no `Organization` row.
3. `requireAuthContext` (`src/lib/server/auth.ts:47-49`) throws 403, and since
   every API route is wrapped in `withAuthenticatedApi`, the whole app is blocked.

The owner's goals:

1. New sign-ups are usable immediately — no manual invitation required.
2. Users get access to **all Klavis integrations the owner configured**.
3. **Only** the Klavis integration catalogue and templates are shared with users.
   Nothing else from the owner's org (agents, data, connections, members).
4. Users authenticate tools with **their own credentials** — never the owner's,
   and never visible to other users.
5. Users can operate their own org and invite their own users.

## Decision summary

**Every sign-up automatically receives its own organization**. This is an
application invariant rather than a deployment flag. There is **no shared/default org** and no
`DEFAULT_ORG_ID`: both things the owner wants shared are already shared at the
platform level, independent of org membership:

- **Klavis catalogue** — `GET /api/mcp/connections`
  (`src/app/api/mcp/connections/route.ts:42`) lists providers from the
  account-level `KLAVIS_API_KEY` live catalogue. Every org in the deployment
  sees exactly the providers the owner enabled in Klavis. Per-user connection
  status/OAuth is layered on top separately.
- **Templates** — `GET /api/agent-templates`
  (`src/app/api/agent-templates/route.ts:62-83`) is a public cross-org
  community library (via `systemPrisma`) plus the built-in seed catalogue.
  Only org-specific auto-generated templates stay private to their org.

Everything the owner does **not** want shared is protected structurally by org
isolation, because users are never members of the owner's org.

### Design arc (for the record)

The original framing was "two org IDs: a shared org + own orgs." Two
clarifications during brainstorming overturned it: (a) only Klavis integrations
and templates may be shared, nothing else in the owner's org; (b) users must
authenticate with their own credentials, never the owner's. A shared org would
require invasive per-user isolation inside one org (members list, runtime tool
planes, documents, flows) and fights the app's org-isolation architecture. The
earlier interim decisions (`DEFAULT_ORG_ID` env var, join-shared-org-as-USER,
"create my own org" settings action) are **superseded and dropped**.

## Changes

### 1. Guarantee self-serve tenancy (fixes the 403 block)

- Remove the `AUTH_ALLOW_JIT_PROVISIONING` gate. If signup is enabled and
  Supabase accepts the identity, the application must create its membership.
- Provision during the auth callback and keep first-request provisioning as a
  self-healing fallback for password login and existing org-less identities.
- The provisioning path
  - honors pending invitations first (invitation joins win, unchanged),
  - names the new org from the signup form's `organization_name` metadata
    (falling back to full name / email prefix),
  - makes the creator `ADMIN` of their own org (so they can connect
    integrations and invite their own users),
  - handles provisioning races (`auth-utils.ts:83-87`).

Invitation/SSO-only installations disable signup at Supabase and set
`AUTH_ALLOW_PASSWORD=false`; they do not represent a valid authenticated user
as an org-less application identity.

### 2. Per-user Klavis connect for all members

- Remove the `ADMIN`-only gates on `POST` and `DELETE`
  `/api/mcp/connections` (`route.ts:74`, `route.ts:123`). Any active member of
  an org may connect/disconnect **their own** provider connections.
- This is safe because the handlers are already per-user under the hood:
  `createServersForTenant(..., auth.dbUser.id, ...)` creates a per-user
  `MCPAgent` row (Klavis end-user id `${organizationId}:${userId}`), and
  `removeServerConnection(orgId, provider, userId)` deletes only the caller's.
- Effect: users invited into a customer's org (role `USER`) can authenticate
  their own credentials, satisfying goal 4 for multi-member orgs.
- Admin gates elsewhere (org settings, members, org-shared MCP servers via
  `/api/mcp-connections`) are unchanged.

### 3. Runtime credential isolation in tool planes (bug fix)

`loadKlavisPlaneGroups(organizationId, …)`
(`src/features/agents/tool-planes.ts:121-134`) queries `MCPAgent` by
`organizationId` only, so in any multi-member org, one member's agents can
execute tools through another member's connected credentials. This violates
goal 4.

- Change `loadKlavisPlaneGroups` to require the acting user:
  filter `MCPAgent` by `{ organizationId, userId, isActive: true }`.
  (`MCPAgent.userId` is non-null; unlike `McpConnection` there is no
  org-shared Klavis row, so a strict per-user filter is correct.)
- Thread the acting user's id through the three call sites:
  - `src/features/agents/execute-agent.ts:261` — the run's initiating user.
  - `src/lib/flows/tool-catalog.ts:46` — the flow's acting user.
  - For non-interactive triggers of either (schedules, Slack events), use the
    owning resource's creator `userId`. (Implementation plan must verify where
    each non-interactive path sources its user identity — this is the one open
    verification item.)
  - `src/lib/intelligence/connection-scan.ts:246` — `scanConnection` already
    receives `userId`; pass it through.
- Caching is unaffected: `getConnectionStatuses` is already keyed per
  `(org, user)`; `toolDiscoveryCacheKey` is per `(org, serverUrl)` and server
  URLs are per-instance.

## Out of scope

- Multi-org membership / org switcher (deliberately deferred in the codebase).
- Any shared/default org mechanism.
- Template publishing rules (community library behavior stays exactly as-is).
- Scoping changes to Nango, Slack, `IntegrationSecret`, or custom MCP
  (`McpConnection`) — `mcpConnectionScope` already models own + org-shared.

## Error handling

- **Provisioning failure** → the auth callback stops before application entry
  and authenticated APIs surface a server error rather than a misleading 403.
- **Klavis end-user cap** — Klavis limits distinct end-users per account
  (`klavis-client.ts` `limit_reached` → HTTP 409 surfaced to the UI). Each user
  who connects counts against the owner's Klavis plan. Operational constraint,
  not handled in code beyond the existing 409.
- **Provisioning races** — existing try/catch + re-read in `provisionUser`.

## Security considerations

- Anyone who can complete sign-up gets a workspace. Email confirmation remains
  per Supabase project settings; the owner can disable self-serve in Supabase
  and with `AUTH_ALLOW_PASSWORD=false`.
- Change 3 closes a real cross-user credential exposure inside multi-member
  orgs; it also protects the owner's own org from future members.
- Removing the ADMIN gate (change 2) only widens access to per-user resources;
  org-level surfaces stay ADMIN-gated.

## Testing

- **Route smoke** (existing pattern, cf. `test(slack): route-smoke coverage`):
  - `POST /api/mcp/connections` as role `USER` succeeds (was 403).
  - `DELETE /api/mcp/connections` as role `USER` removes only the caller's
    connection.
- **Unit — tool planes:** `loadKlavisPlaneGroups` returns only the acting
  user's connections; a second org member's `MCPAgent` rows are excluded.
- **Unit — provisioning:** a production identity creates an org + ADMIN user
  without a feature flag when no invitation exists; invitation path still wins.
- **Manual e2e (dev):** fresh sign-up → lands on dashboard with no 403 →
  Integrations page shows owner-configured catalogue → OAuth connect uses the
  new user's own account.
