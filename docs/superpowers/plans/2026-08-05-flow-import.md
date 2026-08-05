# Flow Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users create a flow from JSON — uploaded file, URL, or pasted text — accepting Sublime's portable export, the builder's bare download, and n8n workflow JSON (converted deterministically).

**Architecture:** Pure converter modules under `src/lib/import/` (detect → convert → sanitize), one new route `POST /api/flows/import` that orchestrates conversion + agent materialization + flow creation in a transaction, and an `ImportFlowDialog` on the flows list page. Spec: `docs/superpowers/specs/2026-08-05-flow-import-design.md`.

**Tech Stack:** Next.js route handlers, zod, Prisma, `node:test` via tsx, hand-rolled shadcn-style UI components.

## Global Constraints

- Branch: `feat/flow-import`. Commit after every task.
- Test runner: `npm test` runs ALL tests; run one file with `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`.
- DB-backed tests are skipped unless `TEST_DATABASE_URL` is set (see `src/app/api/__tests__/template-flow-e2e.test.ts:31-34`; the repo's `verify` skill spins up throwaway Postgres).
- Never import server-only modules (`@/lib/server/api-handler`, prisma) into `src/lib/import/*` converters — they must stay pure so unit tests need no DB.
- Secrets NEVER survive an import: `webhookSecretHash`, `webhookSecretEnc`, `credentials` block, `credentialId`, raw foreign connection ids.
- Created flows are always `status: 'DRAFT'`, `visibility: 'private'`, `version: 1`, `publishedGraph` unset.
- The sanitized graph must pass `flowGraphSchema.parse` before any DB write; `validateFlowGraph` failures become report warnings, not rejections.
- The trigger node in a Sublime graph MUST have id exactly `'trigger'` (validate.ts:371 enforces it).
- Concurrent commits from other sessions may land mid-task (see memory) — `git add` specific paths, never `git add -A`.

---

### Task 1: Import types + format detection

**Files:**
- Create: `src/lib/import/types.ts`
- Create: `src/lib/import/detect.ts`
- Test: `src/lib/import/__tests__/detect.test.ts`

**Interfaces:**
- Produces: `ImportedFlow`, `StubbedNode`, `FlowImportSource`, `FlowImportError` (types.ts); `detectFlowImportFormat(doc: unknown): DetectedImportFormat` (detect.ts). All later tasks consume these.

- [ ] **Step 1: Write the failing test**

`src/lib/import/__tests__/detect.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectFlowImportFormat } from '../detect'

test('detects a sublime.flow portable document', () => {
  assert.equal(detectFlowImportFormat({ format: 'sublime.flow', version: 1, flow: {} }), 'sublime-portable')
})

test('detects a sublime.agent document (so the route can give a targeted error)', () => {
  assert.equal(detectFlowImportFormat({ format: 'sublime.agent', version: 1 }), 'sublime-agent')
})

test('detects an n8n workflow by nodes + connections', () => {
  assert.equal(detectFlowImportFormat({ name: 'wf', nodes: [], connections: {} }), 'n8n')
})

test('detects the builder bare download by a top-level graph', () => {
  assert.equal(
    detectFlowImportFormat({ name: 'My flow', version: 3, graph: { nodes: [], edges: [] } }),
    'sublime-download',
  )
})

test('n8n wins over download when both keys exist (n8n has no top-level graph)', () => {
  assert.equal(detectFlowImportFormat({ nodes: [], connections: {}, graph: { nodes: [], edges: [] } }), 'n8n')
})

test('rejects junk', () => {
  assert.equal(detectFlowImportFormat(null), null)
  assert.equal(detectFlowImportFormat('[]'), null)
  assert.equal(detectFlowImportFormat({ hello: 'world' }), null)
  assert.equal(detectFlowImportFormat({ graph: { nodes: 'no' } }), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/detect.test.ts`
Expected: FAIL — cannot find module `../detect`.

- [ ] **Step 3: Write the implementation**

`src/lib/import/types.ts`:

```ts
/**
 * Flow import — shared types for the converters (detect → convert → sanitize)
 * and the /api/flows/import route that orchestrates them.
 */
import type { FlowGraph } from '@/lib/flows/graph'
import type { FlowTrigger } from '@/lib/flows/trigger'
import type { PortableAgent } from '@/lib/export/portable'

export type FlowImportSource = 'sublime-portable' | 'sublime-download' | 'n8n'

/** An n8n integration node imported as an HTTP stub — reported, never silent. */
export type StubbedNode = { nodeId: string; label: string; originalType: string }

export type ImportedFlow = {
  name: string
  description: string
  trigger: FlowTrigger
  graph: FlowGraph
  /** Agents inlined in a portable doc — materialized on import, then agent refs remapped. */
  agentsToCreate: PortableAgent[]
  source: FlowImportSource
  warnings: string[]
  stubbedNodes: StubbedNode[]
}

/** Converter-level failure with a stable code the route maps onto ApiError. */
export class FlowImportError extends Error {
  constructor(
    message: string,
    readonly code: 'UNRECOGNIZED_FORMAT' | 'AGENT_EXPORT' | 'INVALID_GRAPH',
  ) {
    super(message)
    this.name = 'FlowImportError'
  }
}
```

`src/lib/import/detect.ts`:

```ts
/**
 * Format sniffing for /api/flows/import. Order matters: the portable formats
 * declare themselves via `format`; n8n is `nodes` + `connections` (it never
 * has a top-level `graph`); the builder's bare download is `{ graph }`.
 */
import { PORTABLE_AGENT_FORMAT, PORTABLE_FORMAT } from '@/lib/export/portable'

export type DetectedImportFormat = 'sublime-portable' | 'sublime-download' | 'n8n' | 'sublime-agent' | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function detectFlowImportFormat(doc: unknown): DetectedImportFormat {
  if (!isRecord(doc)) return null
  if (doc.format === PORTABLE_FORMAT) return 'sublime-portable'
  if (doc.format === PORTABLE_AGENT_FORMAT) return 'sublime-agent'
  if (Array.isArray(doc.nodes) && isRecord(doc.connections)) return 'n8n'
  if (isRecord(doc.graph) && Array.isArray(doc.graph.nodes) && Array.isArray(doc.graph.edges)) return 'sublime-download'
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/detect.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/types.ts src/lib/import/detect.ts src/lib/import/__tests__/detect.test.ts
git commit -m "feat(import): flow-import types and format detection"
```

---

### Task 2: Graph sanitizer — strip foreign secrets and refs

**Files:**
- Create: `src/lib/import/sanitize.ts`
- Test: `src/lib/import/__tests__/sanitize.test.ts`

**Interfaces:**
- Consumes: `FlowGraph`, `FlowNode` from `@/lib/flows/graph`.
- Produces:
  - `sanitizeImportedGraph(graph: FlowGraph): { graph: FlowGraph; warnings: string[] }`
  - `remapAgentRefs(graph: FlowGraph, refToId: Record<string, string>): { graph: FlowGraph; clearedRefs: string[] }`

- [ ] **Step 1: Write the failing test**

`src/lib/import/__tests__/sanitize.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { remapAgentRefs, sanitizeImportedGraph } from '../sanitize'

function graphWith(nodes: FlowGraph['nodes'], edges: FlowGraph['edges'] = []): FlowGraph {
  return { nodes, edges }
}

test('strips webhook secrets from the trigger node', () => {
  const { graph } = sanitizeImportedGraph(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook', webhookSecretHash: 'h', webhookSecretEnc: 'e', path: 'x' } } },
  ]))
  const trigger = graph.nodes[0] as Extract<FlowGraph['nodes'][number], { type: 'trigger' }>
  const data = trigger.data.trigger as Record<string, unknown>
  assert.equal(data.webhookSecretHash, undefined)
  assert.equal(data.webhookSecretEnc, undefined)
  assert.equal(data.path, 'x')
})

test('renames a mislabeled trigger node to id "trigger" and remaps edges', () => {
  const { graph } = sanitizeImportedGraph(graphWith(
    [
      { id: 'start-7', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'a', type: 'stop', data: {} },
    ],
    [{ id: 'e1', source: 'start-7', target: 'a' }],
  ))
  assert.equal(graph.nodes[0].id, 'trigger')
  assert.equal(graph.edges[0].source, 'trigger')
})

test('clears foreign tool connection ids but keeps portable ones', () => {
  const { graph, warnings } = sanitizeImportedGraph(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 't1', type: 'tool', data: { connectionId: 'cmb1xyzforeign', toolName: 'send' } },
    { id: 't2', type: 'tool', data: { connectionId: 'nango:slack', toolName: 'slack_post_message' } },
    { id: 't3', type: 'tool', data: { connectionId: 'template:slack', toolName: 'slack_post_message' } },
  ]))
  const [, t1, t2, t3] = graph.nodes as Array<Extract<FlowGraph['nodes'][number], { type: 'tool' }>>
  assert.equal(t1.data.connectionId, '')
  assert.equal(t2.data.connectionId, 'nango:slack')
  assert.equal(t3.data.connectionId, 'template:slack')
  assert.equal(warnings.filter((w) => w.includes('another workspace')).length, 1)
})

test('drops http credentialId and foreign http connectionId', () => {
  const { graph, warnings } = sanitizeImportedGraph(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'h1', type: 'http', data: { url: 'https://api.example.com', method: 'GET', credentialId: 'cred_foreign', connectionId: 'cmbforeign' } },
  ]))
  const http = graph.nodes[1] as Extract<FlowGraph['nodes'][number], { type: 'http' }>
  assert.equal(http.data.credentialId, undefined)
  assert.equal(http.data.connectionId, undefined)
  assert.ok(warnings.length >= 1)
})

test('clears subflow flowId', () => {
  const { graph, warnings } = sanitizeImportedGraph(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 's1', type: 'subflow', data: { flowId: 'someforeignflow' } },
  ]))
  const sub = graph.nodes[1] as Extract<FlowGraph['nodes'][number], { type: 'subflow' }>
  assert.equal(sub.data.flowId, '')
  assert.ok(warnings.some((w) => w.includes('another flow')))
})

test('deduplicates colliding node ids and follows edges', () => {
  const { graph } = sanitizeImportedGraph(graphWith(
    [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'a', type: 'stop', data: {} },
      { id: 'a', type: 'stop', data: {} },
    ],
    [{ id: 'e1', source: 'trigger', target: 'a' }],
  ))
  const ids = graph.nodes.map((node) => node.id)
  assert.equal(new Set(ids).size, 3)
  // The FIRST occurrence keeps the id, so existing edges still point at it.
  assert.equal(graph.edges[0].target, 'a')
})

test('remapAgentRefs replaces mapped refs and clears unmapped ones', () => {
  const { graph, clearedRefs } = remapAgentRefs(graphWith([
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'g1', type: 'agent', data: { agentId: 'ref-1' } },
    { id: 'g2', type: 'agent', data: { agentId: 'ref-2' } },
    { id: 'g3', type: 'agent', data: { agentId: '', prompt: 'inline' } },
  ]), { 'ref-1': 'new-id-1' })
  const [, g1, g2, g3] = graph.nodes as Array<Extract<FlowGraph['nodes'][number], { type: 'agent' }>>
  assert.equal(g1.data.agentId, 'new-id-1')
  assert.equal(g2.data.agentId, '')
  assert.equal(g3.data.agentId, '')
  assert.deepEqual(clearedRefs, ['ref-2'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/sanitize.test.ts`
Expected: FAIL — cannot find module `../sanitize`.

- [ ] **Step 3: Write the implementation**

`src/lib/import/sanitize.ts`:

```ts
/**
 * Post-conversion sanitizer: an imported graph is UNTRUSTED and came from
 * ANOTHER WORKSPACE. Everything that references that workspace — connection
 * row ids, credential vault ids, subflow ids, webhook secrets — is stripped
 * or cleared here, with a human-readable warning per removal. Portable
 * connection ids (nango:/native:/template:) are the documented exception
 * (see src/lib/flows/starter-templates.ts:5-20).
 */
import type { FlowGraph } from '@/lib/flows/graph'

const PORTABLE_CONNECTION_ID = /^(nango:|native:|template:)/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function labelOf(node: FlowGraph['nodes'][number]): string {
  const data = node.data as { label?: string }
  return data.label?.trim() || node.type
}

/** First occurrence keeps its id; later collisions get a numeric suffix. */
function dedupeNodeIds(graph: FlowGraph): void {
  const seen = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id || seen.has(node.id)) {
      const base = node.id || 'step'
      let next = base
      for (let n = 2; seen.has(next) || !next; n += 1) next = `${base}-${n}`
      node.id = next
    }
    seen.add(node.id)
  }
}

/** Rename node `from` to `to` and follow every edge + layout entry. */
function renameNode(graph: FlowGraph, from: string, to: string): void {
  for (const node of graph.nodes) if (node.id === from) node.id = to
  for (const edge of graph.edges) {
    if (edge.source === from) edge.source = to
    if (edge.target === from) edge.target = to
  }
  if (graph.layout && graph.layout[from]) {
    graph.layout[to] = graph.layout[from]
    delete graph.layout[from]
  }
}

export function sanitizeImportedGraph(input: FlowGraph): { graph: FlowGraph; warnings: string[] } {
  const graph: FlowGraph = JSON.parse(JSON.stringify(input))
  const warnings: string[] = []

  dedupeNodeIds(graph)

  // Exactly one trigger, with id 'trigger' (validateFlowGraph requires it).
  const triggers = graph.nodes.filter((node) => node.type === 'trigger')
  for (const extra of triggers.slice(1)) {
    graph.nodes = graph.nodes.filter((node) => node !== extra)
    graph.edges = graph.edges.filter((edge) => edge.source !== extra.id && edge.target !== extra.id)
    warnings.push('The import had more than one trigger — only the first was kept.')
  }
  const trigger = triggers[0]
  if (trigger && trigger.id !== 'trigger') {
    // A node may already hold the name; move it out of the way first.
    if (graph.nodes.some((node) => node !== trigger && node.id === 'trigger')) {
      renameNode(graph, 'trigger', 'trigger-step')
    }
    renameNode(graph, trigger.id, 'trigger')
  }

  for (const node of graph.nodes) {
    if (node.type === 'trigger' && isRecord(node.data.trigger)) {
      // Never resurrect a foreign webhook secret — a fresh one is minted at publish.
      delete node.data.trigger.webhookSecretHash
      delete node.data.trigger.webhookSecretEnc
    }
    if (node.type === 'tool' && node.data.connectionId && !PORTABLE_CONNECTION_ID.test(node.data.connectionId)) {
      node.data.connectionId = ''
      warnings.push(`"${labelOf(node)}" referenced a connection from another workspace — pick one of yours.`)
    }
    if (node.type === 'http') {
      if (node.data.credentialId) {
        delete node.data.credentialId
        warnings.push(`"${labelOf(node)}" referenced a credential from another workspace — re-select or re-create it.`)
      }
      if (node.data.connectionId && !PORTABLE_CONNECTION_ID.test(node.data.connectionId)) {
        delete node.data.connectionId
        warnings.push(`"${labelOf(node)}" referenced a connection from another workspace — pick one of yours.`)
      }
    }
    if (node.type === 'subflow' && node.data.flowId) {
      node.data.flowId = ''
      warnings.push(`"${labelOf(node)}" ran another flow that does not exist here — choose one of your flows.`)
    }
  }

  return { graph, warnings }
}

/**
 * Replace portable agent refs with the ids of agents materialized in THIS
 * workspace. Unmapped non-empty refs are cleared (a dangling foreign agentId
 * would fail validation as UNKNOWN_AGENT) and returned so the route can warn.
 */
export function remapAgentRefs(
  input: FlowGraph,
  refToId: Record<string, string>,
): { graph: FlowGraph; clearedRefs: string[] } {
  const graph: FlowGraph = JSON.parse(JSON.stringify(input))
  const clearedRefs: string[] = []
  for (const node of graph.nodes) {
    if (node.type !== 'agent' || !node.data.agentId) continue
    const mapped = refToId[node.data.agentId]
    if (mapped) node.data.agentId = mapped
    else {
      clearedRefs.push(node.data.agentId)
      node.data.agentId = ''
    }
  }
  return { graph, clearedRefs }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/sanitize.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/sanitize.ts src/lib/import/__tests__/sanitize.test.ts
git commit -m "feat(import): sanitize imported graphs — strip foreign secrets and refs"
```

---

### Task 3: Portable + bare-download importers

**Files:**
- Create: `src/lib/import/portable.ts`
- Test: `src/lib/import/__tests__/portable-import.test.ts`

**Interfaces:**
- Consumes: `flowGraphSchema` (`@/lib/flows/graph`), `normalizeFlowTrigger`/`triggerFromGraph` (`@/lib/flows/trigger`), `PORTABLE_FORMAT`, `toPortableFlow` (test only) from `@/lib/export/portable`, `FlowImportError`/`ImportedFlow` from `./types`.
- Produces: `fromPortableFlow(doc: unknown): ImportedFlow`, `fromDownloadedFlow(doc: unknown): ImportedFlow`.

- [ ] **Step 1: Write the failing test**

`src/lib/import/__tests__/portable-import.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { toPortableFlow } from '@/lib/export/portable'
import { fromDownloadedFlow, fromPortableFlow } from '../portable'
import { FlowImportError } from '../types'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'ask', type: 'agent', data: { agentId: 'agent-1', input: 'hi' } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'ask' }],
}

test('round-trips a toPortableFlow export', () => {
  const doc = toPortableFlow(
    { name: 'Weekly recap', description: 'd', trigger: { type: 'manual' }, graph },
    [{ id: 'agent-1', title: 'Recapper', instructions: 'Write recaps', integrations: ['slack'] }],
    '2026-08-05T00:00:00.000Z',
  )
  const imported = fromPortableFlow(JSON.parse(JSON.stringify(doc)))
  assert.equal(imported.source, 'sublime-portable')
  assert.equal(imported.name, 'Weekly recap')
  assert.equal(imported.graph.nodes.length, 2)
  assert.equal(imported.agentsToCreate.length, 1)
  assert.equal(imported.agentsToCreate[0].ref, 'agent-1')
  // requirements travel as warnings so the UI can show them
  assert.ok(imported.warnings.length >= 1)
})

test('never imports credentials or webhook secrets', () => {
  const doc = {
    format: 'sublime.flow', version: 1, exportedAt: 'x',
    containsCredentials: true,
    credentials: { triggerSecret: 'LIVE' },
    flow: {
      name: 'hooked', description: '',
      trigger: { type: 'webhook', webhookSecretHash: 'h', webhookSecretEnc: 'enc' },
      graph: { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook', webhookSecretHash: 'h' } } }], edges: [] },
    },
    agents: [], requirements: [],
  }
  const imported = fromPortableFlow(doc)
  const trigger = imported.trigger as Record<string, unknown>
  assert.equal(trigger.webhookSecretHash, undefined)
  assert.equal(trigger.webhookSecretEnc, undefined)
  assert.equal(JSON.stringify(imported).includes('LIVE'), false)
})

test('rejects a portable doc whose graph fails the schema', () => {
  const doc = {
    format: 'sublime.flow', version: 1, exportedAt: 'x',
    flow: { name: 'bad', description: '', trigger: { type: 'manual' }, graph: { nodes: [{ id: 'x', type: 'nope', data: {} }], edges: [] } },
    agents: [], requirements: [],
  }
  assert.throws(() => fromPortableFlow(doc), (error: unknown) =>
    error instanceof FlowImportError && error.code === 'INVALID_GRAPH')
})

test('imports the builder bare download shape', () => {
  const imported = fromDownloadedFlow({ name: 'Plain', description: 'x', version: 4, graph, exportedAt: 'x' })
  assert.equal(imported.source, 'sublime-download')
  assert.equal(imported.name, 'Plain')
  assert.equal(imported.trigger.type, 'manual')
  assert.equal(imported.agentsToCreate.length, 0)
})

test('bare download without a name gets a fallback', () => {
  const imported = fromDownloadedFlow({ graph })
  assert.equal(imported.name, 'Imported flow')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/portable-import.test.ts`
Expected: FAIL — cannot find module `../portable`.

- [ ] **Step 3: Write the implementation**

`src/lib/import/portable.ts`:

```ts
/**
 * Import the two Sublime-native shapes: the portable `sublime.flow` document
 * (inverse of toPortableFlow) and the builder's plain download
 * ({ name, description, version, graph }).
 *
 * The credentials block is IGNORED BY DESIGN: a foreign trigger secret must
 * never come alive in this workspace — webhook triggers mint a fresh secret
 * at publish, same as a hand-built flow.
 */
import { z } from 'zod'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import { normalizeFlowTrigger, triggerFromGraph, type FlowTrigger } from '@/lib/flows/trigger'
import { PORTABLE_FORMAT, PORTABLE_VERSION } from '@/lib/export/portable'
import { FlowImportError, type ImportedFlow } from './types'

const portableAgentSchema = z.object({
  ref: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string(),
  goal: z.string().nullable().optional(),
  model: z.string().optional(),
  integrations: z.array(z.string()).default([]),
})

const portableDocSchema = z.object({
  format: z.literal(PORTABLE_FORMAT),
  version: z.number(),
  flow: z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    trigger: z.unknown().optional(),
    graph: z.unknown(),
  }),
  agents: z.array(portableAgentSchema).default([]),
  requirements: z.array(z.string()).default([]),
}).passthrough()

const downloadDocSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().default(''),
  graph: z.unknown(),
}).passthrough()

function parseGraph(raw: unknown): FlowGraph {
  const parsed = flowGraphSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new FlowImportError(
      `The flow definition is not valid: ${issue.path.join('.') || 'graph'} — ${issue.message}`,
      'INVALID_GRAPH',
    )
  }
  return parsed.data
}

function sanitizedTrigger(raw: unknown): FlowTrigger {
  const trigger = normalizeFlowTrigger(raw)
  delete trigger.webhookSecretHash
  delete trigger.webhookSecretEnc
  return trigger
}

export function fromPortableFlow(raw: unknown): ImportedFlow {
  const parsed = portableDocSchema.safeParse(raw)
  if (!parsed.success) {
    throw new FlowImportError('This sublime.flow document is missing required fields.', 'INVALID_GRAPH')
  }
  const doc = parsed.data
  const warnings = [...doc.requirements]
  if (doc.version !== PORTABLE_VERSION) {
    warnings.push(`This export is version ${doc.version}; this workspace understands version ${PORTABLE_VERSION} — imported best-effort.`)
  }
  return {
    name: doc.flow.name,
    description: doc.flow.description,
    trigger: sanitizedTrigger(doc.flow.trigger),
    graph: parseGraph(doc.flow.graph),
    agentsToCreate: doc.agents,
    source: 'sublime-portable',
    warnings,
    stubbedNodes: [],
  }
}

export function fromDownloadedFlow(raw: unknown): ImportedFlow {
  const parsed = downloadDocSchema.safeParse(raw)
  if (!parsed.success) {
    throw new FlowImportError('This flow file is missing its graph.', 'INVALID_GRAPH')
  }
  const graph = parseGraph(parsed.data.graph)
  return {
    name: parsed.data.name ?? 'Imported flow',
    description: parsed.data.description,
    trigger: sanitizedTrigger(triggerFromGraph(graph)),
    graph,
    agentsToCreate: [],
    source: 'sublime-download',
    warnings: [],
    stubbedNodes: [],
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/portable-import.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/portable.ts src/lib/import/__tests__/portable-import.test.ts
git commit -m "feat(import): portable sublime.flow and bare-download importers"
```

---

### Task 4: n8n workflow converter

**Files:**
- Create: `src/lib/import/n8n.ts`
- Test: `src/lib/import/__tests__/n8n-import.test.ts`

**Interfaces:**
- Consumes: `flowGraphSchema`, `ConditionClause`, `CONDITION_OPS` (`@/lib/flows/graph`); `FlowTrigger` (`@/lib/flows/trigger`); `FlowImportError`, `ImportedFlow`, `StubbedNode` (`./types`).
- Produces: `fromN8nWorkflow(raw: unknown): ImportedFlow`.

- [ ] **Step 1: Write the failing test**

`src/lib/import/__tests__/n8n-import.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { fromN8nWorkflow } from '../n8n'

type NodeOf<T extends FlowGraph['nodes'][number]['type']> = Extract<FlowGraph['nodes'][number], { type: T }>

/** Realistic n8n export: webhook → if → (http | slack), plus a sticky note. */
const FIXTURE = {
  name: 'Lead router',
  nodes: [
    { parameters: { path: 'lead' }, id: 'n-hook', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    {
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [{ leftValue: '={{ $json.score }}', rightValue: 50, operator: { type: 'number', operation: 'larger' } }],
        },
      },
      id: 'n-if', name: 'Qualified?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [200, 0],
    },
    {
      parameters: {
        method: 'POST', url: 'https://api.crm.example/leads',
        sendHeaders: true, headerParameters: { parameters: [{ name: 'X-Team', value: 'sales' }] },
        sendBody: true, jsonBody: '={{ JSON.stringify($json) }}',
      },
      id: 'n-http', name: 'Create CRM lead', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, -100],
    },
    { parameters: { channel: '#leads', text: 'low score' }, id: 'n-slack', name: 'Notify Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [400, 100] },
    { parameters: { content: 'docs' }, id: 'n-note', name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 300] },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Qualified?', type: 'main', index: 0 }]] },
    'Qualified?': {
      main: [
        [{ node: 'Create CRM lead', type: 'main', index: 0 }],
        [{ node: 'Notify Slack', type: 'main', index: 0 }],
      ],
    },
  },
  settings: {},
}

test('converts the fixture: trigger, condition with branches, http, slack stub', () => {
  const imported = fromN8nWorkflow(JSON.parse(JSON.stringify(FIXTURE)))
  assert.equal(imported.source, 'n8n')
  assert.equal(imported.name, 'Lead router')
  assert.equal(imported.trigger.type, 'webhook')

  const byId = new Map(imported.graph.nodes.map((node) => [node.id, node]))
  const trigger = byId.get('trigger')
  assert.equal(trigger?.type, 'trigger')

  const condition = imported.graph.nodes.find((node) => node.type === 'condition') as NodeOf<'condition'>
  assert.equal(condition.data.label, 'Qualified?')
  assert.deepEqual(condition.data.clauses, [{ left: '={{ $json.score }}', op: 'gt', right: '50' }])

  const http = imported.graph.nodes.find((node) => node.type === 'http' && node.data.url) as NodeOf<'http'>
  assert.equal(http.data.method, 'POST')
  assert.equal(http.data.url, 'https://api.crm.example/leads')

  // Slack is an integration node → http stub, reported.
  assert.equal(imported.stubbedNodes.length, 1)
  assert.equal(imported.stubbedNodes[0].originalType, 'n8n-nodes-base.slack')
  const stub = byId.get(imported.stubbedNodes[0].nodeId) as NodeOf<'http'>
  assert.equal(stub.type, 'http')
  assert.equal(stub.data.label, 'Notify Slack')
  assert.ok(stub.data.note?.includes('n8n-nodes-base.slack'))

  // Sticky note dropped without a stub.
  assert.equal(imported.graph.nodes.length, 4)

  // Branch wiring: if output 0 → 'true', output 1 → 'false'.
  const trueEdge = imported.graph.edges.find((edge) => edge.source === condition.id && edge.target === http.id)
  const falseEdge = imported.graph.edges.find((edge) => edge.source === condition.id && edge.target === stub.id)
  assert.equal(trueEdge?.branch, 'true')
  assert.equal(falseEdge?.branch, 'false')

  // Layout carried across.
  assert.deepEqual(imported.graph.layout?.[condition.id], { x: 200, y: 0 })

  // Expressions were detected and warned about once.
  assert.ok(imported.warnings.some((warning) => warning.includes('expression')))
})

test('a workflow without a trigger gets a manual trigger wired to entry nodes', () => {
  const imported = fromN8nWorkflow({
    name: 'headless',
    nodes: [{ parameters: {}, id: 'n1', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0] }],
    connections: {},
  })
  assert.equal(imported.trigger.type, 'manual')
  assert.ok(imported.graph.nodes.some((node) => node.id === 'trigger'))
  assert.deepEqual(
    imported.graph.edges.map((edge) => [edge.source, edge.target]),
    [['trigger', 'n1']],
  )
})

test('merge and noOp nodes are dropped and rewired through', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: {}, id: 'n-noop', name: 'NoOp', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [100, 0] },
      { parameters: { amount: 5, unit: 'minutes' }, id: 'n-wait', name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [200, 0] },
    ],
    connections: {
      Manual: { main: [[{ node: 'NoOp', type: 'main', index: 0 }]] },
      NoOp: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
    },
  })
  assert.deepEqual(
    imported.graph.edges.map((edge) => [edge.source, edge.target]),
    [['trigger', 'n-wait']],
  )
  const wait = imported.graph.nodes.find((node) => node.type === 'wait') as NodeOf<'wait'>
  assert.equal(wait.data.amount, 5)
  assert.equal(wait.data.unit, 'minutes')
})

test('core mappings: code, set, switch, stopAndError, respondToWebhook, executeWorkflow, splitInBatches, langchain agent', () => {
  const nodes = [
    { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
    { parameters: { jsCode: 'return items', mode: 'runOnceForEachItem' }, id: 'n-code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] },
    { parameters: { assignments: { assignments: [{ id: 'a1', name: 'greeting', value: 'hello', type: 'string' }] } }, id: 'n-set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0] },
    { parameters: { rules: { values: [{ outputKey: 'big', conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.n }}', rightValue: 10, operator: { type: 'number', operation: 'larger' } }] } }] } }, id: 'n-switch', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 3, position: [0, 0] },
    { parameters: { errorMessage: 'boom' }, id: 'n-stop', name: 'Stop', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [0, 0] },
    { parameters: { respondWith: 'json', responseBody: '{"ok":true}' }, id: 'n-resp', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0] },
    { parameters: { workflowId: 'wf-far-away' }, id: 'n-sub', name: 'Run other', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.1, position: [0, 0] },
    { parameters: { batchSize: 10 }, id: 'n-batch', name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [0, 0] },
    { parameters: { text: 'You are a helpful bot' }, id: 'n-ai', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.7, position: [0, 0] },
  ]
  const imported = fromN8nWorkflow({ nodes, connections: {} })
  const byId = new Map(imported.graph.nodes.map((node) => [node.id, node]))

  const code = byId.get('n-code') as NodeOf<'code'>
  assert.equal(code.type, 'code')
  assert.equal(code.data.code, 'return items')
  assert.equal(code.data.mode, 'eachItem')

  const set = byId.get('n-set') as NodeOf<'transform'>
  assert.equal(set.type, 'transform')
  assert.deepEqual(set.data.fields, [{ name: 'greeting', value: 'hello' }])

  const sw = byId.get('n-switch') as NodeOf<'switch'>
  assert.equal(sw.type, 'switch')
  assert.equal(sw.data.cases.length, 1)
  assert.equal(sw.data.cases[0].op, 'gt')

  assert.equal((byId.get('n-stop') as NodeOf<'stop'>).data.reason, 'boom')
  assert.equal(byId.get('n-resp')?.type, 'respondWebhook')

  const sub = byId.get('n-sub') as NodeOf<'subflow'>
  assert.equal(sub.type, 'subflow')
  assert.equal(sub.data.flowId, '')

  assert.equal(byId.get('n-batch')?.type, 'loop')

  const ai = byId.get('n-ai') as NodeOf<'agent'>
  assert.equal(ai.type, 'agent')
  assert.equal(ai.data.agentId, '')
  assert.equal(ai.data.prompt, 'You are a helpful bot')

  // No integration stubs in this set — everything above maps natively.
  assert.equal(imported.stubbedNodes.length, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/n8n-import.test.ts`
Expected: FAIL — cannot find module `../n8n`.

- [ ] **Step 3: Write the implementation**

`src/lib/import/n8n.ts`:

```ts
/**
 * n8n workflow import — the inverse of `toN8nWorkflow` (src/lib/export/n8n.ts).
 *
 * Product call (2026-08-05): core control-flow primitives map 1:1; the long
 * tail of n8n integration nodes (Slack, Gmail, Sheets, …) imports as HTTP
 * request STUBS — label kept, original type + parameters preserved in the
 * step's note — because most of them are API calls anyway. Every stub is
 * reported via `stubbedNodes` so nothing disappears silently.
 *
 * n8n's `connections` map is keyed by node NAME (not id); this converter
 * resolves names back to ids. Its `={{ … }}` expressions do not translate —
 * they are kept verbatim with ONE summary warning (half-translated
 * expressions would be worse than honest untranslated ones).
 */
import { z } from 'zod'
import {
  flowGraphSchema,
  type ConditionClause,
  type ConditionOp,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from '@/lib/flows/graph'
import type { FlowTrigger } from '@/lib/flows/trigger'
import { FlowImportError, type ImportedFlow, type StubbedNode } from './types'

const n8nNodeSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  position: z.tuple([z.number(), z.number()]).optional(),
}).passthrough()

const n8nWorkflowSchema = z.object({
  name: z.string().optional(),
  nodes: z.array(n8nNodeSchema),
  connections: z.record(z.string(), z.unknown()).default({}),
}).passthrough()

type N8nNode = z.infer<typeof n8nNodeSchema>

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
const WAIT_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const

/** n8n comparison operations → our ConditionOp; unknown ops don't translate. */
const OP_MAP: Record<string, ConditionOp> = {
  equals: 'eq', notEquals: 'neq',
  larger: 'gt', largerEqual: 'gte', smaller: 'lt', smallerEqual: 'lte',
  gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
  contains: 'contains', regex: 'matches',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const asString = (value: unknown): string =>
  value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value)

function baseType(type: string): string {
  return type.replace(/^n8n-nodes-base\./, '')
}

function isTriggerType(type: string): boolean {
  const base = baseType(type)
  return /trigger$/i.test(base) || base === 'webhook' || base === 'cron'
}

function triggerFor(node: N8nNode): FlowTrigger {
  const base = baseType(node.type)
  if (base === 'webhook') return { type: 'webhook' }
  if (base === 'scheduleTrigger' || base === 'cron') return { type: 'schedule' }
  return { type: 'manual' }
}

/** n8n if/filter v2 conditions → our clauses. Untranslatable → empty + flag. */
function clausesFrom(parameters: Record<string, unknown>): { match: 'all' | 'any'; clauses: ConditionClause[]; complete: boolean } {
  const conditions = isRecord(parameters.conditions) ? parameters.conditions : undefined
  const list = conditions && Array.isArray(conditions.conditions) ? conditions.conditions : []
  const match = conditions?.combinator === 'or' ? 'any' : 'all'
  const clauses: ConditionClause[] = []
  let complete = list.length > 0
  for (const entry of list) {
    if (!isRecord(entry)) { complete = false; continue }
    const operator = isRecord(entry.operator) ? asString(entry.operator.operation) : ''
    const op = OP_MAP[operator]
    if (!op) { complete = false; continue }
    clauses.push({ left: asString(entry.leftValue), op, right: asString(entry.rightValue) })
  }
  return { match, clauses, complete }
}

/** { parameters: [{name, value}] } (n8n header/query editors) → JSON object string. */
function pairsToJson(raw: unknown): string | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.parameters)) return undefined
  const out: Record<string, string> = {}
  for (const pair of raw.parameters) {
    if (isRecord(pair) && pair.name) out[asString(pair.name)] = asString(pair.value)
  }
  return Object.keys(out).length ? JSON.stringify(out) : undefined
}

type Mapped =
  | { kind: 'node'; node: FlowNode; warning?: string; stub?: true }
  | { kind: 'drop' }        // merge/noOp/stickyNote — rewire straight through

function mapNode(node: N8nNode, id: string, warnings: string[]): Mapped {
  const p = node.parameters
  const base = baseType(node.type)
  const label = node.name

  if (base === 'stickyNote') return { kind: 'drop' }
  if (base === 'merge' || base === 'noOp') return { kind: 'drop' }

  if (node.type.includes('n8n-nodes-langchain') || base === 'openAi') {
    warnings.push(`"${label}" was an n8n AI step — bind it to one of your agents or refine its inline prompt.`)
    return {
      kind: 'node',
      node: { id, type: 'agent', data: { agentId: '', label, prompt: asString(p.text ?? p.prompt), input: '' } },
    }
  }

  switch (base) {
    case 'httpRequest': {
      const method = HTTP_METHODS.includes(asString(p.method).toUpperCase() as typeof HTTP_METHODS[number])
        ? (asString(p.method).toUpperCase() as typeof HTTP_METHODS[number]) : 'GET'
      const headers = pairsToJson(p.headerParameters)
      const query = pairsToJson(p.queryParameters)
      const body = asString(p.jsonBody ?? p.body)
      if (p.authentication && p.authentication !== 'none') {
        warnings.push(`"${label}" used n8n credentials — re-enter authentication for this HTTP step.`)
      }
      return {
        kind: 'node',
        node: {
          id, type: 'http',
          data: {
            label, method, url: asString(p.url),
            ...(headers ? { headers, sendHeaders: true } : {}),
            ...(query ? { query, sendQuery: true } : {}),
            ...(body ? { body, sendBody: true } : {}),
          },
        },
      }
    }
    case 'if': {
      const { match, clauses, complete } = clausesFrom(p)
      if (!complete) warnings.push(`"${label}": some conditions did not translate — re-enter them.`)
      return { kind: 'node', node: { id, type: 'condition', data: { label, match, clauses } } }
    }
    case 'filter': {
      const { match, clauses, complete } = clausesFrom(p)
      if (!complete) warnings.push(`"${label}": some conditions did not translate — re-enter them.`)
      return { kind: 'node', node: { id, type: 'filter', data: { label, match, clauses } } }
    }
    case 'switch': {
      const rules = isRecord(p.rules) && Array.isArray(p.rules.values) ? p.rules.values : []
      const cases = rules.map((rule, index) => {
        const conditions = isRecord(rule) ? clausesFrom(rule as Record<string, unknown>) : { clauses: [], complete: false, match: 'all' as const }
        const first = conditions.clauses[0]
        if (!first) warnings.push(`"${label}" case ${index + 1}: the rule did not translate — re-enter it.`)
        return {
          id: `case-${index}`,
          label: isRecord(rule) ? asString(rule.outputKey) || undefined : undefined,
          left: first?.left ?? '', op: first?.op ?? ('eq' as ConditionOp), right: first?.right ?? '',
        }
      })
      return { kind: 'node', node: { id, type: 'switch', data: { label, cases } } }
    }
    case 'code': case 'function': case 'functionItem':
      return {
        kind: 'node',
        node: {
          id, type: 'code',
          data: {
            label,
            language: asString(p.language) === 'python' ? 'python' : 'javascript',
            mode: asString(p.mode) === 'runOnceForEachItem' ? 'eachItem' : 'allItems',
            code: asString(p.jsCode ?? p.pythonCode ?? p.functionCode),
          },
        },
      }
    case 'set': {
      const assignments = isRecord(p.assignments) && Array.isArray(p.assignments.assignments) ? p.assignments.assignments : []
      const fields = assignments.flatMap((entry) =>
        isRecord(entry) && entry.name ? [{ name: asString(entry.name), value: asString(entry.value) }] : [])
      return { kind: 'node', node: { id, type: 'transform', data: { label, fields } } }
    }
    case 'wait': {
      const unit = WAIT_UNITS.includes(asString(p.unit) as typeof WAIT_UNITS[number])
        ? (asString(p.unit) as typeof WAIT_UNITS[number]) : 'seconds'
      const amount = Number(p.amount)
      return { kind: 'node', node: { id, type: 'wait', data: { label, amount: Number.isFinite(amount) && amount >= 0 ? amount : 1, unit } } }
    }
    case 'splitInBatches':
      warnings.push(`"${label}": n8n loop wiring does not translate — open the step and choose what to loop over, then move the looped steps into it.`)
      return { kind: 'node', node: { id, type: 'loop', data: { label, over: '', body: [] } } }
    case 'stopAndError':
      return { kind: 'node', node: { id, type: 'stop', data: { label, reason: asString(p.errorMessage) } } }
    case 'respondToWebhook': {
      const code = Number(p.responseCode)
      return {
        kind: 'node',
        node: {
          id, type: 'respondWebhook',
          data: {
            label,
            statusCode: Number.isInteger(code) && code >= 100 && code <= 599 ? code : 200,
            body: typeof p.responseBody === 'string' ? p.responseBody : p.responseBody === undefined ? undefined : JSON.stringify(p.responseBody),
            bodyMode: 'json',
          },
        },
      }
    }
    case 'executeWorkflow':
      warnings.push(`"${label}" ran another n8n workflow — import that workflow too, then select it in this step.`)
      return { kind: 'node', node: { id, type: 'subflow', data: { label, flowId: '' } } }
    default: {
      // The integration tail: import as an honest HTTP stub. The original
      // type + parameters travel in the note so the API call can be rebuilt.
      const note = `Imported from n8n node "${node.type}". Rebuild this step as the equivalent API request.\nOriginal parameters:\n${JSON.stringify(p, null, 2)}`.slice(0, 4000)
      return {
        kind: 'node', stub: true,
        node: { id, type: 'http', data: { label, note, method: 'GET', url: '' } },
      }
    }
  }
}

export function fromN8nWorkflow(raw: unknown): ImportedFlow {
  const parsed = n8nWorkflowSchema.safeParse(raw)
  if (!parsed.success) throw new FlowImportError('This n8n workflow file is missing its nodes.', 'INVALID_GRAPH')
  const workflow = parsed.data
  const warnings: string[] = []
  const stubbedNodes: StubbedNode[] = []

  // ids: prefer n8n's node id; names resolve connections. Trigger becomes 'trigger'.
  const idByName = new Map<string, string>()
  const usedIds = new Set<string>(['trigger'])
  const triggerNodes = workflow.nodes.filter((node) => isTriggerType(node.type))
  const primaryTrigger = triggerNodes[0]
  if (triggerNodes.length > 1) {
    warnings.push('The n8n workflow had multiple triggers — they were merged into one.')
  }

  const nodes: FlowNode[] = []
  const dropped = new Set<string>()
  const layout: NonNullable<FlowGraph['layout']> = {}

  for (const node of workflow.nodes) {
    let id: string
    if (node === primaryTrigger || (isTriggerType(node.type) && primaryTrigger)) {
      id = 'trigger'
    } else {
      id = node.id && !usedIds.has(node.id) ? node.id : node.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step'
      let candidate = id
      for (let n = 2; usedIds.has(candidate); n += 1) candidate = `${id}-${n}`
      id = candidate
      usedIds.add(id)
    }
    idByName.set(node.name, id)
    if (node.position) layout[id] = { x: Math.round(node.position[0]), y: Math.round(node.position[1]) }

    if (node === primaryTrigger) {
      nodes.push({ id: 'trigger', type: 'trigger', data: { trigger: triggerFor(node) } })
      continue
    }
    if (isTriggerType(node.type)) { dropped.add(id); continue } // extra triggers merge into 'trigger'

    const mapped = mapNode(node, id, warnings)
    if (mapped.kind === 'drop') { dropped.add(id); continue }
    nodes.push(mapped.node)
    if (mapped.stub) stubbedNodes.push({ nodeId: id, label: node.name, originalType: node.type })
  }

  // connections: { "<source name>": { main: [ [ {node,type,index} ] ] } }
  const typeById = new Map(nodes.map((node) => [node.id, node.type]))
  const edges: FlowEdge[] = []
  let edgeSeq = 1
  for (const [sourceName, value] of Object.entries(workflow.connections)) {
    const sourceId = idByName.get(sourceName) ?? (dropped.has(sourceName) ? sourceName : undefined)
    const main = isRecord(value) && Array.isArray(value.main) ? value.main : []
    if (!sourceId) continue
    main.forEach((bundle, outputIndex) => {
      if (!Array.isArray(bundle)) return
      for (const link of bundle) {
        if (!isRecord(link) || typeof link.node !== 'string') continue
        const targetId = idByName.get(link.node)
        if (!targetId) continue
        const sourceType = typeById.get(sourceId)
        const branch =
          sourceType === 'condition' ? (outputIndex === 0 ? 'true' : 'false')
          : sourceType === 'switch' ? (nodes.find((n) => n.id === sourceId && n.type === 'switch') as Extract<FlowNode, { type: 'switch' }> | undefined)?.data.cases[outputIndex]?.id ?? 'default'
          : undefined
        edges.push({ id: `e-${edgeSeq++}`, source: sourceId, target: targetId, ...(branch ? { branch } : {}) })
      }
    })
  }

  // Drop-and-rewire merge/noOp/extra-trigger nodes (extra triggers rewire from 'trigger').
  let liveEdges = edges
  for (const dropId of dropped) {
    const incoming = liveEdges.filter((edge) => edge.target === dropId)
    const outgoing = liveEdges.filter((edge) => edge.source === dropId)
    const sources = incoming.length ? incoming : [{ id: '', source: 'trigger', target: dropId } as FlowEdge]
    const bridged: FlowEdge[] = []
    for (const into of sources) {
      for (const out of outgoing) {
        bridged.push({ id: `e-${edgeSeq++}`, source: into.source, target: out.target, ...(into.branch ? { branch: into.branch } : {}) })
      }
    }
    liveEdges = liveEdges.filter((edge) => edge.source !== dropId && edge.target !== dropId).concat(bridged)
    delete layout[dropId]
  }

  // No trigger in the workflow: prepend a manual one wired to the entry nodes.
  let trigger: FlowTrigger = primaryTrigger ? triggerFor(primaryTrigger) : { type: 'manual' }
  if (!primaryTrigger) {
    nodes.unshift({ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } })
    const hasIncoming = new Set(liveEdges.map((edge) => edge.target))
    for (const node of nodes) {
      if (node.id === 'trigger' || hasIncoming.has(node.id)) continue
      liveEdges.push({ id: `e-${edgeSeq++}`, source: 'trigger', target: node.id })
    }
  }

  // Dedupe identical bridged edges (drop-and-rewire can double up on diamonds).
  const seenEdges = new Set<string>()
  const finalEdges = liveEdges.filter((edge) => {
    const key = `${edge.source}→${edge.target}→${edge.branch ?? ''}`
    if (seenEdges.has(key)) return false
    seenEdges.add(key)
    return true
  })

  const expressionHits = JSON.stringify(workflow.nodes).match(/=\{\{|\$json|\$node\b/g)
  if (expressionHits?.length) {
    warnings.push(`${expressionHits.length} n8n expression reference(s) were kept as-is — rewrite them as {{step.…}} or {{input.…}} references.`)
  }

  const graphParse = flowGraphSchema.safeParse({ nodes, edges: finalEdges, ...(Object.keys(layout).length ? { layout } : {}) })
  if (!graphParse.success) {
    const issue = graphParse.error.issues[0]
    throw new FlowImportError(`Converted n8n workflow failed validation: ${issue.path.join('.')} — ${issue.message}`, 'INVALID_GRAPH')
  }

  return {
    name: workflow.name || 'Imported n8n workflow',
    description: '',
    trigger,
    graph: graphParse.data,
    agentsToCreate: [],
    source: 'n8n',
    warnings,
    stubbedNodes,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/n8n-import.test.ts`
Expected: PASS (4 tests). Debug mapping details against the assertions if not — the fixture is the contract.

- [ ] **Step 5: Also run the export round-trip sanity check**

Add to the same test file, run again, confirm PASS:

```ts
test('round-trips our own n8n export back into a flow', async () => {
  const { toN8nWorkflow } = await import('@/lib/export/n8n')
  const { toPortableFlow } = await import('@/lib/export/portable')
  const portable = toPortableFlow(
    {
      name: 'RT', description: '', trigger: { type: 'manual' },
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
          { id: 'call', type: 'http', data: { label: 'Call API', method: 'GET', url: 'https://api.example.com' } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
      },
    },
    [], '2026-08-05T00:00:00.000Z',
  )
  const imported = fromN8nWorkflow(toN8nWorkflow(portable) as unknown)
  assert.equal(imported.trigger.type, 'manual')
  const http = imported.graph.nodes.find((node) => node.type === 'http') as NodeOf<'http'>
  assert.equal(http.data.url, 'https://api.example.com')
  assert.equal(imported.graph.edges.length, 1)
})
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/import/n8n.ts src/lib/import/__tests__/n8n-import.test.ts
git commit -m "feat(import): deterministic n8n workflow converter with HTTP stubs for the integration tail"
```

---

### Task 5: Hardened URL fetcher

**Files:**
- Create: `src/lib/import/fetch-url.ts`
- Test: `src/lib/import/__tests__/fetch-url.test.ts`

**Interfaces:**
- Consumes: `assertEgressAllowed` (`@/lib/integrations/http:27`), `assertPublicUrl`, `SsrfError` (`@/lib/net/ssrf`).
- Produces: `fetchImportDocument(rawUrl: string, fetchImpl?: typeof fetch): Promise<string>` and `MAX_IMPORT_BYTES` (also the inline-document cap in Task 6).

- [ ] **Step 1: Write the failing test**

`src/lib/import/__tests__/fetch-url.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchImportDocument, MAX_IMPORT_BYTES } from '../fetch-url'

const jsonResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init })

test('rejects http:// URLs without fetching', async () => {
  let called = false
  await assert.rejects(
    fetchImportDocument('http://example.com/flow.json', (async () => { called = true; return jsonResponse('{}') }) as typeof fetch),
  )
  assert.equal(called, false)
})

test('rejects private addresses without fetching', async () => {
  let called = false
  await assert.rejects(
    fetchImportDocument('https://127.0.0.1/flow.json', (async () => { called = true; return jsonResponse('{}') }) as typeof fetch),
  )
  assert.equal(called, false)
})

test('returns the body for an allowed URL', async () => {
  const text = await fetchImportDocument(
    'https://example.com/flow.json',
    (async () => jsonResponse('{"format":"sublime.flow"}')) as typeof fetch,
  )
  assert.equal(text, '{"format":"sublime.flow"}')
})

test('follows one redirect and re-validates the hop', async () => {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://example.com/a') {
      return new Response(null, { status: 302, headers: { location: 'https://example.com/b' } })
    }
    return jsonResponse('done')
  }) as typeof fetch
  const text = await fetchImportDocument('https://example.com/a', impl)
  assert.equal(text, 'done')
  assert.deepEqual(calls, ['https://example.com/a', 'https://example.com/b'])
})

test('rejects a redirect to a private address', async () => {
  const impl = (async (input: RequestInfo | URL) => {
    if (String(input) === 'https://example.com/a') {
      return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } })
    }
    return jsonResponse('should never arrive')
  }) as typeof fetch
  await assert.rejects(fetchImportDocument('https://example.com/a', impl))
})

test('rejects an oversized response', async () => {
  const impl = (async () => jsonResponse('x'.repeat(MAX_IMPORT_BYTES + 1))) as typeof fetch
  await assert.rejects(fetchImportDocument('https://example.com/big.json', impl), /too large/i)
})

test('rejects a non-2xx response', async () => {
  const impl = (async () => new Response('nope', { status: 404 })) as typeof fetch
  await assert.rejects(fetchImportDocument('https://example.com/missing.json', impl), /404/)
})
```

Note: `example.com` resolves publicly, so `assertPublicUrl`'s DNS layer passes in tests without mocking. If CI has no DNS, the allowed-URL tests will fail on resolution — in that case pass `lookupImpl` through (check `assertPublicUrl`'s signature in `src/lib/net/ssrf.ts:96` for an injectable resolver; `src/lib/metrics/sources/url.ts` shows the pattern) and inject a stub resolver returning `93.184.216.34`.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/fetch-url.test.ts`
Expected: FAIL — cannot find module `../fetch-url`.

- [ ] **Step 3: Write the implementation**

`src/lib/import/fetch-url.ts` (adjust `assertPublicUrl` usage to its real signature in `src/lib/net/ssrf.ts` — it takes the raw string and throws `SsrfError`):

```ts
/**
 * Import-from-URL fetcher. The URL is user-supplied and this fetch runs
 * server-side, so SSRF is the threat model (same stance as
 * src/lib/metrics/sources/url.ts): egress allowlist + public-URL assertion
 * re-run on EVERY redirect hop, https only, bounded time and bytes.
 */
import { assertEgressAllowed } from '@/lib/integrations/http'
import { assertPublicUrl } from '@/lib/net/ssrf'

const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
    throw new Error('That file is too large to import (2 MB max).')
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_IMPORT_BYTES) {
      await reader.cancel()
      throw new Error('That file is too large to import (2 MB max).')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchImportDocument(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let url = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertEgressAllowed(url)
    await assertPublicUrl(url)
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json, text/plain, */*' },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('The URL redirected without a destination.')
      url = new URL(location, url).toString()
      continue
    }
    if (!response.ok) throw new Error(`The URL responded with ${response.status}.`)
    return await readCapped(response)
  }
  throw new Error('The URL redirected too many times.')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/import/__tests__/fetch-url.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/fetch-url.ts src/lib/import/__tests__/fetch-url.test.ts
git commit -m "feat(import): SSRF-hardened URL fetcher for flow import"
```

---

### Task 6: `POST /api/flows/import` route

**Files:**
- Create: `src/app/api/flows/import/route.ts`
- Modify: `src/app/api/__tests__/mutation-route-contract.test.ts` (add one entry to `contracts`)
- Test: `src/app/api/flows/__tests__/flow-import.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5, plus `withAuthenticatedApi`/`ApiError` (`@/lib/server/api-handler`), `prisma` (`@/lib/prisma`), `assertFlowCapacity`/`assertAgentCapacity` (`@/lib/billing/enforce`), `serializeFlow` (`@/lib/flows/serialize`), `validateFlowGraph` (`@/lib/flows/validate:351`), `inlineLiteralSecretNodes` (`@/lib/flows/inline-auth`), `loadFlowToolCatalog` (`@/lib/flows/tool-catalog`), `missingRequiredProviders`/`resolveGraphToolConnections`/`TEMPLATE_CONNECTION_PREFIX` (`@/lib/templates/provision-plan`), `recordUserEvent` (`@/lib/behavior/record-event`), `DEFAULT_AGENT_MODEL` (`@/lib/llm/model-runner`), `SsrfError` (`@/lib/net/ssrf`).
- Produces: `POST` handler returning `{ success, flow, report: { source, warnings, stubbedNodes, missingIntegrations, createdAgents } }`. Task 7's dialog consumes this response shape.

- [ ] **Step 1: Write the route**

`src/app/api/flows/import/route.ts`:

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { assertAgentCapacity, assertFlowCapacity } from '@/lib/billing/enforce'
import { serializeFlow } from '@/lib/flows/serialize'
import { validateFlowGraph } from '@/lib/flows/validate'
import { inlineLiteralSecretNodes } from '@/lib/flows/inline-auth'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { missingRequiredProviders, resolveGraphToolConnections, TEMPLATE_CONNECTION_PREFIX } from '@/lib/templates/provision-plan'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { SsrfError } from '@/lib/net/ssrf'
import { detectFlowImportFormat } from '@/lib/import/detect'
import { fromDownloadedFlow, fromPortableFlow } from '@/lib/import/portable'
import { fromN8nWorkflow } from '@/lib/import/n8n'
import { remapAgentRefs, sanitizeImportedGraph } from '@/lib/import/sanitize'
import { fetchImportDocument, MAX_IMPORT_BYTES } from '@/lib/import/fetch-url'
import { FlowImportError, type ImportedFlow } from '@/lib/import/types'

// Strip undefined + narrow to plain JSON for Prisma's InputJsonValue (same
// helper as src/app/api/flows/route.ts).
function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

const bodySchema = z.object({
  /** Raw JSON text — an uploaded file read client-side, or pasted JSON. */
  document: z.string().min(1).max(MAX_IMPORT_BYTES).optional(),
  /** Fetch the JSON server-side (SSRF-guarded). */
  url: z.string().url().max(2048).optional(),
}).refine((body) => Boolean(body.document) !== Boolean(body.url), {
  message: 'Provide exactly one of "document" or "url".',
})

function convert(text: string): ImportedFlow {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new ApiError('That is not valid JSON.', 400, 'INVALID_JSON')
  }
  const format = detectFlowImportFormat(doc)
  try {
    if (format === 'sublime-portable') return fromPortableFlow(doc)
    if (format === 'sublime-download') return fromDownloadedFlow(doc)
    if (format === 'n8n') return fromN8nWorkflow(doc)
  } catch (error) {
    if (error instanceof FlowImportError) throw new ApiError(error.message, 400, error.code)
    throw error
  }
  if (format === 'sublime-agent') {
    throw new ApiError('This file is an agent export, not a flow — import it from the Agents page.', 400, 'AGENT_EXPORT')
  }
  throw new ApiError(
    'Unrecognized file. Supported: a Sublime flow export (sublime.flow), a flow download from the builder, or an n8n workflow.',
    400,
    'UNRECOGNIZED_FORMAT',
  )
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json())
  let text = body.document ?? ''
  if (body.url) {
    try {
      text = await fetchImportDocument(body.url)
    } catch (error) {
      if (error instanceof SsrfError) throw new ApiError(error.message, 400, 'URL_NOT_ALLOWED')
      throw new ApiError(error instanceof Error ? error.message : 'The URL could not be fetched.', 400, 'URL_FETCH_FAILED')
    }
  }

  const imported = convert(text)
  const warnings = [...imported.warnings]

  const sanitized = sanitizeImportedGraph(imported.graph)
  let graph = sanitized.graph
  warnings.push(...sanitized.warnings)

  // Imported JSON is untrusted input — same literal-secret gate as POST /api/flows.
  if (inlineLiteralSecretNodes(graph).length) {
    throw new ApiError(
      'HTTP authentication secrets must be saved as a private credential before this flow can be saved.',
      400,
      'INLINE_AUTH_SECRET',
    )
  }

  // template:<provider> placeholders: bind what the workspace has, warn about the rest.
  const templateProviders = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' && node.data.connectionId.startsWith(TEMPLATE_CONNECTION_PREFIX)
      ? [node.data.connectionId.slice(TEMPLATE_CONNECTION_PREFIX.length)] : [],
  )))
  let catalog: Awaited<ReturnType<typeof loadFlowToolCatalog>> | null = null
  if (templateProviders.length) {
    catalog = await loadFlowToolCatalog(auth.organizationId, { userId: auth.dbUser.id }).catch(() => null)
    const missing = catalog ? missingRequiredProviders(templateProviders, catalog) : templateProviders
    if (catalog && missing.length === 0) {
      graph = resolveGraphToolConnections(graph, catalog).graph
    } else {
      warnings.push(`Connect ${missing.join(', ')} and re-select the connection on the affected steps.`)
    }
  }

  await assertFlowCapacity(auth.organizationId)
  for (const _agent of imported.agentsToCreate) await assertAgentCapacity(auth.organizationId)

  // Draft-stage validation is advisory (publish is the hard gate, same as the
  // create path) — issues land in the report, never block the import.
  warnings.push(...validateFlowGraph(graph, { requireRunnable: false }).issues.map((issue) => issue.message))

  // Agents + flow land atomically: a failed import leaves nothing behind.
  const { flow, createdAgents, clearedRefs } = await prisma.$transaction(async (tx) => {
    const refToId: Record<string, string> = {}
    const createdAgents: Array<{ id: string; title: string }> = []
    for (const agent of imported.agentsToCreate) {
      const created = await tx.agentTask.create({
        data: {
          agentType: 'CUSTOM',
          description: agent.title,
          objective: agent.instructions,
          goal: agent.goal ?? null,
          schedule: { type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false },
          status: 'ACTIVE',
          visibility: 'private',
          organizationId: auth.organizationId,
          userId: auth.dbUser.id,
          metadata: {
            title: agent.title,
            description: agent.title,
            model: agent.model ?? DEFAULT_AGENT_MODEL,
            integrations: agent.integrations,
            requiredIntegrations: [],
            skills: [], icon: '', allowSubagents: false, subagentIds: [], autoAnswerFromMemory: true,
          },
        },
        select: { id: true },
      })
      refToId[agent.ref] = created.id
      createdAgents.push({ id: created.id, title: agent.title })
    }
    const remapped = remapAgentRefs(graph, refToId)
    const flow = await tx.flow.create({
      data: {
        name: imported.name,
        description: imported.description,
        status: 'DRAFT',
        visibility: 'private',
        trigger: jsonValue(imported.trigger),
        graph: jsonValue(remapped.graph),
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        metadata: { importedFrom: imported.source },
      },
    })
    return { flow, createdAgents, clearedRefs: remapped.clearedRefs }
  })
  for (const ref of clearedRefs) {
    warnings.push(`An agent step referenced an agent (${ref}) that was not in the file — pick one of your agents.`)
  }

  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'flow_created', resourceType: 'flow', resourceId: flow.id,
    context: { name: flow.name, importedFrom: imported.source },
  })

  // Same construction-time integration warning as POST /api/flows:161-181.
  const finalGraph = flow.graph as unknown as typeof graph
  const usedConnectionIds = Array.from(new Set(finalGraph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
  ).filter((id): id is string => Boolean(id))))
  let missingIntegrations: Array<{ nodeId: string; connectionId: string }> = []
  if (usedConnectionIds.length) {
    const available = catalog ?? await loadFlowToolCatalog(auth.organizationId, {
      userId: auth.dbUser.id, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length,
    }).catch(() => null)
    if (available) {
      const ids = new Set(available.map((connection) => connection.id))
      missingIntegrations = finalGraph.nodes.flatMap((node) =>
        (node.type === 'tool' || node.type === 'http') && node.data.connectionId && !ids.has(node.data.connectionId)
          ? [{ nodeId: node.id, connectionId: node.data.connectionId }] : [],
      )
    }
  }

  return {
    success: true,
    flow: serializeFlow(flow),
    report: {
      source: imported.source,
      warnings,
      stubbedNodes: imported.stubbedNodes,
      missingIntegrations,
      createdAgents,
    },
  }
}, { requires: 'member', rateLimit: { feature: 'flow-import', perUser: 20, windowSeconds: 60 } })
```

Adjustment note while implementing: check `FlowValidationResult`'s issue field names at the top of `src/lib/flows/validate.ts` (the plan assumes `.issues[].message`) and `loadFlowToolCatalog`'s options type — both are consumed exactly as the existing create path does.

- [ ] **Step 2: Add the mutation-route-contract entry**

In `src/app/api/__tests__/mutation-route-contract.test.ts`, add to `contracts` (next to the other flow entries):

```ts
  { name: 'flow import', verb: 'POST', load: () => import('../flows/import/route') },
```

- [ ] **Step 3: Write the DB-backed route test**

`src/app/api/flows/__tests__/flow-import.test.ts` — mirror the setup of `src/app/api/__tests__/template-flow-e2e.test.ts` (env gate at top, auth seeding, real `NextRequest`):

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// DB-backed: skipped without TEST_DATABASE_URL (see template-flow-e2e.test.ts).
const DB_URL = process.env.TEST_DATABASE_URL
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL
  process.env.DIRECT_URL = DB_URL
}

const request = (body: unknown) =>
  new NextRequest('http://localhost/api/flows/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('flow import route', { skip: !DB_URL && 'TEST_DATABASE_URL not set' }, async (t) => {
  const { prisma } = await import('@/lib/prisma')
  const { seedTestOrg, makeTestAuthContext, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
  const { POST } = await import('../import/route')

  const seeded = await seedTestOrg(prisma)
  installTestAuth(makeTestAuthContext(seeded))
  t.after(() => clearTestAuth())

  await t.test('imports a portable doc: agent materialized, refs remapped, secrets dropped', async () => {
    const response = await POST(request({
      document: JSON.stringify({
        format: 'sublime.flow', version: 1, exportedAt: 'x',
        credentials: { triggerSecret: 'FOREIGN-SECRET' },
        flow: {
          name: 'Imported recap', description: 'from another org',
          trigger: { type: 'webhook', webhookSecretHash: 'h', webhookSecretEnc: 'enc' },
          graph: {
            nodes: [
              { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook', webhookSecretHash: 'h' } } },
              { id: 'write', type: 'agent', data: { agentId: 'ref-1', input: 'go' } },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'write' }],
          },
        },
        agents: [{ ref: 'ref-1', title: 'Recapper', instructions: 'Write it', integrations: ['slack'] }],
        requirements: ['Reconnect slack.'],
      }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.success, true)
    assert.equal(body.flow.status, 'draft')
    assert.equal(body.flow.visibility, 'private')
    assert.equal(body.report.source, 'sublime-portable')
    assert.equal(body.report.createdAgents.length, 1)

    const row = await prisma.flow.findUniqueOrThrow({ where: { id: body.flow.id } })
    assert.equal(JSON.stringify(row.trigger).includes('webhookSecretHash'), false)
    assert.equal(JSON.stringify(row).includes('FOREIGN-SECRET'), false)
    const graph = row.graph as { nodes: Array<{ type: string; data: Record<string, unknown> }> }
    const agentStep = graph.nodes.find((node) => node.type === 'agent')
    assert.equal(agentStep?.data.agentId, body.report.createdAgents[0].id)
    const agentRow = await prisma.agentTask.findUniqueOrThrow({ where: { id: body.report.createdAgents[0].id } })
    assert.equal(agentRow.organizationId, seeded.organizationId)
  })

  await t.test('imports an n8n workflow and reports stubs', async () => {
    const response = await POST(request({
      document: JSON.stringify({
        name: 'From n8n',
        nodes: [
          { parameters: {}, id: 'a', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
          { parameters: { channel: '#x' }, id: 'b', name: 'Slack it', type: 'n8n-nodes-base.slack', typeVersion: 2, position: [200, 0] },
        ],
        connections: { Manual: { main: [[{ node: 'Slack it', type: 'main', index: 0 }]] } },
      }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.report.source, 'n8n')
    assert.equal(body.report.stubbedNodes.length, 1)
  })

  await t.test('400 on invalid JSON', async () => {
    const response = await POST(request({ document: 'not json {' }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'INVALID_JSON')
  })

  await t.test('400 on unrecognized shape', async () => {
    const response = await POST(request({ document: JSON.stringify({ hello: 'world' }) }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'UNRECOGNIZED_FORMAT')
  })

  await t.test('400 AGENT_EXPORT for a sublime.agent doc', async () => {
    const response = await POST(request({ document: JSON.stringify({ format: 'sublime.agent', version: 1 }) }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'AGENT_EXPORT')
  })

  await t.test('URL mode rejects private addresses without fetching', async () => {
    const response = await POST(request({ url: 'https://127.0.0.1/flow.json' }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'URL_NOT_ALLOWED')
  })

  await t.test('rejects both document and url', async () => {
    const response = await POST(request({ document: '{}', url: 'https://example.com/f.json' }))
    assert.equal(response.status, 400)
  })
})
```

Check `seedTestOrg`/`makeTestAuthContext`/`installTestAuth` exact signatures in `src/lib/server/__tests__/test-auth.ts:28` and mirror how `template-flow-e2e.test.ts` calls them (including any cleanup helpers it uses) — copy that file's setup verbatim rather than inventing a variant. If the SSRF check on `https://127.0.0.1` surfaces as a different code, match the route's mapping (SsrfError → `URL_NOT_ALLOWED`) — `assertPublicUrl` rejects IP literals in private ranges before any DNS or network work.

- [ ] **Step 4: Run the tests**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/mutation-route-contract.test.ts
# DB-backed (start throwaway Postgres per the `verify` skill, then):
TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/flows/__tests__/flow-import.test.ts
```
Expected: PASS. Also run the structural guards:
```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/mutation-coverage.test.ts src/app/api/__tests__/route-permissions.test.ts
```
Expected: PASS — the new test imports the route module and names POST, which is what mutation-coverage scans for.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/flows/import/route.ts src/app/api/flows/__tests__/flow-import.test.ts src/app/api/__tests__/mutation-route-contract.test.ts
git commit -m "feat(flows): POST /api/flows/import — file/URL/paste import with n8n conversion"
```

---

### Task 7: Import dialog on the flows list

**Files:**
- Create: `src/components/flows/import-flow-dialog.tsx`
- Modify: `src/app/(app)/g/[scope]/flows/page.tsx` (header block at `:270-276`; imports at top)

**Interfaces:**
- Consumes: `POST /api/flows/import` response `{ success, flow: { id }, report: { source, warnings, stubbedNodes, missingIntegrations, createdAgents } }`; UI primitives from `@/components/ui/*`.
- Produces: `<ImportFlowDialog open onOpenChange onImported(flowId) />`.

- [ ] **Step 1: Write the dialog component**

`src/components/flows/import-flow-dialog.tsx`:

```tsx
'use client'

/**
 * Import a flow from a .json file, a URL, or pasted JSON (n8n-style import).
 * The file is read CLIENT-side (it's just JSON text) so the API stays plain
 * JSON — no multipart. After a successful import the report (warnings, n8n
 * stub steps, missing integrations) is shown before navigating, so nothing
 * about the conversion is silently dropped.
 */
import { useRef, useState } from 'react'
import { AlertTriangle, FileJson, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type ImportReport = {
  source: 'sublime-portable' | 'sublime-download' | 'n8n'
  warnings: string[]
  stubbedNodes: Array<{ nodeId: string; label: string; originalType: string }>
  missingIntegrations: Array<{ nodeId: string; connectionId: string }>
  createdAgents: Array<{ id: string; title: string }>
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the user clicks "Open flow" on the success screen. */
  onImported: (flowId: string) => void
}

const MAX_FILE_BYTES = 2 * 1024 * 1024

export function ImportFlowDialog({ open, onOpenChange, onImported }: Props) {
  const [tab, setTab] = useState('file')
  const [fileName, setFileName] = useState('')
  const [document, setDocument] = useState('')
  const [url, setUrl] = useState('')
  const [pasted, setPasted] = useState('')
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ flowId: string; name: string; report: ImportReport } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFileName(''); setDocument(''); setUrl(''); setPasted(''); setError(''); setResult(null); setSubmitting(false)
  }

  const readFile = async (file: File) => {
    setError('')
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is larger than 2 MB.')
      return
    }
    setFileName(file.name)
    setDocument(await file.text())
  }

  const submit = async () => {
    const payload = tab === 'url' ? { url: url.trim() } : { document: tab === 'file' ? document : pasted }
    if (tab === 'url' ? !url.trim() : !(tab === 'file' ? document : pasted).trim()) {
      setError(tab === 'url' ? 'Enter a URL.' : tab === 'file' ? 'Choose a .json file.' : 'Paste the flow JSON.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/flows/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.flow) {
        setError(body.error || 'The flow could not be imported.')
        return
      }
      setResult({ flowId: body.flow.id, name: body.flow.name, report: body.report })
    } catch {
      setError('The flow could not be imported.')
    } finally {
      setSubmitting(false)
    }
  }

  const report = result?.report
  const noteworthy = Boolean(report && (report.warnings.length || report.stubbedNodes.length || report.missingIntegrations.length))

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) reset() }}>
      <DialogContent className="sm:max-w-lg">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Imported “{result.name}”</DialogTitle>
              <DialogDescription>
                The flow was created as a private draft{report?.createdAgents.length ? `, along with ${report.createdAgents.length} agent${report.createdAgents.length === 1 ? '' : 's'} it uses` : ''}.
              </DialogDescription>
            </DialogHeader>
            {noteworthy && report && (
              <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border bg-muted/40 p-3 text-sm">
                {report.stubbedNodes.length > 0 && (
                  <div>
                    <p className="font-medium">Steps imported as HTTP placeholders</p>
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      {report.stubbedNodes.map((stub) => (
                        <li key={stub.nodeId}>{stub.label} <span className="text-xs">({stub.originalType})</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.missingIntegrations.length > 0 && (
                  <div>
                    <p className="font-medium">Connections to set up</p>
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      {report.missingIntegrations.map((missing) => (
                        <li key={missing.nodeId}>{missing.connectionId}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.warnings.length > 0 && (
                  <div>
                    <p className="font-medium">Review after import</p>
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      {report.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              <Button onClick={() => onImported(result.flowId)}>Open flow</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Import a flow</DialogTitle>
              <DialogDescription>
                Bring in a Sublime flow export or an n8n workflow — from a JSON file, a URL, or pasted JSON.
              </DialogDescription>
            </DialogHeader>
            <Tabs value={tab} onValueChange={(next) => { setTab(next); setError('') }}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="file">Upload file</TabsTrigger>
                <TabsTrigger value="url">From URL</TabsTrigger>
                <TabsTrigger value="paste">Paste JSON</TabsTrigger>
              </TabsList>
              <TabsContent value="file" className="pt-3">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault()
                    setDragging(false)
                    const file = event.dataTransfer.files?.[0]
                    if (file) void readFile(file)
                  }}
                  className={cn(
                    'flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-sm text-muted-foreground transition-colors',
                    dragging ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/50',
                  )}
                >
                  {fileName ? (
                    <><FileJson className="h-6 w-6" /><span className="font-medium text-foreground">{fileName}</span><span>Click to choose a different file</span></>
                  ) : (
                    <><Upload className="h-6 w-6" /><span>Drop a .json file here, or click to browse</span></>
                  )}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void readFile(file)
                    event.target.value = ''
                  }}
                />
              </TabsContent>
              <TabsContent value="url" className="space-y-2 pt-3">
                <Label htmlFor="import-url">Public URL of the workflow JSON</Label>
                <Input
                  id="import-url"
                  placeholder="https://example.com/workflow.json"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </TabsContent>
              <TabsContent value="paste" className="space-y-2 pt-3">
                <Label htmlFor="import-paste">Workflow JSON</Label>
                <Textarea
                  id="import-paste"
                  rows={8}
                  placeholder='{"format":"sublime.flow", …} or {"nodes":[…],"connections":{…}}'
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                  className="font-mono text-xs"
                />
              </TabsContent>
            </Tabs>
            {error && (
              <p className="flex items-start gap-1.5 text-sm text-red-600">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => void submit()} loading={submitting}>Import</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

Check `Button`'s `loading` prop and `Tabs` exports exist in `src/components/ui/` (the flows page already uses `loading`; `tabs.tsx` is present). If `Textarea`/`Label` export names differ, match them.

- [ ] **Step 2: Wire it into the flows list page**

In `src/app/(app)/g/[scope]/flows/page.tsx`:

1. Add imports: `Upload` to the `lucide-react` list; `import { ImportFlowDialog } from '@/components/flows/import-flow-dialog'`.
2. Add state next to the other dialog state: `const [importOpen, setImportOpen] = useState(false)`.
3. Replace the header button block (around `:270-276`) with:

```tsx
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1.5 h-4 w-4" /> Import
          </Button>
          <Button onClick={createFlow} loading={creating}>
            <Plus className="mr-1.5 h-4 w-4" /> New flow
          </Button>
        </div>
```

4. Render the dialog next to the existing delete/disable dialogs (end of the returned JSX):

```tsx
      <ImportFlowDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(flowId) => {
          setImportOpen(false)
          void refresh()
          router.push(`/flows/${flowId}`)
        }}
      />
```

(`router` here is the page's existing `useScopedRouter()` instance — same navigation call as `createFlow`.)

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit && npx next lint --file "src/components/flows/import-flow-dialog.tsx" --file "src/app/(app)/g/[scope]/flows/page.tsx"`
(if `next lint` isn't configured, `npm run lint` — check package.json scripts)
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/flows/import-flow-dialog.tsx "src/app/(app)/g/[scope]/flows/page.tsx"
git commit -m "feat(flows): Import dialog — upload, URL, or paste JSON on the flows list"
```

---

### Task 8: Full verification

**Files:** none new.

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: PASS, including the three structural guards (route-permissions, mutation-coverage, mutation-route-contract) and every new `src/lib/import` test.

- [ ] **Step 2: DB-backed pass**

Start throwaway Postgres per the repo's `verify` skill (deploy migrations first — see the QA DB gotcha memory), then:

Run: `TEST_DATABASE_URL=<url> npm test`
Expected: PASS including `flow-import.test.ts` and the existing flow e2e suites.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles clean (no Supabase env needed for build per repo memory).

- [ ] **Step 4: Commit any fixups and finish**

```bash
git status --short   # nothing unexpected
```

Then use superpowers:finishing-a-development-branch to decide integration (target branch: `feat/goal-recovery-plans`).

---

## Self-Review (done at authoring time)

- **Spec coverage:** formats (T1/T3/T4), n8n mapping table (T4), rebinding + warn (T2/T6), secrets stripping (T2/T3/T6 tests), API + SSRF + rate limit + transaction (T5/T6), UI dialog + report (T7), structural guards (T6/T8). `sublime.agent` targeted error: T6. Expression warning: T4. Trigger-less n8n: T4.
- **Type consistency:** `ImportedFlow` produced by all three converters (T3/T4) and consumed by T6; `sanitizeImportedGraph`/`remapAgentRefs` signatures match between T2 and T6; `MAX_IMPORT_BYTES` shared T5→T6; dialog consumes T6's response shape.
- **Known judgment calls for implementers:** exact `FlowValidationResult` issue field name, `assertPublicUrl` signature, and test-auth helper signatures are to be confirmed against the named files — the consuming code is written to the dominant existing patterns.
