# Flow Node typeVersion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every flow node carries a `typeVersion` so node behavior can evolve without breaking existing flows — with a read-time upgrade registry, unknown-future-version rejection at save and publish, and version stamping on node creation/paste.

**Architecture:** `typeVersion` is an optional field inside the graph JSON (absent ⇒ 1), added to all 23 node variants in the zod discriminated union via a shared `nodeSchema()` builder. A new pure module `src/lib/flows/upgrade.ts` holds per-type upgrade step functions and `upgradeFlowGraph()`, applied at the three read chokepoints (run graph load, publish parse, builder load) so the interpreter stays version-blind. Validation and the save routes reject nodes whose `typeVersion` exceeds `LATEST_TYPE_VERSION` (a node authored by a newer client).

**Tech Stack:** TypeScript, zod v3 (strip mode — unknown keys silently dropped, which is why the field must be explicit in every variant), Prisma (no migration needed — field lives in graph JSON), `node:test` + `node:assert/strict` run via `npm test`.

**Spec:** `docs/superpowers/specs/2026-07-26-flows-n8n-parity-gaps-design.md` §1.

## Global Constraints

- `typeVersion` is `z.number().int().min(1).optional()` — NOT `.default(1)`. A default would make the field required in the inferred `FlowNode` type and break every hand-written node literal in the app and tests. Absent means 1; always read through `nodeTypeVersion(node)`.
- `typeVersion` is NOT a zod discriminator. `z.discriminatedUnion('type', …)` stays exactly as-is.
- Pinned snapshots (`FlowVersion.graph`, `FlowRun.graphSnapshot`) are NEVER rewritten — upgrades happen at read time only.
- Tests live in `__tests__` directories next to the code, use `import { test } from 'node:test'` and `import assert from 'node:assert/strict'`, and run with `npm test` (whole suite) — there is no per-file runner script; to run one file use: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`.
- Do not run `git push`. Commit locally after each task.
- Follow existing comment style: comments state constraints the code can't show, not narration.

---

### Task 1: `typeVersion` in the node schema + `LATEST_TYPE_VERSION`

**Files:**
- Modify: `src/lib/flows/graph.ts` (all 23 node variant definitions, lines ~49–518, and exports at ~520–550)
- Test: `src/lib/flows/__tests__/graph-typeversion.test.ts` (create)

**Interfaces:**
- Produces: every `FlowNode` variant accepts optional `typeVersion?: number` (int ≥ 1); `export const LATEST_TYPE_VERSION: Record<FlowNode['type'], number>` (all `1` today).
- Consumed by: Tasks 2–7.

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/graph-typeversion.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, flowNodeSchema, LATEST_TYPE_VERSION, type FlowNode } from '../graph'

test('typeVersion survives a graph parse (zod strip mode would drop an undeclared key)', () => {
  const graph = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', typeVersion: 1, data: { trigger: { type: 'manual' } } },
      { id: 'n2', type: 'stop', typeVersion: 3, data: {} },
    ],
    edges: [],
  })
  assert.equal(graph.nodes[0].typeVersion, 1)
  assert.equal(graph.nodes[1].typeVersion, 3)
})

test('typeVersion is optional — legacy nodes without it still parse', () => {
  const node = flowNodeSchema.parse({ id: 'n1', type: 'stop', data: {} })
  assert.equal(node.typeVersion, undefined)
})

test('typeVersion rejects zero, negatives, and floats', () => {
  for (const bad of [0, -1, 1.5]) {
    assert.equal(flowNodeSchema.safeParse({ id: 'n1', type: 'stop', typeVersion: bad, data: {} }).success, false)
  }
})

test('LATEST_TYPE_VERSION covers every node type in the union', () => {
  const types = flowNodeSchema.options.map((option) => option.shape.type.value) as FlowNode['type'][]
  assert.equal(types.length, 23)
  for (const type of types) {
    assert.equal(typeof LATEST_TYPE_VERSION[type], 'number', `missing LATEST_TYPE_VERSION for ${type}`)
    assert.ok(LATEST_TYPE_VERSION[type] >= 1)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/graph-typeversion.test.ts`
Expected: FAIL — first test gets `typeVersion: undefined` (zod strips the undeclared key), and `LATEST_TYPE_VERSION` is not exported.

- [ ] **Step 3: Implement in `src/lib/flows/graph.ts`**

Add a builder near the top (after the imports/shared field schemas, before the first variant at line ~49):

```ts
/**
 * Every variant shares the { id, type, typeVersion, data } prefix. Built here
 * so a future variant cannot forget typeVersion — zod v3 is strip-mode, and an
 * undeclared key is silently dropped on EVERY parse (save, publish, run,
 * collaboration, undo), which is exactly how the field would get lost.
 * Optional (absent = 1), not defaulted: a default would make the field
 * required in the inferred FlowNode type and break every hand-written node
 * literal. Read it through nodeTypeVersion() in lib/flows/upgrade.ts.
 */
function nodeSchema<T extends string, D extends z.ZodTypeAny>(type: T, data: D) {
  return z.object({
    id: z.string(),
    type: z.literal(type),
    typeVersion: z.number().int().min(1).optional(),
    data,
  })
}
```

Convert **all 23** variant declarations to it, keeping every `data` shape and comment byte-identical. Pattern (repeat for each; only the wrapper changes):

```ts
// BEFORE
const triggerNode = z.object({
  id: z.string(),
  type: z.literal('trigger'),
  data: z.object({ trigger: z.any().optional() }),
})
// AFTER
const triggerNode = nodeSchema('trigger', z.object({ trigger: z.any().optional() }))
```

The 23 variants (order in the union at line ~520): trigger, agent, condition, loop, parallel, stop, tool, http, code, transform, filter, switch, variable, data, humanReview, respondWebhook, wait, repeatUntil, input, output, subflow, router, errorShield. Where a variant currently has comments above its `data` fields (agent, http, tool, …), the multi-line `z.object({...})` for data moves inside the `nodeSchema(...)` call unchanged.

Then add, next to the union export:

```ts
/**
 * The current schema version per node type. Bump a type's entry when its
 * config/behavior changes shape, and register an upgrader in
 * lib/flows/upgrade.ts (lossless) — or, for a genuinely behavior-breaking
 * bump with no lossless mapping, leave the gap and branch on typeVersion in
 * the interpreter's branch for that type (the ONLY place allowed to).
 */
export const LATEST_TYPE_VERSION: Record<FlowNode['type'], number> = {
  trigger: 1, agent: 1, condition: 1, loop: 1, parallel: 1, stop: 1, tool: 1,
  http: 1, code: 1, transform: 1, filter: 1, switch: 1, variable: 1, data: 1,
  humanReview: 1, respondWebhook: 1, wait: 1, repeatUntil: 1, input: 1,
  output: 1, subflow: 1, router: 1, errorShield: 1,
}
```

(`Record<FlowNode['type'], number>` gives compile-time totality — a 24th variant without an entry fails `tsc`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/graph-typeversion.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Run the whole suite to catch regressions**

Run: `npm test`
Expected: PASS — the field is optional, so no existing literal or fixture breaks. If `flowNodeSchema.options[...].shape` typing trips the union test, fix the test, not the schema.

- [ ] **Step 6: Commit**

```bash
git add src/lib/flows/graph.ts src/lib/flows/__tests__/graph-typeversion.test.ts
git commit -m "feat(flows): typeVersion field on every node variant via shared nodeSchema builder"
```

---

### Task 2: Upgrade module (`upgrade.ts`)

**Files:**
- Create: `src/lib/flows/upgrade.ts`
- Test: `src/lib/flows/__tests__/upgrade.test.ts` (create)

**Interfaces:**
- Consumes: `LATEST_TYPE_VERSION`, `FlowGraph`, `FlowNode` from `./graph` (Task 1).
- Produces:
  - `nodeTypeVersion(node: { typeVersion?: number }): number` — absent ⇒ 1.
  - `NODE_UPGRADERS: Partial<Record<FlowNode['type'], Record<number, (node: FlowNode) => FlowNode>>>` — key N holds the vN→vN+1 step.
  - `upgradeFlowGraph(graph: FlowGraph): { graph: FlowGraph; upgraded: { nodeId: string; type: FlowNode['type']; from: number; to: number }[] }`
  - `unknownTypeVersionNodes(graph: FlowGraph): FlowNode[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/upgrade.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph, FlowNode } from '../graph'
import { LATEST_TYPE_VERSION } from '../graph'
import { NODE_UPGRADERS, nodeTypeVersion, unknownTypeVersionNodes, upgradeFlowGraph } from '../upgrade'

const stop = (typeVersion?: number): FlowNode => ({ id: 'n2', type: 'stop', ...(typeVersion ? { typeVersion } : {}), data: { reason: 'done' } })
const graphWith = (...nodes: FlowNode[]): FlowGraph => ({
  nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }, ...nodes],
  edges: [],
})

test('nodeTypeVersion treats absent as 1', () => {
  assert.equal(nodeTypeVersion({}), 1)
  assert.equal(nodeTypeVersion({ typeVersion: 4 }), 4)
})

test('upgradeFlowGraph is identity when everything is at latest', () => {
  const graph = graphWith(stop())
  const result = upgradeFlowGraph(graph)
  assert.equal(result.graph, graph) // same reference — no pointless copy
  assert.deepEqual(result.upgraded, [])
})

test('upgradeFlowGraph chains registered steps to latest and reports them', (t) => {
  // Simulate stop v3 with two lossless steps. Registry and LATEST are
  // restored after the test so other tests see the real world.
  const realLatest = LATEST_TYPE_VERSION.stop
  ;(LATEST_TYPE_VERSION as Record<string, number>).stop = 3
  NODE_UPGRADERS.stop = {
    1: (node) => ({ ...node, data: { ...node.data, note: 'v2' } } as FlowNode),
    2: (node) => ({ ...node, data: { ...node.data, note: 'v3' } } as FlowNode),
  }
  t.after(() => {
    ;(LATEST_TYPE_VERSION as Record<string, number>).stop = realLatest
    delete NODE_UPGRADERS.stop
  })
  const result = upgradeFlowGraph(graphWith(stop()))
  const upgraded = result.graph.nodes.find((node) => node.id === 'n2')!
  assert.equal(upgraded.typeVersion, 3)
  assert.equal((upgraded.data as { note?: string }).note, 'v3')
  assert.deepEqual(result.upgraded, [{ nodeId: 'n2', type: 'stop', from: 1, to: 3 }])
  // Non-destructive: the input graph object was not mutated.
  assert.equal(nodeTypeVersion(graphWith(stop()).nodes[1]), 1)
})

test('upgradeFlowGraph stops at a registry gap (behavior-breaking bump)', (t) => {
  const realLatest = LATEST_TYPE_VERSION.stop
  ;(LATEST_TYPE_VERSION as Record<string, number>).stop = 3
  NODE_UPGRADERS.stop = { 2: (node) => node } // no 1→2 step registered
  t.after(() => {
    ;(LATEST_TYPE_VERSION as Record<string, number>).stop = realLatest
    delete NODE_UPGRADERS.stop
  })
  const result = upgradeFlowGraph(graphWith(stop()))
  assert.equal(nodeTypeVersion(result.graph.nodes.find((node) => node.id === 'n2')!), 1)
  assert.deepEqual(result.upgraded, [])
})

test('unknownTypeVersionNodes flags only future versions', () => {
  const graph = graphWith(stop(1), { ...stop(99), id: 'n3' })
  assert.deepEqual(unknownTypeVersionNodes(graph).map((node) => node.id), ['n3'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/upgrade.test.ts`
Expected: FAIL — module `../upgrade` does not exist.

- [ ] **Step 3: Create `src/lib/flows/upgrade.ts`**

```ts
/**
 * Read-time node upgrades (spec 2026-07-26 §1). A version bump ships a
 * lossless vN→vN+1 step here whenever a lossless mapping exists; the
 * interpreter then only ever sees latest-version nodes. A gap in the registry
 * means a deliberate behavior-breaking bump — those nodes keep their version
 * and the interpreter's branch for that type is the ONLY place allowed to
 * branch on typeVersion.
 *
 * Non-destructive: callers upgrade what they READ. FlowVersion.graph and
 * FlowRun.graphSnapshot are never rewritten.
 */
import { LATEST_TYPE_VERSION, type FlowGraph, type FlowNode } from './graph'

/** Absent typeVersion means 1 — every graph authored before the field existed. */
export function nodeTypeVersion(node: { typeVersion?: number }): number {
  return node.typeVersion ?? 1
}

type NodeUpgrader = (node: FlowNode) => FlowNode

/** Per-type upgrade steps: NODE_UPGRADERS[type][N] maps vN → vN+1. */
export const NODE_UPGRADERS: Partial<Record<FlowNode['type'], Record<number, NodeUpgrader>>> = {}

export type GraphUpgrade = { nodeId: string; type: FlowNode['type']; from: number; to: number }

/** Walk every node to the latest reachable version. Identity (same reference) when nothing changes. */
export function upgradeFlowGraph(graph: FlowGraph): { graph: FlowGraph; upgraded: GraphUpgrade[] } {
  const upgraded: GraphUpgrade[] = []
  const nodes = graph.nodes.map((node) => {
    const from = nodeTypeVersion(node)
    const latest = LATEST_TYPE_VERSION[node.type]
    let current = node
    let version = from
    while (version < latest) {
      const step = NODE_UPGRADERS[node.type]?.[version]
      if (!step) break
      current = { ...step(current), typeVersion: version + 1 } as FlowNode
      version += 1
    }
    if (version !== from) upgraded.push({ nodeId: node.id, type: node.type, from, to: version })
    return current
  })
  return upgraded.length ? { graph: { ...graph, nodes }, upgraded } : { graph, upgraded }
}

/** Nodes authored by a NEWER client than this server — reject, never guess. */
export function unknownTypeVersionNodes(graph: FlowGraph): FlowNode[] {
  return graph.nodes.filter((node) => nodeTypeVersion(node) > LATEST_TYPE_VERSION[node.type])
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/upgrade.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/upgrade.ts src/lib/flows/__tests__/upgrade.test.ts
git commit -m "feat(flows): upgrade registry + upgradeFlowGraph read-time normalization"
```

---

### Task 3: Stamp `typeVersion` on create and paste

**Files:**
- Modify: `src/lib/flows/mutate.ts` (`makeNode` ~line 84, `pasteNodeAfter` ~line 534)
- Test: `src/lib/flows/__tests__/mutate.test.ts` (append)

**Interfaces:**
- Consumes: `LATEST_TYPE_VERSION` (Task 1).
- Produces: every node created via `insertNodeAfter`/`addContainerStep`/`makeNode` (including container body steps) carries `typeVersion: LATEST_TYPE_VERSION[type]`; `pasteNodeAfter` preserves the copied node's `typeVersion`.

- [ ] **Step 1: Write the failing tests (append to `src/lib/flows/__tests__/mutate.test.ts`)**

```ts
import { LATEST_TYPE_VERSION } from '../graph'

test('insertNodeAfter stamps the current typeVersion on the node and container body', () => {
  const { graph } = insertNodeAfter(emptyGraph(), 'trigger', 'loop')
  const loop = graph.nodes.find((n) => n.type === 'loop')!
  const body = graph.nodes.find((n) => n.type === 'agent')!
  assert.equal(loop.typeVersion, LATEST_TYPE_VERSION.loop)
  assert.equal(body.typeVersion, LATEST_TYPE_VERSION.agent)
})

test('pasteNodeAfter preserves the copied node typeVersion', () => {
  const copied = sanitizeCopiedNode({ id: 'x', type: 'stop', typeVersion: 1, data: { reason: 'r' } })!
  const { graph, nodeId } = pasteNodeAfter(emptyGraph(), 'trigger', copied)
  assert.equal(graph.nodes.find((n) => n.id === nodeId)!.typeVersion, 1)
})
```

(The existing file already imports `insertNodeAfter`, `sanitizeCopiedNode`, `pasteNodeAfter`, `emptyGraph`, `test`, `assert` — only add the `LATEST_TYPE_VERSION` import.)

- [ ] **Step 2: Run to verify both fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/mutate.test.ts`
Expected: the two new tests FAIL with `undefined !== 1` (nodes created without the field; paste drops it).

- [ ] **Step 3: Implement in `src/lib/flows/mutate.ts`**

Import `LATEST_TYPE_VERSION` from `@/lib/flows/graph`. In `makeNode`, stamp both the container body and the node itself:

```ts
function makeNode(graph: FlowGraph, type: StepType, agentId?: string): { node: FlowNode; extraNodes: FlowNode[] } {
  const id = newNodeId(graph)
  // Containers are born with one agent body step so they are runnable.
  if (type === 'loop' || type === 'parallel' || type === 'errorShield' || type === 'repeatUntil') {
    const bodyId = `${id}b1`
    const body = {
      id: bodyId,
      type: 'agent',
      typeVersion: LATEST_TYPE_VERSION.agent,
      data: {
        agentId: agentId ?? '',
        input: type === 'loop' ? 'Process this item:\n{{item}}' : 'Use this flow input:\n{{trigger.input}}',
      },
    } as FlowNode
    return { node: { id, type, typeVersion: LATEST_TYPE_VERSION[type], data: defaultData(type, { bodyId }) } as FlowNode, extraNodes: [body] }
  }
  return { node: { id, type, typeVersion: LATEST_TYPE_VERSION[type], data: defaultData(type, { agentId }) } as FlowNode, extraNodes: [] }
}
```

In `pasteNodeAfter`, the rebuilt copy must carry the field (this is the one path that reconstructs `{ id, type, data }` by hand and would silently drop it):

```ts
const copy = { id: copyId, type: copied.type, typeVersion: copied.typeVersion, data: JSON.parse(JSON.stringify(copied.data)) } as FlowNode
```

- [ ] **Step 4: Run the file's tests, then the whole suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/mutate.test.ts` → PASS
Run: `npm test` → PASS (existing mutate/dag-mutate/copilot tests assert on `data`/edges, not exact node key sets — if one does a `deepEqual` on a whole node and fails, update that assertion to include `typeVersion`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/mutate.ts src/lib/flows/__tests__/mutate.test.ts
git commit -m "feat(flows): stamp typeVersion on node create and carry it through paste"
```

---

### Task 4: `UNKNOWN_TYPE_VERSION` validation issue

**Files:**
- Modify: `src/lib/flows/validate.ts` (inside `validateFlowGraph`'s per-node loop, right after the `DUPLICATE_NODE_ID` block ~line 366)
- Test: `src/lib/flows/__tests__/validate.test.ts` (append)

**Interfaces:**
- Consumes: `nodeTypeVersion` from `./upgrade`, `LATEST_TYPE_VERSION` from `./graph`.
- Produces: `validateFlowGraph` emits `{ level: 'error', code: 'UNKNOWN_TYPE_VERSION', nodeId }` for any node with `typeVersion > LATEST_TYPE_VERSION[type]`. (Publish and run already call `validateFlowGraph`, so they block for free.)

- [ ] **Step 1: Write the failing test (append to `src/lib/flows/__tests__/validate.test.ts`)**

Match the file's existing helpers/style (it already builds graphs inline and asserts on issue codes):

```ts
test('a node with a future typeVersion is an UNKNOWN_TYPE_VERSION error', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'n2', type: 'stop', typeVersion: 99, data: {} },
    ],
    edges: [{ id: 'trigger->n2', source: 'trigger', target: 'n2' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_TYPE_VERSION' && issue.nodeId === 'n2'))
})

test('typeVersion at latest (or absent) raises no version issue', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'n2', type: 'stop', typeVersion: 1, data: {} },
      { id: 'n3', type: 'stop', data: {} },
    ],
    edges: [],
  }
  assert.ok(!validateFlowGraph(graph).issues.some((issue) => issue.code === 'UNKNOWN_TYPE_VERSION'))
})
```

If `FlowGraph`/`validateFlowGraph`/`assert`/`test` imports differ from what the file already has, follow the file.

- [ ] **Step 2: Run to verify the first test fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/validate.test.ts`
Expected: new test 1 FAILS (no such code emitted); test 2 passes vacuously.

- [ ] **Step 3: Implement in `src/lib/flows/validate.ts`**

Add imports: `LATEST_TYPE_VERSION` to the existing `@/lib/flows/graph` import; `nodeTypeVersion` from `@/lib/flows/upgrade`. In the first `for (const node of graph.nodes)` loop (the one that builds `byId` and reports `DUPLICATE_NODE_ID`), add:

```ts
    // A newer client authored this node; running it with older semantics
    // would be a silent behavior change — refuse instead (spec 2026-07-26 §1).
    if (nodeTypeVersion(node) > LATEST_TYPE_VERSION[node.type]) {
      add(issues, 'error', 'UNKNOWN_TYPE_VERSION', `${nodeLabel(node)} was built with a newer version of Sublime than this one — upgrade, or rebuild the step.`, node.id)
    }
```

- [ ] **Step 4: Run the file's tests, then the whole suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/validate.test.ts` → PASS
Run: `npm test` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/validate.ts src/lib/flows/__tests__/validate.test.ts
git commit -m "feat(flows): UNKNOWN_TYPE_VERSION validation error for future-version nodes"
```

---

### Task 5: Apply upgrades at the read chokepoints; reject future versions at save

**Files:**
- Modify: `src/lib/flows/publish.ts` (~line 36–38)
- Modify: `src/features/flows/execute-flow.ts` (~line 220, `graph = flowGraphSchema.parse(source)`)
- Modify: `src/app/api/flows/route.ts` (POST create + PUT save handlers)
- Modify: `src/app/flows/[id]/page.tsx` (builder graph loads at ~line 487 and ~1049)
- Test: `src/lib/flows/__tests__/upgrade.test.ts` (already covers the pure function; this task is wiring — verified by suite + typecheck)

**Interfaces:**
- Consumes: `upgradeFlowGraph`, `unknownTypeVersionNodes` (Task 2).
- Produces: runs, publishes, and the builder all operate on upgraded graphs; `POST /api/flows` and `PUT /api/flows` return 400 `UNKNOWN_TYPE_VERSION` when a submitted graph contains a future-version node.

- [ ] **Step 1: `publish.ts` — upgrade after parse**

```ts
import { upgradeFlowGraph } from '@/lib/flows/upgrade'
// ...
  const parsed = flowGraphSchema.safeParse(existing.graph)
  if (!parsed.success) return { published: false, reason: 'Flow graph is not valid' }
  // Publish the UPGRADED graph: the published snapshot is what scheduled and
  // triggered runs execute, so it must be at latest before validation sees it.
  const graph = upgradeFlowGraph(parsed.data).graph
```

(No other change — `graph` flows into validation, `publishedGraph`, and the `FlowVersion` row exactly as before.)

- [ ] **Step 2: `execute-flow.ts` — upgrade the run graph**

At the graph-resolution line inside `runFlowExecution` (~line 220):

```ts
import { upgradeFlowGraph } from '@/lib/flows/upgrade'
// ...
    // Read-time upgrade: pinned snapshots (graphSnapshot) are never rewritten,
    // so a resumed old run is normalized here, at read, every time.
    graph = upgradeFlowGraph(flowGraphSchema.parse(source)).graph
```

- [ ] **Step 3: `src/app/api/flows/route.ts` — reject future versions on save**

In both handlers, right after `body` is parsed (POST parses `flowSchema`; PUT parses the merged object — both have optional `graph`):

```ts
import { unknownTypeVersionNodes } from '@/lib/flows/upgrade'
// ...
  if (body.graph) {
    const unknown = unknownTypeVersionNodes(body.graph)
    if (unknown.length) {
      // An older server accepting a newer client's nodes is the realistic
      // corruption path — schema parse alone would let it straight through.
      throw new ApiError('This flow uses steps from a newer version of Sublime — update before saving here.', 400, 'UNKNOWN_TYPE_VERSION')
    }
  }
```

(`ApiError` is already imported in this file; match the existing `throw new ApiError(...)` style.)

- [ ] **Step 4: `src/app/flows/[id]/page.tsx` — upgrade on builder load**

At the two places raw flow JSON becomes builder state:
- ~line 487: `const g = flow.graph as FlowGraph` → `const g = upgradeFlowGraph(flow.graph as FlowGraph).graph`
- ~line 1049: `setGraph(data.flow.graph)` → `setGraph(upgradeFlowGraph(data.flow.graph as FlowGraph).graph)`

Add the import (`upgradeFlowGraph` from `@/lib/flows/upgrade`; `FlowGraph` type is already imported). Do NOT touch line ~374 `setGraph(remote)` — that is the collaboration reconcile path, whose graphs came from this same page and are already upgraded.

- [ ] **Step 5: Typecheck and full suite**

Run: `npx tsc --noEmit` (or the project's typecheck script if one exists in `package.json` — check `npm run` output)
Expected: clean.
Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/flows/publish.ts src/features/flows/execute-flow.ts src/app/api/flows/route.ts 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): upgrade graphs at run/publish/builder read; reject future typeVersion at save"
```

---

### Task 6: Collaboration patch guard

**Files:**
- Modify: `src/lib/flows/collaboration.ts` (`nodeFieldsChangeSchema` ~line 39, the field-diff producer ~line 89, `applyFieldChanges` ~line 210)
- Test: `src/lib/flows/__tests__/collaboration.test.ts` (append)

**Interfaces:**
- Consumes: `nodeTypeVersion` (Task 2).
- Produces: `nodeFieldsChangeSchema` gains `typeVersion: z.number().int().min(1).optional()`; a field patch whose `typeVersion` doesn't match the node's current effective version is rejected as a conflict (`node:<id>`), exactly like the existing `type` guard. Patches without the key (older clients) apply as today.

- [ ] **Step 1: Write the failing test (append to `src/lib/flows/__tests__/collaboration.test.ts`)**

Follow the file's existing patch-building helpers (read them first — it has tests for the `type` guard to crib from):

```ts
test('a field patch from a stale peer (older typeVersion) is a conflict, not an apply', () => {
  // Node is at v2; the patch was diffed against v1.
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'n2', type: 'stop', typeVersion: 2, data: { reason: 'current' } },
    ],
    edges: [],
  }
  const { graph: next, conflicts } = applyFlowCollaborationPatch(graph, {
    mutationId: 'm1',
    nodes: [],
    edges: [],
    layout: [],
    nodeFields: [{ id: 'n2', type: 'stop', typeVersion: 1, fields: [{ key: 'reason', before: 'current', after: 'stale-edit' }] }],
  })
  assert.ok(conflicts.includes('node:n2'))
  const node = next.nodes.find((n) => n.id === 'n2')!
  assert.equal((node.data as { reason?: string }).reason, 'current')
})

test('a field patch without typeVersion (older client) still applies', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'n2', type: 'stop', data: { reason: 'old' } },
    ],
    edges: [],
  }
  const { graph: next, conflicts } = applyFlowCollaborationPatch(graph, {
    mutationId: 'm2',
    nodes: [],
    edges: [],
    layout: [],
    nodeFields: [{ id: 'n2', type: 'stop', fields: [{ key: 'reason', before: 'old', after: 'new' }] }],
  })
  assert.ok(!conflicts.includes('node:n2'))
  assert.equal((next.nodes.find((n) => n.id === 'n2')!.data as { reason?: string }).reason, 'new')
})
```

Adjust the patch literal shape to whatever `flowCollaborationPatchSchema` actually requires (the file's existing tests show the exact shape — `fieldChangeSchema` keys may differ; follow them).

- [ ] **Step 2: Run to verify the first test fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/collaboration.test.ts`
Expected: first new test FAILS (the stale patch applies today); second passes.

- [ ] **Step 3: Implement in `src/lib/flows/collaboration.ts`**

Schema:

```ts
const nodeFieldsChangeSchema = z.object({
  id: z.string().min(1),
  // Type guard: a field patch only applies while the node is still this type.
  type: z.string().min(1),
  // Version guard: and still this typeVersion — a peer that diffed against v1
  // must not land field SETs on a node another peer upgraded to v2. Optional
  // so older clients' patches stay valid (they skip the check).
  typeVersion: z.number().int().min(1).optional(),
  fields: z.array(fieldChangeSchema).min(1).max(64),
})
```

In `applyFieldChanges`, next to the existing `existing.type !== change.type` rejection (find it just above line ~220 — it pushes `node:<id>` into conflicts and `continue`s), add the same treatment:

```ts
    if (change.typeVersion !== undefined && nodeTypeVersion(existing) !== change.typeVersion) {
      conflicts.push(`node:${change.id}`)
      continue
    }
```

In the producer that builds `NodeFieldsChange` objects (the per-key diff around line ~89 — it already sets `id` and `type` from the node), also set `typeVersion: nodeTypeVersion(after)` where `after` is the post-edit node it diffs toward. Import `nodeTypeVersion` from `./upgrade`.

- [ ] **Step 4: Run the file's tests, then the whole suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/collaboration.test.ts` → PASS
Run: `npm test` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/collaboration.ts src/lib/flows/__tests__/collaboration.test.ts
git commit -m "feat(flows): collaboration field patches guard on typeVersion"
```

---

### Task 7: Portable export version bump + final verification

**Files:**
- Modify: `src/lib/export/portable.ts` (line 28)
- Test: `src/lib/export/__tests__/export.test.ts` (update any assertion pinning `version: 1`)

**Interfaces:**
- Consumes: nothing new — `sanitizeNode` spreads nodes, so `typeVersion` already travels.
- Produces: `PORTABLE_VERSION = 2`. (There is no import route today — imports happen by future tooling; the schema's optional field means a v1 document without `typeVersion` parses fine forever.)

- [ ] **Step 1: Bump the constant**

```ts
// v2 (2026-07-26): nodes carry typeVersion. v1 documents (no typeVersion)
// remain readable — the field is optional and absent means 1.
export const PORTABLE_VERSION = 2
```

- [ ] **Step 2: Fix any pinned assertions**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/export/__tests__/export.test.ts`
If an assertion expects `version: 1`, update it to `PORTABLE_VERSION` (import the constant rather than re-pinning a literal).

- [ ] **Step 3: Full verification**

Run: `npm test` → PASS (whole suite)
Run: `npx tsc --noEmit` (or project typecheck script) → clean
Run: `npm run build` → succeeds (per project memory: `next build` + route smoke is the no-credentials verification protocol; if deeper verification is wanted, use the `verify` skill's throwaway-Postgres route-smoke).

- [ ] **Step 4: Commit**

```bash
git add src/lib/export/portable.ts src/lib/export/__tests__/export.test.ts
git commit -m "feat(flows): portable export v2 — nodes carry typeVersion"
```

---

## Explicitly deferred (matches spec §1 — do not build now)

- No version-aware `NODE_BODIES` registry or per-version UI: every type is at v1, and the read-time upgrade policy means the UI sees latest-only until a behavior-breaking bump actually ships.
- No "outdated node" badge — nothing can be outdated while everything is v1 and upgrades are silent.
- No backfill stamping `typeVersion: 1` into stored graphs — absent means 1 by contract.
