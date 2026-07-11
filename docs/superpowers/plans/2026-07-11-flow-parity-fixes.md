# Flow Parity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canvas drag-to-scroll, loud failure for condition/switch inside container bodies, canonical trigger naming + distinct icons, and an optional trigger-level filter — then a fresh parity-gap sweep.

**Architecture:** Four independent, individually-committable changes to the existing flow builder (no new modules): a pointer handler on the builder's scroll container, a validation rule + runtime guard pair, display-string/icon-map edits, and a filter check at the top of `interpretFlow` with a drawer clause editor. Correctness first (Task 1), cosmetics second, interaction third, feature fourth.

**Tech Stack:** Next.js App Router, TypeScript, `node:test` (+ jsdom/`@testing-library/react` component harness in `src/components/flows/__tests__/`), lucide-react icons.

## Global Constraints

- Work directly on `main` (the Sublime trunk) — each task is one commit; the suite must be green at every commit.
- Error message for condition/switch-in-body (verbatim, both layers): `<label> can't run inside a For each / Parallel body — branching isn't supported there. Use a Filter step to gate items instead.`
- Canonical trigger names: webhook = **"When an HTTP request is received"**, schedule = **"Schedule"** (all surfaces).
- Trigger-filter skip output (verbatim): `Trigger filter did not match — run skipped.`
- Drag threshold: **3px**. Left button only. Never start a pan from an element matching `[data-node-id], button, a, input, textarea, select, [role="menu"], [role="dialog"]`.
- Test commands: `npm test` (full), or targeted `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`.

---

### Task 1: Condition/Switch in container bodies → loud error (Bug #1)

**Files:**
- Modify: `src/lib/flows/validate.ts` (inside `validateFlowGraph`, line ~305)
- Modify: `src/features/flows/interpret.ts:352-355` (the condition/switch arm of `execNode`)
- Test: `src/lib/flows/__tests__/validate.test.ts` (extend existing), `src/features/flows/__tests__/interpret.test.ts` (extend existing — check exact filename with `ls src/features/flows/__tests__/`)

**Interfaces:**
- Produces: validation issue `code: 'CONDITION_IN_CONTAINER'`; `execNode` returns `{ kind: 'fail', error }` for condition/switch instead of `{ kind: 'skip' }`.

- [ ] **Step 1: Write the failing validation test** (in the existing validate test file, matching its existing style — read 2-3 existing cases first):

```typescript
test('condition inside a loop body is a publish error', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'loop1', type: 'loop', data: { source: '{{trigger.input}}', body: ['c1'] } },
      { id: 'c1', type: 'condition', data: { match: 'all', clauses: [{ left: '{{item}}', op: 'eq', right: 'x' }] } },
    ],
    edges: [{ source: 'trigger', target: 'loop1' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  const issue = result.errors.find((i) => i.code === 'CONDITION_IN_CONTAINER')
  assert.ok(issue, 'expected CONDITION_IN_CONTAINER error')
  assert.equal(issue!.nodeId, 'c1')
})

test('switch inside a parallel branch is a publish error; main-chain condition is fine', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'p1', type: 'parallel', data: { branches: [['s1']] } },
      { id: 's1', type: 'switch', data: { value: '{{item}}', branches: [] } },
      { id: 'c-main', type: 'condition', data: { match: 'all', clauses: [{ left: '1', op: 'eq', right: '1' }] } },
    ],
    edges: [
      { source: 'trigger', target: 'p1' },
      { source: 'p1', target: 'c-main' },
    ],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((i) => i.code === 'CONDITION_IN_CONTAINER' && i.nodeId === 's1'))
  assert.ok(!result.errors.some((i) => i.nodeId === 'c-main'))
})
```

Adapt node `data` shapes to the zod schemas in `src/lib/flows/graph.ts` if these don't validate (read `loopNode`/`parallelNode`/`switchNode` definitions and copy a valid minimal shape from an existing test).

- [ ] **Step 2: Run to verify failure** — `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/validate.test.ts` → the two new tests FAIL (no such code emitted).

- [ ] **Step 3: Implement the validation rule** in `validateFlowGraph` (place alongside the other structural rules; use the existing `nodeLabel` helper and issue-push pattern found in the function):

```typescript
// Branching nodes can't execute inside container bodies: bodies are flat
// ordered lists with no edges, so condition/switch have nothing to route on
// (the interpreter refuses them at runtime — this catches it at publish).
const containerBodies: Array<{ containerId: string; ids: string[] }> = []
for (const node of graph.nodes) {
  if (node.type === 'loop') containerBodies.push({ containerId: node.id, ids: node.data.body ?? [] })
  if (node.type === 'parallel') containerBodies.push({ containerId: node.id, ids: (node.data.branches ?? []).flat() })
}
for (const { ids } of containerBodies) {
  for (const id of ids) {
    const inner = nodeById.get(id) // reuse the function's existing node lookup map (check its actual name)
    if (inner && (inner.type === 'condition' || inner.type === 'switch')) {
      issues.push({
        level: 'error',
        code: 'CONDITION_IN_CONTAINER',
        message: `${nodeLabel(inner)} can't run inside a For each / Parallel body — branching isn't supported there. Use a Filter step to gate items instead.`,
        nodeId: inner.id,
      })
    }
  }
}
```

(Reuse the function's real byId map + issues accumulator names — read the function body first.)

- [ ] **Step 4: Write the failing runtime test** (in the interpret test file):

```typescript
test('condition inside a loop body fails the run loudly (no silent skip)', async () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'loop1', type: 'loop', data: { source: '{{trigger.input}}', body: ['c1'] } },
      { id: 'c1', type: 'condition', data: { match: 'all', clauses: [{ left: '{{item}}', op: 'eq', right: 'a' }] } },
    ],
    edges: [{ source: 'trigger', target: 'loop1' }],
  } as FlowGraph
  const result = await interpretFlow(graph, ['a', 'b'], { runAgent: async () => ({ output: 'x' }) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /can't run inside a For each \/ Parallel body/)
})
```

- [ ] **Step 5: Run to verify failure** — the run currently *succeeds* (silent skip) → assertion fails.

- [ ] **Step 6: Implement the runtime guard** — replace `interpret.ts:352-355`:

```typescript
if (node.type === 'condition' || node.type === 'switch') {
  // Bodies are flat ordered lists (no edges), so branching can't route here.
  // The main-chain walker intercepts condition/switch before execNode, so
  // reaching this arm means the node sits inside a container body — a graph
  // publish validation also rejects; this guards stored pre-validation graphs.
  const error = `${node.type === 'condition' ? 'If / else' : 'Switch'} can't run inside a For each / Parallel body — branching isn't supported there. Use a Filter step to gate items instead.`
  emit({ nodeId: node.id, status: 'failed', error })
  return { kind: 'fail', error }
}
```

- [ ] **Step 7: Run both test files + full suite** — targeted files PASS, then `npm test` green (some existing test may rely on the silent skip — if one fails, read it: if it asserts the OLD silent behavior, update it to the new expectation and say so in the commit).

- [ ] **Step 8: Commit** — `git add -A && git commit -m "fix(flows): condition/switch inside container bodies fails loudly instead of silent no-op"`

---

### Task 2: Canonical trigger naming + icon split

**Files:**
- Modify: `src/components/flows/flow-canvas.tsx:187-188` (`titleFor`), `src/components/flows/step-drawer.tsx:1423-1424` (trigger `<select>` options), `src/components/flows/flow-picker.tsx:112,119` (`TRIGGER_ICON`/`TRIGGER_TONE`), `src/components/flows/step-card.tsx:69-101 + ~313` (`NODE_ICON` selection)

**Interfaces:** display-only; no exported types change.

- [ ] **Step 1: Canvas titles** (`flow-canvas.tsx` `titleFor`): `'Schedule trigger'` → `'Schedule'`; `'Webhook trigger'` → `'When an HTTP request is received'`.
- [ ] **Step 2: Drawer options** (`step-drawer.tsx:1423-1424`): option label `Webhook (external)` → `When an HTTP request is received` (keep `value="webhook"`); confirm the schedule option already reads `Schedule`.
- [ ] **Step 3: Picker icon split** (`flow-picker.tsx`): import `Webhook` from `lucide-react`; `TRIGGER_ICON.webhook: Globe` → `Webhook`; `TRIGGER_TONE.webhook: 'bg-emerald-600 text-white'` → `'bg-blue-600 text-white'`.
- [ ] **Step 4: Canvas trigger subtype icons** (`step-card.tsx`): import `Webhook, Clock, Radio` from `lucide-react`; where the icon is chosen (`const Icon = NODE_ICON[node.type]`, ~line 313), special-case triggers:

```typescript
const TRIGGER_SUBTYPE_ICON: Record<string, LucideIcon> = { webhook: Webhook, schedule: Clock, signal: Radio, manual: Zap }
// at the selection site:
const triggerType = node.type === 'trigger' ? String((node.data.trigger as { type?: string } | undefined)?.type ?? 'manual') : ''
const Icon = node.type === 'trigger' ? (TRIGGER_SUBTYPE_ICON[triggerType] ?? Zap) : NODE_ICON[node.type]
```

(Tone stays `NODE_TONE.trigger` blue for all subtypes.)

- [ ] **Step 5: Verify** — `npm run typecheck` clean; `grep -rn "Webhook trigger\|Webhook (external)\|Schedule trigger" src` → empty.
- [ ] **Step 6: Commit** — `git commit -m "fix(flows): one canonical name + distinct icon for the webhook trigger vs HTTP action"`

---

### Task 3: Canvas drag-to-scroll (click-and-hold pan)

**Files:**
- Modify: `src/app/flows/[id]/page.tsx` — add a `useCallback` handler near the assistant-resize handler (~line 76-101, same conventions) and wire it on the scroll container div (~line 967-975)
- Test: create `src/components/flows/__tests__/canvas-pan.test.tsx` (jsdom harness, same imports as `http-url-editor.test.tsx`)

**Interfaces:**
- Produces: exported pure helper `startCanvasPan(container: HTMLElement, event: { button: number; clientY: number; target: EventTarget | null }): { move(clientY: number): void; end(): { dragged: boolean } } | null` in a NEW small module `src/components/flows/canvas-pan.ts` — the page wires it; the test drives it directly plus through DOM events. Keeping the logic in a pure module makes it testable without mounting the 1186-line page.

- [ ] **Step 1: Write the failing test** (`src/components/flows/__tests__/canvas-pan.test.tsx`):

```typescript
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startCanvasPan, PAN_INTERACTIVE_SELECTOR } from '../canvas-pan'

function fakeContainer(): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: 100, writable: true })
  document.body.appendChild(el)
  return el
}

test('left-button drag on background scrolls the container', () => {
  const el = fakeContainer()
  const pan = startCanvasPan(el, { button: 0, clientY: 500, target: el })
  assert.ok(pan)
  pan!.move(450) // drag up 50px → content moves up → scrollTop increases
  assert.equal(el.scrollTop, 150)
  const { dragged } = pan!.end()
  assert.equal(dragged, true)
})

test('sub-threshold movement is a click, not a drag', () => {
  const el = fakeContainer()
  const pan = startCanvasPan(el, { button: 0, clientY: 500, target: el })!
  pan.move(498) // 2px < 3px threshold
  assert.equal(pan.end().dragged, false)
})

test('non-left button and interactive targets do not start a pan', () => {
  const el = fakeContainer()
  assert.equal(startCanvasPan(el, { button: 1, clientY: 0, target: el }), null)
  const btn = document.createElement('button')
  el.appendChild(btn)
  assert.equal(startCanvasPan(el, { button: 0, clientY: 0, target: btn }), null)
})
```

- [ ] **Step 2: Run to verify failure** — module doesn't exist → import error.

- [ ] **Step 3: Implement `src/components/flows/canvas-pan.ts`:**

```typescript
/**
 * Click-and-hold panning for the flow-builder canvas. The canvas is a
 * vertically scrolling column (no XY plane), so "pan" maps drag-Y onto the
 * container's scrollTop. Pure DOM logic — the page component wires pointer
 * events; tests drive this directly.
 */
export const PAN_INTERACTIVE_SELECTOR = '[data-node-id], button, a, input, textarea, select, [role="menu"], [role="dialog"]'
const DRAG_THRESHOLD_PX = 3

export function startCanvasPan(
  container: HTMLElement,
  event: { button: number; clientY: number; target: EventTarget | null },
): { move(clientY: number): void; end(): { dragged: boolean } } | null {
  if (event.button !== 0) return null
  const target = event.target instanceof Element ? event.target : null
  if (target && target.closest(PAN_INTERACTIVE_SELECTOR)) return null

  const startY = event.clientY
  const startScrollTop = container.scrollTop
  let dragged = false

  return {
    move(clientY: number) {
      const delta = startY - clientY
      if (!dragged && Math.abs(delta) < DRAG_THRESHOLD_PX) return
      dragged = true
      container.scrollTop = startScrollTop + delta
    },
    end: () => ({ dragged }),
  }
}
```

- [ ] **Step 4: Run the test** — PASS.

- [ ] **Step 5: Wire it in `page.tsx`.** Add near the other handlers:

```typescript
const panRef = useRef<ReturnType<typeof startCanvasPan>>(null)
const suppressClickRef = useRef(false)
const onCanvasPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
  const container = canvasScrollRef.current
  if (!container) return
  const pan = startCanvasPan(container, event)
  if (!pan) return
  panRef.current = pan
  container.setPointerCapture(event.pointerId)
  document.body.style.cursor = 'grabbing'
  document.body.style.userSelect = 'none'
}, [])
const onCanvasPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
  panRef.current?.move(event.clientY)
}, [])
const endCanvasPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
  const pan = panRef.current
  if (!pan) return
  panRef.current = null
  suppressClickRef.current = pan.end().dragged
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  canvasScrollRef.current?.releasePointerCapture?.(event.pointerId)
}, [])
```

On the container div (line ~967): add `onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={endCanvasPan} onPointerCancel={endCanvasPan}`, change `onClick` to check the suppress flag:

```tsx
onClick={() => {
  if (suppressClickRef.current) { suppressClickRef.current = false; return }
  setSelectedId(null)
}}
```

and add `cursor-grab` styling for the background (className: append `cursor-grab active:cursor-grabbing`).

Import `startCanvasPan` from `@/components/flows/canvas-pan` and add `useRef` if not imported.

- [ ] **Step 6: Verify** — `npm run typecheck` clean; component test green; `npm test` green.
- [ ] **Step 7: Commit** — `git commit -m "feat(flows): click-and-hold drag-to-scroll on the builder canvas"`

---

### Task 4: Trigger-level filter ("Only run when…")

**Files:**
- Modify: `src/features/flows/interpret.ts` (top of `interpretFlow`, after `ctx` is built, ~line 600-618), `src/components/flows/step-drawer.tsx` (trigger editor section ~1420+)
- Test: extend the interpret test file
- (No schema change: trigger node `data.trigger` is `z.any()` — the filter lives at `data.trigger.filter`.)

**Interfaces:**
- Trigger filter shape: `{ match?: 'all' | 'any', clauses?: Array<{ left: string; op: ConditionOp; right: string }> }` stored at `triggerNode.data.trigger.filter`; evaluated with the existing `evalCondition(data, ctx)` from `@/features/flows/context`.

- [ ] **Step 1: Write the failing tests:**

```typescript
test('trigger filter false → run succeeds immediately with a skipped trigger, nothing else runs', async () => {
  let agentRan = false
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook', filter: { match: 'all', clauses: [{ left: '{{trigger.input.status}}', op: 'eq', right: 'urgent' }] } } } },
      { id: 'a1', type: 'agent', data: { agentId: 'agent-1', input: 'go' } },
    ],
    edges: [{ source: 'trigger', target: 'a1' }],
  } as FlowGraph
  const result = await interpretFlow(graph, { status: 'routine' }, { runAgent: async () => { agentRan = true; return { output: 'x' } } })
  assert.equal(result.status, 'succeeded')
  assert.equal(agentRan, false)
  assert.equal(result.output, 'Trigger filter did not match — run skipped.')
})

test('trigger filter true → normal execution', async () => {
  /* same graph, input { status: 'urgent' } → agentRan true, status succeeded */
})

test('no filter → unchanged behavior', async () => {
  /* graph with plain { type: 'webhook' } trigger runs normally */
})
```

(Adapt agent-node data + runAgent expectations to the existing tests' minimal shapes — copy from an existing interpret test.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement in `interpretFlow`** — right after `ctx` is initialized and before the main walk starts (locate `let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]`):

```typescript
// Trigger-level filter ("only run when…"): a run whose trigger payload fails
// the filter completes immediately as skipped — no steps execute. Evaluated
// here (not in the dispatchers) so webhook/schedule/signal/manual all share
// one path and the skipped run stays visible in history.
const triggerNode = graph.nodes.find((node) => node.type === 'trigger')
const triggerFilter = (triggerNode?.data.trigger as { filter?: { match?: 'all' | 'any'; clauses?: { left: string; op: ConditionOp; right: string }[] } } | undefined)?.filter
if (triggerFilter?.clauses?.length && !evalCondition(triggerFilter, ctx)) {
  const output = 'Trigger filter did not match — run skipped.'
  const outcome: StepOutcome = { nodeId: triggerNode!.id, status: 'skipped', output }
  opts.onStep?.(outcome)
  return { status: 'succeeded', steps: [outcome], output }
}
```

Import `evalCondition` and `ConditionOp` from their modules (check `StepOutcome` field names against its type at the top of the file and match exactly — including any timing fields the existing `emit` adds; reuse the file's `emit` helper instead of hand-rolling the outcome if it fits).

- [ ] **Step 4: Run the tests** — PASS; full `npm test` green.

- [ ] **Step 5: Drawer UI** (`step-drawer.tsx`, trigger section): under the existing trigger-type controls, for `trigger.type !== 'manual'`, render an "Only run when…" editor writing to `data.trigger.filter`. Reuse the drawer's existing condition-clause editor component if one is factored out; if the condition editor is inline-only, replicate its minimal row pattern (left input / op select / right input + add-clause button + all/any select) writing through the same `onChange(node)` path the other trigger fields use. Keep it small — an empty clause list means no filter.

- [ ] **Step 6: Verify** — `npm run typecheck && npm run lint && npm test` green.
- [ ] **Step 7: Commit** — `git commit -m "feat(flows): trigger-level filter — skip runs whose payload doesn't match"`

---

### Task 5: Full verification, manual drive, parity-gap sweep

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm run build && npm test` — all green.
- [ ] **Step 2: Manual drive** (run skill / `npm run dev`): open a flow in the builder — (a) click-hold-drag on empty background pans; plain click still deselects; node drag-reorder still works; (b) add a condition, drag flow: publish with condition inside a For-each → validation error names the node and suggests Filter; (c) picker shows the webhook trigger as blue Webhook icon named "When an HTTP request is received"; canvas card matches; (d) set a trigger filter, run with a non-matching payload → run history shows the skipped run.
- [ ] **Step 3:** Push `main` (auto-deploys to Vercel) and confirm the deployment goes READY.
- [ ] **Step 4: Parity-gap sweep (E):** dispatch parallel agents — (i) code-inspection of the flow feature surface (triggers/actions/expressions/error-handling/composition), (ii) web research on Power Automate's current feature set, (iii) web research on Workato's — then synthesize a ranked gap report to `docs/parity/2026-07-11-flow-parity-gaps.md`, deduped against the known deferred list (formula/expression mode, try-catch, callable sub-flows, polling triggers w/ cursor, lookup tables, copilot diff-preview, multi-select nodes, resume-from-cursor WS-R2, 2D canvas).
- [ ] **Step 5: Commit** the report; update the `flow-parity-remaining` memory with the outcome.

---

## Self-Review

**Spec coverage:** A→Task 3, B→Task 1, C→Task 2, D→Task 4, E→Task 5 Step 4. Verification section → Task 5 Steps 1-2. ✅
**Placeholders:** Step bodies carry real code; the two "adapt to existing shapes" notes point at concrete files to copy from (existing validate/interpret tests), not open design. ✅
**Type consistency:** `startCanvasPan` signature identical in module, page wiring, and tests; `CONDITION_IN_CONTAINER` code string identical in rule and tests; filter shape identical in test graph, interpret guard, and drawer write path. ✅

## Risks

- The interpret test file's existing cases may assert the old silent-skip (Task 1 Step 7 addresses).
- `setPointerCapture` doesn't exist in jsdom — that's why pan logic lives in the pure `canvas-pan.ts` module and the page wiring is verified by typecheck + manual drive.
- `StepOutcome` shape in Task 4 must be read from the file, not assumed.
