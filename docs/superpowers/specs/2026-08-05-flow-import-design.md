# Flow Import — file, URL, and paste, with n8n conversion

**Date:** 2026-08-05
**Status:** Approved
**Branch:** `feat/flow-import` (off `feat/goal-recovery-plans`)

## Goal

Let users create a flow from JSON they already have — an uploaded `.json` file, a
URL, or pasted text — the way n8n's "Import from file / Import from URL" works.
Sublime has a complete export pipeline (`sublime.flow` portable docs, an n8n
converter, the builder's plain download) but no import half. This adds it, and
goes one step further: it imports **n8n's own workflow JSON** by converting it
into a Sublime flow.

## Accepted formats

Format is auto-detected from the parsed JSON, in this order:

1. **`sublime.flow` portable v1** — detected by `format: 'sublime.flow'`
   (`src/lib/export/portable.ts`). The inverse of `toPortableFlow`.
2. **Bare builder download** — `{ name, description?, version?, graph }`, the
   shape `downloadFlow()` emits from the builder. Detected by a top-level
   `graph` with `nodes`/`edges` arrays.
3. **n8n workflow** — `{ name?, nodes: [...], connections: {...} }`, n8n's
   export/import shape (documented in `src/lib/export/n8n.ts:8-11`). Detected
   by `nodes` + `connections` and n8n-style node `type` strings.

Anything else → 400 `UNRECOGNIZED_FORMAT` with a human-readable message
listing the supported shapes. `sublime.agent` docs are out of scope (flows
only); importing one returns a targeted error saying it's an agent export.

## n8n conversion (deterministic, no LLM)

A pure mapper `fromN8nWorkflow(workflow): { name, description, trigger, graph,
report }` in `src/lib/import/n8n.ts`, the structural inverse of
`toN8nWorkflow`:

### Node mapping

| n8n type (`n8n-nodes-base.*`) | Sublime node |
|---|---|
| `manualTrigger`, `executeWorkflowTrigger` | `trigger` (manual) |
| `webhook` | `trigger` (webhook; secret re-minted on our side, never imported) |
| `scheduleTrigger`, `cron` | `trigger` (schedule; interval/cron mapped best-effort, else manual + warning) |
| `httpRequest` | `http` (method, url, headers, query, body; auth → warning to re-enter credentials) |
| `if` | `condition` (v2 structured conditions → `ConditionClause` best-effort; untranslatable expressions → empty condition + warning) |
| `switch` | `switch` (rules → cases; expression rules → warning) |
| `filter` | `filter` |
| `code`, `function`, `functionItem` | `code` |
| `set` / Edit Fields | `transform` |
| `wait` | `wait` (amount/unit) |
| `splitInBatches` | `loop` |
| `stopAndError` | `stop` |
| `respondToWebhook` | `respondWebhook` |
| `executeWorkflow` | `subflow` with cleared `flowId` + warning (foreign id is meaningless here) |
| `merge`, `noOp` | dropped; incoming edges rewired to the node's targets (Sublime's DAG has native fan-in) |
| `@n8n/n8n-nodes-langchain.agent`, `openAi`, other AI chat nodes | `agent` step — prompt/system text lifted from parameters, `agentId` left empty for the user to bind |
| **everything else** (the ~400 integration nodes: Slack, Gmail, Sheets, …) | **`http` stub** — label = original node name; the original n8n `type` and `parameters` summarized into the step so the user can rebuild the API call; each one listed in the import report |

Per the product call: integration nodes are deliberately *not* mapped to native
Sublime tool connections in v1 — most are just API calls, so an HTTP stub plus
a clear report entry is the honest, shippable mapping.

### Wiring

- n8n `connections` are keyed by node **name**; convert to id-keyed
  `FlowEdge[]` via the workflow's own name→id table.
- Multi-output nodes: `if` output index 0/1 → `branch: 'true'/'false'`;
  `switch` output index *n* → the corresponding case id, last → `'default'`.
- `position: [x, y]` → `graph.layout[nodeId] = { x, y }`.
- If the workflow has no trigger node, a manual `trigger` node is prepended and
  wired to the entry nodes (Sublime graphs require one; `validateFlowGraph`
  enforces it).

### Expressions

n8n `={{ $json.x }}` expressions do not translate mechanically. v1 leaves them
verbatim in text fields and adds one summary warning to the report
("N n8n expressions were kept as-is — rewrite them as {{step.…}} references").
No partial regex rewriting: half-translated expressions are worse than honest
untranslated ones.

## Portable / bare import

`fromPortableFlow(doc)` in `src/lib/import/portable.ts`:

- Rebuilds `{ name, description, trigger, graph }` from `doc.flow`.
- **Never** imports `doc.credentials`, `containsCredentials`,
  `trigger.webhookSecretHash`, or `trigger.webhookSecretEnc` — a foreign secret
  is dropped on the floor, and webhook triggers get a fresh secret when the
  user publishes, exactly like a hand-built flow.
- **Inlined agents:** each `doc.agents[]` entry is created as a new agent in
  the importing workspace (title, instructions, goal, model), and agent steps'
  `agentId` refs are remapped to the new ids — the same move as
  `rewriteGraphAgentRefs` in `src/lib/templates/provision-plan.ts:98`. Created
  agents appear in the report. Agent `integrations` are reported as
  integrations to connect, not silently bound.
- `doc.requirements` are surfaced verbatim in the report warnings.

The bare download shape skips agent handling (it carries none) and imports the
graph directly.

## Reference rebinding (all formats)

Imported graphs point at another workspace. Auto-rebind + warn, never trust:

- `connectionId` values that are plane-scoped (`nango:<capability>`,
  `native:<provider>`) or `template:<name>` are kept / resolved via
  `resolveGraphToolConnections` against the workspace catalog
  (`src/lib/templates/provision-plan.ts:44`). Raw MCP row ids from a foreign
  workspace are cleared and reported.
- Unresolved connections surface as `missingIntegrations` in the response, the
  same computation `POST /api/flows` already does (`route.ts:161-181`).
- `metadata.errorFlowId` and subflow `flowId` refs are cleared with a warning.
- Node ids are regenerated if they collide or fail schema; edges follow.

## API

**`POST /api/flows/import`** — new route,
`src/app/api/flows/import/route.ts`, wrapped in `withAuthenticatedApi` with
`requires: 'member'` and a declared `rateLimit` (URL fetch is an outbound
egress primitive; e.g. `{ feature: 'flow-import', perUser: 20,
windowSeconds: 60 }`).

Request body (JSON — no multipart; the dialog reads uploaded files client-side
with `FileReader` and sends the text):

```ts
{ document: string }   // raw JSON text (file contents or pasted)
// or
{ url: string }        // server-side fetch
```

URL fetch hardening (modeled on `src/lib/metrics/sources/url.ts`):
`assertEgressAllowed(url)` then `await assertPublicUrl(url)`
(`src/lib/integrations/http.ts:27`, `src/lib/net/ssrf.ts:96`), https only,
10s timeout, 2 MB response cap, redirects followed at most 3 hops with both
guards re-run per hop. Inline `document` is capped at 2 MB too.

Processing pipeline (shared across formats):

1. Parse JSON (400 `INVALID_JSON` on failure), detect format
   (`src/lib/import/detect.ts`).
2. Convert to `{ name, description, trigger, graph, agentsToCreate, report }`.
3. `flowGraphSchema.parse(graph)` → 400 `INVALID_GRAPH` with the zod message.
4. `assertNoInlineSecrets(graph)` (shared with `POST /api/flows`) — imported
   JSON is untrusted and can carry literal HTTP auth secrets.
5. `validateFlowGraph(graph, …)` — failures become report **warnings**, not
   rejections: the flow lands as an editable DRAFT and the hard gate stays at
   publish, same as a hand-built flow.
6. `assertFlowCapacity(orgId)`; create inlined agents (portable format only);
   rebind connections/agents; then `prisma.flow.create` with forced
   `status: 'DRAFT'`, `visibility: 'private'`, `version: 1`,
   `publishedGraph: null`.
7. `recordUserEvent({ kind: 'flow_created' })` (same as the create path).

Response:

```ts
{ success: true,
  flow: serializeFlow(flow),
  report: {
    source: 'sublime-portable' | 'sublime-download' | 'n8n',
    warnings: string[],          // expressions kept, cleared refs, validation issues, doc.requirements
    stubbedNodes: { nodeId, label, originalType }[],   // n8n integration tail → http stubs
    missingIntegrations: string[],
    createdAgents: { id, title }[] } }
```

Agent creation + flow creation run in one `prisma.$transaction` so a failed
import leaves nothing behind.

## UI

**Flows list** (`src/app/(app)/g/[scope]/flows/page.tsx`): an **Import**
button next to "New flow", opening `ImportFlowDialog`
(`src/components/flows/import-flow-dialog.tsx`) built from the existing
`Dialog`/`Tabs`/`Input`/`Textarea` primitives — no new dependency:

- **Upload** tab: `<input type="file" accept=".json,application/json">` plus a
  drag-and-drop target (native drag events; there is no dropzone dep). File is
  read client-side and submitted as `document`.
- **From URL** tab: URL input → submits `{ url }`.
- **Paste JSON** tab: textarea → submits `{ document }` (mirrors the cURL
  import UX in `http-body.tsx:126-200`).

On success: navigate to the builder (`/g/[scope]/flows/[id]`). The report is
shown in the dialog's success state before navigating — warnings, stubbed
nodes, missing integrations — so nothing is silently dropped. Errors render
inline in the dialog (message from `ApiError`).

## Error handling summary

| Case | Result |
|---|---|
| Unparseable JSON | 400 `INVALID_JSON` |
| Recognized none of the three shapes | 400 `UNRECOGNIZED_FORMAT` |
| `sublime.agent` doc | 400 `AGENT_EXPORT` ("this is an agent export…") |
| Graph fails `flowGraphSchema` | 400 `INVALID_GRAPH` |
| Inline literal auth secret | 400 `INLINE_AUTH_SECRET` (existing code) |
| SSRF / disallowed URL | 400 `URL_NOT_ALLOWED` (message from `SsrfError`) |
| URL fetch timeout / too large / non-2xx | 400 `URL_FETCH_FAILED` |
| Over flow cap | 402 from `assertFlowCapacity` (existing) |
| `validateFlowGraph` issues | imported anyway; issues in `report.warnings` |

## Testing

- **Unit:** `detect` on all shapes + junk; `fromPortableFlow` round-trip
  against `toPortableFlow` (secrets dropped, agents remapped);
  `fromN8nWorkflow` round-trip against `toN8nWorkflow`; real hand-written n8n
  fixture files (webhook trigger + if + http + Slack integration node)
  asserting mapping, branch wiring, layout, stub reporting; trigger-less
  workflow gets a manual trigger prepended.
- **Route:** DB-backed tests in `src/app/api/flows/__tests__/` via
  `seedTestOrg`/`installTestAuth` — happy path per format, transaction
  atomicity (agent creation failure leaves no flow), secret-stripping,
  URL-mode SSRF negatives (mock fetch; private-IP URL rejected before any
  request), size cap.
- **Structural CI guards:** entry in `mutation-route-contract.test.ts`;
  covered by mutation-coverage (no `PENDING_COVERAGE` escape hatch exists);
  uses `withAuthenticatedApi` so route-permissions passes.

## Out of scope (v1)

- LLM-assisted conversion of unmapped n8n nodes (deterministic stubs only).
- Mapping n8n integration nodes to native Sublime tool connections.
- Expression translation (`$json`/`$node` → `{{step.…}}`).
- Workato / Power Automate import.
- Import from inside the builder (list-page dialog only).
- `sublime.agent` import.
