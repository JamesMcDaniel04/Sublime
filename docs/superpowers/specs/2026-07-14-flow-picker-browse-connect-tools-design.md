# Flow Picker: Browse Connector Tools & Connect-First Insert — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorming session with owner)

## Problem

In the flow builder's "Add an action" picker, the **By connector** section only
lists integrations that are already **connected and active** for the org/user.
A workspace with nothing connected sees only the always-on native `HTTP API`
entry (see screenshot report). Users cannot discover what Slack, Gmail, or
Salesforce can do inside a flow until they have already gone and connected them
elsewhere — and until recently they could not connect at all (an admin-only gate
on `POST /api/mcp/connections`, since removed so any member can connect).

The owner wants the picker to behave like an MCP server advertising its
tools: every connectable provider should appear with its list of tools and what
each one does (e.g. Slack ~3–4, Gmail ~7, Salesforce ~10), **before** the
provider is connected. Selecting a tool from an un-connected provider should
walk the user through connecting it, then add the node.

## Goals

1. The picker lists **all connectable providers** (connected *and* available),
   each drillable into its real tool list with per-tool descriptions.
2. Tool lists for un-connected providers show real, full fidelity where the data
   allows (Klavis), with a graceful fallback where it does not.
3. Picking a tool from an un-connected provider **connects first, then inserts**
   the node — the user is notified/prompted to connect as part of that flow.
4. Reuse the existing picker UI and connected-catalog machinery; keep changes
   additive and low-risk to the working connected path.

## Non-goals

- **No node-level "needs connection" state.** Connect-first guarantees every
  inserted tool node references a live connection, so there is no new
  un-runnable node state and **no changes to run/publish validation**.
- **No rich Nango tool catalog.** Nango is a delivery plane exposing a single
  synthetic action per capability; it is surfaced as-is, not expanded.
- **No browse entry for custom per-org MCP connections.** Those are added by URL
  and have no pre-add catalog; they remain connect-first (appear once added).
- No redesign of the picker layout beyond the additions below.

## Current architecture (what already exists)

- **Picker** — `src/components/flows/flow-picker.tsx`. Takes a `toolCatalog`
  prop (`ToolCatalog`), renders each connection as a drill-in row
  (`connectionRow`, showing "N available actions") and each tool as a row with
  its description (`connectionToolRow`). The drill-in and per-tool UI we want
  **already exist** — the gap is the data reaching the picker.
- **Client type** — `src/components/flows/tool-catalog-type.ts`
  (`ToolCatalog`): `{ id, name, tools[], toolsError? }[]`.
- **Server loader** — `src/lib/flows/tool-catalog.ts` (`loadFlowToolCatalog`)
  merges four planes via `src/features/agents/tool-planes.ts`:
  - `loadKlavisPlaneGroups` — `prisma.mCPAgent.findMany({ isActive: true })`,
    then live `getServerTools` per server. **Connected only.**
  - `loadMcpConnectionPlaneGroups` — active `mcpConnection` rows. Connected only.
  - `loadNativePlaneGroups` — env-gated built-ins (HTTP/email/slack). Always-on.
  - `loadNangoPlaneGroups` — one delivery action per connected Nango capability.
- **Klavis catalog** — `KlavisClient.listServerCatalog()`
  (`src/lib/mcp/klavis-client.ts`) calls `/mcp-server/servers`. The raw response
  includes a `tools[]` array per provider, but the client currently keeps only
  `toolCount = tools.length` and discards names/descriptions.
- **Provider capabilities** — `src/lib/mcp/provider-capabilities.ts`
  (`PROVIDER_CAPABILITIES`): curated 3–4 tools per provider (name + plain-language
  description). Useful as a fallback when live catalog tool details are absent.
- **Connect flow** — inline in `src/components/integrations/mcp-integration-cards.tsx`
  (`connect`/`disconnect`): `POST /api/mcp/connections` → Klavis OAuth popup →
  poll `?fresh=1` until `status === 'active'`. Nango connect uses the
  session-token flow (`/api/nango/session-token`, `/api/nango/integrations`).

## Data-source fidelity (bounds the design)

| Source | Pre-connection tool list? | Fidelity |
|---|---|---|
| **Klavis** (~34 providers) | Yes — live from `listServerCatalog` | Full real tool names + descriptions. Fallback: curated `PROVIDER_CAPABILITIES.tools` (3–4) |
| **Nango** (connectable apps) | Partial | One synthetic delivery action per app (e.g. `send_message`) |
| **Custom MCP** (per-org URLs) | No | No catalog until the URL is added; connect-first only |
| **Native built-ins** | N/A | Always available (HTTP/email/slack) |

## Design

### 1. Data layer — the "available catalog"

1. **Preserve Klavis tool details.** Change `KlavisClient.listServerCatalog()`
   to return `tools: { name: string; description?: string }[]` per provider,
   with `toolCount` derived from it (backward compatible for existing callers
   that read `toolCount`). Guard each tool entry — only keep objects with a
   string `name`; description optional.

2. **Merge un-connected providers into the catalog.** Extend
   `loadFlowToolCatalog` (or a helper it calls) so the returned list includes,
   after the connected groups, the **available** connectable providers:
   - *Klavis*: providers present in the live catalog **and** in
     `PROVIDER_CAPABILITIES` (same inclusion rule as `GET /api/mcp/connections`)
     that are **not** already an active `mCPAgent` for this org. Tools come from
     the live catalog entry; if a provider's live `tools[]` lacks
     names/descriptions, fall back to `PROVIDER_CAPABILITIES[provider].tools`.
   - *Nango*: connectable apps from the Nango environment
     (`listIntegrations`, already cached) not already connected, each with its
     single delivery action from `DELIVERY_TOOLS`.
   - *Native / custom MCP*: unchanged (native always-on; custom MCP not listed
     as available).

3. **Dedupe by provider.** A provider that is connected must appear **once**
   (as connected), never also as available.

4. **Annotate each connector.** Every catalog entry gains:
   - `connected: boolean`
   - `connect?: { plane: 'klavis' | 'nango'; provider: string }` — present on
     un-connected entries; tells the picker exactly what to connect.

   The connected/native/custom-MCP entries keep today's shape plus
   `connected: true`.

### 2. Types & API

- Extend `ToolCatalog` (`tool-catalog-type.ts`) and the server
  `FlowToolCatalogConnection` (`tool-catalog.ts`) with `connected` and optional
  `connect`. Keep the two structurally in sync (they are deliberately separate
  because the server module imports server-only code).
- The flow page (`src/app/flows/[id]/page.tsx`) already server-loads the
  catalog; it now includes available providers. Add a **client refresh** path so
  the picker can re-pull the catalog after a successful connect (a small fetch
  endpoint already exists: `src/app/api/flows/tool-catalog/route.ts` — reuse or
  extend it).

### 3. Picker UI (additive changes to `flow-picker.tsx`)

- `connectionRow`: for `connected === false`, render a **"Not connected · N
  actions"** badge/label instead of "N available actions". Drilling in still
  lists the real tools with descriptions.
- `connectionToolRow.onSelect`:
  - `connected` → insert the node exactly as today
    (`onPick('tool', { connectionId, toolName, ... })`).
  - not `connected` → **do not insert**; start the connect-first flow (§4),
    passing the `connect` descriptor and the picked tool name.
- Filter chips: today's `all | builtin | connected`. Add an **"Available"**
  notion so users can narrow to connectable-but-not-connected providers
  (`all` shows both connected and available).

### 4. Connect-then-insert flow

- Extract the connect logic currently inline in `mcp-integration-cards.tsx` into
  a shared hook `useConnectProvider` (new, e.g.
  `src/lib/client/use-connect-provider.ts`), covering:
  - Klavis: `POST /api/mcp/connections` → OAuth popup → poll `?fresh=1` until
    `active` (or popup closed / timeout).
  - Nango: session-token connect flow.
  Both the integrations page and the picker consume this one hook (the
  integrations page is refactored to use it, no behavior change there).
- Picker sequence on selecting an un-connected tool:
  1. Notify: "Connecting <Provider>…"
  2. Run `useConnectProvider(connect)`.
  3. On success: refetch the tool catalog, resolve the now-active connection's
     `id` and locate the picked tool by name, then `onPick('tool', …)` to insert.
  4. On failure (popup blocked, auth abandoned, timeout): notify with a clear
     message; insert nothing.
- Tool-name stability: the tool name shown pre-connection comes from the Klavis
  catalog; after connecting, live `getServerTools` returns the same names for the
  same server, so inserting by name is valid. If a picked tool name is absent
  post-connect (rare drift), notify and open the provider's drill-in instead of
  inserting a broken node.

### 5. Notification

- Pick-time status (connecting → success/failure) surfaced via the existing
  notification mechanism if available (the app has a notification bell), else a
  toast. This is the realization of "notify users if they need to connect a tool
  that's listed": the notification *is* the connect prompt/progress.

### 6. Performance & caching

- Cache `listServerCatalog` (Klavis) the way Nango integrations are already
  cached (~10 min TTL, `cacheGet`/`cacheSet`). Including tool names/descriptions
  is a negligible payload increase over the current count-only response.
- The available/connected split is computed per org (which providers are already
  active `mCPAgent`s / Nango connections).

## Testing

- **Catalog merge** (unit): connected vs available split; a connected provider
  is not duplicated as available; custom MCP never appears as available; native
  always present.
- **`listServerCatalog`** (unit): preserves `{name, description}` and still
  derives `toolCount`; entries missing tool detail fall back to curated
  `PROVIDER_CAPABILITIES.tools`.
- **Picker** (component): un-connected connector renders the "Not connected"
  badge and drill-in tool list; selecting a connected tool inserts a node;
  selecting an un-connected tool triggers connect (not insert).
- **Connect hook** (unit/component where feasible): success inserts after
  refetch; failure inserts nothing and notifies.

## Assumptions to verify during implementation

1. **Klavis `/mcp-server/servers` tool objects carry `name` (and ideally
   `description`).** The client currently only counts them. Verify against the
   live API (with `KLAVIS_API_KEY`); if descriptions are absent, use the curated
   `PROVIDER_CAPABILITIES` descriptions keyed by tool name, and fall back to a
   generic description otherwise. The design degrades gracefully either way.
2. **Nango `listIntegrations`** already returns the connectable app list used by
   the integrations page; reuse it directly.

## Rollout / risk

- All changes are additive; the connected-catalog path is unchanged in shape
  (only a `connected` flag added). A failing Klavis/Nango catalog fetch degrades
  to "no available providers" (same as today), never throws.
- Custom-MCP and native behavior untouched.
- Related, already-shipped precondition: `POST`/`DELETE /api/mcp/connections`
  are open to all authenticated members (admin gate removed), so connect-first
  works for non-admins.
