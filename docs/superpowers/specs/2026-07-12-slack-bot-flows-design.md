# Slack-Bot Flows — Design

Flows can power Slack bots, n8n-style: a Slack @mention, DM, channel message, or slash command triggers a flow; the flow's output replies into the originating channel/thread; a thread can carry a multi-turn conversation. Approved scope: per-org bot binding, all four entry points, auto reply-to-origin, multi-turn in v1.

## Grounded starting point (what exists on main)

- Generic external flow trigger: [/api/flows/[id]/trigger](../../../src/app/api/flows/[id]/trigger/route.ts) — per-flow secret, published-graph runs, inline-or-queued dispatch (202), owner attribution, rate limiting. The Slack ingress mirrors this posture but authenticates Slack's way.
- Trigger types `manual | schedule | webhook | signal` in [trigger.ts](../../../src/lib/flows/trigger.ts); the builder stores trigger config on the graph's trigger node, runtime reads `Flow.trigger` (synced on save/publish).
- Outbound Slack: env-level `chat.postMessage` in [slack.ts](../../../src/lib/integrations/slack.ts) + `native:slack` / `nango:slack` planes.
- Resume/multi-turn machinery (just shipped): `continueExecutionId` seed mode in execute-agent; `resumeKey`-targeted run resume; pause questions persisted on FlowRun/steps.
- Secrets encryption: `buildAuthConfig`/`encryptSecret`/`decryptSecret` in [secrets.ts](../../../src/lib/crypto/secrets.ts) (used by mcp-connections).
- `after()` (Next 15) for post-response serverless work; `dispatchFlowExecution` queue mode.

## 1. Per-org bot binding — `SlackWorkspaceConnection`

New Prisma model (org-scoped, supports multiple workspaces per org):

```prisma
model SlackWorkspaceConnection {
  id             String   @id @default(cuid())
  organizationId String
  teamId         String   // Slack workspace id (T…), captured from auth.test
  teamName       String?
  botUserId      String   // U…/B… — the bot's own user id, for echo-guarding
  botToken       Json     // encrypted at rest (secrets.ts shape)
  signingSecret  Json     // encrypted at rest
  status         String   @default("active") // active | error | revoked
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([organizationId, teamId])
  @@map("slack_workspace_connections")
}
```

Setup API: `POST /api/slack/connections { botToken, signingSecret }` → server calls Slack `auth.test` with the token (verifies it, captures `team_id`/`team`/`bot user id`), encrypts both secrets, upserts the row, returns the binding (secrets redacted) + its ingress URL. `GET` lists (redacted), `DELETE` revokes. Also `GET /api/slack/connections/[id]/manifest` returns a ready-to-paste Slack **app manifest** (scopes: `app_mentions:read, im:history, im:read, message.channels, chat:write, commands`; event subscriptions + slash command request URLs pre-filled with the binding's ingress URL) so creating the Slack app is copy-paste.

Setup UI: a "Slack bot" card on the Integrations page — paste two values, see status + copyable ingress URL + manifest download.

## 2. Signed ingress — `POST /api/slack/events/[bindingId]`

One URL per binding (deterministic lookup; no cross-tenant ambiguity; what the manifest embeds). Public endpoint, session-less, mirrors the webhook trigger's `systemPrisma` posture. Processing order:

1. **Rate limit** per bindingId (same helper as the webhook trigger).
2. Read the raw body (signature is computed over the exact bytes).
3. **Verify Slack signature** (Slack signs every request, including `url_verification`): `v0=HMAC_SHA256(signingSecret, "v0:{timestamp}:{rawBody}")` vs `x-slack-signature`, timing-safe compare, reject if `|now - x-slack-request-timestamp| > 300s`. Pure helper `verifySlackSignature(rawBody, timestamp, signature, secret)` in `src/lib/slack/verify.ts` — unit-tested with known vectors.
4. **Dedup**: Slack retries on slow acks — drop events whose `event_id` (or command `trigger_id`) was seen in the last 10 minutes (existing `cache` helpers).
5. **Echo guard**: drop events authored by the binding's own `botUserId` (or any `bot_id` message when the flow's trigger doesn't opt into bot messages). Prevents auto-reply loops.
6. **Ack fast**: respond 200 within the handler; the actual routing + dispatch runs in `after()` (or queue mode when `EXECUTION_MODE=queue`). Slash commands ack with an ephemeral `{"response_type":"ephemeral","text":"Working on it…"}`.
7. **Route** (see §3) and dispatch.

Payload normalization (pure, `src/lib/slack/payload.ts`): both event callbacks and slash commands map to one `SlackTriggerInput`:

```ts
{ kind: 'app_mention'|'message.im'|'message.channels'|'slash_command',
  text, user, channel, channelName?, ts, thread_ts?, team,
  command?, response_url?, permalink? }
```

exposed to the flow as `{{trigger.input.text}}`, `{{trigger.input.channel}}`, etc.

## 3. `slack` trigger type + routing

- `FLOW_TRIGGER_TYPES` gains `'slack'`. Trigger config stored on the flow:

```ts
{ type: 'slack', events: SlackEventKind[],          // which kinds this flow handles
  command?: string,                                  // for slash_command: which command
  channels?: string[],                               // optional channel-id allowlist
  keyword?: string,                                  // optional substring filter on text
  threadMemory?: boolean }                           // §5
```

- Pure router `matchSlackFlows(event, flows)` in `src/lib/slack/route-event.ts`: given the normalized event and the org's ACTIVE slack-triggered flows (published), return the flows whose config matches (kind ∈ events; command equality; channel allowlist; keyword substring). Multiple matches all dispatch (each its own run).
- Dispatch mirrors the webhook trigger: published graph, owner attribution, `trigger: { type:'slack', slack: { channel, thread_ts: thread_ts ?? ts, response_url?, bindingId } }` persisted on the run (the reply hook reads this), input = the normalized payload.
- Builder UI: `TriggerBody` gains a Slack panel (event kinds, command, channels, keyword, thread memory) + the org's binding status + copyable ingress URL. `validate.ts`: a `slack` trigger requires ≥1 event kind; `slash_command` requires `command`.

## 4. Auto reply-to-origin

- The run's trigger JSON carries the origin (`channel`, `thread_ts`, `response_url?`, `bindingId`). A post-run hook in `runFlowExecution` (fires on terminal status AND on pause, only when `trigger.type==='slack'`) posts back using the binding's bot token:
  - **succeeded** → final output, formatted to mrkdwn (`src/lib/slack/format.ts`, pure: strings pass through, objects/arrays become fenced JSON, 4k-char truncation with a "run link" suffix).
  - **failed** → short failure notice.
  - **waiting** → the pending question (this is the multi-turn bridge).
  - Slash commands use `response_url` when present (30-min validity), else the channel.
- Suppression: if the run already posted to the origin (a `native:slack`/`nango:slack` step targeting the same channel in this run), the hook stays silent for `succeeded` (explicit reply wins); it still posts questions/failures.
- Replies always go to the thread (`thread_ts`) so channels stay tidy.

## 5. Multi-turn — `SlackThreadSession`

New Prisma model:

```prisma
model SlackThreadSession {
  id             String   @id @default(cuid())
  organizationId String
  bindingId      String
  channel        String
  threadTs       String   // the thread root ts
  flowId         String
  flowRunId      String   // latest run in this thread
  agentExecutionId String? // latest agent execution (conversation seed)
  status         String   @default("open") // open | closed
  updatedAt      DateTime @updatedAt
  createdAt      DateTime @default(now())
  @@unique([bindingId, channel, threadTs])
  @@map("slack_thread_sessions")
}
```

- A slack-triggered run on a flow with `threadMemory: true` upserts the session (keyed by the reply thread) with its run id; the post-run hook records the run's last `agentExecutionId` (from the run's agent steps) on the session.
- **Ingress precedence** (before trigger matching): a non-bot message arriving in a thread with an `open` session routes as a **continuation**:
  - If the session's run is `waiting` → the message is the **reply**: resume via the existing `runFlowExecution({ flowRunId, reply })` path (the resumeKey machinery targets the paused iteration).
  - Else → start a new run of the session's flow with the message as input AND `slackContinueExecutionId: session.agentExecutionId` on the job; the run's agent adapter passes it as `continueExecutionId` for the FIRST agent step (graph position match), so the agent continues the same conversation. (Reuses the execute-agent seed mode shipped in flow-parity; scoped deliberately to the first agent step — documented limitation.)
- Sessions close on `stop`/`failed` terminal runs older than 7 days (cleanup in the existing cron dispatch) or when the flow is unpublished.

## 6. Security

- Signature verification with timing-safe compare + 5-min window; raw-body handling (no JSON re-serialization before HMAC).
- Secrets encrypted at rest via existing `secrets.ts`; never logged; redacted in all API responses.
- Everything org-scoped through the binding row; the ingress never trusts payload org/team claims beyond selecting the binding by URL id and verifying its signature.
- Echo guard (own botUserId + `bot_id` messages) prevents reply loops; dedup prevents retry double-runs; per-binding rate limit.
- The run executes the PUBLISHED graph only, like the webhook trigger.

## 7. Testing

- Pure units (no DB): `verifySlackSignature` (known HMAC vectors incl. stale timestamp + bad sig), `normalizeSlackPayload` (event callback, slash command, DM shapes), `matchSlackFlows` (kind/command/channel/keyword matrices), `formatSlackReply` (string/object/truncation), session-precedence decision helper.
- Route smoke: `url_verification` echo; 401 on bad signature; 200-fast ack shape.
- DB-gated e2e (local Postgres): binding create → ingress event → run dispatched with normalized input → reply hook posts (Slack API stubbed) → thread session upserted → thread message resumes a waiting run.

## Build order (one branch, SDD per-task reviews)

1. Schema (both models) + secrets plumbing + `POST/GET/DELETE /api/slack/connections` (+ auth.test verify) — the binding.
2. Pure slack lib: `verify.ts`, `payload.ts`, `format.ts` (+ unit tests).
3. Ingress route: challenge, signature, dedup, echo guard, fast-ack skeleton (no routing yet) + route smoke tests.
4. `slack` trigger type: trigger.ts, validate.ts, TriggerBody UI panel, copilot grounding line.
5. Routing + dispatch: `route-event.ts` + ingress wiring → runs with normalized input.
6. Reply-to-origin hook (format + suppression + response_url).
7. Multi-turn: `SlackThreadSession` + ingress precedence + continueExecutionId pass-through.
8. Manifest endpoint + Integrations-page Slack bot card.
