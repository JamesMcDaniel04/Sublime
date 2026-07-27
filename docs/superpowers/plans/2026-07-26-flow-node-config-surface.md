# Flow Node Configuration Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a flow node's configuration reachable in one click and show only what the node genuinely needs — no step-type restatement, no duplicate upstream-data trees, no inline advanced-parameter accordions — and let a saved credential authenticate an MCP server the same way it already authenticates an HTTP node.

**Architecture:** Seven UI tasks strip and relocate existing surfaces inside the Node Detail View (NDV) and the two canvases, deleting `NodeConfigPanel` once its unique capability (container-child reordering) has moved into the NDV. Two credential tasks follow: a pure refactor extracting the HTTP node's credential dialog into a shared `CredentialPicker`, then a new `authConfig: { credentialId }` form for MCP connections resolved through the existing `InjectionPlan` pipeline. Tasks 1–7 are independent of 8–9.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Prisma/Postgres, Tailwind. Tests are `node:test` + `@testing-library/react` under `__tests__/` directories.

**Spec:** [docs/superpowers/specs/2026-07-26-flow-node-config-surface-design.md](../specs/2026-07-26-flow-node-config-surface-design.md)

## Global Constraints

- **Run one test file:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- **Run the whole suite:** `npm test`
- **Typecheck:** `npm run typecheck` — must pass before every commit.
- Every React test file starts with `import '@/test-support/jsdom-env'` as its **first** import, then `import { test, afterEach } from 'node:test'`, `import assert from 'node:assert/strict'`, and calls `afterEach(() => cleanup())`.
- No executor semantics change in Tasks 1–8. Every `node.data` key keeps its current runtime meaning; only where it is edited moves.
- Never write a plaintext secret into `node.data`, a flow graph, or an export. `src/lib/export/__tests__/export.test.ts` enforces this and must stay green.
- Comments explain *why*, not *what* — match the density of the file you are editing.
- The spec's §5 claim that `parseFlowToolConnectionId` recognizes a `credential:<id>` plane is **wrong** and was corrected before planning. That prefix is only a verification key (`src/lib/connections/verification.ts:81`) and a metrics `connectionRef`. Task 9 implements the corrected design: MCP `api_key` auth backed by a stored `Credential`. Do not add a `credential` tool plane.

---

## File Structure

**Create**
| File | Responsibility |
|---|---|
| `src/components/flows/ndv/json-token-view.tsx` | Render a value as indented, clickable, draggable JSON; emit `{{path}}` tokens. Pure and presentational. |
| `src/lib/flows/containers.ts` | `containerChildIds` / `isContainerNode` / `siblingsOf`, lifted out of `dag-canvas.tsx` so two components can share them. |
| `src/components/flows/nodes/container-children.tsx` | List a container node's children with drag-reorder and Add-step. |
| `src/components/credentials/credential-picker.tsx` | Type select + credential list + Edit/Set-up buttons + health badge + save/verify dialog. |
| `src/lib/mcp/connection-credential.ts` | Resolve an `McpConnection`'s `authConfig.credentialId` into an `InjectionPlan`. |
| `src/components/flows/ndv/__tests__/json-token-view.test.tsx` | Task 1 tests. |
| `src/components/flows/nodes/__tests__/container-children.test.tsx` | Task 5 tests. |
| `src/lib/mcp/__tests__/connection-credential.test.ts` | Task 9 tests. |

**Modify**
| File | Change |
|---|---|
| `src/components/flows/ndv/input-pane.tsx` | Raw-only; renders `JsonTokenView`. |
| `src/components/flows/ndv/node-detail-view.tsx` | Drop `dataFields`/`onChangeType`; add `graph`/`labelOf`/`onReorderContainer`/`onDeleteNode`/`onDuplicateNode`; header actions. |
| `src/components/flows/ndv/params-pane.tsx` | Settings tab renders the policy section. |
| `src/components/flows/ndv/step-settings-footer.tsx` | Notes only. |
| `src/components/flows/nodes/types.ts` | Drop `dataFields`; add container props. |
| `src/components/flows/nodes/{agent,code,loop,tool}-body.tsx` | Remove `<AdvancedParamsSection>`. |
| `src/components/flows/nodes/{loop,parallel,repeat-until,error-shield}-body.tsx` | Render `<ContainerChildren>`. |
| `src/components/flows/nodes/http-body.tsx` | Remove `<HttpOptionsSection>`; consume `CredentialPicker`. |
| `src/components/flows/tool-args-editor.tsx` | Remove both `DataTree`s and `dataFields`. |
| `src/components/flows/step-card.tsx` | Single click opens; remove step-type block. |
| `src/components/flows/dag-canvas.tsx` | Delete `NodeConfigPanel`; click routes to `onOpenNode`. |
| `src/components/flows/flow-canvas.tsx` | Click routes to `onOpenNode`. |
| `src/app/flows/[id]/page.tsx` | Shortcut rebinding; prop wiring; delete `buildDataTree`/`changeNodeType` usage. |
| `src/lib/flows/mutate.ts` | Delete `changeNodeType`. |
| `src/lib/mcp/mcp-client.ts` | `credentialPlan` on config; apply it in `rpc`. |
| `src/features/agents/tool-planes.ts` | Supply `credentialPlan` at both client construction sites. |
| `src/features/flows/http-auth.ts` | Same, at its client construction site. |
| `src/components/connections/mcp-connection-dialog.tsx` | API-key auth uses `CredentialPicker`. |
| `src/app/api/mcp-connections/route.ts` | Accept and persist `credentialId`. |

**Delete**
- `src/components/flows/data-tree.tsx`
- `NodeConfigPanel` in `src/components/flows/dag-canvas.tsx:318-425`
- `changeNodeType` in `src/lib/flows/mutate.ts:260`
- `buildDataTree` in `src/lib/flows/datatree.ts` (keep the `DataField`/`FieldType` types only if a non-UI consumer still imports them; delete the file otherwise)

---

## Task 1: JsonTokenView — clickable raw JSON

**Files:**
- Create: `src/components/flows/ndv/json-token-view.tsx`
- Test: `src/components/flows/ndv/__tests__/json-token-view.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function JsonTokenView(props: { value: unknown; onInsertToken: (token: string) => void }): ReactNode`. Every clickable span carries `data-token="{{<path>}}"`. Task 2 renders this.

- [ ] **Step 1: Write the failing test**

Create `src/components/flows/ndv/__tests__/json-token-view.test.tsx`:

```tsx
/**
 * The raw JSON pane is the ONLY way to map upstream data now that the field
 * tree is gone. If a path is computed wrong the user writes a token that
 * silently resolves to nothing at run time, so paths are asserted exactly.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { JsonTokenView } from '../json-token-view'

afterEach(() => cleanup())

const VALUE = {
  trigger: { email: 'a@b.co', count: 2 },
  previousNodes: { http_1: { items: [{ id: 'x1' }], ok: true } },
}

const tokenOf = (container: HTMLElement, path: string) =>
  container.querySelector(`[data-token="{{${path}}}"]`) as HTMLElement | null

test('a nested leaf click emits its full dotted path', () => {
  let inserted: string | null = null
  const { container } = render(<JsonTokenView value={VALUE} onInsertToken={(t) => { inserted = t }} />)
  const leaf = tokenOf(container, 'trigger.email')
  assert.ok(leaf, 'trigger.email is not clickable')
  fireEvent.click(leaf)
  assert.equal(inserted, '{{trigger.email}}')
})

test('array members are addressed by index', () => {
  let inserted: string | null = null
  const { container } = render(<JsonTokenView value={VALUE} onInsertToken={(t) => { inserted = t }} />)
  const leaf = tokenOf(container, 'previousNodes.http_1.items.0.id')
  assert.ok(leaf, 'array member path is wrong')
  fireEvent.click(leaf)
  assert.equal(inserted, '{{previousNodes.http_1.items.0.id}}')
})

test('a container key is itself insertable — whole objects are mappable', () => {
  let inserted: string | null = null
  const { container } = render(<JsonTokenView value={VALUE} onInsertToken={(t) => { inserted = t }} />)
  const key = tokenOf(container, 'previousNodes.http_1')
  assert.ok(key, 'object key is not clickable')
  fireEvent.click(key)
  assert.equal(inserted, '{{previousNodes.http_1}}')
})

test('a leaf drags its braced token as text/plain', () => {
  const { container } = render(<JsonTokenView value={VALUE} onInsertToken={() => {}} />)
  const leaf = tokenOf(container, 'trigger.count')!
  assert.equal(leaf.getAttribute('draggable'), 'true')
  let dragged: string | null = null
  fireEvent.dragStart(leaf, {
    dataTransfer: { setData: (_type: string, value: string) => { dragged = value }, effectAllowed: '' },
  })
  assert.equal(dragged, '{{trigger.count}}')
})

test('booleans, numbers and null all render and are clickable', () => {
  const { container } = render(<JsonTokenView value={{ a: null, b: false, c: 0 }} onInsertToken={() => {}} />)
  for (const path of ['a', 'b', 'c']) assert.ok(tokenOf(container, path), `${path} is not clickable`)
})

test('an empty object renders without crashing', () => {
  const { container } = render(<JsonTokenView value={{}} onInsertToken={() => {}} />)
  assert.ok(container.firstChild)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/json-token-view.test.tsx`
Expected: FAIL — cannot find module `../json-token-view`.

- [ ] **Step 3: Write the implementation**

Create `src/components/flows/ndv/json-token-view.tsx`:

```tsx
'use client'

import { Fragment } from 'react'

/**
 * Upstream data as raw JSON, where every value is a token you can click.
 *
 * Replaces the DataTree field picker: same click-to-insert contract, but the
 * user reads the actual payload rather than a summarised tree, so what they
 * map is what the step will really receive.
 *
 * Container keys are insertable too — mapping a whole object into a body field
 * is common, and forcing a leaf-by-leaf rebuild of it was busywork.
 */

const INDENT = 16

/** `{{a.b.0.c}}` — the token form every chip editor and the executor accept. */
const braced = (path: string) => `{{${path}}}`

function Token({
  path,
  children,
  onInsertToken,
}: {
  path: string
  children: React.ReactNode
  onInsertToken: (token: string) => void
}) {
  const token = braced(path)
  return (
    <span
      role="button"
      tabIndex={0}
      draggable
      data-token={token}
      title={`Insert ${token}`}
      onClick={() => onInsertToken(token)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onInsertToken(token)
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', token)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className="cursor-pointer rounded px-0.5 hover:bg-indigo-100 hover:text-indigo-900 dark:hover:bg-indigo-950/60 dark:hover:text-indigo-200"
    >
      {children}
    </span>
  )
}

function Node({
  value,
  path,
  depth,
  onInsertToken,
}: {
  value: unknown
  path: string
  depth: number
  onInsertToken: (token: string) => void
}) {
  const pad = { paddingLeft: depth * INDENT }

  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, unknown]> = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value as Record<string, unknown>)
    const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
    if (entries.length === 0) return <span>{open}{close}</span>
    return (
      <>
        <span>{open}</span>
        {entries.map(([key, child]) => {
          const childPath = path ? `${path}.${key}` : key
          return (
            <div key={childPath} style={pad} className="whitespace-pre">
              <Token path={childPath} onInsertToken={onInsertToken}>
                {Array.isArray(value) ? key : `"${key}"`}
              </Token>
              <span>: </span>
              <Node value={child} path={childPath} depth={depth + 1} onInsertToken={onInsertToken} />
            </div>
          )
        })}
        <div style={{ paddingLeft: Math.max(0, depth - 1) * INDENT }}>{close}</div>
      </>
    )
  }

  // Leaf. The token is attached to the rendered value, so clicking what you
  // can see is what you get.
  return (
    <Token path={path} onInsertToken={onInsertToken}>
      {typeof value === 'string' ? `"${value}"` : String(value)}
    </Token>
  )
}

export function JsonTokenView({
  value,
  onInsertToken,
}: {
  value: unknown
  onInsertToken: (token: string) => void
}) {
  return (
    <div className="p-4 font-mono text-xs leading-relaxed">
      <Fragment>
        <Node value={value} path="" depth={1} onInsertToken={onInsertToken} />
      </Fragment>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/json-token-view.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/components/flows/ndv/json-token-view.tsx src/components/flows/ndv/__tests__/json-token-view.test.tsx
git commit -m "feat(flows): clickable raw-JSON token view for the NDV input pane"
```

---

## Task 2: Input pane goes raw-only; delete the data trees

**Files:**
- Modify: `src/components/flows/ndv/input-pane.tsx`
- Modify: `src/components/flows/ndv/node-detail-view.tsx` (drop the `dataFields` prop)
- Modify: `src/components/flows/ndv/params-pane.tsx` (drop the pass-through)
- Modify: `src/components/flows/nodes/types.ts:53` (drop `dataFields`)
- Modify: `src/components/flows/nodes/tool-body.tsx` (drop `dataFields`)
- Modify: `src/components/flows/tool-args-editor.tsx:229,296` (drop both `DataTree`s)
- Modify: `src/app/flows/[id]/page.tsx:19,816` (drop `buildDataTree`)
- Delete: `src/components/flows/data-tree.tsx`
- Test: `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`

**Interfaces:**
- Consumes: `JsonTokenView` from Task 1.
- Produces: `InputPane(props: { rawInput?: unknown; onInsertToken: (token: string) => void })` — `dataFields` is gone from the entire prop chain, including `NodeBodyProps`.

- [ ] **Step 1: Update the existing NDV tests**

In `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`, delete `dataFields: []` from `baseProps` and replace the test named `'input pane lists upstream fields and inserts on click'` with:

```tsx
test('input pane shows raw JSON and inserts a token on click', () => {
  let inserted: string | null = null
  const { container } = render(
    <InputPane rawInput={{ trigger: { account: 'acme' } }} onInsertToken={(token) => { inserted = token }} />,
  )
  const leaf = container.querySelector('[data-token="{{trigger.account}}"]') as HTMLElement
  assert.ok(leaf, 'raw JSON is not clickable')
  fireEvent.click(leaf)
  assert.equal(inserted, '{{trigger.account}}')
})

test('input pane offers no Raw/Fields toggle', () => {
  const { queryByText } = render(<InputPane rawInput={{ a: 1 }} onInsertToken={() => {}} />)
  assert.equal(queryByText('Fields'), null, 'the Fields view should be gone')
})

test('input pane explains itself when there is no upstream data', () => {
  const { getByText } = render(<InputPane onInsertToken={() => {}} />)
  getByText(/No upstream data yet/)
})
```

Add `fireEvent` to the `@testing-library/react` import if it is not already there. Delete any other test in the file that passes `dataFields`.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: FAIL — `InputPane` still requires `dataFields` and renders a `<pre>`, so no `[data-token]` element exists.

- [ ] **Step 3: Rewrite the input pane**

Replace the whole body of `src/components/flows/ndv/input-pane.tsx`:

```tsx
'use client'

import { JsonTokenView } from './json-token-view'

/**
 * The NDV's left pane: exactly what this node will receive, as raw JSON.
 * Clicking any value inserts its token at the caret of the last-focused param
 * field; dragging a value drops the braced token into any token editor.
 *
 * There is deliberately no summarised "fields" view — one place to read
 * upstream data, and it shows the real payload.
 */
export function InputPane({
  rawInput,
  onInsertToken,
}: {
  rawInput?: unknown
  onInsertToken: (token: string) => void
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</p>
      </div>
      {rawInput === undefined ? (
        <p className="p-4 text-sm text-muted-foreground">
          No upstream data yet — run the flow once, or pin a step&apos;s output, and the values you can map from will
          appear here.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <JsonTokenView value={rawInput} onInsertToken={onInsertToken} />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Remove the `dataFields` chain**

Make these edits, in this order:

1. `src/components/flows/ndv/node-detail-view.tsx` — delete the `dataFields` prop from the destructure and the type, delete `import type { DataField }`, and change the `<InputPane .../>` call to `<InputPane rawInput={rawInput} onInsertToken={insertToken} />`. Delete `dataFields={dataFields}` from the `<ParamsPane>` call.
2. `src/components/flows/ndv/params-pane.tsx` — no `dataFields` reference remains (it flows via `NodeBodyProps`); nothing to do unless the spread breaks typecheck.
3. `src/components/flows/nodes/types.ts` — delete line 53 (`dataFields?: DataField[]`) and the now-unused `import type { DataField }` on line 4.
4. `src/components/flows/nodes/tool-body.tsx` — delete the `DataField` import, the `dataFields` param and type, `dataFields={dataFields}` on the `<ToolArgsEditor>` call, and `dataFields` from the module's destructure on line 101-102.
5. `src/components/flows/tool-args-editor.tsx` — delete the `DataField` import, the `dataFields` prop from its signature and type, both `<DataTree .../>` elements (lines ~229 and ~296) together with their wrapper elements and any "Available data" heading, the `DataTree` import, and the now-unreachable `insert` helper if nothing else calls it. Leave the placeholder strings mentioning "Available data" reworded to "an upstream value" (lines ~111-113, ~226).
6. `src/app/flows/[id]/page.tsx` — delete the `buildDataTree` import (line 19) and the `dataFields` `useMemo` (around line 816), and the `dataFields={...}` prop on the `<NodeDetailView>` call.
7. Delete `src/components/flows/data-tree.tsx`.
8. Run `grep -rn "dataFields\|DataTree\|buildDataTree" src` and remove every remaining reference. If `src/lib/flows/datatree.ts` has no importers left, delete it; if only its `DataField`/`FieldType` types are still imported, keep the file and delete `buildDataTree`.

- [ ] **Step 5: Run tests and typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: PASS.
Run: `npm run typecheck`
Expected: clean. Any error here is an unremoved `dataFields` reference.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. `src/lib/flows/__tests__/` may have a `buildDataTree` test — delete it if `buildDataTree` is gone.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(flows): raw-JSON input pane replaces the data-field trees"
```

---

## Task 3: Remove the Step type selector

**Files:**
- Modify: `src/components/flows/ndv/step-settings-footer.tsx:26-38`
- Modify: `src/components/flows/ndv/params-pane.tsx:15,46`
- Modify: `src/components/flows/ndv/node-detail-view.tsx` (`onChangeType` prop)
- Modify: `src/components/flows/step-card.tsx:475`
- Modify: `src/app/flows/[id]/page.tsx:12,2197`
- Modify: `src/lib/flows/mutate.ts:260`
- Test: `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `StepSettingsFooter(props: { node, update, tokenWiring })` — no `onChangeType`. `changeNodeType` no longer exists.

- [ ] **Step 1: Write the failing test**

Append to `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`:

```tsx
test('no node type offers a Step type selector — the node IS its type', () => {
  for (const node of NODES) {
    const { container, getByText, unmount } = render(<NodeDetailView node={node} {...baseProps} />)
    fireEvent.click(getByText('Settings'))
    const labels = [...container.querySelectorAll('label')].map((label) => label.textContent)
    assert.equal(labels.includes('Step type'), false, `${node.type} still offers Step type`)
    unmount()
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: FAIL — "still offers Step type".

Note: it may already pass for nodes rendered without `onChangeType`. It must fail for at least one. If every case passes, temporarily add `onChangeType={() => {}}` to `baseProps` to prove the test has teeth, then remove it again.

- [ ] **Step 3: Strip the selector**

Replace `src/components/flows/ndv/step-settings-footer.tsx` entirely:

```tsx
'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { controlClass, labelClass } from '../nodes/field-primitives'
import type { TokenEditorWiring } from '../nodes/types'

/**
 * Per-step notes. The step-type selector that used to live here is gone: a
 * node's type is what the node is, and converting one in place was a rarely
 * correct escape hatch — delete and re-add instead.
 */
export function StepSettingsFooter({
  node,
  update,
  tokenWiring,
}: {
  node: FlowNode
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { blockActive, unblockActive } = tokenWiring
  return (
    <div className="grid gap-1.5">
      <label className={labelClass}>Notes (optional)</label>
      <input
        value={(node.data as { note?: string }).note ?? ''}
        placeholder="Why this step exists, gotchas, links…"
        onFocus={blockActive}
        onBlur={unblockActive}
        onChange={(event) => update({ ...node, data: { ...node.data, note: event.target.value || undefined } } as FlowNode)}
        className={controlClass}
      />
    </div>
  )
}
```

- [ ] **Step 4: Remove `onChangeType` from the chain**

1. `params-pane.tsx` — change the signature to `export function ParamsPane(props: NodeBodyProps)`, delete the `EditableType` import, and call `<StepSettingsFooter node={props.node} update={props.update} tokenWiring={props.tokenWiring} />`.
2. `node-detail-view.tsx` — delete the `onChangeType` prop from the destructure, the type, and the `<ParamsPane>` call. Delete `import type { EditableType }` if unused.
3. `step-card.tsx` — delete the step-type block at line 475 and any `onChangeType` prop it needed.
4. `page.tsx` — delete `onChangeType={...}` at line 2197 and `changeNodeType` from the `@/lib/flows/mutate` import on line 12.
5. `mutate.ts` — delete the `changeNodeType` function at line 260.
6. `grep -rn "changeNodeType\|onChangeType" src` must return nothing outside deleted tests. Delete any test that covered `changeNodeType`.

- [ ] **Step 5: Run tests and typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(flows): drop the step-type selector — a node is its type"
```

---

## Task 4: Execution policy moves to the Settings tab

**Files:**
- Modify: `src/components/flows/ndv/params-pane.tsx`
- Modify: `src/components/flows/nodes/agent-body.tsx:8,227`
- Modify: `src/components/flows/nodes/code-body.tsx:5,91`
- Modify: `src/components/flows/nodes/loop-body.tsx:7,59`
- Modify: `src/components/flows/nodes/tool-body.tsx:9,94`
- Modify: `src/components/flows/nodes/http-body.tsx:23,523`
- Test: `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`

**Interfaces:**
- Consumes: `StepSettingsFooter` from Task 3.
- Produces: nothing new. `AdvancedParamsSection` and `HttpOptionsSection` keep their current exported signatures; only their call sites move.

- [ ] **Step 1: Write the failing test**

Append to `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`:

```tsx
test('execution policy lives in Settings, never in Parameters', () => {
  const agent = { id: 'a1', type: 'agent', data: { agentId: '' } } as FlowNode
  const { container, getByText } = render(<NodeDetailView node={agent} {...baseProps} />)
  const inParams = container.textContent ?? ''
  assert.equal(inParams.includes('Advanced parameters'), false, 'policy is still on the Parameters tab')
  fireEvent.click(getByText('Settings'))
  getByText('Advanced parameters')
})

test('the HTTP node keeps its Options panel, and it is in Settings', () => {
  const http = { id: 'h1', type: 'http', data: { method: 'GET', url: 'https://api/x' } } as FlowNode
  const { container, getByText } = render(<NodeDetailView node={http} {...baseProps} />)
  assert.equal((container.textContent ?? '').includes('Add option'), false, 'Options is still on Parameters')
  fireEvent.click(getByText('Settings'))
  getByText('Options')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: FAIL — "policy is still on the Parameters tab".

- [ ] **Step 3: Move the sections**

Replace the Settings branch of `src/components/flows/ndv/params-pane.tsx`. The whole file becomes:

```tsx
'use client'

import { useState } from 'react'
import type { FlowNode } from '@/lib/flows/graph'
import { NODE_BODIES } from '../nodes/registry'
import type { NodeBodyProps } from '../nodes/types'
import { MissingFields } from '../nodes/missing-fields'
import { AdvancedParamsSection } from '../advanced-params'
import { HttpOptionsSection } from '../nodes/http-options'
import { StepSettingsFooter } from './step-settings-footer'

type HttpNode = Extract<FlowNode, { type: 'http' }>

/**
 * The middle pane. Parameters holds only what the step DOES; Settings holds
 * notes plus execution policy (retries, timeout, on-error, mock output) —
 * previously an accordion crammed into four different node bodies, and a
 * parallel "Options" panel on the HTTP node.
 */
export function ParamsPane(props: NodeBodyProps) {
  const { Body } = NODE_BODIES[props.node.type]
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters')
  const tabClass = (active: boolean) =>
    active
      ? 'border-b-2 border-rose-500 px-3 py-3 text-sm font-semibold text-foreground'
      : 'px-3 py-3 text-sm font-semibold text-muted-foreground'
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex border-b border-border bg-card px-4">
        <button type="button" onClick={() => setTab('parameters')} className={tabClass(tab === 'parameters')}>
          Parameters
        </button>
        <button type="button" onClick={() => setTab('settings')} className={tabClass(tab === 'settings')}>
          Settings
        </button>
      </div>
      {tab === 'parameters' ? (
        <>
          <MissingFields node={props.node} />
          <div className="p-4">
            <Body {...props} />
          </div>
        </>
      ) : (
        <div className="grid gap-4 p-4">
          {props.node.type !== 'trigger' && (
            <StepSettingsFooter node={props.node} update={props.update} tokenWiring={props.tokenWiring} />
          )}
          {props.node.type === 'http' ? (
            <HttpOptionsSection node={props.node as HttpNode} onChange={props.update} />
          ) : (
            <AdvancedParamsSection node={props.node} onChange={props.update} defaultOpen />
          )}
        </div>
      )}
    </div>
  )
}
```

Note: `AdvancedParamsSection` already returns `null` when the node type has no advanced keys (`advanced-params.tsx:30`), so the trigger node needs no special case beyond the notes guard.

- [ ] **Step 4: Remove the inline call sites**

In each of `agent-body.tsx`, `code-body.tsx`, `loop-body.tsx`, `tool-body.tsx`: delete the `<AdvancedParamsSection node={node} onChange={update} />` line and the `import { AdvancedParamsSection } from '../advanced-params'`.

In `http-body.tsx`: delete `<HttpOptionsSection node={node} onChange={update} tokenWiring={tokenWiring} />` (line 523) and the `import { HttpOptionsSection } from './http-options'` (line 23).

Then `grep -rn "AdvancedParamsSection\|HttpOptionsSection" src` should show only `params-pane.tsx`, the two definition files, and their tests.

- [ ] **Step 5: Run tests and typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: clean. `src/components/flows/__tests__/http-options-body.test.tsx` renders `HttpOptionsSection` directly and should be unaffected; if it renders the whole `HttpBody` expecting Options inside it, update it to render `ParamsPane` and click Settings.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(flows): execution policy moves from node bodies to the Settings tab"
```

---

## Task 5: Container children inside the NDV

**Files:**
- Create: `src/lib/flows/containers.ts`
- Create: `src/components/flows/nodes/container-children.tsx`
- Create: `src/components/flows/nodes/__tests__/container-children.test.tsx`
- Modify: `src/components/flows/dag-canvas.tsx:62-88` (import the lifted helpers instead of defining them)
- Modify: `src/components/flows/nodes/types.ts` (add container props to `NodeBodyProps`)
- Modify: `src/components/flows/nodes/loop-body.tsx`, `parallel-body.tsx`, `repeat-until-body.tsx`, `error-shield-body.tsx`
- Modify: `src/components/flows/ndv/node-detail-view.tsx` (thread the new props)
- Modify: `src/app/flows/[id]/page.tsx` (supply them)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function ContainerChildren(props: { node: FlowNode; graph: FlowGraph; labelOf: (node: FlowNode) => string; issuesByNode?: Record<string, StepCardIssues>; readOnly?: boolean; branchIndex?: number; onOpenNode?: (id: string) => void; onChangeNode: (node: FlowNode) => void; onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void }): ReactNode`
  - `export type StepCardIssues = React.ComponentProps<typeof StepCard>['issues']` from the same file.
  - Five new optional fields on `NodeBodyProps`: `graph?: FlowGraph`, `labelOf?: (node: FlowNode) => string`, `issuesByNode?: Record<string, StepCardIssues>`, `onOpenNode?: (id: string) => void`, `onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void`. Task 6 relies on these existing.
  - `src/lib/flows/containers.ts` exporting `containerChildIds`, `isContainerNode`, `siblingsOf`.

- [ ] **Step 1: Write the failing test**

Create `src/components/flows/nodes/__tests__/container-children.test.tsx`:

```tsx
/**
 * Child reordering used to live in the canvas side-panel that Task 6 deletes.
 * These tests are the contract that the capability survived the move.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ContainerChildren } from '../container-children'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

afterEach(() => cleanup())

const LOOP = { id: 'loop1', type: 'loop', data: { over: '{{trigger.input}}', body: ['a', 'b'] } } as FlowNode
const CHILD_A = { id: 'a', type: 'http', data: { method: 'GET', url: 'https://a' } } as FlowNode
const CHILD_B = { id: 'b', type: 'http', data: { method: 'GET', url: 'https://b' } } as FlowNode
const GRAPH = { nodes: [LOOP, CHILD_A, CHILD_B], edges: [] } as unknown as FlowGraph

const base = {
  node: LOOP,
  graph: GRAPH,
  labelOf: (node: FlowNode) => node.id.toUpperCase(),
  onChangeNode: () => {},
}

test('lists every child of the container', () => {
  const { getByText } = render(<ContainerChildren {...base} />)
  getByText('A')
  getByText('B')
})

test('dropping one child on a sibling reports the reorder', () => {
  let call: unknown = null
  const { getByTestId } = render(
    <ContainerChildren {...base} onReorderContainer={(...args) => { call = args }} />,
  )
  const target = getByTestId('container-child-b')
  fireEvent.dragOver(target, { dataTransfer: { getData: () => 'a', dropEffect: '' } })
  fireEvent.drop(target, { dataTransfer: { getData: () => 'a' } })
  assert.deepEqual(call, ['loop1', 0, 1, undefined])
})

test('a non-container node renders nothing', () => {
  const { container } = render(<ContainerChildren {...base} node={CHILD_A} />)
  assert.equal(container.firstChild, null)
})

test('clicking a child opens that child', () => {
  let opened: string | null = null
  const { getByText } = render(<ContainerChildren {...base} onOpenNode={(id) => { opened = id }} />)
  fireEvent.click(getByText('B'))
  assert.equal(opened, 'b')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/container-children.test.tsx`
Expected: FAIL — cannot find module `../container-children`.

- [ ] **Step 3: Lift the container helpers into a shared module**

`containerChildIds`, `isContainerNode`, and `siblingsOf` are currently **local functions inside `dag-canvas.tsx`** (lines 62-88), not shared exports. Two components need them now, so move them verbatim into a new `src/lib/flows/containers.ts`:

```ts
import type { FlowNode } from './graph'

/** The child ids a container owns — mirrors auto-layout/interpreter `contained`. */
export function containerChildIds(node: FlowNode): string[] {
  return node.type === 'loop' || node.type === 'repeatUntil' ? node.data.body
    : node.type === 'parallel' ? node.data.branches.flat()
    : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
    : []
}

export const isContainerNode = (node: FlowNode) =>
  node.type === 'loop' || node.type === 'repeatUntil' || node.type === 'parallel' || node.type === 'errorShield'

/**
 * The sibling list a contained id can be reordered WITHIN, and the branch marker
 * `onReorderContainer` expects. Mirrors the stack canvas exactly: a parallel
 * branch reorders only within its own branch array, and an errorShield's
 * fallback list is marked with branchIndex -1 (insertIntoContainer's convention).
 */
export function siblingsOf(container: FlowNode, childId: string): { list: string[]; branchIndex?: number } {
  if (container.type === 'loop' || container.type === 'repeatUntil') return { list: container.data.body }
  if (container.type === 'parallel') {
    const branchIndex = container.data.branches.findIndex((branch) => branch.includes(childId))
    return { list: branchIndex >= 0 ? container.data.branches[branchIndex] : [], branchIndex: branchIndex >= 0 ? branchIndex : undefined }
  }
  if (container.type === 'errorShield') {
    return container.data.body.includes(childId) ? { list: container.data.body } : { list: container.data.fallback, branchIndex: -1 }
  }
  return { list: [] }
}
```

Then delete those three definitions from `dag-canvas.tsx` and add `import { containerChildIds, isContainerNode, siblingsOf } from '@/lib/flows/containers'`. Run `npm run typecheck` — it must be clean before continuing.

- [ ] **Step 4: Write the component**

Read `src/components/flows/dag-canvas.tsx:347-421` first — the drag/drop logic below is lifted from it, including the same-list constraint.

Create `src/components/flows/nodes/container-children.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { containerChildIds, isContainerNode, siblingsOf } from '@/lib/flows/containers'
import { StepCard } from '../step-card'

/** `NodeIssues` is a local alias in dag-canvas, so borrow StepCard's own type. */
export type StepCardIssues = React.ComponentProps<typeof StepCard>['issues']

/**
 * A container's children, listed and drag-reorderable, inside the NDV.
 *
 * This moved out of the canvas side-panel when a click started opening the
 * NDV directly: it was the one thing that panel could do that the NDV could
 * not, and dropping it would have silently removed reordering.
 */
export function ContainerChildren({
  node,
  graph,
  labelOf,
  issuesByNode,
  readOnly = false,
  onOpenNode,
  onChangeNode,
  onReorderContainer,
}: {
  node: FlowNode
  graph: FlowGraph
  labelOf: (node: FlowNode) => string
  issuesByNode?: Record<string, StepCardIssues>
  readOnly?: boolean
  onOpenNode?: (id: string) => void
  onChangeNode: (node: FlowNode) => void
  onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const byId = useMemo(() => new Map(graph.nodes.map((entry) => [entry.id, entry])), [graph.nodes])
  if (!isContainerNode(node)) return null

  const children = containerChildIds(node)
    .map((id) => byId.get(id))
    .filter((child): child is FlowNode => Boolean(child))
  if (children.length === 0) return null

  return (
    <div className="space-y-2 rounded-2xl border border-dashed border-border bg-card/70 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Steps inside</p>
      {children.map((child) => {
        const { list, branchIndex } = siblingsOf(node, child.id)
        return (
          <div
            key={child.id}
            data-testid={`container-child-${child.id}`}
            draggable={!readOnly}
            onDragStart={(event) => {
              setDragId(child.id)
              event.dataTransfer.setData('text/flow-node-id', child.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(event) => {
              // Only a sibling from the SAME list may drop here — a parallel
              // branch never reorders into another branch.
              const dragged = dragId ?? event.dataTransfer.getData('text/flow-node-id')
              if (dragged && dragged !== child.id && list.includes(dragged)) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }
            }}
            onDrop={(event) => {
              const dragged = event.dataTransfer.getData('text/flow-node-id')
              if (dragged && dragged !== child.id && list.includes(dragged)) {
                event.preventDefault()
                onReorderContainer?.(node.id, list.indexOf(dragged), list.indexOf(child.id), branchIndex)
              }
              setDragId(null)
            }}
            className={cn('rounded-xl transition-opacity', dragId === child.id && 'opacity-50')}
          >
            <StepCard
              node={child}
              title={labelOf(child)}
              issues={issuesByNode?.[child.id]}
              selected={false}
              labelCtx={{} as never}
              draggable={!readOnly}
              onChange={readOnly ? () => {} : onChangeNode}
              onClick={() => onOpenNode?.(child.id)}
              onOpen={!readOnly && onOpenNode ? () => onOpenNode(child.id) : undefined}
            />
          </div>
        )
      })}
    </div>
  )
}
```

If `containerChildIds`, `isContainerNode`, or `siblingsOf` are not exported from `@/lib/flows/graph`, copy the import specifiers exactly as `dag-canvas.tsx` has them.

- [ ] **Step 5: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/container-children.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Render it in the container bodies**

Add these three optional fields to `NodeBodyProps` in `src/components/flows/nodes/types.ts`, importing `FlowGraph` from `@/lib/flows/graph` and reusing `StepCardIssues` exported from `container-children.tsx`:

```ts
  /** Container bodies list and reorder their children; absent elsewhere. */
  graph?: FlowGraph
  labelOf?: (node: FlowNode) => string
  issuesByNode?: Record<string, StepCardIssues>
  onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void
  onOpenNode?: (id: string) => void
```

In each of `loop-body.tsx`, `parallel-body.tsx`, `repeat-until-body.tsx`, `error-shield-body.tsx`, render `<ContainerChildren>` immediately **above** the existing `<AddStepMenu>`, passing the props through from `NodeBodyProps`. In `loop-body.tsx` that means the module's `Body` gains the new props and the inner component renders:

```tsx
      {graph && labelOf && (
        <ContainerChildren
          node={node}
          graph={graph}
          labelOf={labelOf}
          issuesByNode={issuesByNode}
          onOpenNode={onOpenNode}
          onChangeNode={update}
          onReorderContainer={onReorderContainer}
        />
      )}
      {onAddStep && <AddStepMenu label="Add step to loop" onPick={onAddStep} />}
```

For `parallel-body.tsx`, pass the branch's `branchIndex` through to `onReorderContainer` exactly as the body already does for `onAddStep`.

- [ ] **Step 7: Thread the props from the page**

In `src/components/flows/ndv/node-detail-view.tsx`, accept `graph`, `labelOf`, `issuesByNode`, `onReorderContainer`, and `onOpenNode` and spread them into `<ParamsPane>`.

In `src/app/flows/[id]/page.tsx`, pass them on the `<NodeDetailView>` call. `onReorderContainer` uses the existing handler the `<DagCanvas>` already receives (search for `moveContainerStep`), `labelOf` reuses the canvas's `(node) => labelCtx.stepLabels[node.id] || defaultStepLabel(node)`, and `onOpenNode` is `openNdv`.

- [ ] **Step 8: Run tests, typecheck, commit**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/container-children.test.tsx
npm run typecheck && npm test
git add -A
git commit -m "feat(flows): container children move into the NDV with drag-reorder intact"
```

---

## Task 6: One click opens the NDV; delete NodeConfigPanel

**Files:**
- Modify: `src/components/flows/step-card.tsx:244-251`
- Modify: `src/components/flows/dag-canvas.tsx` (delete `NodeConfigPanel` at 318-425 and its render at 741-756)
- Modify: `src/components/flows/flow-canvas.tsx:354-355`
- Modify: `src/app/flows/[id]/page.tsx`
- Test: `src/components/flows/__tests__/canvas-open-node.test.tsx` (create)

**Interfaces:**
- Consumes: `ContainerChildren` must already be rendering inside the NDV (Task 5) — this task removes the only other place children could be reordered.
- Produces: `StepCard` invokes `onOpen` on a single click; `onClick` remains for the container-child case where no `onOpen` is supplied.

- [ ] **Step 1: Write the failing test**

Create `src/components/flows/__tests__/canvas-open-node.test.tsx`:

```tsx
/**
 * A click used to select a node, which rendered a side panel whose only real
 * content was a button that opened the real config surface. One click now
 * goes straight there.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { StepCard } from '../step-card'
import type { FlowNode } from '@/lib/flows/graph'

afterEach(() => cleanup())

const NODE = { id: 'h1', type: 'http', data: { method: 'GET', url: 'https://api/x' } } as FlowNode

test('a single click opens the node', () => {
  let opened = false
  const { getByRole } = render(
    <StepCard node={NODE} title="Http" selected={false} labelCtx={{} as never}
      onChange={() => {}} onClick={() => {}} onOpen={() => { opened = true }} />,
  )
  fireEvent.click(getByRole('button', { name: /Http/ }))
  assert.equal(opened, true, 'a single click did not open the node')
})

test('without an open handler a click still reports the click', () => {
  let clicked = false
  const { getByRole } = render(
    <StepCard node={NODE} title="Http" selected={false} labelCtx={{} as never}
      onChange={() => {}} onClick={() => { clicked = true }} />,
  )
  fireEvent.click(getByRole('button', { name: /Http/ }))
  assert.equal(clicked, true)
})
```

If `getByRole('button', { name: /Http/ })` is ambiguous because the card contains nested buttons, select the root with `container.querySelector('[role="button"]')` instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/canvas-open-node.test.tsx`
Expected: FAIL — "a single click did not open the node".

- [ ] **Step 3: Make a click open**

In `src/components/flows/step-card.tsx`, replace the root handlers at lines 244-251:

```tsx
      onClick={(event) => {
        event.stopPropagation()
        // One click IS "open" — the old select-then-open two-step existed only
        // to feed a preview panel that no longer exists.
        ;(onOpen ?? onClick)?.()
      }}
```

Delete the `onDoubleClick` handler entirely. Line 203's `if (event.key === 'Enter') (onOpen ?? onClick)?.()` already matches this behavior and stays.

- [ ] **Step 4: Delete NodeConfigPanel**

In `src/components/flows/dag-canvas.tsx`:
1. Delete the `NodeConfigPanel` function (lines 318-425).
2. Delete its render block (lines 741-756) and the `panelNode` computation that fed it.
3. Delete now-unused imports (`StepCard`, `containerChildIds`, `isContainerNode`, `siblingsOf`, `AddStepMenu`) — keep any that other code in the file still uses.
4. `DagCanvas` keeps `selectedId`/`onSelect` for the selection ring, but the node's own click handler now calls `onOpenNode`. At line 370 and 414 the `onOpen` prop is already wired; make sure `onClick` no longer competes with it.

In `src/components/flows/flow-canvas.tsx:354-355`, the card already receives both `onClick={() => onSelect(node.id)}` and `onOpen`. Leave both — `StepCard` now prefers `onOpen`.

- [ ] **Step 5: Run tests and typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/canvas-open-node.test.tsx`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: clean. Any dag-canvas test asserting the panel renders must be deleted — the panel is gone by design.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(flows): a click opens the node config; the preview panel is gone"
```

---

## Task 7: Rebind the node shortcuts to the open node

**Files:**
- Modify: `src/app/flows/[id]/page.tsx:707-752`
- Modify: `src/components/flows/ndv/node-detail-view.tsx` (header Delete/Duplicate)
- Test: `src/app/flows/__tests__/node-shortcuts.test.tsx` (create) — or extend the NDV test file if a page-level render is impractical

**Interfaces:**
- Consumes: the NDV from Task 6.
- Produces: `NodeDetailView` accepts `onDeleteNode?: () => void` and `onDuplicateNode?: () => void`, rendering a Delete and a Duplicate button in its header when supplied.

- [ ] **Step 1: Write the failing test**

Append to `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`:

```tsx
test('the NDV header offers Delete and Duplicate when the page supplies them', () => {
  let deleted = false
  let duplicated = false
  const { getByLabelText } = render(
    <NodeDetailView node={NODES[0]} {...baseProps}
      onDeleteNode={() => { deleted = true }} onDuplicateNode={() => { duplicated = true }} />,
  )
  fireEvent.click(getByLabelText('Duplicate step'))
  assert.equal(duplicated, true)
  fireEvent.click(getByLabelText('Delete step'))
  assert.equal(deleted, true)
})

test('the trigger cannot be deleted from the NDV header', () => {
  const trigger = { id: 'trigger', type: 'trigger', data: {} } as FlowNode
  const { queryByLabelText } = render(
    <NodeDetailView node={trigger} {...baseProps} onDeleteNode={() => {}} />,
  )
  assert.equal(queryByLabelText('Delete step'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: FAIL — `getByLabelText('Duplicate step')` finds nothing.

- [ ] **Step 3: Add the header actions**

In `src/components/flows/ndv/node-detail-view.tsx`, accept `onDeleteNode?: () => void` and `onDuplicateNode?: () => void`, and add to the header row (before the close button), importing `Copy` and `Trash2` from `lucide-react`:

```tsx
          {onDuplicateNode && node.type !== 'trigger' && (
            <button type="button" onClick={onDuplicateNode} aria-label="Duplicate step"
              className="text-muted-foreground hover:text-foreground">
              <Copy className="h-4 w-4" />
            </button>
          )}
          {onDeleteNode && node.type !== 'trigger' && (
            <button type="button" onClick={onDeleteNode} aria-label="Delete step"
              className="text-muted-foreground hover:text-red-600">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
```

- [ ] **Step 4: Rebind the keyboard handler**

In `src/app/flows/[id]/page.tsx`, in the `onKey` effect at lines 707-752, replace every use of `selectedId` and `selectedNode` with the open node. Add above the effect:

```tsx
  // Shortcuts follow the OPEN node now that a click opens the NDV directly —
  // there is no selected-but-unopened state left for them to act on.
  const openNode = ndvNode
```

Then inside `onKey`:
- Delete/Backspace branch: `if (openNode && openNode.id !== 'trigger') { e.preventDefault(); commitGraph(deleteNode(graph, openNode.id)); setNdvNodeId(null); toast.success('Step deleted — ⌘Z to undo.') }`
- ⌘C branch: `if (openNode && openNode.type !== 'trigger') { e.preventDefault(); writeFlowClipboard(openNode); toast.success('Step copied.') }`
- ⌘V branch: `const afterId = openNode && openNode.id !== 'trigger' ? openNode.id : ids[ids.length - 1] ?? 'trigger'`, and after pasting call `openNdv(nodeId)` instead of `setSelectedId(nodeId)`.
- Keep the `INPUT`/`TEXTAREA`/`SELECT`/`isContentEditable` guard at the top exactly as it is. Without it, Backspace inside a token chip editor deletes the whole step.
- Update the dependency array to `[undo, redo, openNode, graph, commitGraph, viewingVersion, openNdv]`.

Wire the header actions on the `<NodeDetailView>` call:

```tsx
          onDeleteNode={() => {
            commitGraph(deleteNode(graph, ndvNode.id))
            setNdvNodeId(null)
            toast.success('Step deleted — ⌘Z to undo.')
          }}
          onDuplicateNode={() => {
            const { graph: next, nodeId } = duplicateNode(graph, ndvNode.id)
            commitGraph(next)
            openNdv(nodeId)
          }}
```

Check `duplicateNode`'s real return shape in `src/lib/flows/mutate.ts` before writing this — if it returns a bare `FlowGraph`, drop the destructure and leave the NDV on the original node.

- [ ] **Step 5: Run tests and typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Manual verification**

Start the app (`npm run dev`), open a flow, and confirm: clicking a step opens the NDV; Backspace inside a URL field edits text rather than deleting the step; Backspace with the NDV open and no field focused deletes the step; ⌘Z restores it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(flows): node shortcuts and header actions follow the open node"
```

---

## Task 8: Extract the shared CredentialPicker

**Files:**
- Create: `src/components/credentials/credential-picker.tsx`
- Modify: `src/components/flows/nodes/http-body.tsx` (remove lines 318-392 and 525-552, plus the state and fetch they needed)
- Test: `src/components/flows/__tests__/http-curl-auth.test.tsx` — **must pass unmodified**

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
```ts
export function CredentialPicker(props: {
  value?: string
  type: CredentialType
  onChange: (credentialId: string | undefined, type: CredentialType) => void
  /** URL the verify probe hits, and the domain the list is filtered by. */
  verifyAgainst?: string
  context: 'http' | 'mcp'
}): ReactNode
```
Task 9 consumes this.

- [ ] **Step 1: Confirm the safety net passes today**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/http-curl-auth.test.tsx`
Expected: PASS. This is a pure refactor — that file is the proof, and it must not be edited in this task. Note the count of passing tests.

- [ ] **Step 2: Create the picker**

Create `src/components/credentials/credential-picker.tsx` by moving, verbatim in behavior, from `src/components/flows/nodes/http-body.tsx`: the `ListedCredential` type (lines 26-34), `hostnameOf` and `domainMatches` (43-58), the `credentials` state and `loadCredentials` callback (160-175), the `credentialModal` state (162), `selectedCredential`/`credentialType`/`compatibleCredentials` (181-186), `startCredentialDraft` (215-220), the whole `authMode === 'generic'` JSX block (319-391), and the `<Dialog>` (525-552).

The component's shell:

```tsx
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, KeyRound, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TYPE_LABELS, draftFromRedacted, emptyDraft, type CredentialDraft } from '@/lib/credentials/form'
import { CREDENTIAL_TYPES, type CredentialType, type RedactedCredential } from '@/lib/credentials/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SearchableSelect } from '@/components/flows/searchable-select'
import { CredentialHealth } from '@/components/flows/nodes/credential-health'
import { CredentialEditor } from './credential-editor'
import type { VerificationView } from '@/components/flows/nodes/verification-badge'

/**
 * Choose, create, verify, or repair a stored credential — the one surface for
 * all of it, so every consumer gets domain filtering, health, and in-place
 * editing rather than a detour to Settings.
 *
 * Extracted from the HTTP node body unchanged; http-curl-auth.test.tsx is the
 * contract that the extraction changed no behavior.
 */
export function CredentialPicker({ value, type, onChange, verifyAgainst, context }: {
  value?: string
  type: CredentialType
  onChange: (credentialId: string | undefined, type: CredentialType) => void
  verifyAgainst?: string
  context: 'http' | 'mcp'
}) {
  // …moved body…
}
```

Behavior notes to preserve exactly:
- The type `<select>` calls `onChange(undefined, nextType)` — changing the type clears the chosen credential, as `http-body.tsx:326-329` does today.
- `hostnameOf(verifyAgainst ?? '')` drives both the list filter and the seeded credential name.
- The dialog's `onSaved` calls `onChange(credential.id, credential.type as CredentialType)` and then refetches the list — do not splice the returned row in; only the list endpoint carries the redacted config and verification state the picker renders.
- Keep the trailing explanatory paragraph ("Credentials are encrypted, scoped to your account by default…").

- [ ] **Step 3: Make http-body consume it**

In `src/components/flows/nodes/http-body.tsx`, replace the `authMode === 'generic'` block with:

```tsx
        {authMode === 'generic' && (
          <CredentialPicker
            value={node.data.credentialId}
            type={credentialType}
            verifyAgainst={node.data.url}
            context="http"
            onChange={(credentialId, credentialType) =>
              patch({ authMode: 'generic', credentialId, credentialType })}
          />
        )}
```

Then delete from that file: the `ListedCredential` type, `hostnameOf`, `domainMatches`, `credentials`/`credentialModal` state, `loadCredentials`, the `useEffect` that calls it, `selectedCredential`, `compatibleCredentials`, `startCredentialDraft`, the `<Dialog>` block, and every import that only they used (`SearchableSelect`, `CredentialHealth`, `Dialog*`, `CredentialEditor`, `KeyRound`, `Pencil`, `draftFromRedacted`, `emptyDraft`, `CredentialDraft`, `RedactedCredential`, `VerificationView`, `CREDENTIAL_TYPES`). Keep `credentialType` — it is still computed from `node.data.credentialType ?? 'basic'` — and keep `TYPE_LABELS` only if something else in the file still uses it.

- [ ] **Step 4: Run the safety net**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/http-curl-auth.test.tsx`
Expected: PASS with the same test count as Step 1, **with the test file unmodified**. If a test fails on a missing `aria-label`, the extraction dropped one — restore it in the picker rather than editing the test.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "refactor(credentials): extract the shared CredentialPicker from the HTTP node"
```

---

## Task 9: Back MCP api_key auth with a stored Credential

**Files:**
- Create: `src/lib/mcp/connection-credential.ts`
- Create: `src/lib/mcp/__tests__/connection-credential.test.ts`
- Modify: `src/lib/mcp/mcp-client.ts` (`McpClientConfig`, `rpc`)
- Modify: `src/features/agents/tool-planes.ts:154-155,490-491`
- Modify: `src/features/flows/http-auth.ts` (its client construction)
- Modify: `src/components/connections/mcp-connection-dialog.tsx`
- Modify: `src/app/api/mcp-connections/route.ts`

**Interfaces:**
- Consumes: `CredentialPicker` from Task 8; `resolveCredential` from `src/lib/credentials/resolve.ts`; `applyCredentialPlan` from `src/lib/credentials/apply.ts`.
- Produces: `export async function mcpCredentialPlan(conn: { serverUrl: string; authType: string; authConfig: unknown }, ctx: { organizationId: string; userId?: string }): Promise<InjectionPlan | undefined>`.

**Why this shape:** `mcpConfigFromConnection` (`mcp-client.ts:449`) is synchronous and pure, and resolving a credential needs a database read — so resolution happens beside it, at the three call sites that already have an `organizationId`, and rides into the client as a `credentialPlan`. `applyCredentialPlan` then handles headers *and* query with the same user-value-wins precedence the HTTP path uses.

**No data migration:** rows storing `{ apiKey, headerName }` inline keep working through the untouched `authHeaders()` path. Only newly saved rows use `{ credentialId }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mcp/__tests__/connection-credential.test.ts`:

```ts
/**
 * An MCP server authenticated by a stored credential must produce the same
 * outbound header a per-connection api_key produced, and must never leak the
 * secret when the credential is missing or the domain is not allowed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpCredentialPlan } from '../connection-credential'

const CTX = { organizationId: 'org1', userId: 'user1' }

test('a connection with no credentialId resolves to no plan', async () => {
  const plan = await mcpCredentialPlan(
    { serverUrl: 'https://mcp.example.com', authType: 'api_key', authConfig: { apiKey: 'enc', headerName: 'X-Key' } },
    CTX,
  )
  assert.equal(plan, undefined)
})

test('a non api_key connection resolves to no plan', async () => {
  const plan = await mcpCredentialPlan(
    { serverUrl: 'https://mcp.example.com', authType: 'oauth2', authConfig: { credentialId: 'c1' } },
    CTX,
  )
  assert.equal(plan, undefined)
})

test('a malformed authConfig resolves to no plan rather than throwing', async () => {
  for (const authConfig of [null, 'nope', [], undefined]) {
    const plan = await mcpCredentialPlan(
      { serverUrl: 'https://mcp.example.com', authType: 'api_key', authConfig },
      CTX,
    )
    assert.equal(plan, undefined)
  }
})
```

The resolving-a-real-credential case needs a database and belongs with the route-smoke suite — see Step 6.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/mcp/__tests__/connection-credential.test.ts`
Expected: FAIL — cannot find module `../connection-credential`.

- [ ] **Step 3: Write the resolver**

Create `src/lib/mcp/connection-credential.ts`:

```ts
/**
 * Resolve an MCP connection's stored-credential reference into an injection
 * plan.
 *
 * A connection may authenticate either with its own encrypted api_key blob
 * (the original form, still supported) or by pointing at a vault Credential —
 * `authConfig: { credentialId }`. The vault form is what lets one saved API key
 * serve several MCP servers and HTTP steps instead of being retyped per row.
 *
 * Kept out of mcpConfigFromConnection deliberately: that function is pure and
 * synchronous, and this one reads the database.
 */
import { resolveCredential } from '@/lib/credentials/resolve'
import type { InjectionPlan } from '@/lib/credentials/types'

export async function mcpCredentialPlan(
  conn: { serverUrl: string; authType: string; authConfig: unknown },
  ctx: { organizationId: string; userId?: string },
): Promise<InjectionPlan | undefined> {
  if (conn.authType !== 'api_key') return undefined
  const stored =
    conn.authConfig && typeof conn.authConfig === 'object' && !Array.isArray(conn.authConfig)
      ? (conn.authConfig as Record<string, unknown>)
      : {}
  const credentialId = typeof stored.credentialId === 'string' ? stored.credentialId.trim() : ''
  if (!credentialId) return undefined

  // resolveCredential enforces org scope and the credential's own domain
  // allow-list against this URL, then decrypts. It throws on either failure —
  // and it should: silently calling an MCP server unauthenticated would look
  // like a server-side permission bug to the user.
  return resolveCredential({
    credentialId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    requestUrl: conn.serverUrl,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/mcp/__tests__/connection-credential.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Carry the plan into the client**

In `src/lib/mcp/mcp-client.ts`:

1. Add to `McpClientConfig` (after `headerName`, around line 27):

```ts
  /**
   * Headers/query contributed by a vault Credential backing this connection.
   * Applied with user-value-wins precedence, exactly as the HTTP node does.
   */
  credentialPlan?: InjectionPlan
```
with `import type { InjectionPlan } from '@/lib/credentials/types'` and `import { applyCredentialPlan } from '@/lib/credentials/apply'`.

2. In `rpc()` (around line 320), after `headers` is assembled and before the fetch, apply the plan and use its rewritten URL:

```ts
    const injected = this.config.credentialPlan
      ? applyCredentialPlan(serverUrl, headers, this.config.credentialPlan)
      : { url: serverUrl, headers }
```

Then use `injected.url` and `injected.headers` for the request. Search the rest of `rpc()` for other uses of `serverUrl` in the fetch call and switch them over; leave `this.sessionIds` keyed by the original `serverUrl` so a query-injected URL does not fragment session tracking.

3. Leave `authHeaders()` untouched — an `api_key` connection with no inline `apiKey` already returns `{}`, which is exactly right when the plan supplies the header.

In `src/features/agents/tool-planes.ts` at both client construction sites (lines 154-155 and 490-491) and in `src/features/flows/http-auth.ts`, change the config to:

```ts
    const config = {
      ...mcpConfigFromConnection(fresh),
      credentialPlan: await mcpCredentialPlan(fresh, { organizationId, userId }),
    }
```

Each site already has `organizationId` in scope; `http-auth.ts` may need `userId` threaded from its params — check its signature and pass it if available, otherwise omit it (org-shared credentials still resolve).

- [ ] **Step 6: Add the end-to-end route-smoke test**

Read the `verify` skill first — deploy migrations to the throwaway Postgres before trusting failures.

Add to `src/app/api/__tests__/credentials-route-smoke.test.ts` a case that creates a `Credential` of type `apiKeyHeader` and an `McpConnection` with `authType: 'api_key'` and `authConfig: { credentialId }`, then asserts `mcpCredentialPlan` returns `{ headers: { <headerName>: <key> } }`. Add a second case asserting it throws `CREDENTIAL_DOMAIN_BLOCKED` when the credential's `allowedDomains` excludes the server host.

- [ ] **Step 7: Wire the dialog**

In `src/components/connections/mcp-connection-dialog.tsx`, replace the `draft.authType === 'api_key'` block (around line 311) with `<CredentialPicker type="apiKeyHeader" value={draft.credentialId} verifyAgainst={draft.serverUrl} context="mcp" onChange={(credentialId) => set({ credentialId })} />`. Drop `apiKey` and `headerName` from the draft type and its initial value (lines 20-21, 56-57, 104-105), and from the payload built at lines 183-185 — send `credentialId` instead.

In `src/app/api/mcp-connections/route.ts`, accept `credentialId` on create and update and persist `authConfig: { credentialId }` when `authType === 'api_key'`. Keep the existing `apiKey`/`headerName` branch so older clients and existing rows keep working; validate that the referenced credential is in the caller's org before saving.

- [ ] **Step 8: Run everything**

```bash
npm run typecheck && npm test
```
Expected: clean.

- [ ] **Step 9: Manual verification**

Add an MCP server with API-key auth, choosing a stored credential; confirm the connection verifies, its actions list, and a flow tool step using it runs. Then confirm an existing inline-api_key connection still works untouched.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(mcp): api-key connections can be backed by a reusable stored credential"
```

---

## Final Verification

- [ ] `npm run typecheck && npm run lint && npm test` all pass.
- [ ] `grep -rn "dataFields\|DataTree\|changeNodeType\|NodeConfigPanel" src` returns nothing.
- [ ] `grep -rn "AdvancedParamsSection\|HttpOptionsSection" src --include="*.tsx" | grep -v __tests__` shows only `params-pane.tsx` and the two definition files.
- [ ] Manual pass on a real flow: click a step → NDV opens; Input is clickable raw JSON; Parameters has no policy controls; Settings has notes + policy; no Step type anywhere; a loop's children list and reorder inside the NDV.
- [ ] `git log --oneline` shows nine focused commits.
