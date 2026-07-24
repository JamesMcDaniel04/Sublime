# Flow publish lifecycle, agent-callable flows, canvas toolbar, and credentialed exports

Date: 2026-07-24
Status: approved (design)

## Problem

Four user-reported defects. The first three share a single root cause; the
fourth is independent and reverses part of a decision made the day before.

1. **An agent's "Call flows" panel reports `0 available`** even for flows the
   user just published.
2. **The publish button shows a nonsensical version** (`Publish v4` on a flow the
   user believes they published once).
3. **There is no way to unpublish**, and the button never reflects whether the
   published version is current.
4. **Exports to n8n / Workato / Power Automate omit the credentials the flow
   needs**, so the recipient must hunt for a trigger secret that the export
   itself emits as the literal string `REPLACE_WITH_TRIGGER_SECRET`.

### Root cause: two competing definitions of "published"

`Flow` carries both a `status` string (`DRAFT | ACTIVE | DISABLED`) and a
nullable `publishedGraph`. Two code paths publish a flow, and they disagree
about which field expresses the fact:

| Path | sets `publishedGraph` | sets `status` |
|---|---|---|
| `src/lib/flows/activate.ts` (template provisioning, accepting a suggested flow) | yes | `ACTIVE` |
| `src/app/api/flows/[id]/publish/route.ts` (the editor's Publish button) | yes | **no** |

The two functions are otherwise near-identical: same graph parse, same
`validateFlowGraph` call with the same agent/tool-catalog inputs, same
`$transaction` shape. They were written separately and drifted on the one line
that matters.

Consumers then split across the two fields. Reading `status`:
`src/features/agents/tool-planes.ts` (`where: { status: 'ACTIVE' }`),
`src/app/agents/agent-config-form.tsx` (`status === 'active'`). Reading
`publishedGraph`: `src/app/api/cron/dispatch/route.ts`,
`src/app/api/flows/[id]/trigger/route.ts`, `src/lib/slack/dispatch.ts`,
`src/lib/activity/route-activity.ts`, `src/lib/flows/serialize.ts`.

So a flow published from the editor executes fine when triggered by webhook or
schedule, and is simultaneously invisible to every agent. That is defect 1.

There is also a third writer: `PUT /api/flows` accepts `status` directly, which
is how the editor's `Draft / Active / Disabled` dropdown works. A user can set
`status = ACTIVE` on a flow with no `publishedGraph`, producing a flow that
claims to be active and has nothing to run.

### Second, independent cause of defect 1

Even with `status` fixed, an agent configured for **All flows** still resolves to
zero tools. `loadFlowPlaneGroups` skips any flow lacking
`metadata.agentCallable === true` when no explicit `flowIds` are named
(`src/features/agents/tool-planes.ts`). Nothing in the product ever writes that
flag — `docs/superpowers/plans/2026-07-11-gumloop-track1-flows-as-tools.md`
records the toggle UI as an explicit follow-up that was never built. "All flows"
is therefore a permanently-empty option.

That gate is not merely vestigial: `loadFlowPlaneGroups` queries
`where: { organizationId }` with no per-user read filter. Deleting the gate
without replacing it would expose every colleague's private flow to any agent
with `allowFlows` enabled.

### Defect 2 is not a counting bug

`Flow.version` is per-flow and cannot be influenced by other flows. Only two
sites write it, both reading that flow's own row (`existing.version + 1`), and
`FlowVersion` carries `@@unique([flowId, version])`, so the database namespaces
version numbers per flow.

The confusion is that `version` serves two purposes at once:

- it **defaults to `1` at creation**, before anything is published, so the first
  publish produces `2`;
- the button renders `version + 1` — the *next* number — while the History panel
  renders the *stored* numbers.

One real publish therefore labels the button `Publish v3`, and two label it
`Publish v4`, while History correctly shows `v2` and `v3`.

No migration is warranted. The publish/unpublish redesign removes version math
from the button entirely, leaving version numbers visible only in History where
they are unambiguous.

### Defect 4 conflicts with a deliberate prior decision

Commit `6c822f7` ("fix(flows): stop exporting inline HTTP auth credentials")
removed credentials from all five export targets one day before this design.
Reversing part of it is intentional and requires the safety to move rather than
disappear.

Two hard constraints:

- The flow's webhook trigger secret is stored as a **SHA-256 hash only**
  (`src/app/api/flows/[id]/trigger-secret/route.ts`). The plaintext is
  unrecoverable, which is exactly why exports emit a placeholder.
- Export currently requires only **read** scope
  (`src/app/api/flows/[id]/export/route.ts`), so embedding secrets today would
  hand an org-shared flow's credentials to every viewer.

## Goals

- One definition of "published", written by one function.
- An agent configured to call flows can actually call the flows its owner can see.
- A publish control that reflects real state and can be reversed.
- A top bar without redundant or dead controls.
- Exports that arrive ready to run, with the access model tightened to match.

## Non-goals

- Renumbering existing versions or migrating `Flow.version`.
- Removing the `status` column from the schema.
- Making OAuth connection grants portable (they cannot be).
- A per-flow "agent-callable" settings UI (the per-agent toggle replaces it).

---

## 1. One source of truth for "published"

Extract `src/lib/flows/publish.ts`:

```ts
export type PublishResult = { published: true; version: number } | { published: false; reason: string }

/** Validate the draft and make it live. The only writer of publish state. */
export async function publishFlowDraft(
  flowId: string, organizationId: string, userId: string,
): Promise<PublishResult>

/** Retract a live flow. Keeps version history and the version counter. */
export async function unpublishFlow(
  flowId: string, organizationId: string, userId: string,
): Promise<{ unpublished: boolean }>
```

`publishFlowDraft` holds the body currently duplicated between
`activate.ts` and `publish/route.ts`: parse `graph`, collect the referenced
connection ids, load readable agents and the tool catalogue, run
`validateFlowGraph`, derive the trigger via
`preserveWebhookSecretHash(triggerFromGraph(...))`, then in one transaction
update the flow and create the `FlowVersion` row.

It returns a reason rather than throwing, preserving `activateFlow`'s existing
contract (callers that must not fail a deploy degrade to DRAFT with the reason).
`POST /api/flows/[id]/publish` converts a `published: false` result into an
`ApiError(reason, 400, 'FLOW_VALIDATION_ERROR')`, preserving the current wire
behaviour for the editor.

`activateFlow` becomes a thin wrapper that maps `PublishResult` onto its
existing `ActivateFlowResult` shape, so its two callers
(`src/app/api/templates/provision/route.ts`,
`src/app/api/intelligence/user-suggestions/route.ts`) are unchanged.

### State transitions

| Action | `publishedGraph` | `status` | `version` | `FlowVersion` row |
|---|---|---|---|---|
| Publish | ← current draft graph | `ACTIVE` | `+1` | created at the new number |
| Unpublish | `null` | `DRAFT` | unchanged | **retained** |
| Revert (existing behaviour) | unchanged | unchanged | unchanged | — |

Unpublish deliberately does not decrement `version` or delete rows: reusing a
number would violate `@@unique([flowId, version])` on republish, and destroying
a user's restore points is not the inverse of publishing.

### Closing the third writer

`status` is removed from the `flowSchema` fields writable by `PUT /api/flows`.
A `status` key in a PUT body is **ignored, not rejected** — zod strips unknown
keys by default, so an older client keeps saving successfully and simply stops
moving the flow's publish state. `POST /api/flows` keeps accepting it, because
template provisioning creates rows with an explicit status. The editor stops
sending `status` on save (§4 removes the control that produced it).

Audit and behavioural events already emitted on publish (`flow.published`,
`flow_published`, the `suggestion_accepted` branch) move into
`publishFlowDraft` so both entry points record them. Unpublish emits a matching
`flow.unpublished` audit record.

### Ordering note

Because unpublish sets `status = DRAFT`, a flow that was published and then
unpublished is correctly skipped by the cron dispatcher, the webhook trigger
route, Slack dispatch, and the agent tool loader — all of which already require
one or both fields. No consumer needs changing for unpublish to take effect.

### Knock-on effects on the flows list

`src/app/flows/page.tsx` renders a status badge and partitions its "Suggested
for you" rail on `flow.suggested && flow.status === 'draft'`. Neither needs
changing, and both get more accurate: today an editor-published flow still badges
as "draft" and a published suggestion never leaves the suggestion rail. After
§1 the badge tracks reality and a published suggestion graduates out of the rail
on its own.

---

## 2. Agent-callable flows

### 2a. Replace the dead gate with a real read scope

In `loadFlowPlaneGroups` (`src/features/agents/tool-planes.ts`):

- add `...flowReadScope(userId)` to the Prisma `where`;
- delete the `if (!options.explicit && !isAgentCallableFlow(flow.metadata)) continue` line;
- keep `status: 'ACTIVE'` — after §1 it is a true synonym for published, and it
  is the indexed field.

The agent's `allowFlows` toggle plus its optional `flowIds` list becomes the
opt-in, which is what the configuration UI already implies. The `explicit`
option becomes unnecessary and is removed from the signature along with its call
site in `src/features/agents/execute-agent.ts`.

This is strictly tighter than the status quo, not looser: today a flow marked
`agentCallable` would be exposed to any agent in the organisation regardless of
who owns the flow. After the change, an agent can only reach flows its owner can
read.

`isAgentCallableFlow` and its tests in `src/lib/flows/__tests__/flow-tool.test.ts`
are deleted; the metadata key is left unread rather than migrated, since nothing
ever wrote it.

### 2b. Align the picker with the runtime

`src/app/agents/agent-config-form.tsx` filters on the serialized `published`
field instead of `status === 'active'`, so the picker and
`loadFlowPlaneGroups` agree on one predicate. `/api/flows` already applies
`flowReadScope`, so the list the user sees is the list the agent can reach.

The empty-state copy stays accurate: with §1 and §2a in place, "No published
flows yet — publish a flow to call it from an agent" becomes true rather than
misleading.

---

## 3. Publish / Unpublish control

`serializeFlow` already returns `published` and `unpublishedChanges`
(`src/lib/flows/serialize.ts`), so no new derived state is required. The editor's
`publish()` already saves the draft before publishing
(`src/app/flows/[id]/page.tsx`), so the server's stored draft is authoritative
when computing `unpublishedChanges`.

Let `behind = unpublishedChanges || dirty`, where `dirty` is the editor's
existing unsaved-edits predicate (`src/app/flows/[id]/page.tsx`). Both terms are
needed: `unpublishedChanges` is computed server-side against the *saved* draft,
so without `dirty` the button would read "Unpublish" while the user is looking at
unsaved edits on screen.

| State | Primary button | Secondary |
|---|---|---|
| `!published` | **Publish** | — |
| `published && !behind` | **Unpublish** | — |
| `published && behind` | **Publish changes** | Revert |

Note that `dirty`'s snapshot key currently includes `status`; §4 removes that
term along with the control.

No version number appears on the button in any state; `title` attributes carry
the detail (`Published v3` / `Draft differs from the published version`).
Version numbers remain in the History panel, which already reads stored
`FlowVersion` rows.

Unpublish requires confirmation, because it silently breaks live integrations:

> Unpublish this flow? Scheduled runs and webhook triggers stop firing, and any
> agent wired to call it loses the tool. Your draft and version history are kept.

Wire protocol: `POST /api/flows/[id]/publish` gains `{ unpublish: true }`
alongside the existing `{ revert: true }`. Three modes — publish (neither flag),
revert, unpublish — and the request schema rejects a body setting both flags.

All three modes return `serializeFlow(flow)`, so the editor takes `published`,
`unpublishedChanges`, and `version` from the response rather than computing them
locally.

---

## 4. Canvas toolbar

Three changes to the top bar in `src/app/flows/[id]/page.tsx`, plus one to
`src/components/flows/jam-button.tsx`.

**Remove the status `<select>`.** It duplicates the publish control and, per §1,
`status` is no longer writable through `PUT /api/flows`. The `status` state
variable, its inclusion in the `savedSnapshot` dirty-tracking key, and its place
in the save payload are removed with it.

**Remove emoji reactions.** Delete `ReactionPicker` from `jam-button.tsx`, the
`onReact` prop, `handleReact` / `pushReaction` / `floatingReactions` state, the
`onReaction` callback passed to `useFlowJam`, and the `<JamReactionsOverlay>`
render. `sendReaction` / `onReaction` are also removed from
`src/components/flows/use-flow-jam.ts` and `JamReactionsOverlay` /
`FloatingReaction` from `src/components/flows/flow-comments.tsx`.

**Spotlight survives the deletion.** "Spotlight me — ask everyone to follow" is
currently nested inside the reaction dropdown but is an unrelated collaboration
feature. It moves into the Jam presence popover, next to the existing
follow-a-peer controls, keeping `requestSpotlight` wired.

**Move Jam and Huddle onto the canvas.** `JamButton` leaves the top bar and
renders as a floating pill anchored to the top-right of the canvas body. The
body wrapper is already `position: relative`, so a single absolutely-positioned
overlay serves both the stack and DAG modes without duplicating the element per
branch. It sits above the canvas in stacking order and must not intercept
pointer events outside its own bounds (`pointer-events-none` on the positioning
wrapper, `pointer-events-auto` on the pill).

Every other top-bar control keeps its current position and behaviour.

---

## 5. Credentials in exports

### Access model

`/api/flows/[id]/export` changes from a `GET` to a `POST` taking
`{ target, includeCredentials }`. The verb changes because the route can now mint
a secret as a side effect.

Scope is **per-request, not per-route**:

- `includeCredentials: false` (the default) keeps the current `flowReadScope` —
  the sanitized export leaks nothing the builder does not already show, so
  anyone who can open a shared flow can still take a copy of it.
- `includeCredentials: true` requires `flowOwnerScope`, matching the existing
  rule for `trigger-secret`. A non-owner requesting it gets 403.

Defaulting to `false` preserves today's behaviour for any caller that does not
opt in.

### Making the trigger secret recoverable

The trigger secret is currently hash-only. Rotating it on every export would
silently invalidate the previous export and any live integration, so instead it
is stored reversibly **in addition to** the hash:

- `flow.trigger.webhookSecretHash` — unchanged, still the validation path, so
  `src/app/api/flows/[id]/trigger/route.ts` needs no changes;
- `flow.trigger.webhookSecretEnc` — new, `encryptSecret(secret)` using the
  existing AES-256-GCM helper in `src/lib/crypto/secrets.ts` that already
  protects MCP connection secrets. `ENCRYPTION_KEY` is already required in
  production.

`POST /api/flows/[id]/trigger-secret` writes both fields when minting or
rotating. `preserveWebhookSecretHash` (`src/lib/flows/trigger.ts`) is extended to
carry `webhookSecretEnc` across trigger edits alongside the hash, or a plain
save would wipe it.

At export time:

- ciphertext present → decrypt and embed; the existing secret keeps working;
- ciphertext absent (a secret minted before this change) → mint a **new** secret,
  persist both fields, embed the plaintext, and state in the response and in the
  file's `requirements` that the previous secret is now invalid;
- no secret at all and the flow uses a webhook trigger → mint one, same as above.

`sanitizeTrigger` in `src/lib/export/portable.ts` must strip
`webhookSecretEnc` as well as `webhookSecretHash` from the exported trigger
object in **every** case, credentials included or not — the ciphertext is a
credential and is useless off-platform anyway.

### Where the plaintext lives in the portable document

The plaintext must not be smuggled back into `flow.trigger`, or the "strip in
every case" rule above becomes untestable. Instead `PortableFlow` gains an
optional, clearly-named top-level block:

```ts
credentials?: {
  /** Plaintext webhook trigger secret for this flow, if it has one. */
  triggerSecret?: string
  /** Plaintext trigger secrets for inlined agents, keyed by PortableAgent.ref. */
  agentTriggerSecrets?: Record<string, string>
}
```

Absent entirely when `includeCredentials` is false. The four non-portable target
emitters read from this block when substituting placeholders; the portable target
ships it as-is, which is what makes it re-importable. A single top-level block
also gives the tests one place to assert on.

### What travels and what cannot

| Credential | Included when `includeCredentials` | Why |
|---|---|---|
| Flow webhook trigger secret | yes | recoverable per above; the exported HTTP call is worthless without it |
| Agent trigger secret (agent-step callbacks) | yes, same mechanism | same shape: `src/app/api/agents/[id]/trigger-secret/route.ts` stores `metadata.triggerSecretHash` and gains a sibling `metadata.triggerSecretEnc`. (It already tolerates a legacy plaintext `metadata.triggerSecret`; that field is read-only for compatibility and is never written.) |
| Inline HTTP `auth` option (password / token / value) | yes | user-typed into the graph; recoverable verbatim. Currently stripped by `redactHttpAuthOption` (`src/features/flows/http.ts`) |
| Authorization / Proxy-Authorization / Cookie headers, credential-shaped URL and body fields | yes | same rationale; currently stripped by `redactAuthHeaders` / `redactDeep` / `redactUrl` |
| Nango OAuth connection grants | **no** | per-user grants scoped to this application; no export can make them work elsewhere. They remain named `requirements`. |

Implementation shape: `toPortableFlow` gains an options argument
(`{ includeCredentials: boolean; triggerSecret?: string; agentTriggerSecrets?: Record<string, string> }`).
`sanitizeNode` skips its redaction calls when credentials are included. Because
all five targets convert the *same* portable document, no target can accidentally
diverge — the property commit `6c822f7` established is preserved.

**The redaction helpers themselves stay unconditional.** `redactHttpAuthOption`,
`redactAuthHeaders`, `redactDeep`, and `redactUrl` gain no "include credentials"
parameter. `redactHttpAuthOption` is shared with `redactHttpStepInput`, which
sanitizes **persisted run rows**; threading a bypass flag through it would put
one keystroke between a correct export and plaintext tokens written to the
database. The opt-in lives one level up, in `sanitizeNode` deciding whether to
call them at all.

The five target emitters replace their `REPLACE_WITH_TRIGGER_SECRET` /
placeholder literals with the real value when one is supplied, and keep the
placeholder otherwise.

### Marking the output

An export containing credentials is itself a credential. Three places say so:

- the portable document gains `containsCredentials: true` and a leading
  `requirements` entry stating that the file carries live secrets and should be
  handled accordingly;
- `toInstructions` emits the same warning as its first line;
- the download toast in the editor changes from
  "Credentials were not included…" to a warning that the file contains live
  credentials. The current toast asserts the opposite and is wrong the moment
  this ships.

The export menu offers both variants explicitly rather than silently choosing,
so the user's intent is recorded in the click:

- *"n8n workflow (with credentials)"* — the default for each target
- *"n8n workflow (no credentials)"* — the sanitized variant

The editor already carries the ownership predicate as `canManageJam`
(`src/app/flows/[id]/page.tsx` — the API returns it and its own comment names it
as ownership). Non-owners see only the sanitized variants, matching the scope
rule. The server enforces this independently; the menu is convenience, not the
control.

---

## Testing

Unit and integration tests, following the existing `node:test` layout under
`__tests__` directories.

**Publish lifecycle** (`src/lib/flows/__tests__/publish.test.ts`, new)
- publish sets `publishedGraph`, `status = ACTIVE`, `version + 1`, and creates the
  `FlowVersion` row at the new number
- publish on an invalid graph returns `{ published: false, reason }` and mutates
  nothing
- unpublish nulls `publishedGraph`, sets `status = DRAFT`, and leaves `version`
  and all `FlowVersion` rows intact
- publish → unpublish → publish produces version `n+2` with no unique-constraint
  violation

**Agent tool loading** (`src/features/agents/__tests__/tool-planes.test.ts`, new)
- a flow published through `publishFlowDraft` appears as a `flow_<slug>` tool for
  an agent with `allowFlows` and no `flowIds` — the regression test for defect 1
- a flow owned by another user and not shared does **not** appear
- an org-shared flow does appear
- an unpublished flow does not appear

`src/app/api/__tests__/tool-capture-e2e.test.ts` currently seeds its fixture with
`metadata: { agentCallable: true }`. That flag stops being read, so the fixture
must instead be published (or seeded with `status: 'ACTIVE'` plus a
`publishedGraph`) and owned by the agent's owner, or the test silently stops
exercising the flow-tool path.

**Route smoke** (per the `verify` skill's protocol, real handlers + seeded auth)
- `POST /api/flows/[id]/publish` then `GET /api/flows` shows `published: true`
  and `status: 'active'`
- `{ unpublish: true }` reverses both
- `PUT /api/flows` with a `status` field no longer changes `status`

**Export** (`src/lib/export/__tests__/export.test.ts`, extend)
- with `includeCredentials: false`, every one of the five targets still redacts —
  the existing assertions from `6c822f7` are kept verbatim as the regression
  guard
- with `includeCredentials: true`, every target carries the real trigger secret
  and the inline HTTP auth value, and none carries `webhookSecretHash` or
  `webhookSecretEnc`
- a non-owner receives 403 when requesting `includeCredentials: true`
- exporting twice with a pre-existing encrypted secret returns the **same**
  secret and does not rotate

**Trigger secret round-trip** (`src/lib/crypto/__tests__` or alongside the route)
- mint → the stored ciphertext decrypts to the returned plaintext, and the
  stored hash validates it
- a trigger edit through `PUT /api/flows` preserves both fields

## Risks and mitigations

**An exported file is now a credential.** Anyone it is forwarded to can trigger
the flow. Mitigated by owner-only access, an explicit opt-in per download, and
labelling in three places — but not eliminated. This is inherent to the request.

**Reversing part of `6c822f7`.** The no-credentials path remains the default and
keeps its full test coverage, so the behaviour that commit established is still
enforced for every caller that does not opt in.

**Removing the status dropdown removes a capability.** `DISABLED` becomes
unreachable from the editor. Nothing else in the product distinguishes `DISABLED`
from `DRAFT` — both fail the `status === 'ACTIVE'` and `publishedGraph != null`
checks — so no behaviour is lost. Existing `DISABLED` rows keep working and can
be republished.

**`ENCRYPTION_KEY` dependency.** Already mandatory in production. In development
without a key, `encryptSecret` falls back to reversible base64 and the trigger
secret is stored no more securely than the rest of that environment; production
is unaffected.
