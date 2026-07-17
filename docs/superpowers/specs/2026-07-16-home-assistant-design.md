# Home Assistant — Workspace-Level AI Assistant Design

**Date:** 2026-07-16
**Status:** Approved

## Summary

Replace the current Home tab (Agent HQ at `/dashboard`) with a workspace-level
"holistic" AI assistant, and move Agent HQ to a new **Agents** tab at `/agents`.
The Home assistant oversees everything in the platform (agents, runs,
connections, flows), converts assignments — pasted as text or uploaded as files —
into agent instructions through a clarifying-question dialogue, and can create
and execute agents with the instructions it generates.

## Decisions (user-confirmed)

1. **Auto-apply:** once requirements are aligned, the assistant creates the
   agent automatically (no confirm card) and shows a created-agent card with a
   **Run** button. Execution stays a one-click human action unless the user
   explicitly asks the assistant to run it.
2. **Routing:** the assistant takes over `/dashboard`; Agent HQ moves to
   `/agents`. Legacy `/dashboard?agent=|run=|view=` deep links redirect to
   `/agents` with params intact.
3. **Scope:** read everything (agents, recent runs, connections, flows), write
   agents (create + execute). Modifying existing agents stays in the per-agent
   assistant on the Agents page.
4. **History:** conversations are persisted per user with a history dropdown,
   same interaction pattern as the per-agent chat (fresh chat on visit, past
   sessions reachable).

## Architecture: structured single-call assistant

One LLM call per message via the existing `generateStructured` seam (same
pattern as `/api/agents/[id]/chat`). No agentic tool loop in v1 — the action
set is small (answer, ask clarifying questions, emit agent draft, execute
agent) and a JSON schema covers it deterministically and cheaply.

### Data model (Prisma)

Two new models, clones of the agent-chat pair minus `agentTaskId`:

```prisma
model AssistantChatSession {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  userId         String
  title          String?          // derived from first user message
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  messages       AssistantChatMessage[]
  @@index([organizationId, userId, updatedAt])
  @@map("assistant_chat_sessions")
}

model AssistantChatMessage {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  userId         String
  sessionId      String
  role           String
  content        String   @db.Text
  metadata       Json?    // attachment | createdAgent | executedRun
  createdAt      DateTime @default(now())
  session        AssistantChatSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@index([sessionId, createdAt])
  @@map("assistant_chat_messages")
}
```

`metadata` shapes:

- `attachment`: `{ filename, text, truncated? }` on user messages — the
  extracted text (already capped at 24k chars by the extract endpoint) is
  stored so the transcript and any follow-up turns survive reloads; the UI
  renders only the filename chip.
- `createdAgent`: `{ id, title, icon, description }` — renders the created
  card with Run / Open in Agents buttons.
- `executedRun`: `{ executionId, agentId, status }` — renders a run-started
  card linking to `/agents?run=<id>`.

### API routes (`/api/assistant/*`)

- **`GET /api/assistant/chat?sessionId=`** — messages for a session (org+user
  scoped), newest 100, same serialization approach as agent chat.
- **`GET /api/assistant/chat/sessions`** — session list for the history
  dropdown (id, title, updatedAt, messageCount).
- **`POST /api/assistant/chat`** — body `{ message, sessionId?, attachment? }`
  where `attachment` is `{ filename, text }` from the extract endpoint.
  Flow:
  1. Guards: provider configured, rate limit (`30/min` per user), monthly
     token budget check.
  2. Resolve/create session (title derived from first message).
  3. Build **workspace context** (see below) + last 20 messages of the session.
  4. `generateStructured` with response schema
     `{ reply, agentDraft | null, action | null }`.
  5. If `agentDraft` present: create the agent server-side (same normalization
     and `syncAgentConnectors` as `/api/agents/draft` — this logic is
     extracted into a shared helper so the two routes cannot drift), append
     `createdAgent` metadata.
  6. If `action.type === 'execute'`: validate the agent id is visible to this
     user in this org, invoke the existing execution path, append
     `executedRun` metadata.
  7. Persist user + assistant messages only after the model call succeeds;
     estimate and record token usage (~chars/4) as the other routes do.
- **`POST /api/assistant/extract`** — multipart file upload. Reuses
  `isSupported`/`extractText` from `src/lib/knowledge/extract.ts`. Rejects
  unsupported types (415) and files > 10 MB (413); truncates extracted text to
  24k chars (flagging `truncated: true`). Returns `{ filename, text, truncated }`.
  Rate-limited like chat.

### Workspace context assembly

A new `buildWorkspaceContext(auth)` helper (in `src/features/assistant/`)
returns a compact JSON context:

- **agents:** id, title, description, schedule label, status, integrations,
  last run status/time (owned + org-visible, same scoping as `/api/agents`).
- **recentRuns:** last 20 executions across agents — agent title, status,
  started, one-line result summary.
- **connections:** provider keys + status from the Nango/MCP/builtin
  registries (connected / error / not connected).
- **flows:** id + name + step count.

Everything is truncated to keep the context bounded (~15k chars target).

### System prompt behavior

- Answer oversight questions ("what's going on", "which connections are
  broken") strictly from the provided context; say plainly when the context
  doesn't contain the answer.
- For assignment conversion: if delivery requirements are genuinely ambiguous
  (output format, cadence/schedule, destinations/integrations, scope), ask a
  **single batch** of targeted clarifying questions before drafting. Once
  aligned — or when the assignment already answers those questions — emit
  `agentDraft` (title, icon, description, instructions, integrations from the
  registry vocabulary, schedule). Instructions are complete operating
  instructions in second person, same standard as `/api/agents/draft`.
- Never emit both `agentDraft` and clarifying questions in the same turn.
- `action.execute` only when the user explicitly asks to run an agent.
- Concise markdown, sentence case, no emoji (house style).

## Routing & tab changes

- `src/app/dashboard/` → `src/app/agents/` (Agent HQ, unchanged behavior; its
  internal `router.replace('/dashboard'...)` calls become `/agents`).
- New `src/app/dashboard/` hosts the Home assistant page.
- **Legacy redirect:** the new dashboard page inspects `agent`, `run`, and
  `view` search params on mount and `router.replace`s to `/agents?...` with
  them intact — old notifications, bookmarks, and palette links keep working.
- Sidebar nav: **Home** → `/dashboard` (Sparkles icon), **Agents** → `/agents`
  (Brain icon), Integrations, Flows. Sidebar agent rows, "+" (new agent), and
  post-run navigation point at `/agents...`.
- Command palette: Home → `/dashboard`, new Agents entry → `/agents`,
  Templates → `/agents?view=templates`, agent/run results → `/agents?...`.
- Updated to `/agents` where they mean the agent workspace: notification URLs
  (`notification-href.ts`, `service.ts`), templates pages, skills pages,
  `agent-config-form`/`-dialog` run links, `step-card` link, `not-found`,
  `error.tsx`.
- Unchanged (still `/dashboard`, now Home): `page.tsx` root redirect, auth
  login/update-password redirects, `safeReturnToPath` fallback, middleware.
- `app-shell`: add `/agents` to `APP_PREFIXES`; `FULLSCREEN_ROUTES` becomes
  `{'/dashboard', '/agents'}` (the assistant page is also full-height).
- `/templates` redirect page → `/agents?view=templates`.

## UI (`src/app/dashboard/page.tsx` + components)

ChatGPT/Claude-style single-column chat surface:

- **Empty state (hero):** vertically centered greeting ("Hey {firstName} —
  what should we take on?"), a large rounded composer (textarea that grows,
  `+` attach button on the left, send button on the right), and 4 preset chips
  under it, each mapped to a real capability:
  1. "Turn an assignment into an agent" — focuses the composer with a guiding
     placeholder and opens the attach affordance.
  2. "What did my agents do this week?" — sends directly.
  3. "Which connections need attention?" — sends directly.
  4. "Build me a daily briefing agent" — sends directly.
- **Conversation state:** transcript scrolls (user bubbles right-tinted,
  assistant markdown left, same Markdown component as the per-agent panel),
  composer pinned to the bottom, auto-scroll on new messages.
- **Attachments:** `+` opens a file picker (accept list from `isSupported`
  formats). Selected file uploads to `/api/assistant/extract` immediately,
  shows as a chip (filename + size, removable) above the composer; sent with
  the next message. Extraction errors toast and clear the chip.
- **Created-agent card:** icon, title, description, "Run" button (calls
  `/api/agents/{id}/execute`, toasts, then links to the run) and "Open in
  Agents" (`/agents?agent=<id>`). Also fires `notifyAgentsChanged()` so the
  sidebar tree updates.
- **Run card:** for assistant-executed runs — status + "View run" link.
- **Header row:** "Home" eyebrow, new-chat button, history dropdown (same
  relative-time list pattern as the per-agent panel).
- Mobile: same layout, full-width column.

## Error handling

- Rate limit / budget exceeded → 429 with the existing error vocabulary.
- Model failure → 502 `ASSISTANT_FAILED` preserving the cause; client toasts
  and restores the composer input.
- Agent creation failure after a valid draft → the reply still renders, with
  an inline error note instead of a created card (conversation is never lost).
- Execute action on an agent the user can't see → the assistant reply states
  it can't find that agent (validated server-side; no cross-org leakage).
- Unsupported/oversized upload → 415/413 with a clear toast.

## Testing

Following `src/app/api/__tests__` conventions:

- Assistant chat: session org/user scoping (no cross-user or cross-org reads),
  session creation + title derivation, message persistence only on model
  success.
- Draft creation: shared helper normalizes icon/schedule identically to
  `/api/agents/draft`; connectors synced.
- Execute action: id validation against visibility scope.
- Extract: format gating, size cap, truncation flag.
- Redirects: legacy `/dashboard?agent=|run=|view=` param mapping to `/agents`.

## Out of scope (v1)

- Modifying/deleting existing agents from Home (lives in the per-agent
  assistant).
- Agentic multi-tool loops, streaming responses.
- Non-text file formats (images, spreadsheets beyond CSV).
- Cross-conversation memory for the Home assistant.
