# n8n parity — top 5 gaps — design

Date: 2026-07-26 · Branch: one per gap, off `main` · Approved by James in-session.

Derived from an n8n source parity audit (n8n-master `packages/workflow`,
`packages/core`, `packages/nodes-base` vs `src/features/flows`,
`src/lib/flows`, `src/components/flows`). The audit named twelve gaps; this
spec covers the five highest-leverage ones. Gaps 6–12 (node `typeVersion`,
polling triggers + durable static data, managed webhook subscriptions, item
streams, full-JS expressions, community-node SDK, binary pipeline) are
explicitly out of scope here and get their own specs.

## Build order and delivery

One branch, one spec-derived plan, and one PR per gap, in this order:

**3 → 4 → 5 → 2 → 1** — smallest, purest-engine work first, so the two
full-stack features land on a base that is already proven. Each gap is
independently revertable. Later gaps do not depend on earlier ones except
where stated (none do, structurally).

---

## Gap 3 — Expression function expansion

**Problem.** `{{= fn(...) }}` (`src/features/flows/context.ts`,
`expressionValue`) ships 14 functions: `coalesce, concat, upper, lower, trim,
length, add, subtract, multiply, divide, if, json, stringify, now`. Everyday
data shaping that n8n users do inline — format a date, take the first element,
split a string, round a number — is impossible without dropping into a Code
node.

**Non-goal.** Arbitrary JS. The no-eval design is deliberate and stays: a fixed
whitelist of pure functions, quote/depth-aware `splitArgs`, exact-token
structure preservation.

**Change.** Add ~20 functions to the same registry, in four groups:

| Group | Functions |
|---|---|
| Dates | `formatDate(value, pattern)`, `addTime(value, amount, unit)`, `diffDays(a, b)`, `startOfDay(value)` |
| Arrays | `first(arr)`, `last(arr)`, `count(arr)`, `joinList(arr, sep)`, `pluck(arr, key)`, `unique(arr)`, `sum(arr)`, `sortBy(arr, key)` |
| Strings | `split(s, sep)`, `replace(s, find, repl)`, `slice(s, start, end?)`, `padStart(s, len, pad)`, `capitalize(s)` |
| Numbers | `round(n, places?)`, `floor(n)`, `ceil(n)`, `abs(n)`, `formatNumber(n, locale?)` |

Implemented on native `Date` / `Intl` / `Array` — **no new dependency**.
Every function is total: bad input returns a safe empty value rather than
throwing, matching how `matches` already handles a bad RegExp.

**Untouched.** Unknown-function behavior, arg splitting, `resolveTemplate` /
`resolveTemplateValue` structure preservation, the `readPath` root set.

**Verification.** Cases per function in
`src/features/flows/__tests__/context.test.ts`, including the total-on-bad-input
property. The builder's function hint list is updated so the token editor
autocompletes the new names.

---

## Gap 4 — Per-node error branch edges

**Problem.** n8n's `onError: 'continueErrorOutput'` synthesizes a dedicated
Error output port, so "if this node fails, go do X" is an ordinary graph edge.
Sublime has `onError: 'continue'` (structured `{ok: false, error}` output) and
the `errorShield` container, but failure cannot be *routed*.

**Change.** An edge may carry `branch: 'error'` out of any node type that
already supports `onError`: `agent`, `tool`, `http`, `code`, `subflow`.

Semantics, in the `interpret.ts` DAG scheduler:

- **Failure, error edge present** — the node settles `ok` carrying its existing
  structured-failure output `{ok: false, error}`; `activeEdges` lights only the
  error-labeled edges and prunes the normal ones, reusing the existing
  branch-node pruning path.
- **Success** — error edges are pruned exactly like a not-taken branch.
- **Failure, no error edge** — today's behavior, unchanged.

**Precedence.** error edge > `onError: 'continue'` > stop.

**Validation** (`src/lib/flows/validate.ts`):

- `ERROR_EDGE_WITH_CONTINUE` — warning; the node has both an error edge and
  `onError: 'continue'`, the edge wins.
- `ERROR_EDGE_UNSUPPORTED` — error; error edge out of a node type with no
  `onError` support.
- Error edges inside container bodies are forbidden, same rule as branch nodes.

**Downstream access.** `{{step.<id>.output.error}}` — no new context root.

**UI.** Supported nodes gain an "on error" connection affordance on the DAG
canvas; error edges render in the destructive tone.

**Resume and persistence are unaffected** — the node settles as a normal
completed step, so `completedKey`, `resolveResumeState`, and step-row
persistence need no change.

---

## Gap 5 — Partial re-run seeded from last run

**Problem.** n8n's `runPartialWorkflow2` reconstructs an execution stack from
prior run data and re-runs only what is dirty. Sublime has `startNodeId` /
`onlyNodeId` / `mockOutputs` / pins, but "run from here, reusing what already
ran" requires the user to supply mocks or pins by hand.

**Change.** `POST /api/flows/[id]/execute` with `startNodeId` gains
`seedMode: 'lastRun' | 'none'`, defaulting to `'lastRun'`.

Server-side seeding:

1. Load the newest terminal (`succeeded` | `failed` | `stopped`) run for the
   flow, scoped by the existing run-visibility rule.
2. Take its `succeeded` steps, keep only those whose `nodeId` still exists in
   the current draft graph **and** is a graph ancestor of `startNodeId`.
   Ancestor computation exists today as a closure inside `interpret.ts`
   (`ancestorsOf`, ~line 436, used to build edge-scoped upstream); this gap
   extracts it into a pure exported helper in `src/lib/flows/graph.ts` so the
   execute route can reuse it. Extraction is behavior-preserving and is
   covered by the existing `interpret-edge-scoped-context` tests.
3. Keep only top-level steps — a step with a non-empty `iterationPath` is
   skipped, so container internals are never seeded; a container's own final
   output is.
4. Pass the result as the interpreter's existing `completed` map. Variable /
   input / output replay comes free from the resume path already built for it.

**Precedence.** explicit `mockOutputs` > pins > last-run seed > live execution.
An upstream node with no seed simply runs live — today's behavior.

**Provenance.** The seeding run's id is written to `FlowRun.trigger` as
`seededFromRunId`. The run panel shows "upstream reused from run *X* · run
fresh instead"; the escape hatch re-dispatches with `seedMode: 'none'`.

**Rejected alternative.** n8n-style dirty-node detection needs per-node graph
hashing and change bookkeeping; ancestor-filtered seeding delivers the same
practical result for a fraction of the complexity and reuses code that exists.

---

## Gap 2 — External approvals via signed URLs

**Problem.** `humanReview` pauses and notifies, but the reply must come through
the authenticated Sublime UI (`POST /api/executions/[id]/reply`). n8n resumes
from a signed `$execution.resumeUrl` or a hosted form, and Slack "Send and Wait"
puts approve/decline buttons directly in the message. External stakeholders —
the common case for an approval — cannot act without an account.

**Node change.** `humanReview` gains
`approvalMode: 'reply' | 'approveDecline'`, defaulting to `'reply'`
(every existing node keeps today's behavior).

**Token model.** New Prisma model `FlowApprovalToken`:

| Field | Purpose |
|---|---|
| `flowRunId`, `nodeId`, `iterationPath` | Exactly which pause this token settles |
| `organizationId` | Tenant scope (tenant-guard compliant) |
| `tokenHash` | SHA-256 of a 32-byte random secret; **the secret is never stored** |
| `expiresAt` | Default 7 days |
| `usedAt` | Single-use claim |

Created when the pause persists. Best-effort invalidated when the run resumes
by any other path (in-app reply, time wake, stop).

**Public surface.**

- `GET /approve/[token]` — unauthenticated, minimal page. Renders **only** the
  flow name and the node's configured message. Approve / Decline buttons plus
  an optional comment field.
- `POST /api/approvals/[token]` — validates by hash, claims atomically
  (`updateMany where usedAt: null`, the same claim pattern as the run's
  waiting→running transition), then dispatches the existing resume with a
  structured reply `{approved, comment}`.

**Security.** Invalid, expired, and already-used tokens return an *identical*
404 — no existence oracle. Per-IP rate limiting on both routes. The page leaks
no org, user, or run detail beyond the message the flow author wrote. This is
the second session-less route in the app (the agent trigger endpoint is the
first) and is documented as such.

**Delivery.** The signed URL is included in the existing pause `notify()`
fan-out (bell / email / Slack). The in-app reply path keeps working and
consumes the token.

**Interpreter change.** Minimal: in `approveDecline` mode the resumed step
output is the structured decision object, so conditions branch on
`{{step.<id>.output.approved}}`.

**Rejected alternative.** Stateless HMAC tokens — cannot be made single-use
without a row to claim, and revocation on resume-by-other-path becomes
impossible.

---

## Gap 1 — Resource-locator pickers for tool and HTTP args

**Problem.** n8n's `resourceLocator` lets a user browse a connected account —
pick a Slack channel, a Sheet, a repo — with search, ID/URL entry, and
validation. Sublime's `tool-args-editor.tsx` renders MCP JSON-Schema fields as
plain text/token inputs, so filling `channel` means knowing the raw ID.

**Server.** A list-source registry, `src/lib/flows/list-sources.ts`, behind one
API: `POST /api/flows/list-options` `{connectionId, source, query?, cursor?}` →
`{items: [{value, label, description?}], nextCursor?}`. Three planes, all
org-scoped and credential-resolved server-side:

- **Nango** — per-capability listers via the Nango proxy: Slack channels/users,
  Sheets spreadsheets, Drive files, GitHub repos, Calendar calendars.
- **Native** — Google (Drive/Sheets via the stored refresh token) and Slack
  (generalizing the channels endpoint the trigger config already uses).
- **MCP** — heuristic sibling-lister: on the same server, find tools matching
  `list|search` whose output is array-shaped and drive the picker through them.

**Client.** `tool-args-editor.tsx` maps a schema field to a resource kind by arg
name/description pattern (`channel`, `user`, `spreadsheet`, `file`, `repo`, …),
scoped to the selected connection's provider. A matching field renders a
searchable combobox with three modes, mirroring n8n's resourceLocator:

1. **Pick from list** — the API above, searchable and paginated.
2. **Enter ID** — today's plain input.
3. **Use token** — today's `{{token}}` editor.

**Graph shape.** The picked value stays a **plain literal** in `args`. The human
label is cached in a new optional `argMeta` record on the tool node, purely for
display. Graphs therefore stay portable and no migration is needed.

**HTTP nodes** get pickers only when `authMode: 'predefined'` identifies the
provider.

**Rejected alternative.** Adopting n8n's `resourceLocator` value object
(`{__rl: true, mode, value, cachedResultName}`) inside `args` — it breaks arg
portability, requires migrating every existing graph, and pushes display
concerns into the execution payload. The literal-plus-`argMeta` sidecar avoids
all three.

---

## Testing posture

Consistent with the repo: `node:test` logic tests are the primary net.

- **Gap 3** — per-function cases plus a total-on-bad-input property.
- **Gap 4** — scheduler tests for failure-routes-to-error-edge,
  success-prunes-error-edge, precedence over `onError: 'continue'`, and the two
  new validation codes.
- **Gap 5** — seeding filters (missing node, non-ancestor, container-internal),
  precedence ordering, and provenance recording.
- **Gap 2** — token claim atomicity (concurrent double-approve settles once),
  identical-404 for invalid/expired/used, resume-by-other-path invalidation,
  and the structured decision output.
- **Gap 1** — registry dispatch per plane, org scoping, and the arg-name →
  resource-kind mapping. Live provider calls are mocked.

New API GET routes are added to the route-smoke completeness net. The two
public routes (`/approve/[token]`, `/api/approvals/[token]`) are session-less by
design and are documented alongside the agent trigger endpoint in
`ARCHITECTURE.md`.
