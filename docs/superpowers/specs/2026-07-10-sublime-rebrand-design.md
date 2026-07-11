# Backstory → Sublime Rebrand — Design Spec

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan
**Branch:** `rebrand-sublime`

## Goal

Rebrand the application from **"Backstory Studio"** to **"Sublime"** and strip every trace of "Backstory" branding, while turning the product into a **generic, fully-ungated white-label AI agent platform**. Specifically:

1. Rename the product brand everywhere → **Sublime**.
2. Remove **all forced connection gates** (the Backstory MCP gate *and* the People.ai "Sales AI" entitlement gate) — the app is usable with zero required connections.
3. Delete the legacy **`BackstoryMcpClient`** and the user-facing **Sales AI agent tool plane**.
4. Delete the built-in **agent templates** and **skills library**.
5. **Preserve** the People.ai *backend* data plumbing (client, `salesai-facts` enrichment, signal receiver) because it powers **Signals** and **Graph RAG**, which are kept and are the next roadmap item.

Result: Sublime ships with generic tool planes — Klavis MCP, native built-ins (Granola/Slack/HTTP/Email), custom per-org MCP connections, Nango delivery — and no forced onboarding.

## Decisions locked during brainstorming

| Decision | Choice |
|----------|--------|
| Sequencing | Rebrand first (verify green), *then* flow-parity fixes (separate effort — see `[[flow-parity-remaining]]` memory) |
| Rename vs delete boundary | App brand → Sublime; **delete** MCP gate + templates; keep generic MCP/connections |
| People.ai / Sales AI depth | **Surgical**: purge branding + both gates + the agent tool plane + templates; **keep** the backend client + `salesai-facts` + signal receiver + RAG enrichment as an optional, env-configured data source with no requirement |
| Entitlement gate | **Remove** — fully ungated |

### The 6 sub-decisions (approved defaults)

1. **Sales AI plane `'backstory'` slug** — *deleted* along with the plane (not renamed); avoids any stored-data migration.
2. **`/connect` page** — *deleted* entirely (both gates gone).
3. **`/api/setup/status`** — *deleted* entirely (nothing left to report).
4. **Skills engine** — *kept*, built-ins emptied: `backstory-skills.json` → `sublime-skills.json` containing `[]`; community/custom skills still compose.
5. **Built-in templates** — *deleted* (`builtInTemplates` → `[]`); `/templates` shows community templates only.
6. **`bs-` CSS prefix** (202 uses, = "**B**ack**s**tory") — *renamed* `bs-` → `sl-` across `page.tsx`, `landing.css`, `sublime-design.css`.

## Scope

### A. RENAME → "Sublime" (brand surface)

- **App identity / metadata:** `src/app/layout.tsx` (`title`), `src/app/page.tsx` (title, body copy, aria-labels, `© 2026 Backstory`), `package.json` `name`, `README.md`, `ARCHITECTURE.md` prose.
- **Auth + legal pages:** `src/app/auth/login/page.tsx`, `src/app/auth/signup/page.tsx`, `src/app/terms/page.tsx`, `src/app/privacy/page.tsx` (incl. `support@backstory.app` / `privacy@backstory.app` → Sublime domain).
- **Assets:** `public/backstory-lockup-black.svg`, `backstory-logo-dark.svg`, `backstory-logo-white.svg`, `backstory-mark-blue.svg` → new **Sublime wordmark/mark SVGs** (generated placeholders; user may swap real brand art later). Update every referencing `<img src>` (`page.tsx`, `auth/*`, `sidebar.tsx`, `integration-logo.tsx`).
- **Design system:** rename `src/app/backstory-design.css` → `src/app/sublime-design.css`; update `@import` in `globals.css`; update header comments; `tailwind.config.js` comment.
- **CSS class prefix:** `bs-*` → `sl-*` (coordinated across `page.tsx`, `landing.css`, `sublime-design.css`).
- **Runtime strings:** sidebar `AGENTS_CHANGED_EVENT = 'backstory:agents-changed'` → `'sublime:...'` and `DEFAULT_ORG_LOGO`; email sender default (`integrations/email.ts`); push contact (`notifications/push.ts`); audit CSV filename (`api/audit/export/route.ts`); MCP client-identity names (`clientName: 'BackstoryStudio'` in `peopleai/client.ts`, `streamable-http.ts`, `mcp-client.ts`, `klavis-client.ts`; DCR `client_name` in `oauth-authcode.ts`).
- **Prompt copy:** `system-prompt.ts`, `agents/[id]/chat/route.ts`, `dashboard/assistant-panel.tsx`, `flows/copilot-grounding.ts`, `dashboard/page.tsx` fallback copy.
- **Comments:** `peopleai/oauth.ts`, `peopleai/register-webhook.ts`, `mcp-client.ts`, `integrations/granola.ts`, `.env.example`, `render.yaml` (`backstory-worker` service name).

### B. DELETE — both gates (fully ungated)

- **Whole files:** `src/lib/mcp/backstory-connection.ts` (+ its test), `src/lib/mcp/backstory-mcp.ts`, `src/components/layout/setup-gate.tsx`, `src/app/api/setup/status/route.ts`, `src/app/connect/page.tsx`, `src/lib/entitlement.ts` (+ `src/lib/__tests__/entitlement.test.ts`).
- **Edits:**
  - `src/lib/server/auth.ts` — remove gate imports, `ensureBackstoryConnection` call, the `BACKSTORY_MCP_REQUIRED` block, the `assertEntitled`/`entitlementGateEnabled` entitlement block, and the `skipBackstoryGate`/`skipEntitlementGate` options.
  - `src/lib/server/api-handler.ts` — remove `skipBackstoryGate`/`skipEntitlementGate` from the options type.
  - `src/components/layout/app-shell.tsx` — drop the `SetupGate` import and unwrap both `<SetupGate>` usages (**breaks compile if missed** — has no literal "backstory").
  - `src/app/dashboard/page.tsx` — remove the `window.location.assign('/connect')` gate redirect.
  - `src/app/api/mcp-connections/oauth/callback/route.ts` — remove `bustBackstoryReadyCache` import + call.
  - `src/app/api/mcp-connections/oauth/start/route.ts` and `src/app/api/peopleai/connect/route.ts` — remove the `skipBackstoryGate` option (note: `peopleai/connect` route itself is removed — see C).
- **Config:** remove `BACKSTORY_MCP_URL/CLIENT_ID/CLIENT_SECRET/TOKEN_URL` from `render.yaml`; remove/replace the `ENTITLEMENT_GATE` knob references.

### C. DELETE — Sales AI agent tool plane + entitlement onboarding + templates/skills

- **Sales AI *agent tool plane*** (the user-facing tool source, distinct from backend enrichment):
  - `src/features/agents/tool-planes.ts` — remove `loadPeopleAiPlaneGroup`, the `BackstoryMcpClient` fallback branches, and the `people_ai` branch of `resolveFlowToolExecutor`; drop the `'backstory'`/`people_ai` provider wiring, `platformName: 'backstory'` (Klavis) → `'sublime'`.
  - `src/lib/connectors/registry.ts` — remove the `'backstory'` `ConnectorKind` + descriptor.
  - `src/features/agents/execute-agent.ts` + `src/features/flows/execute-flow.ts` — remove `backstory` from write-plane regexes and the Klavis `/backstory/i` exclusion.
  - `src/lib/flows/tool-connection-id.ts` / `tool-catalog.ts` / `flow-picker.tsx` — remove `people_ai:backstory` plane from the catalog + docs.
  - UI aliases: `integration-logo.tsx`, `integration-chip.tsx`, `agent-activity-pane.tsx`, `agent-config-form.tsx`, `integrations/page.tsx`, `connections/mcp-connection-dialog.tsx` placeholder.
  - **Eval fixtures/tests** referencing `backstory_get_account`/`backstory_get_opportunity`: `lib/eval/fixtures/index.ts`, `lib/eval/__tests__/eval.test.ts`, `lib/llm/__tests__/ir.test.ts`, `connectors/__tests__/*`, `flows/__tests__/tool-connection-id.test.ts`, `agents/__tests__/approval.test.ts` — update to a generic provider or remove.
- **Entitlement onboarding (People.ai per-user OAuth connect flow):** delete `src/lib/peopleai/connect-service.ts` (+ its test), `src/app/api/peopleai/connect/route.ts`, `src/app/api/peopleai/callback/route.ts`, `src/app/api/peopleai/status/route.ts`. **KEEP `src/lib/peopleai/oauth.ts`** — it is imported by the kept `client.ts` (`refreshTokens`/`discoverMetadata`/`envOAuthConfig`), so it's a token/protocol helper, not connect UI. **KEEP `src/app/api/peopleai/webhook-secret/route.ts`** — it manages the signal receiver's secret. `register-webhook.ts` has no callers (inert) — leave it unless it imports a removed symbol. RAG/signals do **not** depend on per-user OAuth — they use the *service* client (`getPeopleAiServiceClient`) + webhook receiver.
- **Templates + skills:** `src/app/api/agent-templates/route.ts` — set `builtInTemplates = []` (keep CRUD for community templates); delete `src/lib/playbooks/salesai-upsell.ts` + `src/app/api/playbooks/salesai-upsell/route.ts` (+ test); delete `src/lib/skills/backstory-skills.json`, add `src/lib/skills/sublime-skills.json` = `[]`, repoint `compose.ts` import; update `templates/page.tsx` placeholder and `system-prompt.test.ts`.

### D. KEEP (unbranded — protects Graph RAG + Signals)

- `src/lib/peopleai/client.ts` (service + read client factories), `src/lib/peopleai/oauth.ts` (token/protocol helper — required by client.ts), `src/lib/peopleai/salesai-facts.ts`, `src/lib/peopleai/webhook-secret.ts`, `src/app/api/peopleai/webhook-secret/route.ts`, `src/lib/peopleai/register-webhook.ts` (inert).
- Signal receiver: `src/app/api/signals/people-ai/route.ts`, `src/lib/signals/map.ts`, `src/lib/signals/verify.ts`, the generic `signals/*` + `signals/custom/*` (incl. `signals/custom/[id]/run` which uses `getPeopleAiReadClient`).
- All of RAG: `src/lib/rag/indexer.ts`, `backfill.ts`, `retrieve.ts`, `store.ts` (enrichment degrades to the service client when no per-user token exists — acceptable).
- Generic tool planes: Klavis, native built-ins, custom MCP connections, Nango delivery.

These stay behind existing env config (`PEOPLE_AI_SERVICE_CLIENT_ID/SECRET`, webhook secret) and impose **no** onboarding requirement.

## Data / schema

- **No destructive migration.** There are zero `backstory*` columns; "backstory" is only a `provider` string value + comments. `Organization.entitlement*` / `peopleAiTeamId` and the `PeopleAiConnection` model are **left in place** (dormant) to avoid a risky schema drop — they can be pruned in a later dedicated migration if desired.
- **Optional dev-only cleanup:** `DELETE FROM mcp_connections WHERE provider = 'backstory'`. Not required for correctness.
- Update the `AgentConnector.kind` doc comment (drop `'backstory'` from the enumerated values) and the `McpConnection.provider` comment.

## Verification

1. `npm run typecheck` — catches the `app-shell.tsx` / `compose.ts` break-on-delete cases.
2. `npm run lint`.
3. `npm run build`.
4. `npm test` — updated/removed tests all green; no orphaned imports.
5. **Run the app** (via the `run` skill): confirm it loads with **no `/connect` redirect**, the dashboard renders as "Sublime", branding/logo are Sublime, and creating an agent works without any connection.

## Out of scope

- Flow-parity fixes (#1 condition/switch-in-container, #3 trigger/action naming) — the *next* effort, tracked in the `[[flow-parity-remaining]]` memory.
- Professional Sublime logo art — placeholder wordmark SVGs are generated; the user swaps real assets later.
- Pruning dormant `PeopleAiConnection` / entitlement DB columns — deferred to an optional later migration.

## Risks & mitigations

- **Break-on-delete with no literal match:** `app-shell.tsx` (imports `SetupGate`) and `compose.ts` (imports `backstory-skills.json`) must be edited alongside the deletions. Covered by typecheck.
- **Stored agents/flows referencing `backstory_*` tools or `people_ai:backstory` connections** stop resolving. Acceptable for this clone; the catalog simply no longer offers them.
- **RAG enrichment fidelity** drops from per-user to service-identity when the OAuth connect flow is removed. Acceptable and documented.
- **Route smoke test** (`api/__tests__/route-smoke.test.ts`) enumerates the route tree and fails if a route is added/removed without updating its case list — must update it for the deleted routes.
