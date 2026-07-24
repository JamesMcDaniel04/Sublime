# Flow Node Setup Hardening — Implementation Plan (Phases 0–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 2766-line `step-card.tsx` into a per-node-type registry, build an n8n-style Node Detail View (Input | Parameters | Output) as the single node-config surface, and let a user test exactly one node without firing anything downstream.

**Architecture:** Three sequenced phases. Phase 0 turns `renderNodeBody`'s switch into a data registry (`NODE_BODIES`) so the param bodies have exactly one implementation with two consumers. Phase 1 adds `src/components/flows/ndv/` — an overlay hosting the registry body between a datatree input pane and a last-run output pane — and demotes the canvas card to summary-only. Phase 2 adds `opts.onlyNodeId` to the interpreter (making downstream nodes *structurally* unreachable rather than conditionally skipped), a pure input-resolution module, a `FlowNodePin` table for dev-time fixtures, and a `/test-node` route.

**Tech Stack:** Next.js 15 (App Router, `runtime = 'nodejs'`), React 19, Prisma + Postgres, Zod, `node:test` + `@testing-library/react` (jsdom), `tsx`, Tailwind, motion/react, lucide-react.

**Spec:** [`docs/superpowers/specs/2026-07-24-flow-node-setup-hardening-design.md`](../specs/2026-07-24-flow-node-setup-hardening-design.md)

## Global Constraints

- **Node:** `>=20 <23`. TypeScript strict; no `any` in shipped code (tests may cast).
- **Phase 0 is a pure refactor.** Zero behaviour change. Every moved body must be moved *verbatim* — no renames, no "while I'm here" cleanups, no reformatting. The proof is that existing tests pass untouched and `tsc --noEmit` is clean.
- **Org-scope guard:** every Prisma query against an org model MUST include `organizationId` (the tenant guard in `src/lib/tenant-guard.ts` throws otherwise).
- **Secrets discipline:** never persist a decrypted secret to `Flow.graph`, `FlowRunStep.input/output`, client responses, or logs. Pins (Phase 2) store *node output*, which can contain API response data — pins are therefore per-user and never enter `publishedGraph` or `/export`.
- **Write-safety invariant (Phase 2, non-negotiable):** a "Test step" action must never execute a node the user did not select. Assert it with a test, not by inspection.
- **Unit/component test run:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`
- **Full suite:** `npm test`
- **Typecheck:** `npx tsc --noEmit -p tsconfig.json` (must exit 0)
- **DB/route test run:** bring up throwaway Postgres per the **`verify`** skill (Homebrew PG15, port 54339, stub the Supabase objects, `prisma migrate deploy`), then prefix with `TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa`. Seed with `seedTestOrg(prisma)` → `{ organizationId, userId, auth, cleanup }` and `installTestAuth(auth)` from `@/lib/server/__tests__/test-auth`.
- **Commit** after every task, with green tests. Work on the current feature branch; do not push unless asked.

---

## File Structure

**Phase 0 — Create**

- `src/components/flows/nodes/field-primitives.tsx` — shared control classes + small pure helpers every body uses (`labelClass`, `controlClass`, `tokenControlClass`, `isRecord`, `parseKeyValueRows`, `serializeKeyValueRows`, `uniqueFieldName`, `inputTypeForField`, `stopEvent`).
- `src/components/flows/nodes/types.ts` — `NodeBodyProps`, `NodeBodyModule`, `TokenEditorWiring`, `Agent`, `KeyValueRow`, `InputKind`.
- `src/components/flows/nodes/registry.ts` — `NODE_BODIES: Record<FlowNode['type'], NodeBodyModule>`.
- `src/components/flows/nodes/<type>-body.tsx` — one module per node type (22 files, listed per task).
- `src/components/flows/nodes/__tests__/registry.test.ts` — totality + metadata tests.
- `src/components/flows/nodes/__tests__/field-primitives.test.ts` — helper round-trips.

**Phase 0 — Modify**

- `src/components/flows/step-card.tsx` — becomes card chrome only; imports `NODE_BODIES`. Target: under 900 lines.

**Phase 1 — Create**

- `src/components/flows/ndv/node-detail-view.tsx` — overlay, 3-pane layout, keyboard handling.
- `src/components/flows/ndv/params-pane.tsx` — hosts the registry body + settings footer.
- `src/components/flows/ndv/input-pane.tsx` — upstream datatree, drag source.
- `src/components/flows/ndv/output-pane.tsx` — last-run output + pin control.
- `src/components/flows/ndv/__tests__/node-detail-view.test.tsx` — mount smoke per node type.

**Phase 1 — Modify**

- `src/app/flows/[id]/page.tsx` — `ndvNodeId` state, `?node=` URL sync, render the NDV.
- `src/components/flows/step-card.tsx` — summary-only; `onOpen` replaces inline expansion.

**Phase 2 — Create**

- `src/lib/flows/node-test-input.ts` — `resolveNodeTestInput` (pure).
- `src/lib/flows/__tests__/node-test-input.test.ts`
- `src/app/api/flows/[id]/test-node/route.ts` — `POST`.
- `src/app/api/flows/[id]/pins/route.ts` — `GET` + `PUT` + `DELETE`.
- `src/app/api/__tests__/test-node-route-smoke.test.ts`
- `src/features/flows/__tests__/interpret-only-node.test.ts`
- `prisma/migrations/<timestamp>_flow_node_pins/migration.sql`

**Phase 2 — Modify**

- `prisma/schema.prisma` — `FlowNodePin` model + back-relation on `Flow`.
- `src/features/flows/interpret.ts` — `opts.onlyNodeId` + single-node reachability.
- `src/features/flows/execute-flow.ts` — `FlowExecutionJob.onlyNodeId`, thread to interpret, `trigger.type` union gains `'node_test'`.
- `src/app/api/flows/[id]/runs/route.ts` — exclude `node_test` runs by default.
- `src/components/flows/test-panel.tsx` — drop the `partial` checkbox and raw `mockOutputsText` textarea; pins and the NDV replace them.

---

## Task 1: `field-primitives.tsx` + `types.ts`

Extract the shared vocabulary first so every later body module has somewhere to import from. Nothing moves yet.

**Files:**
- Create: `src/components/flows/nodes/field-primitives.tsx`
- Create: `src/components/flows/nodes/types.ts`
- Create: `src/components/flows/nodes/__tests__/field-primitives.test.ts`
- Modify: `src/components/flows/step-card.tsx` (delete the moved definitions, import them instead)

**Interfaces:**
- Produces: `labelClass: string`, `controlClass: string`, `tokenControlBase: string`, `tokenControlClass: string`, `isRecord(value: unknown): value is Record<string, unknown>`, `parseKeyValueRows(value?: string): KeyValueRow[]`, `serializeKeyValueRows(rows: KeyValueRow[]): string`, `uniqueFieldName(base: string, fields: OutputField[]): string`, `inputTypeForField(field: OutputField): InputKind`, `stopEvent(event: React.MouseEvent | React.FocusEvent): void`.
- Produces: `type KeyValueRow = { key: string; value: string }`, `type InputKind = 'text' | 'yesno' | 'file' | 'email' | 'number' | 'date'`, `type Agent = { id: string; title: string }`, `type TokenEditorWiring`, `type NodeBodyProps`, `type NodeBodyModule`.

- [ ] **Step 1: Create `src/components/flows/nodes/types.ts`**

```tsx
import type { ReactNode } from 'react'
import type { FlowNode, OutputField } from '@/lib/flows/graph'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import type { DataField } from '@/lib/flows/datatree'
import type { TokenTextEditorHandle } from '../token-text-editor'
import type { ToolCatalog } from '../tool-catalog-type'
import type { EditableType } from '../node-types'

export type Agent = { id: string; title: string }
export type KeyValueRow = { key: string; value: string }
export type InputKind = 'text' | 'yesno' | 'file' | 'email' | 'number' | 'date'

/**
 * Wiring a body needs to participate in datatree token insertion: register a
 * chip-editor handle under a stable key, mark it focused, and block/unblock
 * inserts while a plain (non-token) input holds focus.
 */
export type TokenEditorWiring = {
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  blockActive: () => void
  unblockActive: () => void
}

/**
 * Everything any node body may need. Bodies destructure only what they use —
 * one prop bag keeps the registry's call site uniform, so adding a node type
 * never means touching the dispatch.
 */
export type NodeBodyProps = {
  node: FlowNode
  flowId?: string
  agents: Agent[]
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
  variableNames?: string[]
  dataFields?: DataField[]
  onAddStep?: (type: EditableType, branchIndex?: number) => void
}

/**
 * One node type's authoring surface.
 *
 * `defaultEditorKey` is where a datatree click lands when no chip editor has
 * been focused yet (the type's primary token field), and `requiredFields` names
 * the `node.data` keys that must be non-empty for the step to run — consumed by
 * the registry totality test now and by validation highlighting later.
 */
export type NodeBodyModule = {
  Body: (props: NodeBodyProps) => ReactNode
  defaultEditorKey?: string
  requiredFields: readonly string[]
}

export type { FlowNode, OutputField }
```

- [ ] **Step 2: Create `src/components/flows/nodes/field-primitives.tsx`**

Copy these **verbatim** out of `step-card.tsx` — `controlClass` (L223-224), `tokenControlBase` (L228-229), `tokenControlClass` (L230), `labelClass` (L231), `isRecord` (L233-235), `inputTypeForField` (L241-249), `uniqueFieldName` (L251-257), `parseKeyValueRows` (L259-274), `serializeKeyValueRows` (L276-280), `stopEvent` (L313-316). Do not alter a character of the class strings — they are load-bearing for tailwind-merge ordering.

```tsx
import { FIELD_TYPES, type OutputField } from '@/lib/flows/graph'
import type { InputKind, KeyValueRow } from './types'

export const controlClass =
  'h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-muted-foreground/50 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
// TokenTextEditor overrides that restyle the drawer-flavored defaults to match
// the card's denser slate inputs. No border color here — `invalid` red borders
// (appended after this string) must win in tailwind-merge order.
export const tokenControlBase =
  'min-h-10 rounded-md bg-background px-3 py-2 text-sm text-foreground transition-colors empty:before:text-muted-foreground hover:border-muted-foreground/50 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
export const tokenControlClass = `${tokenControlBase} border-border`
export const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function stopEvent(event: React.MouseEvent | React.FocusEvent) {
  event.stopPropagation()
}
```

Then append `inputTypeForField`, `uniqueFieldName`, `parseKeyValueRows`, and `serializeKeyValueRows` exactly as they appear in `step-card.tsx`, adding `export` to each.

- [ ] **Step 3: Write the failing test** `src/components/flows/nodes/__tests__/field-primitives.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRecord, parseKeyValueRows, serializeKeyValueRows, uniqueFieldName } from '../field-primitives'

test('key/value rows round-trip through serialize → parse', () => {
  const rows = [{ key: 'X-Api-Version', value: '2' }, { key: 'Accept', value: 'application/json' }]
  const parsed = parseKeyValueRows(serializeKeyValueRows(rows))
  assert.deepEqual(parsed.filter((row) => row.key), rows)
})

test('parseKeyValueRows tolerates junk instead of throwing', () => {
  // The field is user-typed free text; a half-finished edit must not crash the card.
  assert.deepEqual(parseKeyValueRows('not json'), [{ key: '', value: '' }])
  assert.deepEqual(parseKeyValueRows(undefined), [{ key: '', value: '' }])
  assert.deepEqual(parseKeyValueRows('[]'), [{ key: '', value: '' }])
})

test('uniqueFieldName suffixes until it stops colliding', () => {
  const fields = [{ name: 'email', type: 'text' }, { name: 'email_2', type: 'text' }] as Parameters<typeof uniqueFieldName>[1]
  assert.equal(uniqueFieldName('email', fields), 'email_3')
  assert.equal(uniqueFieldName('phone', fields), 'phone')
})

test('isRecord rejects arrays and null', () => {
  assert.equal(isRecord({ a: 1 }), true)
  assert.equal(isRecord([1]), false)
  assert.equal(isRecord(null), false)
})
```

- [ ] **Step 4: Run it — expect failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/field-primitives.test.ts`
Expected: FAIL — `Cannot find module '../field-primitives'` if Step 2 was skipped, otherwise assertion detail telling you the real `parseKeyValueRows` fallback shape. **If an assertion fails, the test is wrong, not the code** — this task must not change behaviour. Read the real implementation in `step-card.tsx:259-274` and correct the expectation.

- [ ] **Step 5: Point `step-card.tsx` at the new modules**

Delete the moved definitions from `step-card.tsx` and add:

```tsx
import {
  controlClass,
  inputTypeForField,
  isRecord,
  labelClass,
  parseKeyValueRows,
  serializeKeyValueRows,
  stopEvent,
  tokenControlBase,
  tokenControlClass,
  uniqueFieldName,
} from './nodes/field-primitives'
import type { Agent, InputKind, KeyValueRow, NodeBodyProps, TokenEditorWiring } from './nodes/types'
```

Delete the now-duplicated local `type Agent`, `type KeyValueRow`, `type InputKind`, and `type TokenEditorWiring` declarations. Leave `FIELD_TYPES` imported where still used.

- [ ] **Step 6: Run the tests and typecheck**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/field-primitives.test.ts
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
```

Expected: new test PASSes, `tsc` exits 0, full suite has the same pass count as before this task plus 4.

- [ ] **Step 7: Commit**

```bash
git add src/components/flows/nodes src/components/flows/step-card.tsx
git commit -m "refactor(flows): extract node field primitives and shared types"
```

---

## Task 2: Registry scaffold + four trivial bodies

Establish the pattern on the smallest bodies, and add the totality test that will guard every later move.

**Files:**
- Create: `src/components/flows/nodes/registry.ts`
- Create: `src/components/flows/nodes/respond-webhook-body.tsx`, `wait-body.tsx`, `subflow-body.tsx`, `stop-body.tsx`
- Create: `src/components/flows/nodes/__tests__/registry.test.ts`
- Modify: `src/components/flows/step-card.tsx` (delete the four moved functions; `renderNodeBody` delegates those four cases to the registry)

**Interfaces:**
- Consumes: `NodeBodyModule`, `NodeBodyProps`, `labelClass`, `controlClass` from Task 1.
- Produces: `NODE_BODIES: Partial<Record<FlowNode['type'], NodeBodyModule>>` — becomes a total `Record` in Task 5.

- [ ] **Step 1: Move `RespondWebhookBody`**

Create `src/components/flows/nodes/respond-webhook-body.tsx`. Move the function body from `step-card.tsx:970-980` **verbatim**, then wrap it in a module export. The `Body` signature widens to `NodeBodyProps`, so narrow `node` at the top — this is the one permitted edit per move:

```tsx
'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

function RespondWebhookBody({ node: raw, update }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'respondWebhook' }>
  // …the moved JSX, unchanged…
}

export const respondWebhookModule: NodeBodyModule = {
  Body: RespondWebhookBody,
  requiredFields: ['statusCode'],
}
```

- [ ] **Step 2: Move `WaitBody`, `SubflowBody`, `StopBody` the same way**

Sources: `WaitBody` at `step-card.tsx:981-987`, `SubflowBody` at `996-999`, `StopBody` at `2424-2437`. Module metadata:

```tsx
export const waitModule: NodeBodyModule = { Body: WaitBody, requiredFields: [] }
export const subflowModule: NodeBodyModule = { Body: SubflowBody, requiredFields: ['flowId'] }
export const stopModule: NodeBodyModule = { Body: StopBody, requiredFields: [] }
```

Check each against `graph.ts` before writing `requiredFields` — name only keys the schema makes mandatory or that validation already treats as required. If a type has none, use `[]`.

- [ ] **Step 3: Create `src/components/flows/nodes/registry.ts`**

```ts
import type { FlowNode } from '@/lib/flows/graph'
import type { NodeBodyModule } from './types'
import { respondWebhookModule } from './respond-webhook-body'
import { waitModule } from './wait-body'
import { subflowModule } from './subflow-body'
import { stopModule } from './stop-body'

/**
 * Every node type's authoring surface, keyed by type.
 *
 * Replaces the `renderNodeBody` switch that used to be the ONLY thing that knew
 * which fields a node type has. As data it can be consumed more than once — the
 * canvas card and the NDV render the same body — and iterated, so a totality
 * test can prove no node type ships without a param surface.
 *
 * Widened to a total Record in Task 5, once every body has moved.
 */
export const NODE_BODIES: Partial<Record<FlowNode['type'], NodeBodyModule>> = {
  respondWebhook: respondWebhookModule,
  wait: waitModule,
  subflow: subflowModule,
  stop: stopModule,
}
```

- [ ] **Step 4: Write the registry test** `src/components/flows/nodes/__tests__/registry.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NODE_BODIES } from '../registry'

// Grows to the full union in Task 5. Listing types explicitly (rather than
// deriving from NODE_BODIES' own keys) is deliberate: a test that reads its
// expectations off the thing under test proves nothing.
const MOVED_SO_FAR = ['respondWebhook', 'wait', 'subflow', 'stop'] as const

test('every moved node type has a body module', () => {
  for (const type of MOVED_SO_FAR) {
    const entry = NODE_BODIES[type]
    assert.ok(entry, `${type} has no registry entry`)
    assert.equal(typeof entry.Body, 'function', `${type}.Body is not a component`)
    assert.ok(Array.isArray(entry.requiredFields), `${type}.requiredFields must be an array`)
  }
})

test('requiredFields entries are non-empty strings', () => {
  for (const [type, entry] of Object.entries(NODE_BODIES)) {
    for (const field of entry!.requiredFields) {
      assert.equal(typeof field, 'string', `${type} has a non-string requiredField`)
      assert.ok(field.trim().length > 0, `${type} has a blank requiredField`)
    }
  }
})
```

- [ ] **Step 5: Run it — expect PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/registry.test.ts`
Expected: PASS (2 tests). A failure here means a module export name is wrong.

- [ ] **Step 6: Delegate those four cases in `renderNodeBody`**

In `step-card.tsx`, delete the four moved functions and replace their `switch` cases with a registry lookup ahead of the switch:

```tsx
  const registered = NODE_BODIES[node.type]
  if (registered) {
    const { Body } = registered
    return <Body node={node} flowId={flowId} agents={agents} toolCatalog={toolCatalog} update={update} onRefreshAgents={onRefreshAgents} tokenWiring={tokenWiring} showErrors={showErrors} variableNames={variableNames} dataFields={dataFields} onAddStep={onAddStep} />
  }
  switch (node.type) {
    // …remaining un-moved cases…
  }
```

Add `import { NODE_BODIES } from './nodes/registry'`.

- [ ] **Step 7: Verify no behaviour change**

```bash
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
```

Expected: `tsc` exits 0; existing `step-card`/`dag-canvas` tests pass **unmodified**. If you had to edit an existing test, you changed behaviour — revert and redo the move verbatim.

- [ ] **Step 8: Commit**

```bash
git add src/components/flows/nodes src/components/flows/step-card.tsx
git commit -m "refactor(flows): add node body registry with four leaf bodies"
```

---

## Task 3: Move the mid-size bodies

**Files:**
- Create, one per type: `condition-body.tsx` (serves both `condition` and `filter`), `transform-body.tsx`, `loop-body.tsx`, `parallel-body.tsx`, `switch-body.tsx`, `router-body.tsx`, `error-shield-body.tsx`, `repeat-until-body.tsx`, `input-body.tsx`, `output-body.tsx`
- Modify: `src/components/flows/nodes/registry.ts`, `src/components/flows/nodes/__tests__/registry.test.ts`, `src/components/flows/step-card.tsx`

**Interfaces:**
- Consumes: Task 1 primitives, Task 2's registry shape.
- Produces: registry entries for `condition`, `filter`, `transform`, `loop`, `parallel`, `switch`, `router`, `errorShield`, `repeatUntil`, `input`, `output`.

- [ ] **Step 1: Move each body verbatim**

Sources in `step-card.tsx` (line numbers are pre-refactor; find by function name if they have shifted):

| Function | Lines | New file | `defaultEditorKey` | `requiredFields` |
|---|---|---|---|---|
| `ConditionBody` | 2044-2131 | `condition-body.tsx` | `clause.left` | `['clauses']` |
| `TransformBody` | 2132-2183 | `transform-body.tsx` | `xf.0` | `['fields']` |
| `LoopBody` | 2184-2229 | `loop-body.tsx` | `loop.over` | `['over']` |
| `SwitchBody` | 2249-2332 | `switch-body.tsx` | `sw.left` | `['cases']` |
| `RouterBody` | 2333-2423 | `router-body.tsx` | — | `['branches']` |
| `ErrorShieldBody` | 2230-2248 | `error-shield-body.tsx` | — | `[]` |
| `RepeatUntilBody` | 988-995 | `repeat-until-body.tsx` | — | `[]` |
| `parallel` inline JSX | 926-945 | `parallel-body.tsx` | — | `['branches']` |
| `input` inline `<p>` | 2  lines | `input-body.tsx` | — | `[]` |
| `output` inline `<p>` | 2 lines | `output-body.tsx` | — | `[]` |

`condition` and `filter` share `ConditionBody` — export **one** module and register it under both keys, exactly as the old switch did:

```ts
  condition: conditionModule,
  filter: conditionModule,
```

The `parallel`, `input`, and `output` cases were inline JSX in the switch rather than named functions. Move that JSX into a named `ParallelBody` / `InputBody` / `OutputBody` in the new file, unchanged.

`defaultEditorKey` values come from `DEFAULT_EDITOR_KEYS` at `step-card.tsx:339-350` — copy them, do not invent them. Types absent from that map get no key.

- [ ] **Step 2: Register them**

Add the ten imports and eleven keys (`condition` + `filter`) to `NODE_BODIES`.

- [ ] **Step 3: Extend the registry test**

```ts
const MOVED_SO_FAR = [
  'respondWebhook', 'wait', 'subflow', 'stop',
  'condition', 'filter', 'transform', 'loop', 'parallel', 'switch',
  'router', 'errorShield', 'repeatUntil', 'input', 'output',
] as const
```

Add:

```ts
test('condition and filter share one body module', () => {
  // They shared a single ConditionBody in the old switch; two copies would be
  // two places to fix a clause-editor bug.
  assert.equal(NODE_BODIES.condition, NODE_BODIES.filter)
})
```

- [ ] **Step 4: Delete the moved cases from the switch**

Remove those cases and the moved function declarations from `step-card.tsx`.

- [ ] **Step 5: Verify**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/registry.test.ts
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
```

Expected: registry test PASSes (3 tests), `tsc` exits 0, existing tests unmodified and green.

- [ ] **Step 6: Commit**

```bash
git add src/components/flows/nodes src/components/flows/step-card.tsx
git commit -m "refactor(flows): move control-flow node bodies into the registry"
```

---

## Task 4: Move the large bodies

The four biggest, plus the remaining data-shaped ones. Same discipline: verbatim moves.

**Files:**
- Create: `trigger-body.tsx`, `agent-body.tsx`, `http-body.tsx`, `tool-body.tsx`, `variable-body.tsx`, `data-body.tsx`, `human-review-body.tsx`
- Create: `src/components/flows/nodes/inline-key-value.tsx` (shared by `http-body` and any later body)
- Modify: `registry.ts`, `__tests__/registry.test.ts`, `step-card.tsx`

**Interfaces:**
- Consumes: Task 1 primitives; `InlineKeyValue` moves alongside its only current consumer.
- Produces: registry entries for `trigger`, `agent`, `http`, `tool`, `variable`, `data`, `humanReview` — completing the union.

- [ ] **Step 1: Move `InlineKeyValue` first**

`step-card.tsx:1901-1965` → `src/components/flows/nodes/inline-key-value.tsx`, exported. `HttpBody` imports it. It is a presentational helper, not a node body, so it gets no registry entry.

- [ ] **Step 2: Move the seven bodies verbatim**

| Function | Lines | New file | `defaultEditorKey` | `requiredFields` |
|---|---|---|---|---|
| `TriggerBody` | 1000-1489 | `trigger-body.tsx` | — | `['trigger']` |
| `AgentBody` | 1490-1700 | `agent-body.tsx` | `agent.input` | `['agentId']` |
| `HttpBody` | 1701-1900 | `http-body.tsx` | `http.body` | `['url']` |
| `ToolBody` | 1966-2043 | `tool-body.tsx` | — | `['connectionId', 'toolName']` |
| `VariableBody` | 2438-2539 | `variable-body.tsx` | `var.value` | `['name']` |
| `DataBody` | 2540-2724 | `data-body.tsx` | `data.input` | `['op']` |
| `HumanReviewBody` | 2725-2766 | `human-review-body.tsx` | `hr.message` | `[]` |

`TriggerBody` carries the `nextOccurrence` memo with the load-bearing comment at `step-card.tsx:1076-1080` about cron scanning being too slow to call per-render. **Move that comment with it** — it documents a real ~13s worst case and someone will otherwise "simplify" the memo away.

`AgentBody` takes `agents` and `onRefreshAgents`; `ToolBody` and `HttpBody` take `toolCatalog`; `VariableBody` takes `variableNames`. All are already on `NodeBodyProps`.

- [ ] **Step 3: Register them and complete the union in the test**

```ts
const ALL_TYPES = [
  'trigger', 'agent', 'http', 'respondWebhook', 'wait', 'repeatUntil', 'tool',
  'condition', 'filter', 'transform', 'loop', 'parallel', 'switch', 'stop',
  'variable', 'data', 'humanReview', 'router', 'errorShield', 'input',
  'output', 'subflow',
] as const
```

Rename `MOVED_SO_FAR` → `ALL_TYPES` throughout, and add the totality guard:

```ts
test('ALL_TYPES matches the FlowNode union exactly', () => {
  // The guard that makes the registry trustworthy: a new node type added to
  // graph.ts fails HERE until it has a body module, instead of rendering an
  // empty config surface in production.
  const registered = Object.keys(NODE_BODIES).sort()
  assert.deepEqual(registered, [...ALL_TYPES].sort())
})
```

- [ ] **Step 4: Verify the union is genuinely exhaustive**

Cross-check `ALL_TYPES` against `graph.ts:479` (the discriminated-union list). If they differ, fix `ALL_TYPES` — do not weaken the test.

```bash
grep -n 'triggerNode, agentNode' src/lib/flows/graph.ts
```

- [ ] **Step 5: Verify**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/registry.test.ts
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
```

Expected: registry test PASSes (4 tests), `tsc` exits 0, existing tests unmodified and green.

- [ ] **Step 6: Commit**

```bash
git add src/components/flows/nodes src/components/flows/step-card.tsx
git commit -m "refactor(flows): move remaining node bodies into the registry"
```

---

## Task 5: Retire `renderNodeBody`

**Files:**
- Modify: `src/components/flows/nodes/registry.ts` (widen to a total `Record`)
- Modify: `src/components/flows/step-card.tsx` (delete `renderNodeBody`, render from the registry directly)

**Interfaces:**
- Produces: `NODE_BODIES: Record<FlowNode['type'], NodeBodyModule>` — total, so `NODE_BODIES[node.type]` needs no null check.
- Produces: `DEFAULT_EDITOR_KEYS` is gone; callers read `NODE_BODIES[type].defaultEditorKey`.

- [ ] **Step 1: Widen the registry type**

```ts
export const NODE_BODIES: Record<FlowNode['type'], NodeBodyModule> = { /* …all 22 keys… */ }
```

`tsc` now fails if any union member is missing — the compile-time twin of Task 4's runtime test.

- [ ] **Step 2: Delete `renderNodeBody` and render inline**

At the card's body render site (`step-card.tsx:759-764`):

```tsx
            <div onClick={stopEvent} onFocus={stopEvent} className="border-t border-border px-5 py-4">
              {(() => {
                const { Body } = NODE_BODIES[node.type]
                return <Body node={node} flowId={flowId} agents={agents} toolCatalog={toolCatalog} update={update} onRefreshAgents={onRefreshAgents} tokenWiring={tokenWiring} showErrors={showErrors} variableNames={variableNames} dataFields={dataFields} onAddStep={onAddStep} />
              })()}
              {node.type !== 'trigger' && (
                <StepSettingsFooter node={node} update={update} onChangeType={onChangeType} tokenWiring={tokenWiring} />
              )}
            </div>
```

- [ ] **Step 3: Replace `DEFAULT_EDITOR_KEYS`**

Delete the map at `step-card.tsx:339-350`. In `insertToken` (`step-card.tsx:492-498`), change:

```tsx
    const fallbackKey = DEFAULT_EDITOR_KEYS[node.type]
```

to:

```tsx
    const fallbackKey = NODE_BODIES[node.type].defaultEditorKey
```

- [ ] **Step 4: Verify and check the size goal**

```bash
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
wc -l src/components/flows/step-card.tsx
```

Expected: `tsc` exits 0; all tests green and unmodified; `step-card.tsx` under 900 lines (from 2766).

- [ ] **Step 5: Commit**

```bash
git add src/components/flows/nodes src/components/flows/step-card.tsx
git commit -m "refactor(flows): render node bodies from the registry, drop renderNodeBody"
```

---

## Task 6: NDV overlay shell + params pane

**Files:**
- Create: `src/components/flows/ndv/node-detail-view.tsx`
- Create: `src/components/flows/ndv/params-pane.tsx`
- Create: `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
- Modify: `src/app/flows/[id]/page.tsx`

**Interfaces:**
- Consumes: `NODE_BODIES` (Task 5), `ResizablePanel` from `../resizable-panel`.
- Produces: `<NodeDetailView>` accepting `{ node, flowId, agents, toolCatalog, dataFields, labelCtx, variableNames, upstreamLabels, lastOutput, onChange, onChangeType, onRefreshAgents, onAddStep, onClose }`.

- [ ] **Step 1: Write the failing mount test** `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`

```tsx
/**
 * The NDV must MOUNT for every node type. Typecheck can't catch a body that
 * crashes on absent optional data, and a config surface that throws is worse
 * than a rough one — it strands the user with no way to edit the step.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { NodeDetailView } from '../node-detail-view'
import type { FlowNode } from '@/lib/flows/graph'

afterEach(() => cleanup())

const NODES: FlowNode[] = [
  { id: 'n1', type: 'http', data: { method: 'GET', url: 'https://api/x' } },
  { id: 'n2', type: 'tool', data: { connectionId: '', toolName: '' } },
  { id: 'n3', type: 'condition', data: { clauses: [] } },
  { id: 'n4', type: 'stop', data: {} },
] as FlowNode[]

for (const node of NODES) {
  test(`mounts for a ${node.type} node`, () => {
    const { container, getByText } = render(
      <NodeDetailView
        node={node}
        agents={[]}
        toolCatalog={[]}
        dataFields={[]}
        upstreamLabels={{}}
        lastOutput={undefined}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    assert.ok(container.firstChild, 'rendered nothing')
    getByText('Parameters')
  })
}

test('closes on Escape', () => {
  let closed = false
  render(
    <NodeDetailView
      node={NODES[3]}
      agents={[]}
      toolCatalog={[]}
      dataFields={[]}
      upstreamLabels={{}}
      lastOutput={undefined}
      onChange={() => {}}
      onClose={() => { closed = true }}
    />,
  )
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  assert.equal(closed, true)
})
```

- [ ] **Step 2: Run it — expect failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: FAIL — `Cannot find module '../node-detail-view'`.

- [ ] **Step 3: Create `params-pane.tsx`**

```tsx
'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { NODE_BODIES } from '../nodes/registry'
import type { NodeBodyProps } from '../nodes/types'

/**
 * The middle pane: the very same body module the canvas card used to render
 * inline. One implementation, two consumers — the whole point of Phase 0.
 */
export function ParamsPane(props: NodeBodyProps) {
  const { Body } = NODE_BODIES[props.node.type]
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <p className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Parameters
      </p>
      <div className="p-4">
        <Body {...props} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create `node-detail-view.tsx`**

Three columns; the outer two are `ResizablePanel`s so widths persist under `flow.ndv.*`. Requirements the test pins: renders the literal text `Parameters`, and a `keydown` Escape on `document` calls `onClose`.

```tsx
'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { FlowNode } from '@/lib/flows/graph'
import type { DataField } from '@/lib/flows/datatree'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import type { ToolCatalog } from '../tool-catalog-type'
import type { EditableType } from '../node-types'
import type { Agent, TokenEditorWiring } from '../nodes/types'
import { ResizablePanel } from '../resizable-panel'
import { ParamsPane } from './params-pane'
import { InputPane } from './input-pane'
import { OutputPane } from './output-pane'

export function NodeDetailView({
  node, flowId, agents, toolCatalog, dataFields, labelCtx, variableNames,
  upstreamLabels, lastOutput, onChange, onChangeType, onRefreshAgents, onAddStep, onClose,
}: {
  node: FlowNode
  flowId?: string
  agents: Agent[]
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  labelCtx?: TokenLabelContext
  variableNames?: string[]
  upstreamLabels: Record<string, string>
  lastOutput: unknown
  onChange: (node: FlowNode) => void
  onChangeType?: (type: EditableType) => void
  onRefreshAgents?: () => void
  onAddStep?: (type: EditableType, branchIndex?: number) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const label = ('label' in node.data && node.data.label) || node.type

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/40 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={`Configure ${label}`}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="truncate text-sm font-semibold">{label}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ResizablePanel storageKey="flow.ndv.inputWidth" defaultWidth={280}>
            <InputPane dataFields={dataFields} onInsertToken={insertToken} />
          </ResizablePanel>
          <div className="min-w-0 flex-1 border-x border-border">
            <ParamsPane
              node={node}
              flowId={flowId}
              agents={agents}
              toolCatalog={toolCatalog}
              update={onChange}
              onRefreshAgents={onRefreshAgents}
              tokenWiring={tokenWiring}
              variableNames={variableNames}
              dataFields={dataFields}
              onAddStep={onAddStep}
              onChangeType={onChangeType}
            />
          </div>
          <ResizablePanel storageKey="flow.ndv.outputWidth" defaultWidth={320}>
            <OutputPane lastOutput={lastOutput} pinned={false} />
          </ResizablePanel>
        </div>
      </div>
    </div>
  )
}
```

Check `ResizablePanel`'s real props before writing this — `src/components/flows/resizable-panel.tsx` is 76 lines; if it docks to the right edge only, wrap the input pane in a plain `<div>` with a fixed width instead of forcing the component to do something it wasn't built for. Note which you chose in the commit message.

Build the token wiring inside the NDV the same way `StepCard` does (`step-card.tsx:447-505`): an `editorHandles` ref map, `registerEditor`, `focusEditor`, `blockActive`/`unblockActive`, and an `insertToken` that falls back to `NODE_BODIES[node.type].defaultEditorKey`. The NDV's input pane replaces the card's token popover, so **do not** port the popover positioning code (`step-card.tsx:456-478`) — it exists only to float a datatree next to a field on a zoomed canvas, and the NDV has a permanent pane for that.

`ParamsPane` takes `onChangeType` so it can render the settings footer moved in Task 9; until then pass it through and ignore it.

- [ ] **Step 5: Create placeholder `input-pane.tsx` and `output-pane.tsx`**

Tasks 7 and 8 fill these in. They must accept the props the NDV already passes in Step 4 so this task compiles on its own — the props are simply unused for now:

```tsx
// src/components/flows/ndv/input-pane.tsx
'use client'

import type { DataField } from '@/lib/flows/datatree'

export function InputPane({ dataFields }: { dataFields: DataField[]; onInsertToken: (token: string) => void }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <p className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</p>
      <p className="p-4 text-sm text-muted-foreground">{dataFields.length} field(s)</p>
    </div>
  )
}
```

```tsx
// src/components/flows/ndv/output-pane.tsx
'use client'

export function OutputPane({ lastOutput }: { lastOutput: unknown; pinned: boolean }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <p className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Output</p>
      <pre className="p-4 font-mono text-xs">{lastOutput === undefined ? '' : JSON.stringify(lastOutput, null, 2)}</pre>
    </div>
  )
}
```

- [ ] **Step 6: Run the test — expect PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 7: Wire it into the builder**

In `src/app/flows/[id]/page.tsx`:

```tsx
  const [ndvNodeId, setNdvNodeId] = useState<string | null>(null)
```

Sync to the URL so an open NDV is linkable and survives refresh:

```tsx
  // `?node=<id>` keeps the open NDV in the URL — a builder link can point at a
  // specific step, and a refresh mid-configuration doesn't dump you back to the
  // bare canvas.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (ndvNodeId) params.set('node', ndvNodeId)
    else params.delete('node')
    const next = params.toString()
    window.history.replaceState(null, '', next ? `?${next}` : window.location.pathname)
  }, [ndvNodeId])
```

Read the initial value once on mount, and only if the id exists in the graph (a stale link must not open an empty NDV):

```tsx
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('node')
    if (initial && graph.nodes.some((node) => node.id === initial)) setNdvNodeId(initial)
    // Mount-only: later graph edits must not reopen a closed NDV.
     
  }, [])
```

Render it when `ndvNodeId` resolves to a node, passing the existing `dataFields` memo (`page.tsx:790-817`) and the selected run's output for that node.

- [ ] **Step 8: Verify**

```bash
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
```

- [ ] **Step 9: Commit**

```bash
git add src/components/flows/ndv src/app/flows/\[id\]/page.tsx
git commit -m "feat(flows): add node detail view overlay hosting the params registry"
```

---

## Task 7: Input pane

**Files:**
- Modify: `src/components/flows/ndv/input-pane.tsx`
- Modify: `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`

**Interfaces:**
- Consumes: `DataField[]` from `buildDataTree` (already built by `page.tsx`), `DataTree` from `../data-tree`.
- Produces: `<InputPane dataFields onInsertToken />`; each leaf is `draggable` and sets `text/plain` to the braced token.

- [ ] **Step 1: Write the failing test**

Append to the NDV test file:

```tsx
test('input pane lists upstream fields and inserts on click', () => {
  let inserted: string | null = null
  const { getByText } = render(
    <InputPane
      dataFields={[{ label: 'account', token: '{{trigger.input.account}}', type: 'string' }]}
      onInsertToken={(token) => { inserted = token }}
    />,
  )
  const field = getByText('account')
  field.click()
  assert.equal(inserted, '{{trigger.input.account}}')
})

test('input pane shows an empty state rather than nothing', () => {
  const { getByText } = render(<InputPane dataFields={[]} onInsertToken={() => {}} />)
  // A blank pane reads as broken; say WHY there is no data.
  getByText(/no upstream data/i)
})
```

Add `import { InputPane } from '../input-pane'`.

- [ ] **Step 2: Run it — expect failure**

Expected: FAIL — `InputPane` takes no props yet, so `getByText('account')` finds nothing.

- [ ] **Step 3: Implement `input-pane.tsx`**

Reuse `DataTree` (`src/components/flows/data-tree.tsx`) — it already renders a `DataField[]` tree with click-to-insert. Add drag:

```tsx
'use client'

import type { DataField } from '@/lib/flows/datatree'
import { DataTree } from '../data-tree'

export function InputPane({
  dataFields,
  onInsertToken,
}: {
  dataFields: DataField[]
  onInsertToken: (token: string) => void
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <p className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Input
      </p>
      {dataFields.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No upstream data yet — run the flow once, or pin a step&apos;s output, and the fields you can map from appear here.
        </p>
      ) : (
        <DataTree fields={dataFields} onPick={onInsertToken} />
      )}
    </div>
  )
}
```

Check `data-tree.tsx`'s actual prop names before writing this — if they are not `fields`/`onPick`, use the real ones.

- [ ] **Step 4: Add drag-to-param**

On each leaf in `DataTree`, add:

```tsx
  draggable
  onDragStart={(event) => {
    event.dataTransfer.setData('text/plain', field.token)
    event.dataTransfer.effectAllowed = 'copy'
  }}
```

`TokenTextEditor` is a contenteditable, so a `text/plain` drop inserts the braced token at the caret with no extra wiring. Verify by hand; do not add a custom drop handler unless the native path fails.

- [ ] **Step 5: Run the tests — expect PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/flows/ndv src/components/flows/data-tree.tsx
git commit -m "feat(flows): NDV input pane with click and drag token insertion"
```

---

## Task 8: Output pane

**Files:**
- Modify: `src/components/flows/ndv/output-pane.tsx`
- Modify: `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`

**Interfaces:**
- Produces: `<OutputPane lastOutput pinned onPin onUnpin />`. `onPin`/`onUnpin` are wired to the API in Task 11; here they are props only.

- [ ] **Step 1: Write the failing test**

```tsx
test('output pane renders the last run output', () => {
  const { getByText } = render(<OutputPane lastOutput={{ ok: true, id: 'msg_1' }} pinned={false} />)
  getByText(/msg_1/)
})

test('output pane explains an absent output instead of rendering blank', () => {
  const { getByText } = render(<OutputPane lastOutput={undefined} pinned={false} />)
  getByText(/hasn't produced output/i)
})

test('output pane marks pinned data as pinned', () => {
  // Pinned data is stale by construction — if the pane showed it identically to
  // a fresh run, a user would debug against a fixture without knowing.
  const { getByText } = render(<OutputPane lastOutput={{ ok: true }} pinned />)
  getByText(/pinned/i)
})
```

- [ ] **Step 2: Run it — expect failure**

Expected: FAIL — `OutputPane` takes no props yet.

- [ ] **Step 3: Implement**

```tsx
'use client'

import { Pin } from 'lucide-react'

export function OutputPane({
  lastOutput,
  pinned,
  onPin,
  onUnpin,
}: {
  lastOutput: unknown
  pinned: boolean
  onPin?: () => void
  onUnpin?: () => void
}) {
  const hasOutput = lastOutput !== undefined && lastOutput !== null
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Output</p>
        {pinned && (
          <span className="flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
            <Pin className="h-3 w-3" /> Pinned
          </span>
        )}
      </div>
      {hasOutput ? (
        <>
          <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">{JSON.stringify(lastOutput, null, 2)}</pre>
          <div className="border-t border-border p-3">
            {pinned ? (
              <button type="button" onClick={onUnpin} className="text-xs font-semibold text-muted-foreground hover:text-foreground">Unpin</button>
            ) : (
              <button type="button" onClick={onPin} className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                <Pin className="h-3.5 w-3.5" /> Pin this output
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">This step hasn&apos;t produced output yet. Test it to see what it returns.</p>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the tests — expect PASS** (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/flows/ndv
git commit -m "feat(flows): NDV output pane with pin affordance"
```

---

## Task 9: Card becomes summary-only

**Files:**
- Modify: `src/components/flows/step-card.tsx`
- Modify: `src/app/flows/[id]/page.tsx`
- Modify: `src/components/flows/__tests__/dag-canvas.test.tsx` (this is the one place an existing test legitimately changes)

**Interfaces:**
- Produces: `StepCard` gains `onOpen?: () => void` and no longer renders param bodies or `StepSettingsFooter`.

- [ ] **Step 1: Move `StepSettingsFooter` into the NDV**

`StepSettingsFooter` (`step-card.tsx:838-877`) moves to `src/components/flows/ndv/step-settings-footer.tsx`, rendered by `ParamsPane` below the body. It carries the step-type select and notes field, which belong with the params now.

- [ ] **Step 2: Delete the expanded-body branch from the card**

Remove the `motion.div` body block (`step-card.tsx:750-765`) and the `NODE_BODIES` render. Keep `collapsedAffordance(node)` — it is the summary. Keep the `codeOpen` JSON view; it is a card-level debug affordance, not a param surface.

- [ ] **Step 3: Add `onOpen` and wire the gestures**

```tsx
  onOpen?: () => void
```

Double-click and Enter/Space on the card root call `onOpen`. `onRootKeyDown` (`step-card.tsx:441-446`) currently calls `onClick` for Enter/Space; single click still selects, Enter now opens:

```tsx
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (event.key === 'Enter') onOpen?.()
    else onClick?.()
  }
```

Add a visible Open button to the card header too — a discoverable affordance beside the keyboard/double-click ones.

- [ ] **Step 4: Wire `onOpen` in `page.tsx`**

`onOpen={() => setNdvNodeId(node.id)}` wherever `StepCard` is rendered (canvas and any list view).

- [ ] **Step 5: Update the canvas test**

`dag-canvas.test.tsx` asserts a card per top-level node — that still holds. If any assertion depends on expanded param fields, retarget it at the NDV instead of deleting it. State in the commit message which assertions moved and why.

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
```

- [ ] **Step 7: Manual check**

Use the `run` skill to launch the app. Confirm: clicking a card selects it; Enter or double-click opens the NDV; Escape closes it; the URL carries `?node=<id>`; a refresh reopens the same NDV; editing a param persists after close.

- [ ] **Step 8: Commit**

```bash
git add src/components/flows src/app/flows/\[id\]/page.tsx
git commit -m "feat(flows): canvas card becomes summary-only, NDV owns configuration"
```

---

## Task 10: `onlyNodeId` in the interpreter

The write-safety core. Do this before any UI can call it.

**Files:**
- Modify: `src/features/flows/interpret.ts` (opts type ~L93, reachability ~L1165-1176)
- Create: `src/features/flows/__tests__/interpret-only-node.test.ts`

**Interfaces:**
- Produces: `InterpretOptions.onlyNodeId?: string` — when set, exactly that node executes; every other node is structurally unreachable.

- [ ] **Step 1: Write the failing test** `src/features/flows/__tests__/interpret-only-node.test.ts`

The `recorder()` + `http()` helpers below mirror `interpret-dag.test.ts` — read that file first to confirm the adapter shape hasn't changed.

```ts
/**
 * Single-node test mode. The property that matters is NEGATIVE: nothing except
 * the selected node may run. A downstream write action firing because someone
 * tweaked a config field is the exact failure this mode exists to prevent, so
 * these assertions are about what DIDN'T execute.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const http = (id: string, label: string, path: string) =>
  ({ id, type: 'http' as const, data: { label, method: 'GET' as const, url: `https://api/${path}` } })

/** Records every node the interpreter actually executed, and its resolved config. */
function recorder() {
  const ran: string[] = []
  const configs: Record<string, unknown> = {}
  const runAction: RunActionFn = async (node) => {
    ran.push(node.id)
    configs[node.id] = node.config
    return { output: { ok: true, id: node.id } }
  }
  return { runAction, ran, configs }
}

// trigger → a → b → c   ('c' stands in for any downstream write)
const chain: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    http('a', 'Fetch A', 'a'),
    http('b', 'Fetch B', 'b'),
    http('c', 'Delete everything', 'c'),
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'a' },
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ],
}

test('onlyNodeId runs exactly the selected node', async () => {
  const { runAction, ran } = recorder()
  const result = await interpretFlow(chain, 'go', { runAction, onlyNodeId: 'b', completed: { a: { items: [1] } } })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['b'])
})

test('onlyNodeId runs NEITHER downstream nor upstream nodes', async () => {
  const { runAction, ran } = recorder()
  await interpretFlow(chain, 'go', { runAction, onlyNodeId: 'b', completed: { a: {} } })
  assert.equal(ran.includes('c'), false, 'a downstream step MUST NOT run')
  assert.equal(ran.includes('a'), false, 'an upstream step MUST NOT re-run either')
})

test('onlyNodeId resolves upstream tokens from seeded completed outputs', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      http('a', 'Fetch A', 'a'),
      { id: 'b', type: 'http', data: { label: 'Use A', method: 'GET' as const, url: 'https://api/{{step.a.output.slug}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
    ],
  }
  const { runAction, configs } = recorder()
  await interpretFlow(graph, 'go', { runAction, onlyNodeId: 'b', completed: { a: { slug: 'widgets' } } })
  // The seeded output must be reachable through the same token path the
  // datatree emits. If this path is wrong, fix the TEST to match
  // buildDataTree's format — do not change the interpreter to suit it.
  assert.match(String((configs.b as { url?: string }).url), /widgets/)
})

test('an unknown onlyNodeId does not silently run the whole flow', async () => {
  // Falling through to the trigger would promote a one-node test into a full
  // run — the worst available failure mode for this option.
  const { runAction, ran } = recorder()
  const result = await interpretFlow(chain, 'go', { runAction, onlyNodeId: 'ghost' }).catch(() => ({ status: 'failed' as const }))
  assert.notEqual(result.status, 'succeeded')
  assert.deepEqual(ran, [])
})

test('a container node is refused rather than run empty', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input.items}}', body: [] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  } as unknown as FlowGraph
  const { runAction, ran } = recorder()
  const result = await interpretFlow(graph, 'go', { runAction, onlyNodeId: 'loop' }).catch((error: Error) => {
    assert.match(error.message, /steps inside it/i)
    return { status: 'failed' as const }
  })
  assert.notEqual(result.status, 'succeeded')
  assert.deepEqual(ran, [])
})
```

- [ ] **Step 2: Run it — expect failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/interpret-only-node.test.ts`
Expected: FAIL — `onlyNodeId` is not a recognised option, so the whole flow runs and `ran` has extra entries.

- [ ] **Step 3: Add the option**

In `InterpretOptions` (beside `startNodeId`, `interpret.ts:93`):

```ts
  /**
   * Builder single-node test: execute ONLY this node. Upstream values come from
   * `completed` (seeded by the caller from pins / the last run). Distinct from
   * `startNodeId`, which begins here and continues downstream — this must never
   * fire a downstream write action.
   */
  onlyNodeId?: string
```

- [ ] **Step 4: Implement single-node reachability**

Replace `interpret.ts:1165-1176`:

```ts
  const startId =
    (opts.onlyNodeId && byId.get(opts.onlyNodeId)?.id) ||
    (opts.startNodeId && byId.get(opts.startNodeId)?.id) ||
    byId.get('trigger')?.id ||
    graph.nodes[0]?.id
  // An unknown onlyNodeId must NOT fall through to the trigger — that would
  // silently promote a one-node test into a full run.
  if (opts.onlyNodeId && !byId.get(opts.onlyNodeId)) {
    throw new Error('That step is no longer part of this flow — reopen it and try again.')
  }
  // Only nodes reachable from the entry participate — an orphan subgraph never
  // ran under the old walk and must not start running now.
  const reachable = new Set<string>()
  if (startId) {
    if (opts.onlyNodeId) {
      // Single-node mode: the walk never leaves this node, so everything
      // downstream is structurally unreachable rather than conditionally
      // skipped. Retry, timeout, token resolution, budget caps, and audit all
      // keep working unchanged.
      reachable.add(startId)
    } else {
      const stack = [startId]
      while (stack.length) {
        const id = stack.pop()!
        if (reachable.has(id)) continue
        reachable.add(id)
        for (const edge of outEdges.get(id) ?? []) stack.push(edge.target)
      }
    }
  }
```

- [ ] **Step 5: Reject container nodes**

A container's behaviour *is* running its body, so isolating one is meaningless. After the unknown-id guard:

```ts
  const CONTAINER_TYPES = new Set(['loop', 'parallel', 'repeatUntil', 'errorShield'])
  if (opts.onlyNodeId && CONTAINER_TYPES.has(byId.get(opts.onlyNodeId)!.type)) {
    throw new Error('This step contains other steps — test the steps inside it individually.')
  }
```

Add a test asserting a `loop` node rejects with that message.

- [ ] **Step 6: Run the tests — expect PASS** (5 tests)

- [ ] **Step 7: Run the whole interpreter suite**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test $(find src/features/flows/__tests__ -name '*.test.ts')
npx tsc --noEmit -p tsconfig.json
```

Expected: all green. The `startNodeId` path must be untouched — `interpret-dag.test.ts` and `execute-flow-resume.test.ts` prove it.

- [ ] **Step 8: Commit**

```bash
git add src/features/flows/interpret.ts src/features/flows/__tests__/interpret-only-node.test.ts
git commit -m "feat(flows): interpreter onlyNodeId executes exactly one node"
```

---

## Task 11: `FlowNodePin` model + pins API

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_flow_node_pins/migration.sql` (generated)
- Create: `src/app/api/flows/[id]/pins/route.ts`

**Interfaces:**
- Produces: `prisma.flowNodePin` with `(flowId, nodeId, userId)` unique.
- Produces: `GET /api/flows/[id]/pins` → `{ success: true, pins: { nodeId: unknown }[] }`; `PUT` body `{ nodeId, output }`; `DELETE` body `{ nodeId }`.

- [ ] **Step 1: Add the model**

After `FlowRunStep` in `prisma/schema.prisma`:

```prisma
/// A pinned node output: a dev-time fixture so testing a step doesn't re-hit an
/// upstream API. Deliberately NOT stored in Flow.graph — pins must never reach
/// publishedGraph or /export, and they are per-user working state, not part of
/// the flow definition.
model FlowNodePin {
  id             String   @id @default(cuid())
  flowId         String
  nodeId         String
  userId         String
  organizationId String   @db.Uuid
  output         Json
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  flow Flow @relation(fields: [flowId], references: [id], onDelete: Cascade)

  @@unique([flowId, nodeId, userId])
  @@index([flowId, userId])
  @@map("flow_node_pins")
}
```

Add `nodePins FlowNodePin[]` to `model Flow`.

- [ ] **Step 2: Format, validate, generate the migration**

```bash
npx prisma format
npx prisma validate
```

Then bring up throwaway PG per the `verify` skill and:

```bash
DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa npx prisma migrate dev --name flow_node_pins --create-only
```

- [ ] **Step 3: Sanity-check the SQL**

Open the generated `migration.sql`. Confirm it creates `flow_node_pins` with the unique index on `(flow_id, node_id, user_id)`, the `(flow_id, user_id)` index, and the `flows` foreign key with `ON DELETE CASCADE`. No other table may change.

- [ ] **Step 4: Write the route** `src/app/api/flows/[id]/pins/route.ts`

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope } from '@/lib/server/visibility'

export const runtime = 'nodejs'

const flowIdFrom = (pathname: string) => pathname.split('/').at(-2)

/** Pins are per-user working state on a flow the caller can read. */
async function readableFlow(id: string, organizationId: string, userId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId, ...flowReadScope(userId) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return flow
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = flowIdFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Flow id is required')
  await readableFlow(id, auth.organizationId, auth.dbUser.id)
  const pins = await prisma.flowNodePin.findMany({
    where: { flowId: id, organizationId: auth.organizationId, userId: auth.dbUser.id },
    select: { nodeId: true, output: true, updatedAt: true },
  })
  return { success: true, pins }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const id = flowIdFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Flow id is required')
  await readableFlow(id, auth.organizationId, auth.dbUser.id)
  const { nodeId, output } = z
    .object({ nodeId: z.string().min(1), output: z.unknown() })
    .parse(await request.json().catch(() => ({})))
  const pin = await prisma.flowNodePin.upsert({
    where: { flowId_nodeId_userId: { flowId: id, nodeId, userId: auth.dbUser.id } },
    create: { flowId: id, nodeId, userId: auth.dbUser.id, organizationId: auth.organizationId, output: output ?? null },
    update: { output: output ?? null },
    select: { nodeId: true, output: true, updatedAt: true },
  })
  return { success: true, pin }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = flowIdFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Flow id is required')
  await readableFlow(id, auth.organizationId, auth.dbUser.id)
  const { nodeId } = z.object({ nodeId: z.string().min(1) }).parse(await request.json().catch(() => ({})))
  await prisma.flowNodePin.deleteMany({
    where: { flowId: id, nodeId, userId: auth.dbUser.id, organizationId: auth.organizationId },
  })
  return { success: true }
})
```

- [ ] **Step 5: Verify against a real database**

```bash
npx prisma generate
npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 6: Commit**

```bash
git add prisma src/app/api/flows/\[id\]/pins
git commit -m "feat(flows): FlowNodePin model and per-user pins API"
```

---

## Task 12: `resolveNodeTestInput` (pure)

**Files:**
- Create: `src/lib/flows/node-test-input.ts`
- Create: `src/lib/flows/__tests__/node-test-input.test.ts`

**Interfaces:**
- Produces:

```ts
export type NodeRef = { id: string; label: string; risk: 'read' | 'write' | 'destructive' }
export type NodeTestInput = {
  mockOutputs: Record<string, unknown>
  missing: NodeRef[]
  riskyMissing: NodeRef[]
}
export function resolveNodeTestInput(params: {
  nodeId: string
  graph: FlowGraph
  pins: Record<string, unknown>
  lastOutputs: Record<string, unknown>
  riskOf?: (nodeId: string) => 'read' | 'write' | 'destructive'
  labelOf?: (nodeId: string) => string
}): NodeTestInput
```

- [ ] **Step 1: Write the failing test** `src/lib/flows/__tests__/node-test-input.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveNodeTestInput } from '../node-test-input'
import type { FlowGraph } from '../graph'

// trigger → a → b → c
const graph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'a', type: 'http', data: { method: 'GET', url: 'https://api/a' } },
    { id: 'b', type: 'http', data: { method: 'GET', url: 'https://api/b' } },
    { id: 'c', type: 'http', data: { method: 'POST', url: 'https://api/c' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'a' },
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ],
} as unknown as FlowGraph

test('prefers a pin over the last run output', () => {
  const result = resolveNodeTestInput({
    nodeId: 'b',
    graph,
    pins: { a: { from: 'pin' } },
    lastOutputs: { a: { from: 'run' } },
  })
  assert.deepEqual(result.mockOutputs.a, { from: 'pin' })
  assert.deepEqual(result.missing, [])
})

test('falls back to the last run output when no pin exists', () => {
  const result = resolveNodeTestInput({ nodeId: 'b', graph, pins: {}, lastOutputs: { a: { from: 'run' } } })
  assert.deepEqual(result.mockOutputs.a, { from: 'run' })
  assert.deepEqual(result.missing, [])
})

test('reports ancestors with neither pin nor run output as missing', () => {
  const result = resolveNodeTestInput({ nodeId: 'c', graph, pins: {}, lastOutputs: {} })
  assert.deepEqual(result.missing.map((ref) => ref.id).sort(), ['a', 'b'])
})

test('only ANCESTORS are considered — never downstream nodes', () => {
  // Resolving input for 'b' must not care about 'c'. If it did, a node with an
  // unrun descendant would look unresolvable forever.
  const result = resolveNodeTestInput({ nodeId: 'b', graph, pins: {}, lastOutputs: {} })
  assert.equal(result.missing.some((ref) => ref.id === 'c'), false)
})

test('flags missing ancestors that perform writes', () => {
  const result = resolveNodeTestInput({
    nodeId: 'c',
    graph,
    pins: { a: { ok: true } },
    lastOutputs: {},
    riskOf: (id) => (id === 'b' ? 'destructive' : 'read'),
  })
  assert.deepEqual(result.riskyMissing.map((ref) => ref.id), ['b'])
  // riskyMissing is a SUBSET of missing, never a separate list.
  assert.ok(result.riskyMissing.every((ref) => result.missing.some((m) => m.id === ref.id)))
})

test('the trigger is never reported as a missing ancestor', () => {
  // A manual test supplies trigger input directly, so the trigger is never
  // something the user must "run first".
  const result = resolveNodeTestInput({ nodeId: 'a', graph, pins: {}, lastOutputs: {} })
  assert.equal(result.missing.some((ref) => ref.id === 'trigger'), false)
})

test('a diamond ancestor is reported once, not twice', () => {
  const diamond = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'root', type: 'http', data: { method: 'GET', url: 'https://api/root' } },
      { id: 'l', type: 'http', data: { method: 'GET', url: 'https://api/l' } },
      { id: 'r', type: 'http', data: { method: 'GET', url: 'https://api/r' } },
      { id: 'join', type: 'http', data: { method: 'GET', url: 'https://api/j' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'root' },
      { id: 'e1', source: 'root', target: 'l' },
      { id: 'e2', source: 'root', target: 'r' },
      { id: 'e3', source: 'l', target: 'join' },
      { id: 'e4', source: 'r', target: 'join' },
    ],
  } as unknown as FlowGraph
  const result = resolveNodeTestInput({ nodeId: 'join', graph: diamond, pins: {}, lastOutputs: {} })
  assert.equal(result.missing.filter((ref) => ref.id === 'root').length, 1)
})
```

- [ ] **Step 2: Run it — expect failure**

Expected: FAIL — `Cannot find module '../node-test-input'`.

- [ ] **Step 3: Implement**

```ts
import type { FlowGraph } from '@/lib/flows/graph'

export type NodeRisk = 'read' | 'write' | 'destructive'
export type NodeRef = { id: string; label: string; risk: NodeRisk }
export type NodeTestInput = {
  mockOutputs: Record<string, unknown>
  missing: NodeRef[]
  riskyMissing: NodeRef[]
}

/**
 * Decide what a single-node test should feed the selected node.
 *
 * Resolution order per ancestor: pinned output › last run's output › report as
 * missing. Pure and synchronous so it is cheap to unit-test — the interesting
 * behaviour is graph traversal and precedence, not I/O.
 *
 * `riskyMissing` is the subset of `missing` that performs an external write, so
 * the caller can name those actions before offering to run them. Running a
 * write action to satisfy a config check is a real side effect and must be an
 * explicit, informed choice.
 */
export function resolveNodeTestInput({
  nodeId,
  graph,
  pins,
  lastOutputs,
  riskOf,
  labelOf,
}: {
  nodeId: string
  graph: FlowGraph
  pins: Record<string, unknown>
  lastOutputs: Record<string, unknown>
  riskOf?: (nodeId: string) => NodeRisk
  labelOf?: (nodeId: string) => string
}): NodeTestInput {
  const parents = new Map<string, string[]>()
  for (const edge of graph.edges ?? []) {
    const list = parents.get(edge.target)
    if (list) list.push(edge.source)
    else parents.set(edge.target, [edge.source])
  }
  const typeOf = new Map((graph.nodes ?? []).map((node) => [node.id, node.type]))

  // Every transitive ancestor, deduped — a diamond's shared root is one entry.
  const ancestors = new Set<string>()
  const stack = [...(parents.get(nodeId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (ancestors.has(id)) continue
    ancestors.add(id)
    for (const parent of parents.get(id) ?? []) stack.push(parent)
  }

  const mockOutputs: Record<string, unknown> = {}
  const missing: NodeRef[] = []
  for (const id of ancestors) {
    // The trigger's payload comes from the test input, not from running it.
    if (typeOf.get(id) === 'trigger') continue
    if (id in pins) mockOutputs[id] = pins[id]
    else if (id in lastOutputs) mockOutputs[id] = lastOutputs[id]
    else missing.push({ id, label: labelOf?.(id) ?? id, risk: riskOf?.(id) ?? 'read' })
  }
  return { mockOutputs, missing, riskyMissing: missing.filter((ref) => ref.risk !== 'read') }
}
```

- [ ] **Step 4: Run the tests — expect PASS** (7 tests)

- [ ] **Step 5: Add `riskForNode` in the same module**

The caller needs a `riskOf` to pass in. A tool node already persists its
classification on `node.data.risk` (`graph.ts:138`, written by the tool picker
from the catalog), so this is graph-local — no catalog argument, no async.

Append the test first:

```ts
test('riskForNode reads a tool node persisted risk', () => {
  assert.equal(riskForNode({ id: 't', type: 'tool', data: { connectionId: 'c', toolName: 'delete_all', risk: 'destructive' } } as never), 'destructive')
})

test('riskForNode treats a non-GET http node as a write', () => {
  // No persisted risk on http nodes — the method is the only signal, and
  // guessing "read" for a POST is the dangerous direction to be wrong in.
  assert.equal(riskForNode({ id: 'h', type: 'http', data: { method: 'POST', url: 'https://api/x' } } as never), 'write')
  assert.equal(riskForNode({ id: 'h', type: 'http', data: { method: 'GET', url: 'https://api/x' } } as never), 'read')
})

test('riskForNode defaults an unclassified tool node to write, not read', () => {
  // An older graph may carry no risk field. Defaulting to read would let a
  // real write run without the confirmation this exists to trigger.
  assert.equal(riskForNode({ id: 't', type: 'tool', data: { connectionId: 'c', toolName: 'send' } } as never), 'write')
})

test('riskForNode calls pure in-memory steps read', () => {
  assert.equal(riskForNode({ id: 'x', type: 'transform', data: { fields: [] } } as never), 'read')
})
```

Then implement:

```ts
/**
 * How dangerous is it to run this node unattended?
 *
 * Errs toward `write` when unsure: a false `write` costs one extra
 * confirmation, a false `read` silently fires a real side effect.
 */
export function riskForNode(node: FlowNode): NodeRisk {
  if (node.type === 'tool') return node.data.risk ?? 'write'
  if (node.type === 'http') return node.data.method === 'GET' || node.data.method === 'HEAD' ? 'read' : 'write'
  return 'read'
}
```

Add `riskForNode` to the test file's import. Run — expect PASS (11 tests).

- [ ] **Step 6: Add the two remaining traversals**

Task 14 needs the descendant direction (to warn about downstream writes before "Run from here") and a topological order (to materialise missing ancestors in dependency order). Both live here so all four graph walks are tested the same way.

Tests first:

```ts
test('downstreamWriteActions finds transitive descendants that write', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'transform', data: { fields: [] } },
      { id: 'b', type: 'http', data: { method: 'POST', url: 'https://api/b' } },
      { id: 'c', type: 'transform', data: { fields: [] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
  } as unknown as FlowGraph
  // From 'a': 'b' writes, 'c' does not, and 'a' itself is never included.
  assert.deepEqual(downstreamWriteActions({ nodeId: 'a', graph }).map((ref) => ref.id), ['b'])
  assert.deepEqual(downstreamWriteActions({ nodeId: 'b', graph }).map((ref) => ref.id), [])
})

test('topoSortByGraph puts a shared ancestor before both dependents, once', () => {
  const graph = {
    nodes: [
      { id: 'root', type: 'transform', data: { fields: [] } },
      { id: 'l', type: 'transform', data: { fields: [] } },
      { id: 'r', type: 'transform', data: { fields: [] } },
    ],
    edges: [
      { id: 'e0', source: 'root', target: 'l' },
      { id: 'e1', source: 'root', target: 'r' },
    ],
  } as unknown as FlowGraph
  const refs = [
    { id: 'l', label: 'L', risk: 'read' as const },
    { id: 'root', label: 'Root', risk: 'read' as const },
    { id: 'r', label: 'R', risk: 'read' as const },
  ]
  const order = topoSortByGraph(refs, graph).map((ref) => ref.id)
  assert.equal(order.filter((id) => id === 'root').length, 1)
  assert.ok(order.indexOf('root') < order.indexOf('l'))
  assert.ok(order.indexOf('root') < order.indexOf('r'))
})
```

Then implement:

```ts
/** Transitive descendants of `nodeId` that perform an external write. */
export function downstreamWriteActions({ nodeId, graph }: { nodeId: string; graph: FlowGraph }): NodeRef[] {
  const children = new Map<string, string[]>()
  for (const edge of graph.edges ?? []) {
    const list = children.get(edge.source)
    if (list) list.push(edge.target)
    else children.set(edge.source, [edge.target])
  }
  const byId = new Map((graph.nodes ?? []).map((node) => [node.id, node]))
  const seen = new Set<string>()
  const stack = [...(children.get(nodeId) ?? [])]
  const writes: NodeRef[] = []
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node) {
      const risk = riskForNode(node)
      if (risk !== 'read') writes.push({ id, label: labelOfNode(node), risk })
    }
    for (const child of children.get(id) ?? []) stack.push(child)
  }
  return writes
}

/**
 * Order `refs` so every node follows its own ancestors. Kahn's algorithm over
 * the subgraph induced by `refs` — edges to nodes outside the set are ignored,
 * because those are already satisfied by the caller's accumulated outputs.
 */
export function topoSortByGraph(refs: NodeRef[], graph: FlowGraph): NodeRef[] {
  const inSet = new Map(refs.map((ref) => [ref.id, ref]))
  const remaining = new Map<string, Set<string>>()
  for (const ref of refs) remaining.set(ref.id, new Set())
  for (const edge of graph.edges ?? []) {
    if (inSet.has(edge.source) && inSet.has(edge.target)) remaining.get(edge.target)!.add(edge.source)
  }
  const ordered: NodeRef[] = []
  const ready = refs.filter((ref) => remaining.get(ref.id)!.size === 0)
  const queued = new Set(ready.map((ref) => ref.id))
  while (ready.length) {
    const ref = ready.shift()!
    ordered.push(ref)
    for (const [id, deps] of remaining) {
      if (!deps.delete(ref.id) || deps.size > 0 || queued.has(id) || ordered.some((done) => done.id === id)) continue
      queued.add(id)
      ready.push(inSet.get(id)!)
    }
  }
  // A cycle would strand nodes; append them so the caller still tries rather
  // than silently dropping work. graph.ts already rejects cyclic graphs, so
  // this is a belt-and-braces path, not an expected one.
  for (const ref of refs) if (!ordered.some((done) => done.id === ref.id)) ordered.push(ref)
  return ordered
}
```

`labelOfNode(node)` returns `node.data.label?.trim()` or falls back to the node type — copy the existing `nodeLabel` helper from `src/lib/flows/validate.ts:25` rather than writing a second one, exporting it from there if needed.

Run — expect PASS (13 tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/node-test-input.ts src/lib/flows/__tests__/node-test-input.test.ts
git commit -m "feat(flows): resolveNodeTestInput decides single-node test input"
```

---

## Task 13: `/test-node` route

**Files:**
- Create: `src/app/api/flows/[id]/test-node/route.ts`
- Create: `src/app/api/__tests__/test-node-route-smoke.test.ts`
- Modify: `src/features/flows/execute-flow.ts` (`FlowExecutionJob.onlyNodeId`, `trigger.type` union)
- Modify: `src/app/api/flows/[id]/runs/route.ts` (exclude node-test runs)

**Interfaces:**
- Consumes: `resolveNodeTestInput` (Task 12), `opts.onlyNodeId` (Task 10).
- Produces: `POST /api/flows/[id]/test-node` body `{ nodeId, input?, mockOutputs? }` → `{ success: true, run: { flowRunId, status, output } }`.

- [ ] **Step 1: Thread `onlyNodeId` through `execute-flow.ts`**

Add to `FlowExecutionJob` beside `startNodeId` (`execute-flow.ts:47`):

```ts
  /** Builder single-node test: execute ONLY this node (never downstream). */
  onlyNodeId?: string
```

Extend the `trigger` union (`execute-flow.ts:57`) with `'node_test'`:

```ts
  trigger?: { type: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack' | 'activity' | 'node_test'; [key: string]: unknown }
```

Pass it to `interpretFlow` beside `startNodeId` (`execute-flow.ts:768`):

```ts
    ...(job.onlyNodeId ? { onlyNodeId: job.onlyNodeId } : {}),
```

- [ ] **Step 2: Write the route**

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope } from '@/lib/server/visibility'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/flows/[id]/test-node — run exactly ONE node of the draft graph.
 *
 * Separate from /execute deliberately: this must not record a manual-run
 * behaviour event, and its FlowRun is tagged `node_test` so builder
 * experiments don't pollute run history. Downstream nodes never execute (see
 * interpret.ts `onlyNodeId`), so testing a step can't fire a later write.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const parsed = z
    .object({
      nodeId: z.string().min(1),
      input: z.unknown().optional(),
      mockOutputs: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await request.json().catch(() => ({})))

  // Awaited, not backgrounded: the NDV shows this node's output inline, so the
  // caller wants the result rather than a run id to poll.
  const result = await dispatchFlowExecution({
    flowId: id,
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    input: parseFlowInput(parsed.input),
    onlyNodeId: parsed.nodeId,
    mockOutputs: parsed.mockOutputs,
    trigger: { type: 'node_test', nodeId: parsed.nodeId },
  })
  const run = 'queued' in result ? { flowRunId: result.flowRunId, status: 'queued', output: null } : result
  return { success: true, run }
})
```

- [ ] **Step 3: Exclude node-test runs from history**

In `src/app/api/flows/[id]/runs/route.ts`, add an opt-in param and filter by default:

```ts
  // Builder single-node tests are debugging noise in run history — excluded
  // unless asked for explicitly (`includeNodeTests=1`).
  const includeNodeTests = searchParams.get('includeNodeTests') === '1'
```

Add to the `where`:

```ts
      ...(includeNodeTests ? {} : { NOT: { trigger: { path: ['type'], equals: 'node_test' } } }),
```

Verify this JSON-path predicate against the real Prisma version — if `NOT` + `path` is unsupported, filter in application code after the query and say so in a comment.

- [ ] **Step 4: Write the route-smoke test** `src/app/api/__tests__/test-node-route-smoke.test.ts`

Bring up throwaway PG per the `verify` skill. Read an existing route-smoke test in that directory first and copy its `seedTestOrg` / `installTestAuth` / request-construction idiom exactly — the helper signatures below are the expected shape, not a guess to be trusted blind.

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@/lib/prisma'
import { seedTestOrg } from '@/lib/server/__tests__/test-seed'
import { installTestAuth } from '@/lib/server/__tests__/test-auth'
import { POST as testNode } from '@/app/api/flows/[id]/test-node/route'
import { GET as listRuns } from '@/app/api/flows/[id]/runs/route'

let seeded: Awaited<ReturnType<typeof seedTestOrg>>
let flowId: string

const GRAPH = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'a', type: 'transform', data: { label: 'Set fields', fields: [{ name: 'x', value: 'one' }] } },
    { id: 'b', type: 'transform', data: { label: 'Set more', fields: [{ name: 'y', value: 'two' }] } },
    { id: 'loop', type: 'loop', data: { label: 'For each', over: '{{trigger.input.items}}', body: [] } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'a' },
    { id: 'e1', source: 'a', target: 'b' },
  ],
}

before(async () => {
  seeded = await seedTestOrg(prisma)
  installTestAuth(seeded.auth)
  const flow = await prisma.flow.create({
    data: { name: 'Node test', organizationId: seeded.organizationId, userId: seeded.userId, graph: GRAPH, trigger: { type: 'manual' } },
    select: { id: true },
  })
  flowId = flow.id
})

after(async () => { await seeded.cleanup() })

const post = (body: unknown) =>
  testNode(new Request(`http://localhost/api/flows/${flowId}/test-node`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never)

test('runs only the selected node and tags the run node_test', async () => {
  const response = await post({ nodeId: 'a', input: {} })
  assert.equal(response.status, 200)
  const runs = await prisma.flowRun.findMany({ where: { flowId }, include: { steps: true } })
  assert.equal(runs.length, 1)
  // The whole point: one step row, and it is the node we asked for.
  assert.deepEqual(runs[0].steps.map((step) => step.nodeId), ['a'])
  assert.equal((runs[0].trigger as { type?: string }).type, 'node_test')
})

test('a node-test run is absent from the default runs list', async () => {
  const hidden = await listRuns(new Request(`http://localhost/api/flows/${flowId}/runs`) as never)
  const shown = await listRuns(new Request(`http://localhost/api/flows/${flowId}/runs?includeNodeTests=1`) as never)
  assert.equal((await hidden.json()).runs.length, 0, 'builder experiments must not pollute run history')
  assert.equal((await shown.json()).runs.length, 1, 'but must remain retrievable when asked for')
})

test('a container node is refused', async () => {
  const response = await post({ nodeId: 'loop', input: {} })
  assert.notEqual(response.status, 200)
  assert.match(JSON.stringify(await response.json()), /steps inside it/i)
})

test('another org cannot test a node of this flow', async () => {
  const other = await seedTestOrg(prisma)
  installTestAuth(other.auth)
  try {
    const response = await post({ nodeId: 'a', input: {} })
    // 404, not 403 — a cross-org id must not confirm the flow exists.
    assert.equal(response.status, 404)
  } finally {
    installTestAuth(seeded.auth)
    await other.cleanup()
  }
})
```

`transform` nodes are used rather than `http`/`tool` so the test needs no outbound network stub — the assertions are about *which* nodes ran, not what they returned.

- [ ] **Step 5: Run the route smoke test**

```bash
TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa \
  TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/test-node-route-smoke.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
```

- [ ] **Step 7: Commit**

```bash
git add src/app/api/flows/\[id\]/test-node src/app/api/__tests__/test-node-route-smoke.test.ts src/features/flows/execute-flow.ts src/app/api/flows/\[id\]/runs/route.ts
git commit -m "feat(flows): test-node route runs a single node without downstream effects"
```

---

## Task 14: Wire "Test step" into the NDV

**Files:**
- Modify: `src/components/flows/ndv/node-detail-view.tsx`
- Modify: `src/components/flows/ndv/output-pane.tsx`
- Modify: `src/app/flows/[id]/page.tsx`
- Modify: `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`

**Interfaces:**
- Consumes: `resolveNodeTestInput`, `POST /test-node`, `GET/PUT/DELETE /pins`.
- Produces: `NodeDetailView` gains `onTestStep`, `testState`, `pins`, `onPin`, `onUnpin`.

- [ ] **Step 1: Write the failing tests**

```tsx
test('Test step is disabled for a container node with the reason shown', () => {
  const loop = { id: 'l1', type: 'loop', data: { over: '{{trigger.input.items}}', body: [] } } as unknown as FlowNode
  const { getByRole, getByText } = render(<NodeDetailView node={loop} {...baseProps} onTestStep={() => {}} />)
  const button = getByRole('button', { name: /test step/i })
  assert.equal((button as HTMLButtonElement).disabled, true)
  getByText(/steps inside it individually/i)
})

test('testing a node with unresolved risky ancestors asks before running them', () => {
  let ran = false
  const { getByRole, getByText } = render(
    <NodeDetailView node={httpNode} {...baseProps} riskyMissing={[{ id: 'a', label: 'Delete records', risk: 'destructive' }]} onTestStep={() => { ran = true }} />,
  )
  getByRole('button', { name: /test step/i }).click()
  // Must NOT run yet — it names the write action and waits.
  assert.equal(ran, false)
  getByText(/Delete records/)
})

test('a failed node test surfaces the error in the output pane', () => {
  const { getByText } = render(
    <NodeDetailView node={httpNode} {...baseProps} testState={{ status: 'failed', error: '401 Unauthorized' }} />,
  )
  getByText(/401 Unauthorized/)
})
```

Define `baseProps` once at the top of the file and reuse it — the earlier tests' inline prop bags should be refactored onto it in this step.

- [ ] **Step 2: Run — expect failure**

Expected: FAIL — no Test step button exists.

- [ ] **Step 3: Add the button and confirm flow**

In the NDV header, a primary `Test step` button. Disabled with an inline reason when the node type is a container (`loop | parallel | repeatUntil | errorShield`) — mirror the interpreter's copy from Task 10 Step 5 so the UI and the API say the same thing.

When `missing` is non-empty the node cannot be tested honestly — its upstream tokens would resolve to nothing and it would either fail with a confusing error or "succeed" against empty input. So the button's behaviour forks on what is missing:

| `missing` | `riskyMissing` | Behaviour |
|---|---|---|
| empty | — | Test immediately |
| non-empty | empty | Say which steps have no data, offer **Get their data & test** (one click, no confirm — every one is read-only) |
| non-empty | non-empty | Confirm first, naming each write action |

**Materialising missing ancestor data** uses the same single-node mechanism rather than a full run: topologically sort `missing` and `POST /test-node` each in dependency order, accumulating each result into `mockOutputs` before the next. By the time each ancestor runs, its *own* ancestors are already satisfied. Nothing outside the ancestor set ever executes — a full `/execute` would also fire everything downstream of the node under test, which is the failure this mode exists to prevent.

```tsx
  // Ancestors first, in dependency order, each feeding the next. Reuses
  // /test-node so the "only this node" guarantee holds at every step.
  const materialise = async (refs: NodeRef[], seed: Record<string, unknown>) => {
    const accumulated = { ...seed }
    for (const ref of topoSortByGraph(refs, graph)) {
      const response = await fetch(`/api/flows/${flowId}/test-node`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: ref.id, input: testInput, mockOutputs: accumulated }),
      })
      const body = await response.json()
      if (!response.ok || body.run?.status === 'failed') {
        throw new Error(`${ref.label} failed — fix it before testing this step. ${body.run?.error ?? ''}`.trim())
      }
      accumulated[ref.id] = body.run?.output
    }
    return accumulated
  }
```

Export `topoSortByGraph(refs, graph)` from `node-test-input.ts` alongside the other traversals, with a unit test covering the diamond case (a shared ancestor must appear once, before both of its dependents).

When `riskyMissing` is non-empty, the first click opens a confirm naming each risky action rather than running:

```tsx
  {confirming && (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
      <p className="font-semibold text-amber-900">These earlier steps have no data yet and make real changes:</p>
      <ul className="mt-1.5 list-disc pl-5 text-amber-900">
        {riskyMissing.map((ref) => <li key={ref.id}>{ref.label} <span className="font-mono text-[10px] uppercase">{ref.risk}</span></li>)}
      </ul>
      <p className="mt-2 text-amber-800">Running them will make those changes for real. Pin their output instead to avoid it.</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => { setConfirming(false); onTestStep() }}>Run them anyway</Button>
        <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
      </div>
    </div>
  )}
```

- [ ] **Step 4: Wire the call in `page.tsx`**

```tsx
  const testNode = useCallback(async (nodeId: string) => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    const resolved = resolveNodeTestInput({
      nodeId, graph, pins, lastOutputs,
      riskOf: (id) => { const node = byId.get(id); return node ? riskForNode(node) : 'write' },
      labelOf: (id) => labelForNode(id),
    })
    const response = await fetch(`/api/flows/${flowId}/test-node`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId, input: testInput, mockOutputs: resolved.mockOutputs }),
    })
    // …set testState from the response; on failure surface run.error…
  }, [graph, pins, lastOutputs, flowId, testInput, toolCatalog])
```

`riskForNode` comes from Task 12 Step 5. An id absent from the graph resolves to `'write'` — the safe direction.

- [ ] **Step 5: Wire pin/unpin**

`onPin` PUTs the node's current output; `onUnpin` DELETEs. Load pins once with the flow and keep them in `page.tsx` state so `resolveNodeTestInput` sees them.

- [ ] **Step 6: Keep "Run from here" as an explicit secondary action**

Today's `startNodeId` behaviour (this node *and everything downstream*) stays available — it is genuinely useful for "I fixed the bug, carry on from here" — but it is no longer reachable by accident. Move it out of the Test panel's checkbox (`test-panel.tsx:139-142`) and into a secondary item in the NDV's Test-step split button, behind a confirm that names what it will fire.

Write the failing test first:

```tsx
test('Run from here names the downstream write actions before running', () => {
  let ran = false
  const { getByRole, getByText } = render(
    <NodeDetailView
      node={httpNode}
      {...baseProps}
      downstreamWrites={[{ id: 'c', label: 'Send email', risk: 'write' }]}
      onRunFromHere={() => { ran = true }}
    />,
  )
  getByRole('button', { name: /run from here/i }).click()
  assert.equal(ran, false, 'must confirm before firing downstream writes')
  getByText(/Send email/)
})

test('Run from here with no downstream writes runs immediately', () => {
  // Nothing to warn about — a confirm here would be noise that teaches users
  // to click through warnings.
  let ran = false
  const { getByRole } = render(<NodeDetailView node={httpNode} {...baseProps} downstreamWrites={[]} onRunFromHere={() => { ran = true }} />)
  getByRole('button', { name: /run from here/i }).click()
  assert.equal(ran, true)
})
```

`downstreamWrites` is computed in `page.tsx` by walking descendants of the selected node and filtering with `riskForNode` — the mirror image of `resolveNodeTestInput`'s ancestor walk. Add it as an exported `downstreamWriteActions({ nodeId, graph })` in `node-test-input.ts` with its own unit test, so both directions of the traversal live together and are tested the same way.

`onRunFromHere` POSTs to the existing `/execute` route with `startNodeId` and the resolved `mockOutputs` — unchanged behaviour, newly explicit. Then delete the `partial` checkbox and `mockOutputsText` textarea from `test-panel.tsx`; raw-JSON mock authoring is superseded by pins.

- [ ] **Step 7: Run the tests — expect PASS** (15 tests)

- [ ] **Step 8: Verify end to end**

```bash
npx tsc --noEmit -p tsconfig.json
npm test 2>&1 | tail -20
```

Then use the `run` skill and confirm by hand:
1. Open a tool node's NDV → Test step → output appears in the right pane.
2. A downstream write step did **not** run (check run history with `includeNodeTests=1`).
3. Pin an output → the upstream step's icon shows pinned → testing the downstream node makes no upstream network call.
4. A container node's Test step is disabled with the reason.
5. A step with an unrun write ancestor prompts before running it.
6. "Run from here" on a step with a downstream email/Slack action names it before running.

- [ ] **Step 9: Commit**

```bash
git add src/components/flows/ndv src/components/flows/test-panel.tsx src/app/flows/\[id\]/page.tsx src/lib/flows/node-test-input.ts src/lib/flows/__tests__/node-test-input.test.ts
git commit -m "feat(flows): NDV Test step with pin reuse and write-risk confirmation"
```

---

## Done criteria

- `step-card.tsx` under 900 lines; `NODE_BODIES` total over `FlowNode['type']` and guarded by both `tsc` and the registry test.
- The NDV is the only node-config surface; it opens by click/keyboard, closes on Escape, and round-trips through `?node=<id>`.
- `onlyNodeId` executes exactly one node, proven by a test asserting a downstream destructive step does not run.
- Pins live in `flow_node_pins`, never in `Flow.graph` — verify with `grep -n 'pin' src/lib/export/portable.ts` returning nothing.
- Node-test runs are absent from default run history.
- `npm test` green; `npx tsc --noEmit` exits 0.

## Deferred to later phases (do not build here)

- **Phase 3 — credential verification state.** Blocked on the credential vault ([plan](2026-07-21-credential-vault-http-parity.md)). The NDV's connection picker gets its health chip then; build the picker now without one.
- **Phase 4 — form quality.** Live resolved-value preview under token fields, `requiredFields`-driven validation highlighting, searchable comboboxes, `inputSchema.description` hints. `requiredFields` is populated in Phase 0 but not yet consumed — that is intentional groundwork, not dead code.
