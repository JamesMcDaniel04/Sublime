# Sublime Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand "Backstory Studio" → "Sublime" and remove all forced connection gates, the legacy Backstory MCP client, the Sales AI agent tool plane, and the built-in templates/skills — leaving a generic, ungated white-label agent platform while preserving the People.ai backend that powers Signals + Graph RAG.

**Architecture:** Deletion-first, rename-last. Remove whole subsystems in dependency order (gates → Sales AI tool plane → templates/skills), each ending with a green typecheck/build, then do the pure brand rename over the reduced surface. No DB migration (no `backstory*` columns exist).

**Tech Stack:** Next.js App Router, TypeScript, Prisma/PostgreSQL, Fastify/BullMQ worker, `node:test`, ESLint.

## Global Constraints

- **New brand name:** `Sublime` (replaces "Backstory"/"Backstory Studio").
- **Package name:** `sublime-studio` (replaces `backstory-studio`).
- **Placeholder brand domain:** `sublime.app` (replaces `backstory.app` in emails/legal). User swaps real domain later.
- **CSS class prefix:** `sl-` (replaces `bs-`).
- **Design CSS file:** `src/app/sublime-design.css` (renamed from `backstory-design.css`).
- **Skills file:** `src/lib/skills/sublime-skills.json` containing `[]` (replaces `backstory-skills.json`).
- **Test cycle for a refactor:** this is a rename/delete refactor with no new behavior, so each task's verification is `npm run typecheck` (catches break-on-delete) + the relevant existing `npm test` subset + a residual-`grep` check, not new TDD tests. Only add/modify tests where deleted code had tests.
- **KEEP untouched (do not delete):** `src/lib/peopleai/{client.ts,oauth.ts,salesai-facts.ts,webhook-secret.ts,register-webhook.ts}`, `src/app/api/peopleai/webhook-secret/route.ts`, all `src/lib/rag/*`, all `src/lib/signals/*`, `src/app/api/signals/**`. These power Signals + Graph RAG.
- **Commit after every task.** Branch: `rebrand-sublime`.

---

### Task 1: Remove both forced gates (fully ungate the app)

Removes the Backstory MCP connection gate AND the People.ai "Sales AI" entitlement gate, plus the `/connect` onboarding and its supporting routes. Leaves the app usable with zero required connections. `backstory-mcp.ts` (`BackstoryMcpClient`) is NOT touched here — it belongs to Task 2 (used by the tool plane).

**Files:**
- Delete: `src/lib/mcp/backstory-connection.ts`, `src/lib/mcp/__tests__/backstory-connection.test.ts`, `src/lib/entitlement.ts`, `src/lib/__tests__/entitlement.test.ts`, `src/app/api/setup/status/route.ts`, `src/components/layout/setup-gate.tsx`, `src/app/connect/page.tsx`, `src/lib/peopleai/connect-service.ts`, `src/lib/peopleai/__tests__/connect-service.test.ts`, `src/app/api/peopleai/connect/route.ts`, `src/app/api/peopleai/callback/route.ts`, `src/app/api/peopleai/status/route.ts`
- Modify: `src/lib/server/auth.ts`, `src/lib/server/api-handler.ts`, `src/components/layout/app-shell.tsx`, `src/app/dashboard/page.tsx:122`, `src/app/api/mcp-connections/oauth/callback/route.ts`, `src/app/api/mcp-connections/oauth/start/route.ts`, `src/lib/server/__tests__/auth-gate.test.ts`, `src/app/api/__tests__/route-smoke.test.ts`

**Interfaces:**
- Produces: `requireAuthContext()` and `withAuthenticatedApi(handler)` take **no options** after this task (the `{ skipBackstoryGate?, skipEntitlementGate? }` param is gone). Every caller passing those options must drop them.

- [ ] **Step 1: Rewrite `src/lib/server/auth.ts`** — remove the gate imports, both gate blocks, the entitlement helpers, and the options param. Final file:

```typescript
import { getAuthWithUser } from '@/lib/supabase/auth-utils'

type AuthResult = NonNullable<Awaited<ReturnType<typeof getAuthWithUser>>>

export interface AuthContext {
  user: AuthResult['user']
  dbUser: NonNullable<AuthResult['dbUser']>
  userId: string
  organizationId: string
}

// Production-inert test seam (unchanged — see original comment).
let testAuthContext: AuthContext | null = null

export function setTestAuthContext(ctx: AuthContext | null): void {
  testAuthContext = ctx
}

function testAuthActive(): boolean {
  return process.env.NODE_ENV !== 'production' && Boolean(process.env.TEST_DATABASE_URL)
}

export class AuthContextError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
    readonly code: string = 'AUTH_ERROR',
  ) {
    super(message)
    this.name = 'AuthContextError'
  }
}

export async function requireAuthContext(): Promise<AuthContext> {
  if (testAuthContext && testAuthActive()) return testAuthContext

  const auth = await getAuthWithUser()

  if (!auth?.user || !auth.userId) {
    throw new AuthContextError('Authentication required', 401)
  }

  if (!auth.dbUser || !auth.organizationId) {
    throw new AuthContextError('Organization access required', 403)
  }

  return {
    user: auth.user,
    dbUser: auth.dbUser,
    userId: auth.userId,
    organizationId: auth.organizationId,
  }
}
```

- [ ] **Step 2: Edit `src/lib/server/api-handler.ts`** — drop the options param. Change lines 26-32 to:

```typescript
export function withAuthenticatedApi(handler: AuthenticatedHandler) {
  return async (request: NextRequest): Promise<Response> => {
    try {
      const auth = await requireAuthContext()
      const result = await handler(request, auth)
```

- [ ] **Step 3: Edit `src/components/layout/app-shell.tsx`** — remove `import { SetupGate } from './setup-gate'` (line 6), update the doc comment (drop "connect"), and unwrap both `<SetupGate>` usages (lines 46, 49):

```tsx
        {fullscreen ? (
          <ErrorBoundary>{children}</ErrorBoundary>
        ) : (
          <div className="container mx-auto max-w-7xl animate-fade-in px-3 py-4 sm:px-6 sm:py-8">
            <ErrorBoundary>{children}</ErrorBoundary>
          </div>
        )}
```

- [ ] **Step 4: Delete the gate files** (listed above). Also edit `src/app/dashboard/page.tsx:122` — remove the `window.location.assign('/connect')` redirect (the enclosing `!backstoryConnected` branch); if the surrounding `fetch('/api/setup/status')` effect exists only to gate, remove the whole effect.

- [ ] **Step 5: Edit the two MCP-oauth routes** — `oauth/callback/route.ts`: remove `import { bustBackstoryReadyCache } from '@/lib/mcp/backstory-connection'` and its call (`if (payload.userId) bustBackstoryReadyCache(...)`). `oauth/start/route.ts`: remove the trailing `, { skipBackstoryGate: true }` from the `withAuthenticatedApi(...)` call.

- [ ] **Step 6: Update tests** — delete gate-only assertions in `src/lib/server/__tests__/auth-gate.test.ts` (if the whole file tests gates, delete it); remove the deleted routes (`peopleai/connect`, `peopleai/callback`, `peopleai/status`, `setup/status`) from the route enumeration/case-list in `src/app/api/__tests__/route-smoke.test.ts`.

- [ ] **Step 7: Verify** — `grep -rn "skipBackstoryGate\|skipEntitlementGate\|assertEntitled\|entitlementGateEnabled\|backstoryMcpReady\|ensureBackstoryConnection\|/api/setup/status\|resolveEntitlement" src` returns **nothing** (except possibly comments to fix). Then:

```bash
npm run typecheck
```
Expected: PASS (0 errors). If `app-shell.tsx` or another consumer still references a deleted symbol, fix it here.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: remove Backstory MCP + entitlement gates (fully ungate app)"
```

---

### Task 2: Remove the Sales AI agent tool plane + legacy BackstoryMcpClient

Deletes the user-facing People.ai/"Backstory" tool plane and the legacy `BackstoryMcpClient`. The People.ai **backend** client (`getPeopleAiServiceClient`/`getPeopleAiReadClient`) stays for RAG/signals — only the agent-facing tool source is removed.

**Files:**
- Delete: `src/lib/mcp/backstory-mcp.ts`
- Modify: `src/features/agents/tool-planes.ts`, `src/features/agents/execute-agent.ts`, `src/lib/flows/tool-catalog.ts`, `src/features/flows/execute-flow.ts`, `src/lib/connectors/registry.ts`, `src/lib/flows/tool-connection-id.ts`, `src/components/flows/flow-picker.tsx`, `src/components/integrations/integration-logo.tsx`, `src/components/integrations/integration-chip.tsx`, `src/app/dashboard/agent-activity-pane.tsx`, `src/app/dashboard/agent-config-form.tsx`, `src/app/integrations/page.tsx`, `src/app/connections/mcp-connection-dialog.tsx`
- Tests: `src/lib/eval/fixtures/index.ts`, `src/lib/eval/__tests__/eval.test.ts`, `src/lib/llm/__tests__/ir.test.ts`, `src/lib/connectors/__tests__/registry.test.ts`, `src/lib/connectors/__tests__/agent-connectors.test.ts`, `src/lib/flows/__tests__/tool-connection-id.test.ts`, `src/lib/agents/__tests__/approval.test.ts`, `src/features/agents/__tests__/tool-registry.test.ts`

**Interfaces:**
- Consumes: `getPeopleAiServiceClient`, `getPeopleAiClientForUser` remain exported from `@/lib/peopleai/client` (untouched) — only their use inside the deleted `loadPeopleAiPlaneGroup` goes away.
- Produces: `FlowToolPlane` no longer includes `'people_ai'`; `loadPeopleAiPlaneGroup` no longer exists; the `'backstory'` `ConnectorKind` no longer exists.

- [ ] **Step 1: Edit `src/features/agents/tool-planes.ts`** — remove `import { BackstoryMcpClient, backstoryMcpConfigured } from '@/lib/mcp/backstory-mcp'` (line 24); delete the entire `loadPeopleAiPlaneGroup` function (≈ lines 171-274); in `resolveFlowToolExecutor`, delete the `if (plane === 'people_ai') { ... }` branch (≈ lines 528-541); change the two Klavis `platformName: 'backstory'` (lines 127, 520) to `platformName: 'sublime'`; drop `BackstoryMcpClient` from the `McpToolClient` comment (line 38).

- [ ] **Step 2: Edit callers of `loadPeopleAiPlaneGroup`** — `src/features/agents/execute-agent.ts`: remove it from the import (line 17) and delete the `const peopleAiGroup = await loadPeopleAiPlaneGroup(...)` call + any use of `peopleAiGroup` (line 271 and wherever it's spread into the groups list). `src/lib/flows/tool-catalog.ts`: remove from import (line 28) and the `wantPlane('people_ai') ? loadPeopleAiPlaneGroup(...) : null` entry (line 48).

- [ ] **Step 3: Edit write-plane regexes** — `src/features/agents/execute-agent.ts:924` and `src/features/flows/execute-flow.ts:53`: change `/^(nango|slack|email|backstory)/i` → `/^(nango|slack|email)/i`. Also `execute-agent.ts:248-250`: remove the `.filter((p) => !/backstory/i.test(p))` Klavis exclusion (no longer a real provider).

- [ ] **Step 4: Edit `src/lib/connectors/registry.ts`** — remove `'backstory'` from the `ConnectorKind` union (line 24) and delete the `backstory` connector descriptor (lines 48-55).

- [ ] **Step 5: Remove the `people_ai` plane from the flow catalog** — `src/lib/flows/tool-connection-id.ts`: remove `'people_ai'` from the `FlowToolPlane` union and the `people_ai:backstory` doc example. `src/components/flows/flow-picker.tsx`: remove the `people_ai`/`backstory` plane handling (lines ~169, 180).

- [ ] **Step 6: Edit UI alias/label mappings** — remove `backstory` entries/substring checks in: `integration-logo.tsx` (L58, L68-70), `integration-chip.tsx` (L12), `agent-activity-pane.tsx` (L127, L164 alias list, L425 `<IntegrationLogo slug="backstory" .../>`), `agent-config-form.tsx` (L682 comment), `integrations/page.tsx` (L28 comment), `mcp-connection-dialog.tsx` (L238 placeholder `"e.g. Backstory MCP"` → `"e.g. Notion MCP"`).

- [ ] **Step 7: Delete `src/lib/mcp/backstory-mcp.ts`.**

- [ ] **Step 8: Update tests** — in `eval/fixtures/index.ts`, `eval.test.ts`, `ir.test.ts` change tool names `backstory_get_account`/`backstory_get_opportunity` → a generic kept provider (e.g. `granola_list_documents`) OR delete those fixture cases if they only exercised the removed plane. In `registry.test.ts`, `agent-connectors.test.ts`, `tool-connection-id.test.ts`, `approval.test.ts`, `tool-registry.test.ts` remove the `'backstory'`/`people_ai:backstory` cases.

- [ ] **Step 9: Verify**

```bash
grep -rn "loadPeopleAiPlaneGroup\|BackstoryMcpClient\|backstoryMcpConfigured\|people_ai:backstory\|backstory_get_" src
npm run typecheck
```
Expected: grep returns nothing; typecheck PASS.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: remove Sales AI agent tool plane + legacy BackstoryMcpClient"
```

---

### Task 3: Remove built-in templates + skills library

Empties the built-in agent-template catalog and the built-in skills library, keeping the CRUD/compose engines intact for community/custom content.

**Files:**
- Delete: `src/lib/skills/backstory-skills.json`, `src/lib/playbooks/salesai-upsell.ts`, `src/lib/playbooks/__tests__/salesai-upsell.test.ts`, `src/app/api/playbooks/salesai-upsell/route.ts`
- Create: `src/lib/skills/sublime-skills.json`
- Modify: `src/app/api/agent-templates/route.ts`, `src/lib/skills/compose.ts`, `src/features/agents/system-prompt.ts`, `src/features/agents/__tests__/system-prompt.test.ts`, `src/app/templates/page.tsx:716`, `src/app/api/__tests__/route-smoke.test.ts`

- [ ] **Step 1: Create `src/lib/skills/sublime-skills.json`** with an empty array:

```json
[]
```

- [ ] **Step 2: Edit `src/lib/skills/compose.ts:1`** — repoint the import:

```typescript
import skills from './sublime-skills.json'
```

- [ ] **Step 3: Delete `src/lib/skills/backstory-skills.json`.**

- [ ] **Step 4: Edit `src/app/api/agent-templates/route.ts`** — replace the entire `builtInTemplates` array literal (lines 41-734) with:

```typescript
const builtInTemplates: Array<Record<string, unknown>> = []
```
Keep `serializeTemplate`, `templateSchema`, and the GET/POST/PUT/DELETE handlers unchanged (the GET still merges `builtInTemplates` (now empty) with stored community templates).

- [ ] **Step 5: Delete the SalesAI playbook** — `src/lib/playbooks/salesai-upsell.ts`, its test, and `src/app/api/playbooks/salesai-upsell/route.ts`. Then `grep -rn "salesai-upsell\|salesaiUpsell" src` and remove any remaining import/reference (e.g. a template `playbook: "salesai-upsell"` field is already gone with Step 4).

- [ ] **Step 6: Edit `src/features/agents/system-prompt.ts`** — the built-in-skills path now composes over an empty list; confirm `composeInstructions` still works with `extraSkills` only. Remove any comment naming "Backstory". Update `system-prompt.test.ts` — its `getSkill`/`listSkills` cases must expect an empty built-in set (change assertions to community-skill inputs or assert `listSkills()` is `[]`).

- [ ] **Step 7: Edit `src/app/templates/page.tsx:716`** — placeholder `"Slack, Backstory MCP"` → `"Slack, Notion"`. Remove the deleted playbooks route from `route-smoke.test.ts` enumeration.

- [ ] **Step 8: Verify**

```bash
grep -rn "backstory-skills\|salesai-upsell\|builtInTemplates\[" src
npm run typecheck && npm test 2>&1 | tail -20
```
Expected: grep clean; typecheck PASS; tests PASS.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: remove built-in Backstory templates + skills library"
```

---

### Task 4: Brand rename → Sublime (assets, CSS, copy, config)

Pure rename over the reduced surface. No logic changes. Do assets + CSS first, then strings.

**Files (assets/CSS):** `public/backstory-*.svg` (→ `sublime-*.svg`), `src/app/backstory-design.css` (→ `sublime-design.css`), `src/app/globals.css`, `src/app/landing.css`, `src/app/page.tsx`
**Files (strings/config):** `package.json`, `README.md`, `ARCHITECTURE.md`, `tailwind.config.js`, `.env.example`, `render.yaml`, `src/app/layout.tsx`, `src/app/auth/login/page.tsx`, `src/app/auth/signup/page.tsx`, `src/app/terms/page.tsx`, `src/app/privacy/page.tsx`, `src/components/layout/sidebar.tsx`, `src/lib/integrations/email.ts`, `src/lib/notifications/push.ts`, `src/app/api/audit/export/route.ts`, `src/lib/peopleai/client.ts`, `src/lib/mcp/streamable-http.ts`, `src/lib/mcp/mcp-client.ts`, `src/lib/mcp/klavis-client.ts`, `src/lib/mcp/oauth-authcode.ts`, `src/features/agents/system-prompt.ts`, `src/app/api/agents/[id]/chat/route.ts`, `src/app/dashboard/assistant-panel.tsx`, `src/lib/flows/copilot-grounding.ts`, `src/app/dashboard/page.tsx`, `src/lib/peopleai/oauth.ts` (comment + `oauth.test.ts` scope string)

- [ ] **Step 1: Create Sublime logo SVGs.** Create `public/sublime-lockup-black.svg`, `sublime-logo-white.svg`, `sublime-mark-blue.svg` as simple text wordmarks (see snippet below for the mark). Then delete the four `public/backstory-*.svg` files. Minimal placeholder mark:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Sublime">
  <rect width="32" height="32" rx="7" fill="#1d4ed8"/>
  <text x="16" y="22" font-family="Georgia, serif" font-size="18" fill="#fff" text-anchor="middle">S</text>
</svg>
```
Lockup: same but a wider viewBox with the word "Sublime" in `Georgia, serif`. (User replaces with real art later.)

- [ ] **Step 2: Repoint every `<img src="/backstory-*.svg">`** to the new `sublime-*.svg` path, with `alt="Sublime"`. Sites: `page.tsx` (mark + lockup), `auth/login/page.tsx`, `auth/signup/page.tsx`, `sidebar.tsx` (`DEFAULT_ORG_LOGO`), `integration-logo.tsx`.

- [ ] **Step 3: Rename the design CSS.** `git mv src/app/backstory-design.css src/app/sublime-design.css`; update `@import './backstory-design.css'` → `'./sublime-design.css'` in `globals.css:1`; update header comments in the CSS file + `landing.css` reference + `tailwind.config.js:3` comment.

- [ ] **Step 4: Rename the `bs-` CSS prefix → `sl-`** across exactly `src/app/page.tsx`, `src/app/landing.css`, `src/app/sublime-design.css` (202 occurrences). Use a scoped sed per file, e.g.:

```bash
sed -i '' -E 's/\bbs-/sl-/g' src/app/landing.css src/app/sublime-design.css
```
For `page.tsx`, do the same but verify no `bs-` appears inside non-class string content first (`grep -n 'bs-' src/app/page.tsx`). Re-grep after: `grep -rn '\bbs-' src/app` → empty.

- [ ] **Step 5: Rename brand strings.** Replace user-facing "Backstory Studio" → "Sublime" and standalone "Backstory" → "Sublime" in: `layout.tsx` title, `page.tsx` (title/copy/aria/`© 2026 Backstory`), `auth/*` copy, `terms/privacy` copy, `assistant-panel.tsx`, `chat/route.ts` system prompt, `copilot-grounding.ts`, `system-prompt.ts`, `dashboard/page.tsx` fallback copy. Email domains: `terms/page.tsx` `support@backstory.app` → `support@sublime.app`; `privacy/page.tsx` `privacy@backstory.app` → `privacy@sublime.app`; `notifications/push.ts` `notifications@backstory.app` → `notifications@sublime.app`.

- [ ] **Step 6: Rename runtime identifiers.** `package.json` name → `sublime-studio`; `sidebar.tsx` `AGENTS_CHANGED_EVENT = 'backstory:agents-changed'` → `'sublime:agents-changed'`; `email.ts` sender default `'Backstory <onboarding@resend.dev>'` → `'Sublime <onboarding@resend.dev>'`; `audit/export/route.ts` filename `backstory-audit-` → `sublime-audit-`; MCP client-identity `clientName: 'BackstoryStudio'`/`'Backstory'` → `'Sublime'` in `peopleai/client.ts`, `streamable-http.ts`, `mcp-client.ts`, `klavis-client.ts`; `oauth-authcode.ts` `client_name: 'Backstory Studio'` → `'Sublime'`; `peopleai/__tests__/oauth.test.ts` `scope: 'backstory-studio'` → `'sublime-studio'` (and the matching source in `oauth.ts` if present).

- [ ] **Step 7: Config + docs.** `README.md` (title + intro), `ARCHITECTURE.md` (drop the `backstory-mcp.ts` line — it's deleted; note the rebrand), `.env.example` (comment), `render.yaml` (service `name: backstory-worker` → `sublime-worker`; **remove** the `BACKSTORY_MCP_URL/CLIENT_ID/CLIENT_SECRET/TOKEN_URL` env keys + their comment).

- [ ] **Step 8: Verify**

```bash
npm run typecheck && npm run lint && npm run build
grep -rniE "backstory" src public README.md ARCHITECTURE.md render.yaml tailwind.config.js package.json | grep -v "docs/"
```
Expected: build PASS; the grep returns **only** intentional leftovers (ideally none). Investigate every hit.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: rebrand Backstory Studio → Sublime (assets, CSS, copy, config)"
```

---

### Task 5: Full verification + run the app

- [ ] **Step 1: Full check**

```bash
npm run typecheck && npm run lint && npm run build && npm test 2>&1 | tail -30
```
Expected: all PASS, 0 failing tests.

- [ ] **Step 2: Residual sweep** — `grep -rniE "backstory" src public *.md *.json *.js *.yaml | grep -vi "docs/superpowers"` returns nothing. Any remaining hit is either fixed or explicitly justified in the commit message.

- [ ] **Step 3: Run the app** (use the `run` skill or `npm run dev:all`). Confirm: (a) app loads with **no redirect to `/connect`**; (b) `/connect` now 404s; (c) the dashboard/sidebar/landing render as **Sublime** with the new mark; (d) creating an agent works with zero connections configured; (e) `/templates` loads (empty built-ins, community list intact); (f) Integrations page has no "Backstory" entry.

- [ ] **Step 4: Optional dev DB cleanup** (only if a dev DB has stale rows):

```sql
DELETE FROM mcp_connections WHERE provider = 'backstory';
```

- [ ] **Step 5: Final commit (if the run surfaced any fix)**

```bash
git add -A && git commit -m "chore: post-rebrand verification fixes"
```

---

## Self-Review

**Spec coverage:** ✅ Rename (Task 4), gate deletion (Task 1), Sales AI tool plane + BackstoryMcpClient (Task 2), templates/skills (Task 3), KEEP People.ai backend/RAG/signals (untouched by all tasks — enforced by Global Constraints), no DB migration (documented), verification incl. running the app (Task 5). The 6 sub-decisions all map: slug deleted (T2), `/connect` deleted (T1), `/api/setup/status` deleted (T1), skills emptied (T3), templates emptied (T3), `bs-`→`sl-` (T4).

**Placeholder scan:** No "TBD/TODO"; every edit names exact files/lines/strings. The one generative step (logo SVG) ships concrete placeholder markup.

**Type consistency:** `requireAuthContext()`/`withAuthenticatedApi(handler)` lose their options param consistently across T1 (definition) and all call-sites (`oauth/start`, and the deleted routes). `FlowToolPlane` loses `'people_ai'` in T2 with all consumers updated. `loadPeopleAiPlaneGroup` deletion (T2) covers both callers (execute-agent, tool-catalog).

## Risks

- **Break-on-delete (no literal match):** `app-shell.tsx` (T1 Step 3) and `compose.ts` (T3 Step 2) — both explicitly edited alongside their deletions; typecheck gate catches misses.
- **Route smoke test** enumerates routes — updated in T1 Step 6 and T3 Step 7 for every deleted route.
- **`dashboard/page.tsx`** may reference `backstoryConnected` from the now-deleted status endpoint (T1 Step 4) — remove the whole gate-fetch effect, not just the redirect line.
