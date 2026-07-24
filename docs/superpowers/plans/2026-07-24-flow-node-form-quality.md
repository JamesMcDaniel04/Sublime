# Flow Node Form Quality — Implementation Plan (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `{{token}}` field self-evidencing — show what it actually resolves to as you type — and stop the NDV from silently accepting a step that can't run.

**Architecture:** Three independent pieces on top of the Phase 0–2 groundwork. (1) A pure `previewContext` builder feeds the **real** runtime resolver (`resolveTemplate` from `features/flows/context.ts` — one `import type`, so client-safe) so a preview can never drift from execution semantics. (2) `NODE_BODIES[type].requiredFields`, populated in Phase 0 and so far unconsumed, drives a "what's missing" summary in the params pane. (3) A searchable combobox replaces the bare connection/action `<select>`s, which don't scale to a catalog of hundreds of actions.

**Tech Stack:** Next.js 15 (App Router), React 19, `node:test` + `@testing-library/react` (jsdom), `tsx`, Tailwind, lucide-react.

**Spec:** [`docs/superpowers/specs/2026-07-24-flow-node-setup-hardening-design.md`](../specs/2026-07-24-flow-node-setup-hardening-design.md) — Phase 4.

## Global Constraints

- **Node:** `>=20 <23`. TypeScript strict; no `any` in shipped code (tests may cast).
- **Reuse the real resolver.** The preview MUST call `resolveTemplate`/`resolveTemplateValue` from `@/features/flows/context`. Never reimplement token or expression semantics — a preview that disagrees with the runtime is worse than no preview, because it is believed. `context.ts` is pure (single `import type`), so importing it into a client component is safe; do not add runtime imports to it.
- **A preview is a sample, and must say so.** Values come from the last run / pinned data / test input, not from a live call. Never present a preview as a guarantee.
- **Never block typing.** Preview and validation are advisory: no disabled inputs, no refusing to save a half-finished field. Phase 2's per-node test already scopes hard failures to the node under test.
- **Unit/component test run:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`
- **Full suite:** `npm test` · **Typecheck:** `npx tsc --noEmit -p tsconfig.json` (must exit 0) · **Lint:** `npx eslint <paths>` (0 warnings on touched files)
- **Commit** after every task, with green tests. Work on the current feature branch; do not push unless asked.

---

## File Structure

**Create**

- `src/lib/flows/preview-context.ts` — `buildPreviewContext` (pure): builder-visible sample data → a `FlowContext` the real resolver accepts. Plus `previewToken` for one field's resolved string.
- `src/lib/flows/__tests__/preview-context.test.ts`
- `src/components/flows/nodes/field-preview.tsx` — `<FieldPreview>`: the "→ resolved value" line under a token field.
- `src/components/flows/nodes/missing-fields.tsx` — `missingRequiredFields` (pure) + `<MissingFields>` summary.
- `src/components/flows/nodes/__tests__/missing-fields.test.ts`
- `src/components/flows/searchable-select.tsx` — `<SearchableSelect>`: typeahead over a flat option list, keyboard-navigable.
- `src/components/flows/__tests__/searchable-select.test.tsx`

**Modify**

- `src/components/flows/ndv/params-pane.tsx` — render `<MissingFields>` above the body; thread `previewContext` down.
- `src/components/flows/nodes/types.ts` — `NodeBodyProps` gains `previewContext?: FlowContext`.
- `src/components/flows/ndv/node-detail-view.tsx` — build the preview context once, pass it through.
- `src/app/flows/[id]/page.tsx` — supply the sample data (`lastOutputs`, `triggerInput`, variables) the preview context needs.
- `src/components/flows/nodes/tool-body.tsx` — connection + action pickers become `<SearchableSelect>`.
- `src/components/flows/token-text-editor.tsx` — accept an optional `preview` node rendered beneath the editor.

**Explicitly NOT in scope** — already shipped: field descriptions from `inputSchema.description` render at `tool-args-editor.tsx:286`.

---

## Task 1: `buildPreviewContext` + `previewToken` (pure)

**Files:**
- Create: `src/lib/flows/preview-context.ts`
- Create: `src/lib/flows/__tests__/preview-context.test.ts`

**Interfaces:**
- Consumes: `resolveTemplate`, `type FlowContext` from `@/features/flows/context`.
- Produces:

```ts
export function buildPreviewContext(params: {
  lastOutputs: Record<string, unknown>
  triggerInput?: unknown
  variables?: Record<string, unknown>
  inputs?: Record<string, unknown>
  item?: unknown
  loop?: { index: number; count: number }
}): FlowContext

export type TokenPreview =
  | { kind: 'empty' }                                    // nothing to preview
  | { kind: 'literal' }                                  // no tokens — don't echo it back
  | { kind: 'resolved'; text: string; truncated: boolean }
  | { kind: 'unresolved'; missing: string[] }            // token paths with no sample data

export function previewToken(template: string, ctx: FlowContext, maxChars?: number): TokenPreview
```

- [ ] **Step 1: Write the failing test** `src/lib/flows/__tests__/preview-context.test.ts`

```ts
/**
 * Token preview. The contract that matters: a preview uses the SAME resolver
 * the runtime uses, so what the user sees is what the step will send. These
 * tests also pin the honesty rules — an unresolvable token must read as
 * unknown, never as empty string.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPreviewContext, previewToken } from '../preview-context'

const ctx = buildPreviewContext({
  lastOutputs: { n1: { slug: 'widgets', items: [{ name: 'Acme' }] } },
  triggerInput: { account: 'Acme Corp', priority: 'high' },
  variables: { attempts: 3 },
})

test('resolves a step token from sample output', () => {
  const preview = previewToken('Alert: {{step.n1.output.slug}}', ctx)
  assert.deepEqual(preview, { kind: 'resolved', text: 'Alert: widgets', truncated: false })
})

test('resolves trigger input and variables', () => {
  assert.equal((previewToken('{{trigger.input.account}}', ctx) as { text: string }).text, 'Acme Corp')
  assert.equal((previewToken('{{var.attempts}}', ctx) as { text: string }).text, '3')
})

test('resolves a nested array path the datatree emits', () => {
  assert.equal((previewToken('{{step.n1.output.items.0.name}}', ctx) as { text: string }).text, 'Acme')
})

test('a field with no tokens is literal — not echoed back', () => {
  // Echoing a plain string under itself is noise; the preview exists to show
  // what you CANNOT see.
  assert.deepEqual(previewToken('#alerts', ctx), { kind: 'literal' })
})

test('an empty field previews as empty', () => {
  assert.deepEqual(previewToken('', ctx), { kind: 'empty' })
  assert.deepEqual(previewToken('   ', ctx), { kind: 'empty' })
})

test('an unknown token reports WHICH path is unresolved', () => {
  // resolveTemplate renders a missing path as '' — silently. Presenting that
  // as a successful empty resolution would hide a typo'd token, the single
  // most common flow-authoring bug.
  const preview = previewToken('Hi {{step.nope.output.x}}', ctx)
  assert.deepEqual(preview, { kind: 'unresolved', missing: ['step.nope.output.x'] })
})

test('a mix of known and unknown reports only the unknown', () => {
  const preview = previewToken('{{trigger.input.account}} / {{var.ghost}}', ctx)
  assert.deepEqual(preview, { kind: 'unresolved', missing: ['var.ghost'] })
})

test('objects resolve to JSON, matching runtime behaviour', () => {
  const preview = previewToken('{{step.n1.output}}', ctx) as { text: string }
  assert.equal(preview.text, JSON.stringify({ slug: 'widgets', items: [{ name: 'Acme' }] }))
})

test('long values truncate and say so', () => {
  const long = buildPreviewContext({ lastOutputs: { n1: { blob: 'x'.repeat(500) } } })
  const preview = previewToken('{{step.n1.output.blob}}', long, 80) as { text: string; truncated: boolean }
  assert.equal(preview.truncated, true)
  assert.ok(preview.text.length <= 80)
})

test('expression tokens preview through the real grammar', () => {
  // `{{=upper(...)}}` is runtime syntax; the preview must not treat it as an
  // unresolved path. Reusing resolveTemplate gets this for free.
  assert.equal((previewToken('{{=upper(trigger.input.priority)}}', ctx) as { text: string }).text, 'HIGH')
})

test('an absent trigger input does not throw', () => {
  const bare = buildPreviewContext({ lastOutputs: {} })
  assert.deepEqual(previewToken('{{trigger.input.x}}', bare), { kind: 'unresolved', missing: ['trigger.input.x'] })
})

test('loop item and index are previewable inside a loop body', () => {
  const inLoop = buildPreviewContext({ lastOutputs: {}, item: { sku: 'A1' }, loop: { index: 0, count: 3 } })
  assert.equal((previewToken('{{item.sku}}', inLoop) as { text: string }).text, 'A1')
  assert.equal((previewToken('{{loop.index}}', inLoop) as { text: string }).text, '0')
})
```

- [ ] **Step 2: Run it — expect failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/preview-context.test.ts`
Expected: FAIL — `Cannot find module '../preview-context'`.

- [ ] **Step 3: Implement `src/lib/flows/preview-context.ts`**

The `unresolved` detection is the only real logic: `resolveTemplate` renders a missing path as `''` and cannot tell you it did, so probe each token path separately against the context before formatting.

```ts
/**
 * Token preview for the builder: what a `{{token}}` field will actually
 * resolve to, using the REAL runtime resolver.
 *
 * Reusing `resolveTemplate` is the whole point — a preview with its own
 * token/expression semantics would drift from execution, and a wrong preview
 * is worse than none because the user believes it. `features/flows/context`
 * is pure (a single `import type`), so it is safe in a client component.
 *
 * Sample data comes from the last run, pinned outputs, or the test input —
 * never a live call. The UI labels it as a sample.
 */
import { resolveTemplate, type FlowContext } from '@/features/flows/context'

const DEFAULT_MAX_CHARS = 160
const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

export type TokenPreview =
  | { kind: 'empty' }
  | { kind: 'literal' }
  | { kind: 'resolved'; text: string; truncated: boolean }
  | { kind: 'unresolved'; missing: string[] }

/** Builder-visible sample data → the context shape the runtime resolver reads. */
export function buildPreviewContext({
  lastOutputs,
  triggerInput,
  variables,
  inputs,
  item,
  loop,
}: {
  lastOutputs: Record<string, unknown>
  triggerInput?: unknown
  variables?: Record<string, unknown>
  inputs?: Record<string, unknown>
  item?: unknown
  loop?: { index: number; count: number }
}): FlowContext {
  return {
    trigger: { input: triggerInput },
    step: Object.fromEntries(Object.entries(lastOutputs).map(([id, output]) => [id, { output }])),
    ...(variables ? { variables } : {}),
    ...(inputs ? { input: inputs } : {}),
    ...(item !== undefined ? { item } : {}),
    ...(loop ? { loop } : {}),
  }
}

/** Token paths in `template` that resolve to nothing against `ctx`. */
function unresolvedPaths(template: string, ctx: FlowContext): string[] {
  const missing: string[] = []
  for (const match of template.matchAll(TOKEN_RE)) {
    const path = match[1].trim()
    // Expressions carry their own fallbacks (coalesce, if, …) — a function
    // legitimately returning '' is not an unresolved reference.
    if (path.startsWith('=')) continue
    if (resolveTemplate(`{{${path}}}`, ctx) === '') missing.push(path)
  }
  return missing
}

export function previewToken(template: string, ctx: FlowContext, maxChars = DEFAULT_MAX_CHARS): TokenPreview {
  if (!template.trim()) return { kind: 'empty' }
  TOKEN_RE.lastIndex = 0
  if (!TOKEN_RE.test(template)) return { kind: 'literal' }
  const missing = unresolvedPaths(template, ctx)
  if (missing.length > 0) return { kind: 'unresolved', missing }
  const full = resolveTemplate(template, ctx)
  return full.length > maxChars
    ? { kind: 'resolved', text: `${full.slice(0, maxChars - 1)}…`, truncated: true }
    : { kind: 'resolved', text: full, truncated: false }
}
```

- [ ] **Step 4: Run — expect PASS** (12 tests)

If the `expression tokens` or array-path test fails, read `readPath`/`expressionValue` in `src/features/flows/context.ts` and fix the TEST's expectation to match real runtime behaviour. Do not change `context.ts` — its semantics are what production runs.

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/lib/flows/preview-context.ts src/lib/flows/__tests__/preview-context.test.ts
git add src/lib/flows/preview-context.ts src/lib/flows/__tests__/preview-context.test.ts
git commit -m "feat(flows): token preview via the real runtime resolver"
```

---

## Task 2: `<FieldPreview>` under token fields

**Files:**
- Create: `src/components/flows/nodes/field-preview.tsx`
- Modify: `src/components/flows/token-text-editor.tsx` (optional `preview` slot)
- Modify: `src/components/flows/nodes/types.ts` (`NodeBodyProps.previewContext`)
- Modify: `src/components/flows/ndv/node-detail-view.tsx`, `src/components/flows/ndv/params-pane.tsx`, `src/app/flows/[id]/page.tsx`
- Modify: `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`

**Interfaces:**
- Consumes: `previewToken`, `buildPreviewContext` (Task 1).
- Produces: `<FieldPreview value={string} ctx={FlowContext | undefined} />`; renders nothing for `empty`/`literal`, so it never adds noise to a plain field.

- [ ] **Step 1: Write the failing test**

Append to `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`:

```tsx
// ── Field preview ─────────────────────────────────────────────────────────────

test('field preview shows the resolved value of a token field', () => {
  const ctx = buildPreviewContext({ lastOutputs: {}, triggerInput: { account: 'Acme' } })
  const { getByText } = render(<FieldPreview value="Alert: {{trigger.input.account}}" ctx={ctx} />)
  getByText(/Alert: Acme/)
})

test('field preview renders NOTHING for a field with no tokens', () => {
  // A plain value echoed under itself is pure noise.
  const ctx = buildPreviewContext({ lastOutputs: {} })
  const { container } = render(<FieldPreview value="#alerts" ctx={ctx} />)
  assert.equal(container.textContent, '')
})

test('field preview names an unresolved token instead of showing blank', () => {
  const ctx = buildPreviewContext({ lastOutputs: {} })
  const { getByText } = render(<FieldPreview value="{{step.ghost.output.x}}" ctx={ctx} />)
  getByText(/step\.ghost\.output\.x/)
})

test('field preview renders nothing without a context', () => {
  // No sample data yet (fresh flow, never run) — say nothing rather than
  // claiming every token is broken.
  const { container } = render(<FieldPreview value="{{trigger.input.x}}" ctx={undefined} />)
  assert.equal(container.textContent, '')
})
```

Add to that file's imports:

```tsx
import { FieldPreview } from '../../nodes/field-preview'
import { buildPreviewContext } from '@/lib/flows/preview-context'
```

- [ ] **Step 2: Run — expect failure** (`Cannot find module '../../nodes/field-preview'`)

- [ ] **Step 3: Implement `field-preview.tsx`**

```tsx
'use client'

import { CornerDownRight } from 'lucide-react'
import { previewToken } from '@/lib/flows/preview-context'
import type { FlowContext } from '@/features/flows/context'

/**
 * The "→ resolved value" line under a token field: what this field will send,
 * using sample data from the last run / pinned outputs / test input.
 *
 * Renders nothing when there is nothing worth saying (no tokens, empty field,
 * or no sample data at all) — the value of this line depends on it being
 * signal, not decoration.
 */
export function FieldPreview({ value, ctx }: { value: string; ctx?: FlowContext }) {
  if (!ctx) return null
  const preview = previewToken(value, ctx)
  if (preview.kind === 'empty' || preview.kind === 'literal') return null
  if (preview.kind === 'unresolved') {
    return (
      <p className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-500">
        <CornerDownRight className="mt-px h-3 w-3 shrink-0" />
        <span>
          No sample data for <span className="font-mono">{preview.missing.join(', ')}</span> — run the step or pin an earlier one to preview it.
        </span>
      </p>
    )
  }
  return (
    <p className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-muted-foreground">
      <CornerDownRight className="mt-px h-3 w-3 shrink-0" />
      <span className="break-all font-mono" title="Resolved from the last run's data — a sample, not a live call.">
        {preview.text}
      </span>
    </p>
  )
}
```

- [ ] **Step 4: Add the `preview` slot to `TokenTextEditor`**

An optional `preview?: React.ReactNode` prop rendered directly beneath the editor's contenteditable. Every existing call site is unaffected (absent = today's markup exactly). Read the component first and place it inside the same wrapper the invalid-border styling uses, so preview text aligns with the field.

- [ ] **Step 5: Thread `previewContext` through**

- `types.ts`: `NodeBodyProps` gains `previewContext?: FlowContext`.
- `node-detail-view.tsx`: accept `previewContext` and pass into `ParamsPane`.
- `params-pane.tsx`: already spreads props into `Body` — no change needed beyond the type.
- `page.tsx`: build it beside the existing `dataFields` memo, reusing the sample values that memo already derives (`lastOutputs` including node-test results, `triggerInput` from `testInput`/last run, `upstreamVariables`, and the loop item when `loopContext` is set):

```tsx
  // Sample data for token previews — the same values the datatree offers, so
  // what you can insert is exactly what you can preview.
  //
  // `variables` is deliberately absent: upstreamVariables carries DECLARED
  // names and types ({name, type}[]), never values — a variable's value only
  // exists mid-run. So `{{var.x}}` previews as "no sample data", which is the
  // truth. Inventing a placeholder here would render a fake value in the exact
  // place the user is deciding whether their mapping is right.
  const previewContext = useMemo(
    () => buildPreviewContext({
      lastOutputs: ndvLastOutputs,
      triggerInput: testInput.trim() ? parseFlowInput(testInput) : storedRunInput(selectedRun?.input),
      ...(loopContext ? { item: ndvLastOutputs.__item, loop: { index: 0, count: 1 } } : {}),
    }),
    [ndvLastOutputs, testInput, selectedRun, loopContext],
  )
```

- [ ] **Step 6: Use it in the two highest-value bodies**

Wire `<FieldPreview>` into `http-body.tsx` (url + body fields) and `tool-body.tsx`'s `ToolArgsEditor` args. Those are where token mapping actually happens. Do NOT wire all 22 bodies in this task — prove the pattern on two, then extend once the shape is settled.

- [ ] **Step 7: Verify + commit**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/ndv/__tests__/node-detail-view.test.tsx
npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5
npx eslint src/components/flows src/app/flows/\[id\]/page.tsx
git add -A src/components/flows src/app/flows/\[id\]/page.tsx
git commit -m "feat(flows): live resolved-value preview under token fields"
```

---

## Task 3: Missing-required-fields summary

**Files:**
- Create: `src/components/flows/nodes/missing-fields.tsx`
- Create: `src/components/flows/nodes/__tests__/missing-fields.test.ts`
- Modify: `src/components/flows/ndv/params-pane.tsx`

**Interfaces:**
- Consumes: `NODE_BODIES[type].requiredFields` (populated in Phase 0, unconsumed until now).
- Produces:

```ts
export function missingRequiredFields(node: FlowNode): string[]
```

- [ ] **Step 1: Write the failing test** `src/components/flows/nodes/__tests__/missing-fields.test.ts`

```ts
/**
 * requiredFields, finally consumed. The registry knows which node.data keys a
 * step needs; this turns that into a straight answer to "why can't this run?"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingRequiredFields } from '../missing-fields'
import { NODE_BODIES } from '../registry'
import type { FlowNode } from '@/lib/flows/graph'

test('reports an empty required string field', () => {
  const node = { id: 't', type: 'tool', data: { connectionId: '', toolName: '' } } as FlowNode
  assert.deepEqual(missingRequiredFields(node).sort(), ['connectionId', 'toolName'])
})

test('reports nothing once required fields are filled', () => {
  const node = { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'send' } } as FlowNode
  assert.deepEqual(missingRequiredFields(node), [])
})

test('treats a whitespace-only value as missing', () => {
  const node = { id: 's', type: 'subflow', data: { flowId: '   ' } } as FlowNode
  assert.deepEqual(missingRequiredFields(node), ['flowId'])
})

test('treats an empty array as missing', () => {
  // A transform with zero fields, a parallel with zero branches: present but
  // useless, which is the case a plain null-check misses.
  const node = { id: 'x', type: 'transform', data: { fields: [] } } as unknown as FlowNode
  assert.deepEqual(missingRequiredFields(node), ['fields'])
})

test('a node type with no required fields never reports anything', () => {
  const node = { id: 'p', type: 'stop', data: {} } as FlowNode
  assert.deepEqual(missingRequiredFields(node), [])
})

test('every node type can be checked without throwing', () => {
  // Totality: a new node type must not crash the params pane.
  for (const type of Object.keys(NODE_BODIES)) {
    const node = { id: 'n', type, data: {} } as unknown as FlowNode
    assert.ok(Array.isArray(missingRequiredFields(node)), `${type} threw or returned a non-array`)
  }
})
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `missing-fields.tsx`**

```tsx
'use client'

import { AlertCircle } from 'lucide-react'
import type { FlowNode } from '@/lib/flows/graph'
import { NODE_BODIES } from './registry'

/**
 * Which of this node type's required `data` keys are still unset.
 *
 * "Present but useless" counts as missing — an empty string, a whitespace-only
 * string, and an empty array all mean the step can't run, and a plain
 * null-check would pass all three.
 */
export function missingRequiredFields(node: FlowNode): string[] {
  const required = NODE_BODIES[node.type]?.requiredFields ?? []
  const data = node.data as Record<string, unknown>
  return required.filter((field) => {
    const value = data[field]
    if (value === undefined || value === null) return true
    if (typeof value === 'string') return value.trim() === ''
    if (Array.isArray(value)) return value.length === 0
    return false
  })
}

/** Advisory summary above the params — never blocks editing. */
export function MissingFields({ node }: { node: FlowNode }) {
  const missing = missingRequiredFields(node)
  if (missing.length === 0) return null
  return (
    <p className="flex items-start gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] leading-4 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>
        Still needed before this step can run: <span className="font-mono">{missing.join(', ')}</span>
      </span>
    </p>
  )
}
```

- [ ] **Step 4: Run — expect PASS** (6 tests)

- [ ] **Step 5: Render it in `params-pane.tsx`**

Between the "Parameters" heading and the body, so it reads before the fields it describes.

- [ ] **Step 6: Verify + commit**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/nodes/__tests__/missing-fields.test.ts
npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5
git add src/components/flows/nodes src/components/flows/ndv/params-pane.tsx
git commit -m "feat(flows): params pane names the fields a step still needs"
```

---

## Task 4: `<SearchableSelect>` for connection + action pickers

**Files:**
- Create: `src/components/flows/searchable-select.tsx`
- Create: `src/components/flows/__tests__/searchable-select.test.tsx`
- Modify: `src/components/flows/nodes/tool-body.tsx`

**Interfaces:**
- Produces:

```ts
export type SearchableOption = { value: string; label: string; hint?: string }

export function SearchableSelect(props: {
  value: string
  options: SearchableOption[]
  onChange: (value: string) => void
  /** Accessible name for the trigger button (tests query by it). */
  ariaLabel: string
  /** Trigger text when `value` is empty. */
  placeholder?: string
  /** Red border, matching the bare-select `showErrors` behaviour it replaces. */
  invalid?: boolean
  /** Shown when `options` is empty — e.g. a connection whose discovery failed. */
  emptyLabel?: string
}): React.ReactNode
```

- [ ] **Step 1: Write the failing test** `src/components/flows/__tests__/searchable-select.test.tsx`

```tsx
/**
 * The connection/action picker. A bare <select> can't be searched, and a real
 * MCP catalog runs to hundreds of actions — scrolling is not a strategy.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { SearchableSelect } from '../searchable-select'

afterEach(() => cleanup())

const OPTIONS = [
  { value: 'send_message', label: 'send_message', hint: 'Post to a channel' },
  { value: 'list_channels', label: 'list_channels' },
  { value: 'delete_message', label: 'delete_message' },
]

test('shows the selected option label when closed', () => {
  const { getByRole } = render(<SearchableSelect value="list_channels" options={OPTIONS} ariaLabel="Action" onChange={() => {}} />)
  assert.match(getByRole('button', { name: /action/i }).textContent ?? '', /list_channels/)
})

test('filters options as you type and selects the match', () => {
  let picked: string | null = null
  const { getByRole, getByText, queryByText } = render(
    <SearchableSelect value="" options={OPTIONS} ariaLabel="Action" onChange={(value) => { picked = value }} />,
  )
  act(() => { getByRole('button', { name: /action/i }).click() })
  act(() => { fireEvent.change(getByRole('textbox'), { target: { value: 'delete' } }) })
  assert.equal(queryByText('send_message'), null, 'non-matching option must be filtered out')
  act(() => { getByText('delete_message').click() })
  assert.equal(picked, 'delete_message')
})

test('search matches the hint, not just the label', () => {
  // Users search for what an action DOES ("post") more often than its snake_case id.
  const { getByRole, getByText } = render(<SearchableSelect value="" options={OPTIONS} ariaLabel="Action" onChange={() => {}} />)
  act(() => { getByRole('button', { name: /action/i }).click() })
  act(() => { fireEvent.change(getByRole('textbox'), { target: { value: 'post to a' } }) })
  getByText('send_message')
})

test('says so when nothing matches', () => {
  const { getByRole, getByText } = render(<SearchableSelect value="" options={OPTIONS} ariaLabel="Action" onChange={() => {}} />)
  act(() => { getByRole('button', { name: /action/i }).click() })
  act(() => { fireEvent.change(getByRole('textbox'), { target: { value: 'zzz' } }) })
  getByText(/no matches/i)
})

test('Escape closes without changing the value', () => {
  let changed = 0
  const { getByRole, queryByRole } = render(
    <SearchableSelect value="list_channels" options={OPTIONS} ariaLabel="Action" onChange={() => { changed++ }} />,
  )
  act(() => { getByRole('button', { name: /action/i }).click() })
  act(() => { fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' }) })
  assert.equal(queryByRole('textbox'), null, 'popover should close')
  assert.equal(changed, 0)
})

test('an empty option list still opens and explains itself', () => {
  // A connection whose discovery failed has no actions — the picker must not
  // look identical to one that simply hasn't loaded.
  const { getByRole, getByText } = render(<SearchableSelect value="" options={[]} ariaLabel="Action" emptyLabel="No actions — reconnect this connection." onChange={() => {}} />)
  act(() => { getByRole('button', { name: /action/i }).click() })
  getByText(/reconnect this connection/i)
})
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `searchable-select.tsx`**

A button showing the current label; clicking opens a panel with a text input and a filtered list. Requirements the tests pin: `role="button"` labelled by `ariaLabel`, a `role="textbox"` search input when open, case-insensitive matching over `label + hint`, a "No matches" empty state, a caller-supplied `emptyLabel` when `options` is empty, and Escape closing without firing `onChange`. Close on outside mousedown too (mirror the popover pattern already in `step-card.tsx`). Reuse `controlClass` from `nodes/field-primitives` for the trigger so it sits flush with neighbouring fields.

- [ ] **Step 4: Run — expect PASS** (6 tests)

- [ ] **Step 5: Adopt it in `tool-body.tsx`**

Replace the connection `<select>` and the action `<select>`. Map the catalog to options — connection: `{ value: entry.id, label: entry.name }`; action: `{ value: tool.name, label: tool.name, hint: tool.description }`. Keep the existing `onChange` bodies verbatim (they carry the schema-snapshotting logic — `actionInputSchema`, `actionSchemaHash`, `risk`); only the control changes. Pass `invalid={showErrors && !node.data.connectionId}` to preserve today's red-border behaviour, and `emptyLabel` from the connection's `toolsError` when present, so a dead connection reads as dead here too (the gap Phase 3 closes properly).

- [ ] **Step 6: Verify + commit**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/searchable-select.test.tsx
npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5
npx eslint src/components/flows
git add src/components/flows
git commit -m "feat(flows): searchable connection and action pickers"
```

---

## Task 5: Extend the preview to the remaining token fields

Only after Task 2's shape has survived contact with two bodies.

**Files:**
- Modify: `condition-body.tsx`, `switch-body.tsx`, `transform-body.tsx`, `loop-body.tsx`, `variable-body.tsx`, `data-body.tsx`, `human-review-body.tsx`, `agent-body.tsx`, `router-body.tsx`, `repeat-until-body.tsx`

- [ ] **Step 1: Add `<FieldPreview>` beneath each body's token editors**

Use the same `value` the editor is bound to and the `previewContext` prop. Skip non-token inputs (field names, labels, KV keys) — a preview under a literal renders nothing anyway, but wiring it there is noise in the diff.

- [ ] **Step 2: Verify each body still mounts**

The NDV mount test covers 4 node types. Extend `NODES` in `node-detail-view.test.tsx` to include one node of every type carrying a `previewContext`, so a body that mishandles the new prop fails here:

```tsx
test('every node type mounts with a preview context', () => {
  const ctx = buildPreviewContext({ lastOutputs: { n0: { x: 1 } }, triggerInput: { a: 'b' } })
  for (const type of Object.keys(NODE_BODIES)) {
    const node = { id: 'n', type, data: {} } as unknown as FlowNode
    const view = render(<NodeDetailView node={node} {...baseProps} previewContext={ctx} />)
    assert.ok(view.container.firstChild, `${type} rendered nothing`)
    view.unmount()
  }
})
```

Some bodies will throw on `data: {}` because they index required arrays (e.g. `node.data.branches.flat()`). Where that happens, give that type a minimal valid `data` in a small per-type fixture map rather than weakening the assertion — and note in the commit which types needed one, since that is a real robustness signal about those bodies.

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5
git add src/components/flows
git commit -m "feat(flows): token preview across every node body"
```

---

## Done criteria

- Typing `{{trigger.input.account}}` into any wired token field shows `→ Acme Corp` beneath it, from the last run's data.
- A typo'd token names the unresolved path instead of silently previewing blank.
- The preview calls `resolveTemplate` — verify with `grep -rn "resolveTemplate" src/lib/flows/preview-context.ts` and confirm no second token parser exists in the client.
- The params pane names missing required fields for every node type, and blocks nothing.
- Connection and action pickers are searchable, including by action description.
- `npm test` green; `npx tsc --noEmit` exits 0; `npx eslint src/components/flows src/lib/flows` reports 0 warnings on touched files.

## Out of scope

- **Phase 3 (credential verification state)** — blocked on the credential vault plan. The `emptyLabel`/`toolsError` surfacing in Task 4 is a stopgap, not the verified-state chip.
- **Expression authoring UI** — the `{{=fn(...)}}` grammar exists in `context.ts` and previews correctly, but a function palette / autocomplete is its own effort.
- **Debounced preview** — `resolveTemplate` is a synchronous regex replace over a small string; measure before adding machinery. If a body ever previews a large array, memoize there.
