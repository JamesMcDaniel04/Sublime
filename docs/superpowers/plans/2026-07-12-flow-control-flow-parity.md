# Implementation Plan — Flow Control-Flow Parity (Gumloop parity, Track 2)

**Predecessor:** [2026-07-11-gumloop-track1-flows-as-tools.md](2026-07-11-gumloop-track1-flows-as-tools.md) (shipped: flows-as-tools + Input/Output nodes + synchronous subflow). This plan closes the **5 remaining Gumloop flow-orchestration gaps**. Parity gap source: [../../parity/2026-07-11-flow-parity-gaps.md](../../parity/2026-07-11-flow-parity-gaps.md).

## Goal

Close the last 5 control-flow gaps so a Sublime flow can express Gumloop-style branching, reconvergence, ad-hoc reasoning, batch memory, and error recovery:

1. **Router (AI-mode)** — a `router` node with N labelled branches where a **cheap LLM** picks the branch from the resolved input + branch descriptions (vs the deterministic `switch`).
2. **Join** — configurable reconvergence of `parallel` branches into one merged value (array / labelled object / shallow-merge), vs today's fixed opaque keyed object.
3. **Inline-prompt agent node** — the `agent` node gains an optional `prompt` + `model` "run this prompt" mode (an ephemeral one-shot model call, **no saved `AgentTask`**), used when `agentId` is empty.
4. **Loop-Mode conversation threading** — an opt-in `loop.threadAgent` that threads one agent conversation across iterations (multi-turn batch memory), vs a fresh conversation each iteration.
5. **Error Shield** — a new `errorShield` **container** (body + fallback): on a body failure it routes to the fallback path (vs only per-step `onError:'continue'`).

## Architecture

- **Pure interpreter, injected adapters.** `interpretFlow` ([src/features/flows/interpret.ts](../../../src/features/flows/interpret.ts)) is a pure graph walker; every impure call is injected (`RunAgentFn`/`RunActionFn`/`RunFlowFn`). This plan:
  - adds a **new injected adapter `RouteAiFn`** for the Router's LLM branch-pick (the interpreter must NOT call the model directly — same discipline as `runAgent`);
  - extends `RunAgentFn`'s node payload with `prompt`/`model` (inline agent) and `thread` (loop-thread);
  - adds `router`/`errorShield` arms and a `join` merge to the `parallel` arm.
- **Cheap LLM seam (real).** [src/lib/llm/model-runner.ts](../../../src/lib/llm/model-runner.ts) already exposes `generateStructured` (JSON-schema-constrained one-shot, cross-provider fallback) and `generateHeadline` (cheap `messages.create`). The Router's branch pick uses **`generateStructured`** (enum-constrained → reliable). The inline agent uses a **new small `generateText`** (one-shot text completion, mirrors `generateHeadline`). Neither creates an `AgentExecution` row or loads tools/RAG — they are direct model calls.
- **Reconvergence rides the existing `parallel` fan-out.** `parallel` ([interpret.ts:635](../../../src/features/flows/interpret.ts)) already does `Promise.all` over branch bodies and merges into `{ [branch[0] ?? node.id]: output }`. Join changes only the **output-assembly line**, extracted into a pure `joinBranchOutputs`. No new container.
- **Error Shield rides the existing container model.** `loop`/`parallel` are containers with node-id member lists executed via `execBody`. `errorShield` is a container with two member lists (`body`, `fallback`): run `body`; on a `fail` control, run `fallback` instead. Same `contained`-set/validation/UI-container machinery.
- **Loop-thread rides the agent runtime.** Threading needs `runAgentExecution` to **continue** a prior completed execution with a new user turn — which it cannot do today (see Constraints). This plan adds a minimal `continueExecutionId` transcript-seed mode to [execute-agent.ts](../../../src/features/agents/execute-agent.ts) and a per-run `threadKey → executionId` map in the `runAgent` adapter.
- **Pure decision logic extracted + unit-tested** with `node:test`, mirroring [src/lib/flows/__tests__/io-nodes.test.ts](../../../src/lib/flows/__tests__/io-nodes.test.ts): `src/lib/flows/router.ts` (prompt/schema/parse) and `src/lib/flows/join.ts` (`joinBranchOutputs`). Interpreter behaviour is tested through the injected-adapter harness (fake `routeAi`/`runAgent`), like [interpret.test.ts](../../../src/features/flows/__tests__/interpret.test.ts).

## Tech Stack

- TypeScript (strict), Zod graph schema ([src/lib/flows/graph.ts](../../../src/lib/flows/graph.ts)), Anthropic SDK via `model-runner.ts`, Prisma, Next.js.
- **Test runner:** `node:test` via tsx. Single-file red/green loop: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path/to/file.test.ts>`. Whole suite: `npm test` (`TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test $(find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -path '*__tests__*')`).
- Typecheck: `npx tsc --noEmit` — **mandatory after Task 1 and Task 2** (the two exhaustive-switch tasks).
- Test style: `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`; pure functions and the interpreter's fake-adapter harness. No DB in unit tests (DB-touching adapters are verified by typecheck + the pure seam they delegate to + one manual inline run).

## Global Constraints

- **HARD INVARIANT — existing flows run byte-identically.** Every already-stored graph parses and runs with the *same* step rows and *same* returned output:
  - `parallel` with **`join` unset** returns the exact current `{ [branch[0] ?? node.id]: output }` object (Task 5 defaults to it).
  - `agent` with a non-empty `agentId` runs the saved-agent path unchanged; `prompt`/`model` are additive optionals (Task 6).
  - `loop` with **`threadAgent` unset/false** builds the same fresh per-item context (Task 7).
  - No `router`/`errorShield` exists in any stored graph until this ships; the new arms are inert for legacy graphs. Covered by explicit back-compat interpreter tests in Tasks 5–8.
- **HARD INVARIANT — the exhaustive-switch UI/mutate files MUST be updated for any NEW node kind, or `tsc` breaks.** Track 1 assumed adding node kinds wouldn't break `tsc`; that was WRONG. `router` and `errorShield` are new `FlowNode['type']` members, so **Task 1 must, in the same commit,** add keys/cases to the non-`Partial` records and value-returning switches or `tsc` fails:
  - [src/components/flows/step-card.tsx](../../../src/components/flows/step-card.tsx) — `NODE_ICON: Record<FlowNode['type'], …>` (line 109) and `NODE_TONE: Record<FlowNode['type'], string>` (line 131) — **compile break** without new keys.
  - [src/lib/flows/mutate.ts](../../../src/lib/flows/mutate.ts) — `defaultData(type: FlowNode['type'])` (line 19), a `switch` returning `FlowNode['data']` with no `default` — **compile break** without new cases.
  - Non-breaking but must be updated for correctness (both have a `default:` arm): `titleFor`/`subtitleFor` ([flow-canvas.tsx:194,243](../../../src/components/flows/flow-canvas.tsx)); `nodeLabel` ([validate.ts:25](../../../src/lib/flows/validate.ts)); `renderNodeBody` ([step-card.tsx:889](../../../src/components/flows/step-card.tsx)).
- **Interpreter purity.** The Router's model call is injected as `opts.routeAi`. The interpreter never imports `model-runner.ts`. Inline-agent/loop-thread model work lives in the `execute-flow.ts` adapters.
- **No invented APIs.** Reuse: `FlowNode`/`FieldType`/`OutputField`/`flowNodeSchema` (graph.ts); `FlowContext`/`resolveTemplate`/`resolveTemplateValue`/`asStructured` (context.ts); `RunAgentFn`/`RunActionFn`/`RunFlowFn`/`InterpretResult`/`NodeResult` (interpret.ts); `structuredResponseInstruction`/`parseStructuredAgentOutput` (agent-response.ts); `generateStructured`/`generateHeadline`/`DEFAULT_AGENT_MODEL`/`isProviderAvailabilityError`/`structuredProviderOrder`/`qwenClient`/`qwenModel`/`claudeClient` (model-runner.ts — some are file-local; `generateText` is added there); `coerceToIR`/`irUser` (ir.ts) + `appendUserMessage` (ModelRunner) for the thread seed.
- **Resume stability.** A Router pick is non-deterministic; on resume the interpreter MUST reuse the branch chosen on the first run (from `opts.completed`) instead of re-calling the model (Task 4). Loop-thread executions chain by seeded transcript, not one re-opened row (Task 7).
- **Graceful degradation.** No `routeAi` adapter → a `router` node fails cleanly ("Router steps need an AI runtime"). Inline-agent/thread model failures surface as the step's `error` under existing `onError` semantics — never a run crash.
- Commit after each green step (Conventional Commits); one task per branch off `main`.

## File Structure

**Create:**
| File | Responsibility |
|---|---|
| `src/lib/flows/router.ts` | Pure: `buildRouterPrompt`, `routerBranchSchema`, `parseRouterChoice`. |
| `src/lib/flows/__tests__/router.test.ts` | Unit tests for the above. |
| `src/lib/flows/join.ts` | Pure: `joinBranchOutputs(entries, strategy)`. |
| `src/lib/flows/__tests__/join.test.ts` | Unit tests. |
| `src/lib/flows/__tests__/graph-control-flow.test.ts` | Schema tests for the new/extended node kinds. |
| `src/features/flows/__tests__/interpret-router.test.ts` | Router interpreter behaviour (fake `routeAi`). |
| `src/features/flows/__tests__/interpret-join.test.ts` | Join reconvergence + back-compat. |
| `src/features/flows/__tests__/interpret-inline-agent.test.ts` | Inline-agent branch (fake `runAgent`). |
| `src/features/flows/__tests__/interpret-loop-thread.test.ts` | Loop-thread `ctx.thread` propagation. |
| `src/features/flows/__tests__/interpret-error-shield.test.ts` | Error Shield body/fallback semantics. |

**Modify:**
| File | Change |
|---|---|
| `src/lib/flows/graph.ts` | `routerNode`, `errorShieldNode`; extend `agentNode` (`prompt`,`model`), `loopNode` (`threadAgent`), `parallelNode` (`join`,`labels`); add to union. |
| `src/features/flows/context.ts` | `FlowContext.error?: string` (`{{error}}`), `FlowContext.thread?: { key; iteration }`. |
| `src/components/flows/step-card.tsx` | `NODE_ICON`/`NODE_TONE` keys; `renderNodeBody` + `RouterBody`/`ErrorShieldBody`/inline `AgentBody`/parallel `join` control (Tasks 2,4,5,6,8). |
| `src/lib/flows/mutate.ts` | `defaultData` cases; container plumbing for `errorShield` (body+fallback) across every loop/parallel enumeration. |
| `src/components/flows/node-types.ts` | `EditableType` union + `NODE_TYPES` palette entries for `router`,`errorShield`. |
| `src/components/flows/flow-canvas.tsx` | `contained` set, `titleFor`/`subtitleFor`, `nestedCards` (errorShield body+fallback), `renderChain` router branch fan-out. |
| `src/lib/flows/validate.ts` | `nodeLabel`, `reachableFrom`, `containerMemberIds`, validation arms + guards (router-in-container, errorShield members, inline-agent, join, loop-thread). |
| `src/features/flows/interpret.ts` | `RouteAiFn` type + `opts.routeAi`; `router` walker arm; `parallel` join; `agent` inline pass-through; `loop` thread ctx; `errorShield` arm; `contained` set. |
| `src/features/flows/execute-flow.ts` | `routeAi` adapter (→`generateStructured`); `runAgent` inline branch (→`generateText`) + thread map (→`continueExecutionId`). |
| `src/features/agents/execute-agent.ts` | `continueExecutionId` transcript-seed mode on `runAgentExecution`. |
| `src/lib/llm/model-runner.ts` | `generateText({system,user,model,maxTokens})`. |
| `src/lib/flows/copilot-grounding.ts` | `graphRules` clauses for the 5 features. |

---

## Task 1 — Shared graph schema + compile-forced exhaustive switches

Adds the two new node kinds and the three node extensions, and — **in the same commit** — the mandatory `tsc`-breaking record/switch keys so the tree compiles. Behaviour comes in later tasks; this task only makes the graph representable and the app compile.

**Files:** `src/lib/flows/graph.ts` (modify), `src/features/flows/context.ts` (modify), `src/components/flows/step-card.tsx` (modify — `NODE_ICON`/`NODE_TONE` only), `src/lib/flows/mutate.ts` (modify — `defaultData` cases only), `src/lib/flows/__tests__/graph-control-flow.test.ts` (create).

**Interfaces**
- Produces:
  - `router` node: `{ id; type:'router'; data:{ label?; note?; input?; instructions?; branches: { id: string; label?: string; description?: string }[] } }`.
  - `errorShield` node: `{ id; type:'errorShield'; data:{ label?; note?; body: string[]; fallback: string[] } }`.
  - `agentNode.data` gains `prompt?: string`, `model?: string`.
  - `loopNode.data` gains `threadAgent?: boolean`.
  - `parallelNode.data` gains `join?: 'object'|'array'|'merge'`, `labels?: string[]`.
  - `FlowContext` gains `error?: string`, `thread?: { key: string; iteration: number }`.

### Steps

1. **Write failing test** — `src/lib/flows/__tests__/graph-control-flow.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, emptyGraph } from '../graph'

test('router node parses with labelled branches', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'r', type: 'router', data: { input: '{{trigger.input}}', branches: [
        { id: 'billing', label: 'Billing', description: 'Payment, invoices, refunds' },
        { id: 'tech', label: 'Tech', description: 'Bugs and errors' },
      ] } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const r = parsed.success && parsed.data.nodes.find((n) => n.type === 'router')
  assert.ok(r && r.type === 'router')
  assert.equal(r.data.branches[0].id, 'billing')
})

test('errorShield node parses with body + fallback member lists', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'shield', type: 'errorShield', data: { body: ['a'], fallback: ['b'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'y' } },
      { id: 'b', type: 'agent', data: { agentId: 'z', input: 'w' } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const s = parsed.success && parsed.data.nodes.find((n) => n.type === 'errorShield')
  assert.ok(s && s.type === 'errorShield')
  assert.deepEqual(s.data.body, ['a'])
  assert.deepEqual(s.data.fallback, ['b'])
})

test('agent gains inline prompt+model; loop gains threadAgent; parallel gains join', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'inline', type: 'agent', data: { agentId: '', prompt: 'Classify {{trigger.input}}', model: 'claude-haiku-4-5' } },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', threadAgent: true, body: ['inline'] } },
      { id: 'par', type: 'parallel', data: { join: 'array', labels: ['a', 'b'], branches: [['inline'], ['inline']] } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const a = parsed.success && parsed.data.nodes.find((n) => n.id === 'inline')
  assert.ok(a && a.type === 'agent' && a.data.prompt === 'Classify {{trigger.input}}')
})

test('BACK-COMPAT: emptyGraph + a parallel with no join still parse', () => {
  assert.equal(flowGraphSchema.safeParse(emptyGraph()).success, true)
  const legacy = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'p', type: 'parallel', data: { branches: [['x']] } },
      { id: 'x', type: 'agent', data: { agentId: 'a', input: 'i' } },
    ],
    edges: [],
  })
  assert.equal(legacy.success, true)
})
```

2. **Run — fails** (schema doesn't know the kinds/fields): `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/graph-control-flow.test.ts`.

3. **Implement — `src/lib/flows/graph.ts`.**
   - Extend `agentNode.data` (after `humanAssistance`, line ~75):
```ts
    // Inline-prompt mode: when agentId is blank, the step runs this prompt as an
    // ephemeral one-shot model call (no saved AgentTask). model overrides the
    // default; ignored when agentId is set (a saved agent brings its own model).
    prompt: z.string().optional(),
    model: z.string().optional(),
```
   - Extend `loopNode.data` (after `concurrency`, line ~151):
```ts
    // Loop-thread: keep ONE agent conversation across iterations (multi-turn
    // batch memory) instead of a fresh conversation each item. Forces sequential
    // execution (concurrency 1) — you cannot thread one conversation concurrently.
    threadAgent: z.boolean().optional(),
```
   - Extend `parallelNode.data` (line ~155):
```ts
const parallelNode = z.object({
  id: z.string(),
  type: z.literal('parallel'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    branches: z.array(z.array(z.string())),
    // Reconvergence strategy for the branch outputs. Unset = today's opaque
    // keyed object { [branchHeadNodeId]: output } (byte-identical back-compat).
    // 'array' = outputs in branch order; 'object' = keyed by `labels`;
    // 'merge' = shallow-merge branch objects into one.
    join: z.enum(['object', 'array', 'merge']).optional(),
    labels: z.array(z.string()).optional(),
  }),
})
```
   - Add the two new node consts (after `subflowNode`, line ~318):
```ts
// AI ROUTER: an LLM picks one labelled branch from the resolved input + each
// branch's description. Routed on the MAIN CHAIN by edge branch = chosen id
// (like switch), with a `default` edge fallback. The pick is delegated to an
// injected adapter (RouteAiFn) so the interpreter stays pure; on resume the
// interpreter reuses the branch chosen on the first run (determinism).
const routerNode = z.object({
  id: z.string(),
  type: z.literal('router'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    input: z.string().optional(),
    instructions: z.string().optional(),
    branches: z.array(z.object({ id: z.string(), label: z.string().optional(), description: z.string().optional() })).default([]),
  }),
})
// ERROR SHIELD: a container that runs `body`; if the body FAILS, it runs
// `fallback` instead and shields the error (the step succeeds with the
// fallback's output). pause/stop/drop are NOT shielded (they propagate). The
// caught error is exposed to the fallback via {{error}}.
const errorShieldNode = z.object({
  id: z.string(),
  type: z.literal('errorShield'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    body: z.array(z.string()).default([]),
    fallback: z.array(z.string()).default([]),
  }),
})
```
   - Add both to the union:
```ts
export const flowNodeSchema = z.discriminatedUnion('type', [
  triggerNode, agentNode, conditionNode, loopNode, parallelNode, stopNode, toolNode, httpNode, transformNode, filterNode, switchNode, variableNode, dataNode, humanReviewNode, inputNode, outputNode, subflowNode, routerNode, errorShieldNode,
])
```

4. **Implement — `src/features/flows/context.ts`.** Add to `FlowContext` (after `input?`, line ~19):
```ts
  // Set inside an Error Shield's fallback body: the caught error message,
  // readable via `{{error}}`. Absent outside a shielded fallback.
  error?: string
  // Set inside a threaded loop body (loop.threadAgent): the stable thread key
  // (per loop) + 0-based iteration, so the agent adapter can continue ONE
  // conversation across iterations. Absent in normal (unthreaded) bodies.
  thread?: { key: string; iteration: number }
```
   (`readPath` already walks any root property, so `{{error}}` resolves with no change.)

5. **Implement — compile-forced switches (MANDATORY, same commit).**
   - `src/components/flows/step-card.tsx` — add to `NODE_ICON` (import `Sparkles`, `ShieldAlert` from `lucide-react`):
```ts
  router: Sparkles,
  errorShield: ShieldAlert,
```
   and to `NODE_TONE`:
```ts
  router: 'bg-fuchsia-500 text-white',
  errorShield: 'bg-rose-600 text-white',
```
   - `src/lib/flows/mutate.ts` — add to `defaultData`'s switch (before `case 'trigger'`):
```ts
    case 'router':
      return { input: '{{trigger.input}}', branches: [{ id: 'branch1', label: '' }] }
    case 'errorShield':
      return { body: extra?.bodyId ? [extra.bodyId] : [], fallback: [] }
```
   (Container body wiring for `errorShield` in `makeNode`/`changeNodeType` is Task 2; this case alone satisfies the `switch`'s exhaustiveness so `tsc` passes now.)

6. **Run — passes.** Then **`npx tsc --noEmit` — must be clean** (this is the task that proves the exhaustive switches are satisfied).

7. **Commit:** `feat(flows): add router + errorShield node kinds and inline/thread/join fields to the graph schema`.

---

## Task 2 — Builder plumbing: mutate container ops, palette, canvas rendering

Makes `router` and `errorShield` creatable and editable in the builder, and wires `errorShield`'s two-list container into every loop/parallel enumeration. No interpreter behaviour yet.

**Files:** `src/lib/flows/mutate.ts` (modify), `src/components/flows/node-types.ts` (modify), `src/components/flows/flow-canvas.tsx` (modify), `src/lib/flows/__tests__/mutate.test.ts` (append).

**Interfaces**
- `errorShield` participates in: `makeNode`, `changeNodeType`, `addContainerStep`, `containerPositionOf`, `insertIntoContainer`, `duplicateNode`, `deleteNode`, `containedIdsOf`, `subtreeIdsOf`, `sanitizeCopiedNode`, `moveNodeAfter`'s contained set — all the places that today special-case `loop`/`parallel`.
- `router`/`errorShield` join `EditableType` + `NODE_TYPES`.
- Canvas: `contained` set, `titleFor`/`subtitleFor` arms, `nestedCards` (errorShield body+fallback columns), `renderChain` router branch fan-out.

### Steps

1. **Write failing test** — append to `src/lib/flows/__tests__/mutate.test.ts`:
```ts
import { insertNodeAfter, changeNodeType, addContainerStep, duplicateNode, deleteNode } from '../mutate'
import { emptyGraph } from '../graph'

test('errorShield is created with a body agent step and an empty fallback', () => {
  const g0 = emptyGraph()
  const { graph, nodeId } = insertNodeAfter(g0, 'trigger', 'errorShield')
  const shield = graph.nodes.find((n) => n.id === nodeId)
  assert.ok(shield && shield.type === 'errorShield')
  assert.equal(shield.data.body.length, 1)
  assert.equal(shield.data.fallback.length, 0)
  assert.ok(graph.nodes.find((n) => n.id === shield.data.body[0]))
})

test('deleteNode purges an id from errorShield body AND fallback', () => {
  const g0 = emptyGraph()
  const { graph: g1, nodeId: shieldId } = insertNodeAfter(g0, 'trigger', 'errorShield')
  const shield = g1.nodes.find((n) => n.id === shieldId)!
  const bodyId = shield.type === 'errorShield' ? shield.data.body[0] : ''
  const g2 = deleteNode(g1, bodyId)
  const after = g2.nodes.find((n) => n.id === shieldId)
  assert.ok(after && after.type === 'errorShield')
  assert.equal(after.data.body.includes(bodyId), false)
})

test('router can be created and retyped', () => {
  const { graph, nodeId } = insertNodeAfter(emptyGraph(), 'trigger', 'router')
  assert.ok(graph.nodes.find((n) => n.id === nodeId && n.type === 'router'))
  const retyped = changeNodeType(graph, nodeId, 'switch')
  assert.equal(retyped.nodes.find((n) => n.id === nodeId)!.type, 'switch')
})
```

2. **Run — fails** (`errorShield` has no container wiring; `insertNodeAfter` seeds no body).

3. **Implement — `src/lib/flows/mutate.ts`.** Treat `errorShield` as a container with a body wherever `loop`/`parallel` are special-cased. The pattern: add `errorShield` to the container predicate and read/write its `body` (and, in enumerations, `fallback`).
   - `makeNode` (line ~58): change the container guard to include `errorShield`, and seed its `body`:
```ts
  if (type === 'loop' || type === 'parallel' || type === 'errorShield') {
    const bodyId = `${id}b1`
    const body = {
      id: bodyId,
      type: 'agent',
      data: {
        agentId: agentId ?? '',
        input: type === 'loop' ? 'Process this item:\n{{item}}' : 'Use this flow input:\n{{trigger.input}}',
      },
    } as FlowNode
    return { node: { id, type, data: defaultData(type, { bodyId }) } as FlowNode, extraNodes: [body] }
  }
```
   - `changeNodeType` (line ~130): same guard extension (`errorShield`'s `defaultData({ bodyId })` puts the seed in `body`).
   - `addContainerStep` (line ~148): add an `errorShield` arm appending to `body`:
```ts
    if (node.type === 'errorShield') return { ...node, data: { ...node.data, body: [...node.data.body, bodyNode.id] } }
```
     (Adding to the *fallback* list is a follow-up; v1 adds to `body`.)
   - `containerPositionOf` (line ~167): add:
```ts
    if (node.type === 'errorShield') {
      const b = node.data.body.indexOf(id)
      if (b >= 0) return { containerId: node.id, index: b }
      const f = node.data.fallback.indexOf(id)
      if (f >= 0) return { containerId: node.id, branchIndex: -1, index: f } // -1 marks the fallback list
    }
```
     and in `insertIntoContainer` (line ~184) handle it:
```ts
    if (entry.type === 'errorShield') {
      const list = position.branchIndex === -1 ? [...entry.data.fallback] : [...entry.data.body]
      list.splice(position.index + 1, 0, insertedId)
      return position.branchIndex === -1
        ? { ...entry, data: { ...entry.data, fallback: list } }
        : { ...entry, data: { ...entry.data, body: list } }
    }
```
   - `duplicateNode` (line ~206): copy empties both lists:
```ts
  if (copy.type === 'errorShield') copy.data = { ...copy.data, body: [], fallback: [] }
```
   - `deleteNode` (line ~235): purge from both lists:
```ts
      if (node.type === 'errorShield') return { ...node, data: { ...node.data, body: node.data.body.filter((b) => b !== id), fallback: node.data.fallback.filter((b) => b !== id) } }
```
   - `containedIdsOf` (line ~254):
```ts
  if (node.type === 'errorShield') return [...node.data.body, ...node.data.fallback]
```
   - `sanitizeCopiedNode` (line ~364):
```ts
  if (node.type === 'errorShield') return { ...node, data: { ...node.data, body: [], fallback: [] } }
```
   (`subtreeIdsOf` and `moveNodeAfter`'s `contained` set both call `containedIdsOf`, so they pick up `errorShield` automatically.)

4. **Implement — `src/components/flows/node-types.ts`.** Extend the union + palette:
```ts
export type EditableType = Extract<
  FlowNode['type'],
  'agent' | 'condition' | 'loop' | 'parallel' | 'stop' | 'tool' | 'http' | 'transform' | 'filter' | 'switch' | 'variable' | 'data' | 'humanReview' | 'router' | 'errorShield'
>

export const NODE_TYPES: { value: EditableType; label: string }[] = [
  { value: 'agent', label: 'Run agent' },
  { value: 'tool', label: 'Tool call' },
  { value: 'http', label: 'HTTP request' },
  { value: 'transform', label: 'Set fields' },
  { value: 'data', label: 'Data operation' },
  { value: 'variable', label: 'Variable' },
  { value: 'humanReview', label: 'Request information' },
  { value: 'condition', label: 'If / else' },
  { value: 'switch', label: 'Switch' },
  { value: 'router', label: 'AI router' },
  { value: 'filter', label: 'Filter' },
  { value: 'loop', label: 'For each' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'errorShield', label: 'Error shield' },
  { value: 'stop', label: 'Stop' },
]
```

5. **Implement — `src/components/flows/flow-canvas.tsx`.**
   - `contained` set (line ~188): include `errorShield` members:
```ts
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body
      : node.type === 'parallel' ? node.data.branches.flat()
      : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
      : [],
    ),
  )
```
   - `titleFor` (line ~194): add arms before `default`:
```ts
      case 'router':
        return node.data.label || 'AI router'
      case 'errorShield':
        return node.data.label || 'Error shield'
```
   - `subtitleFor` (line ~243): add:
```ts
      case 'router':
        return `${node.data.branches.length} branch${node.data.branches.length === 1 ? '' : 'es'}`
      case 'errorShield':
        return `${node.data.body.length} step${node.data.body.length === 1 ? '' : 's'}, ${node.data.fallback.length} fallback`
```
   - `nestedCards` (line ~332): render an `errorShield`'s two labelled columns (Body / On error), reusing the container reorder machinery. Mirror the loop/parallel branch handling: for `errorShield`, `ids = [...body, ...fallback]`, and `siblingsOf` returns `body` (branchIndex `undefined`) or `fallback` (branchIndex `-1`, matching `insertIntoContainer`). Render two dashed columns with headers "Body" and "On error → fallback", each with an `AddNestedStepMenu`/`InsertMenu` wired to `onAddContainerStep` (body) — fallback add is a follow-up affordance, called out in Assumptions.
   - `renderChain` (line ~405, after the `switch` block): add a `router` branch fan-out identical to `switch` but reading `node.data.branches`:
```ts
      if (node.type === 'router') {
        const branches = [
          ...node.data.branches.map((b) => ({ key: b.id, label: b.label || b.description || b.id })),
          { key: 'default', label: 'default' },
        ]
        parts.push(
          <div key={`${node.id}-router`} className="my-3 grid gap-4 md:grid-cols-2">
            {branches.map((branch) => (
              <div key={branch.key} className="rounded-2xl border border-dashed border-slate-300 bg-white/75 p-3">
                <p className="mb-3 truncate text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{branch.label}</p>
                <div className="space-y-3">
                  {renderChain(branchHead(node.id, branch.key), seen)}
                  <InsertMenu compact agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onAppendBranch(node.id, branch.key, type, seed)} />
                </div>
              </div>
            ))}
          </div>,
        )
        return parts
      }
```
   - The card's drag guard (line ~322) already excludes `condition`/`switch`; add `&& node.type !== 'router'` so a router (branch-anchor) can't be relocated (its branches would orphan). And `onAddStep` (line ~326) enables the nested add for `errorShield` too:
```ts
        onAddStep={(node.type === 'loop' || node.type === 'parallel' || node.type === 'errorShield') && onAddContainerStep ? (type) => onAddContainerStep(node.id, type) : undefined}
```

6. **Run — passes**, `npx tsc --noEmit` clean.

7. **Commit:** `feat(flows): builder create/edit/canvas support for router + errorShield`.

---

## Task 3 — Validation for all 5 features

**Files:** `src/lib/flows/validate.ts` (modify), `src/lib/flows/__tests__/validate.test.ts` (append).

**Interfaces**
- `nodeLabel` cases for `router`/`errorShield`.
- `reachableFrom` + `containerMemberIds` include `errorShield` members.
- New checks: router branches (≥1, ids non-empty + unique, default-edge warning, router blocked in container); errorShield (body ≥1; fallback-empty warning; members guarded like a loop body); inline-agent (agent needs `agentId` OR `prompt`; both → warning); join (`labels`/`branches` length mismatch warning); loop-thread (`threadAgent` + `concurrency>1` warning; body must contain an agent).

### Steps

1. **Write failing test** — append to `src/lib/flows/__tests__/validate.test.ts`:
```ts
test('router: needs branches, unique ids, and is blocked inside a container', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['r'] } },
      { id: 'r', type: 'router', data: { branches: [{ id: 'a' }, { id: 'a' }] } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'loop' }],
  })
  const codes = r.errors.map((e) => e.code)
  assert.ok(codes.includes('DUPLICATE_ROUTER_BRANCH'))
  assert.ok(codes.includes('ROUTER_IN_CONTAINER'))
})

test('errorShield needs a body; empty fallback is a warning', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'errorShield', data: { body: [], fallback: [] } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 's' }],
  })
  assert.ok(r.errors.some((e) => e.code === 'EMPTY_SHIELD_BODY'))
  assert.ok(r.warnings.some((e) => e.code === 'EMPTY_SHIELD_FALLBACK'))
})

test('inline agent: no agentId AND no prompt is an error', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: '', prompt: '' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'a' }],
  }, { agents: [] })
  assert.ok(r.errors.some((e) => e.code === 'MISSING_AGENT_OR_PROMPT'))
})

test('inline agent with a prompt and no agentId is valid', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: '', prompt: 'Classify {{trigger.input}}' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'a' }],
  }, { agents: [] })
  assert.equal(r.errors.some((e) => e.code === 'MISSING_AGENT'), false)
  assert.equal(r.errors.some((e) => e.code === 'MISSING_AGENT_OR_PROMPT'), false)
})
```

2. **Run — fails.**

3. **Implement — `src/lib/flows/validate.ts`.**
   - `nodeLabel` (line ~29): add `case 'router': return 'AI router'` and `case 'errorShield': return 'Error shield'`.
   - `reachableFrom` (line ~242): add `if (node.type === 'errorShield') { node.data.body.forEach(visit); node.data.fallback.forEach(visit) }`.
   - Replace the **agent** validation arm (line ~348) with an inline-aware version:
```ts
    if (node.type === 'agent') {
      const hasAgent = Boolean(node.data.agentId?.trim())
      const hasPrompt = Boolean(node.data.prompt?.trim())
      if (!hasAgent && !hasPrompt) {
        add(issues, 'error', 'MISSING_AGENT_OR_PROMPT', `${nodeLabel(node)} needs a saved agent or an inline prompt.`, node.id)
      } else if (hasAgent && context.agents && !agentIds.has(node.data.agentId)) {
        add(issues, 'error', 'UNKNOWN_AGENT', `${nodeLabel(node)} uses an agent that is not available.`, node.id)
      } else if (hasAgent && hasPrompt) {
        add(issues, 'warning', 'AGENT_AND_PROMPT', `${nodeLabel(node)} has both a saved agent and an inline prompt — the saved agent is used and the prompt is ignored.`, node.id)
      }
      if (!hasAgent && hasPrompt) { /* inline: input optional */ }
      else if (!node.data.input?.trim()) {
        add(issues, 'warning', 'EMPTY_AGENT_INPUT', `${nodeLabel(node)} has an empty message.`, node.id)
      }
    }
```
   - After the `parallel` arm (line ~419), add a `join`/`labels` sanity warning:
```ts
    if (node.type === 'parallel' && node.data.join === 'object' && node.data.labels && node.data.labels.length !== node.data.branches.length) {
      add(issues, 'warning', 'JOIN_LABELS_MISMATCH', `${nodeLabel(node)} has ${node.data.labels.length} join label(s) for ${node.data.branches.length} branch(es).`, node.id)
    }
```
   - After the `loop` arm (line ~409), add thread constraints:
```ts
    if (node.type === 'loop' && node.data.threadAgent) {
      if ((node.data.concurrency ?? 1) > 1) {
        add(issues, 'warning', 'THREAD_FORCES_SEQUENTIAL', `${nodeLabel(node)} threads one conversation across iterations, so it runs sequentially (concurrency 1).`, node.id)
      }
      const bodyHasAgent = node.data.body.some((id) => byId.get(id)?.type === 'agent')
      if (!bodyHasAgent) {
        add(issues, 'warning', 'THREAD_NO_AGENT', `${nodeLabel(node)} has conversation threading on but no agent step in its body.`, node.id)
      }
    }
```
   - Add the `router` and `errorShield` structural arms (after the `switch` arm, line ~444):
```ts
    if (node.type === 'router') {
      if (node.data.branches.length === 0) add(issues, 'error', 'EMPTY_ROUTER', `${nodeLabel(node)} needs at least one branch.`, node.id)
      const ids = node.data.branches.map((b) => b.id.trim()).filter(Boolean)
      node.data.branches.forEach((b, index) => {
        if (!b.id.trim()) add(issues, 'error', 'MISSING_ROUTER_BRANCH_ID', `${nodeLabel(node)} branch ${index + 1} needs an id.`, node.id)
        if (!b.description?.trim() && !b.label?.trim()) add(issues, 'warning', 'ROUTER_BRANCH_NO_HINT', `${nodeLabel(node)} branch ${index + 1} has no label or description for the AI to route on.`, node.id)
      })
      for (const id of unique(ids)) {
        if (ids.filter((entry) => entry === id).length > 1) add(issues, 'error', 'DUPLICATE_ROUTER_BRANCH', `${nodeLabel(node)} has duplicate branch id "${id}".`, node.id)
      }
      if (!graph.edges.some((edge) => edge.source === node.id && edge.branch === 'default')) {
        add(issues, 'warning', 'MISSING_ROUTER_DEFAULT', `${nodeLabel(node)} has no default branch.`, node.id)
      }
    }
    if (node.type === 'errorShield') {
      if (node.data.body.length === 0) add(issues, 'error', 'EMPTY_SHIELD_BODY', `${nodeLabel(node)} needs at least one step in its body.`, node.id)
      if (node.data.fallback.length === 0) add(issues, 'warning', 'EMPTY_SHIELD_FALLBACK', `${nodeLabel(node)} has no fallback steps — a body error is swallowed and produces no output.`, node.id)
      for (const memberId of [...node.data.body, ...node.data.fallback]) {
        if (!byId.has(memberId)) add(issues, 'error', 'MISSING_CONTAINER_STEP', `${nodeLabel(node)} references missing step "${memberId}".`, node.id)
      }
    }
```
   - `containerMemberIds` (line ~529): include `errorShield`:
```ts
  const containerMemberIds = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body
      : node.type === 'parallel' ? node.data.branches.flat()
      : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
      : [],
    ),
  )
```
   - In the container-member guard loop, extend the branching-node guard (line ~540) to include `router`, and the I/O guard remains:
```ts
    if (member.type === 'condition' || member.type === 'switch' || member.type === 'router') {
      add(issues, 'error', member.type === 'router' ? 'ROUTER_IN_CONTAINER' : 'CONDITION_IN_CONTAINER',
        `${nodeLabel(member)} can't run inside a For each / Parallel / Error shield body — branching isn't supported there.`, member.id)
    }
```
     (A `router` reuses the branching-in-container prohibition for the exact reason `switch` does: container bodies are flat ordered lists with no edges to route on.)

4. **Run — passes.**

5. **Commit:** `feat(flows): validate router, errorShield, inline agent, join, and loop-thread`.

---

## Task 4 — Router (AI-mode) interpreter + adapter

**Files:** `src/lib/flows/router.ts` (create), `src/lib/flows/__tests__/router.test.ts` (create), `src/features/flows/interpret.ts` (modify), `src/features/flows/execute-flow.ts` (modify), `src/features/flows/__tests__/interpret-router.test.ts` (create).

**Interfaces**
- Pure (`router.ts`):
  - `buildRouterPrompt(branches: RouterBranchSpec[], instructions: string | undefined, input: string): { system: string; user: string }`
  - `routerBranchSchema(branches: RouterBranchSpec[]): Record<string, unknown>` (JSON schema `{ branch: enum([...ids, 'default']) }`)
  - `parseRouterChoice(raw: string, branches: RouterBranchSpec[]): { branch: string } | { error: string }`
  - `type RouterBranchSpec = { id: string; label?: string; description?: string }`
- Interpreter: `type RouteAiFn = (node: { id: string; branches: RouterBranchSpec[]; instructions?: string; input: string }) => Promise<{ branch: string } | { error: string }>`; `opts.routeAi?: RouteAiFn`; a `router` arm in the **main-chain walker** (not `execNode`) with resume reuse.
- Adapter (`execute-flow.ts`): `routeAi` calling `generateStructured`.

### Steps

1. **Write failing test** — `src/lib/flows/__tests__/router.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRouterPrompt, routerBranchSchema, parseRouterChoice } from '../router'

const branches = [
  { id: 'billing', label: 'Billing', description: 'invoices, refunds' },
  { id: 'tech', description: 'bugs, errors' },
]

test('routerBranchSchema constrains branch to the ids plus default', () => {
  const schema = routerBranchSchema(branches) as any
  assert.deepEqual(schema.properties.branch.enum, ['billing', 'tech', 'default'])
  assert.deepEqual(schema.required, ['branch'])
})

test('buildRouterPrompt lists every branch id + hint and includes the input', () => {
  const { system, user } = buildRouterPrompt(branches, 'Be strict.', 'my invoice is wrong')
  assert.match(system, /billing/)
  assert.match(system, /invoices, refunds/)
  assert.match(system, /Be strict\./)
  assert.match(user, /my invoice is wrong/)
})

test('parseRouterChoice accepts a known id, rejects an unknown one, tolerates fences', () => {
  assert.deepEqual(parseRouterChoice('{"branch":"tech"}', branches), { branch: 'tech' })
  assert.deepEqual(parseRouterChoice('```json\n{"branch":"billing"}\n```', branches), { branch: 'billing' })
  assert.deepEqual(parseRouterChoice('{"branch":"default"}', branches), { branch: 'default' })
  assert.ok('error' in parseRouterChoice('{"branch":"nope"}', branches))
  assert.ok('error' in parseRouterChoice('not json', branches))
})
```

2. **Run — fails.**

3. **Implement — `src/lib/flows/router.ts`:**
```ts
export type RouterBranchSpec = { id: string; label?: string; description?: string }

/** JSON schema constraining the model reply to one known branch id (or default). */
export function routerBranchSchema(branches: RouterBranchSpec[]): Record<string, unknown> {
  const ids = branches.map((b) => b.id.trim()).filter(Boolean)
  return {
    type: 'object',
    properties: { branch: { type: 'string', enum: [...ids, 'default'] } },
    required: ['branch'],
    additionalProperties: false,
  }
}

/** The routing prompt: each branch's id + human hint, and the input to classify. */
export function buildRouterPrompt(
  branches: RouterBranchSpec[],
  instructions: string | undefined,
  input: string,
): { system: string; user: string } {
  const lines = branches
    .filter((b) => b.id.trim())
    .map((b) => `- "${b.id.trim()}"${b.label?.trim() ? ` (${b.label.trim()})` : ''}${b.description?.trim() ? `: ${b.description.trim()}` : ''}`)
  const system = [
    'You are a router. Choose the single best branch for the input from the list below.',
    'Reply with ONLY a JSON object {"branch": "<id>"} using one of these exact ids (or "default" if none fits):',
    ...lines,
    instructions?.trim() ? `\nAdditional guidance: ${instructions.trim()}` : '',
  ].filter(Boolean).join('\n')
  return { system, user: input }
}

function extractJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* next */ }
  }
  return undefined
}

/** Validate the model's pick against the known branch ids (or 'default'). */
export function parseRouterChoice(raw: string, branches: RouterBranchSpec[]): { branch: string } | { error: string } {
  const record = extractJson(raw)
  const choice = record && typeof record.branch === 'string' ? record.branch.trim() : ''
  if (!choice) return { error: 'The router did not return a branch choice.' }
  const known = new Set([...branches.map((b) => b.id.trim()).filter(Boolean), 'default'])
  if (!known.has(choice)) return { error: `The router chose an unknown branch "${choice}".` }
  return { branch: choice }
}
```

4. **Run — passes** (`router.test.ts`).

5. **Write failing interpreter test** — `src/features/flows/__tests__/interpret-router.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RouteAiFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echo: RunAgentFn = async (node) => ({ output: node.input })

const routerGraph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'r', type: 'router', data: { input: '{{trigger.input}}', branches: [{ id: 'billing' }, { id: 'tech' }] } },
    { id: 'b', type: 'agent', data: { agentId: 'x', input: 'BILLING' } },
    { id: 't', type: 'agent', data: { agentId: 'x', input: 'TECH' } },
    { id: 'd', type: 'agent', data: { agentId: 'x', input: 'DEFAULT' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'r' },
    { id: 'e1', source: 'r', target: 'b', branch: 'billing' },
    { id: 'e2', source: 'r', target: 't', branch: 'tech' },
    { id: 'e3', source: 'r', target: 'd', branch: 'default' },
  ],
}

test('router routes to the AI-chosen branch', async () => {
  const routeAi: RouteAiFn = async () => ({ branch: 'tech' })
  const result = await interpretFlow(routerGraph, 'my app crashed', { runAgent: echo, routeAi })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'TECH')
})

test('router falls to the default edge when the model says default', async () => {
  const routeAi: RouteAiFn = async () => ({ branch: 'default' })
  const result = await interpretFlow(routerGraph, '???', { runAgent: echo, routeAi })
  assert.equal(result.output, 'DEFAULT')
})

test('router fails cleanly with no routeAi adapter', async () => {
  const result = await interpretFlow(routerGraph, 'x', { runAgent: echo })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /AI runtime/)
})

test('RESUME reuses the branch chosen on the first run (no re-call)', async () => {
  let calls = 0
  const routeAi: RouteAiFn = async () => { calls += 1; return { branch: 'billing' } }
  const result = await interpretFlow(routerGraph, 'x', { runAgent: echo, routeAi, completed: { r: 'tech' } })
  assert.equal(calls, 0)
  assert.equal(result.output, 'TECH')
})
```

6. **Run — fails.**

7. **Implement — `src/features/flows/interpret.ts`.**
   - Import the type: `import type { RouterBranchSpec } from '@/lib/flows/router'`.
   - Add the adapter type (after `RunFlowFn`, line ~26):
```ts
// AI Router branch pick. Injected (like runAgent) so the interpreter stays
// pure: the execute-flow adapter wires this to a cheap generateStructured call.
export type RouteAiFn = (node: { id: string; branches: RouterBranchSpec[]; instructions?: string; input: string }) => Promise<{ branch: string } | { error: string }>
```
   - Add `routeAi?: RouteAiFn` to `Opts` (line ~37).
   - In the **main-chain walker**, add a `router` arm right after the `switch` arm (line ~750). It mirrors `switch` (emit branch id, route via `outgoing(id, branch)`), but is async and resume-stable:
```ts
    if (current.type === 'router') {
      if (overBudget()) return { status: 'failed', steps, output: lastOutput, error: 'Flow exceeded the maximum number of steps.' }
      let chosen: string
      // Resume stability: reuse the branch chosen on the first run (the stored
      // output IS the branch id). Re-calling the model could route differently.
      const prior = opts.completed && Object.prototype.hasOwnProperty.call(opts.completed, current.id) ? opts.completed[current.id] : undefined
      if (typeof prior === 'string' && prior) {
        chosen = prior
        emit({ nodeId: current.id, status: 'skipped', output: chosen })
      } else if (!opts.routeAi) {
        const error = 'Router steps need an AI runtime and are not supported in this runtime.'
        emit({ nodeId: current.id, status: 'failed', error })
        return { status: 'failed', steps, output: lastOutput, error }
      } else {
        const input = resolveTemplate(current.data.input ?? '{{trigger.input}}', ctx)
        const res = await opts.routeAi({ id: current.id, branches: current.data.branches, instructions: current.data.instructions, input })
        if ('error' in res) {
          emit({ nodeId: current.id, status: 'failed', error: res.error })
          return { status: 'failed', steps, output: lastOutput, error: res.error }
        }
        chosen = res.branch
        ctx.step[current.id] = { output: chosen }
        emit({ nodeId: current.id, status: 'succeeded', output: chosen })
      }
      const edge = outgoing(current.id, chosen)
      current = edge ? byId.get(edge.target) : undefined
      continue
    }
```
   - In `execNode`, extend the existing `condition || switch` container-body guard (line ~367) to also catch a stray `router` inside a body (parity with the validation guard):
```ts
    if (node.type === 'condition' || node.type === 'switch' || node.type === 'router') {
      const label = node.type === 'condition' ? 'If / else' : node.type === 'switch' ? 'Switch' : 'AI router'
      const error = `${label} can't run inside a For each / Parallel body — branching isn't supported there.`
      emit({ nodeId: node.id, status: 'failed', error })
      return { kind: 'fail', error }
    }
```

8. **Implement — `src/features/flows/execute-flow.ts` adapter.**
   - Imports: `import { buildRouterPrompt, routerBranchSchema, parseRouterChoice } from '@/lib/flows/router'`, `import { generateStructured } from '@/lib/llm/model-runner'`, and add `RouteAiFn` to the interpret import.
   - Define the adapter (near `runFlow`, before the `interpretFlow` call, line ~624):
```ts
  // AI Router: a cheap, enum-constrained one-shot model call — NOT a full agent
  // run (no AgentExecution row, no tools/RAG). generateStructured already does
  // cross-provider fallback and JSON-schema-constrained output.
  const routeAi: RouteAiFn = async (node) => {
    try {
      const { system, user } = buildRouterPrompt(node.branches, node.instructions, node.input)
      const raw = await generateStructured({ system, user, schema: routerBranchSchema(node.branches), schemaName: 'router_choice', maxTokens: 64 })
      return parseRouterChoice(raw, node.branches)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
```
   - Thread it into the interpret call (line ~624):
```ts
  const result = await interpretFlow(graph, input, {
    runAgent,
    runAction,
    runFlow,
    routeAi,
    onStep,
    ...(resuming ? { completed, resumeNodeId, resumeReply: job.reply } : {}),
  })
```

9. **Run — passes** (`interpret-router.test.ts`), `npx tsc --noEmit`. Then one manual inline run of a router flow to confirm the live pick + routing.

10. **Commit:** `feat(flows): AI router node with a cheap structured branch pick`.

---

## Task 5 — Join: configurable parallel reconvergence

**Files:** `src/lib/flows/join.ts` (create), `src/lib/flows/__tests__/join.test.ts` (create), `src/features/flows/interpret.ts` (modify), `src/features/flows/__tests__/interpret-join.test.ts` (create), `src/components/flows/step-card.tsx` (modify — parallel `join` control).

**Interfaces**
- Pure (`join.ts`): `type JoinEntry = { key: string; output: unknown; label?: string }`, `type JoinStrategy = 'object'|'array'|'merge'`, `joinBranchOutputs(entries: JoinEntry[], strategy?: JoinStrategy): unknown`.
- Interpreter: the `parallel` arm's output-assembly line uses `joinBranchOutputs`.

### Steps

1. **Write failing test** — `src/lib/flows/__tests__/join.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinBranchOutputs } from '../join'

const entries = [
  { key: 'n1', output: { a: 1 }, label: 'first' },
  { key: 'n2', output: { b: 2 }, label: 'second' },
]

test('unset strategy = back-compat keyed object by branch-head id', () => {
  assert.deepEqual(joinBranchOutputs(entries), { n1: { a: 1 }, n2: { b: 2 } })
})

test('array = outputs in branch order', () => {
  assert.deepEqual(joinBranchOutputs(entries, 'array'), [{ a: 1 }, { b: 2 }])
})

test('object = keyed by label, falling back to the branch key when unlabelled', () => {
  assert.deepEqual(joinBranchOutputs(entries, 'object'), { first: { a: 1 }, second: { b: 2 } })
  assert.deepEqual(joinBranchOutputs([{ key: 'n1', output: 1 }], 'object'), { n1: 1 })
})

test('merge = shallow-merge branch objects (non-objects ignored)', () => {
  assert.deepEqual(joinBranchOutputs([...entries, { key: 'n3', output: 'x' }], 'merge'), { a: 1, b: 2 })
})
```

2. **Run — fails.**

3. **Implement — `src/lib/flows/join.ts`:**
```ts
export type JoinStrategy = 'object' | 'array' | 'merge'
export type JoinEntry = { key: string; output: unknown; label?: string }

/**
 * Reconverge parallel branch outputs. `undefined` strategy reproduces today's
 * behaviour EXACTLY — a keyed object { [branchHeadNodeId]: output } — so stored
 * flows are byte-identical. 'array' preserves branch order; 'object' keys by the
 * branch label (falling back to the branch-head id); 'merge' shallow-merges the
 * branch outputs that are plain objects.
 */
export function joinBranchOutputs(entries: JoinEntry[], strategy?: JoinStrategy): unknown {
  if (strategy === 'array') return entries.map((e) => e.output)
  if (strategy === 'merge') {
    const merged: Record<string, unknown> = {}
    for (const e of entries) {
      if (e.output && typeof e.output === 'object' && !Array.isArray(e.output)) Object.assign(merged, e.output as Record<string, unknown>)
    }
    return merged
  }
  return Object.fromEntries(
    entries.map((e) => [strategy === 'object' && e.label?.trim() ? e.label.trim() : e.key, e.output]),
  )
}
```

4. **Run — passes.**

5. **Write failing interpreter test** — `src/features/flows/__tests__/interpret-join.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echo: RunAgentFn = async (node) => ({ output: node.input })

function graph(extra: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'p', type: 'parallel', data: { branches: [['x'], ['y']], ...extra } },
      { id: 'x', type: 'agent', data: { agentId: 'a', input: 'A' } },
      { id: 'y', type: 'agent', data: { agentId: 'a', input: 'B' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'p' }],
  }
}

test('BACK-COMPAT: parallel with no join returns the keyed-by-head-id object', async () => {
  const result = await interpretFlow(graph({}), '', { runAgent: echo })
  assert.deepEqual(result.output, { x: 'A', y: 'B' })
})

test('join array returns outputs in branch order', async () => {
  const result = await interpretFlow(graph({ join: 'array' }), '', { runAgent: echo })
  assert.deepEqual(result.output, ['A', 'B'])
})

test('join object keys by labels', async () => {
  const result = await interpretFlow(graph({ join: 'object', labels: ['left', 'right'] }), '', { runAgent: echo })
  assert.deepEqual(result.output, { left: 'A', right: 'B' })
})
```

6. **Run — fails.**

7. **Implement — `src/features/flows/interpret.ts`.** Import `import { joinBranchOutputs } from '@/lib/flows/join'`. Replace the `parallel` arm's output line (line ~648). Today:
```ts
      const output = Object.fromEntries(results.filter((r) => r.res.control?.kind !== 'drop').map((r) => [r.key, r.res.output]))
```
   becomes:
```ts
      const entries = results
        .map((r, index) => ({ key: r.key, output: r.res.output, label: node.data.labels?.[index], dropped: r.res.control?.kind === 'drop' }))
        .filter((e) => !e.dropped)
      const output = joinBranchOutputs(entries, node.data.join)
```
   (`results` is `Promise.all`-ordered, aligned with `node.data.branches`, so `labels[index]` matches branch `index`. The drop filter and `r.key = branch[0] ?? node.id` are unchanged, so the unset-`join` path is byte-identical.)

8. **Implement — `src/components/flows/step-card.tsx`.** In `renderNodeBody`'s `parallel` case (line ~906), add a small `<select>` under the branch count for `data.join` (`object`/`array`/`merge`, default "Keyed object (default)"), updating via `update({ ...node, data: { ...node.data, join: value || undefined } })`. Minimal; labels editing can piggyback on branch headers as a follow-up (Assumptions).

9. **Run — passes** (`interpret-join.test.ts`), `npx tsc --noEmit`.

10. **Commit:** `feat(flows): configurable Join reconvergence for parallel branches`.

---

## Task 6 — Inline-prompt agent node

**Files:** `src/lib/llm/model-runner.ts` (modify — add `generateText`), `src/features/flows/interpret.ts` (modify), `src/features/flows/execute-flow.ts` (modify), `src/features/flows/__tests__/interpret-inline-agent.test.ts` (create), `src/components/flows/step-card.tsx` (modify — inline prompt fields in `AgentBody`).

**Design (grounded):** `runAgentExecution` **requires a saved `AgentTask`** — `prisma.agentTask.findFirst(... status:'ACTIVE')` throws `'Agent not found or inactive'` ([execute-agent.ts:362](../../../src/features/agents/execute-agent.ts)). So an inline prompt-only step CANNOT run through it. Instead the inline step is a **direct one-shot model call** (`generateText`) — no AgentExecution row, no tools/RAG. The interpreter's existing structured path is reused verbatim: it already appends `structuredResponseInstruction` to the message and parses the reply with `parseStructuredAgentOutput`, so inline structured output works through the same instruction+parse path as saved agents — the adapter only needs to return text.

**Interfaces**
- `generateText(opts: { system: string; user: string; model?: string; maxTokens?: number }): Promise<string>` (model-runner.ts).
- `RunAgentFn` node payload gains `prompt?: string`, `model?: string`.
- Interpreter `agent` arm passes `prompt`/`model` when `agentId` is blank.
- `execute-flow.ts` `runAgent` adapter: if `agentId` blank → `generateText`; else the existing `runAgentExecution` path.

### Steps

1. **Write failing test** — `src/features/flows/__tests__/interpret-inline-agent.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

test('inline agent passes prompt + model + resolved input to the adapter', async () => {
  const seen: { agentId: string; prompt?: string; model?: string; input: string }[] = []
  const runAgent: RunAgentFn = async (node) => {
    seen.push({ agentId: node.agentId, prompt: node.prompt, model: node.model, input: node.input })
    return { output: 'classified' }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: '', prompt: 'Classify: {{trigger.input}}', model: 'claude-haiku-4-5', input: '{{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const result = await interpretFlow(graph, 'a refund request', { runAgent })
  assert.equal(result.output, 'classified')
  assert.equal(seen[0].agentId, '')
  assert.equal(seen[0].prompt, 'Classify: a refund request')
  assert.equal(seen[0].model, 'claude-haiku-4-5')
})

test('saved agent (agentId set) does NOT pass a prompt', async () => {
  const seen: { prompt?: string }[] = []
  const runAgent: RunAgentFn = async (node) => { seen.push({ prompt: node.prompt }); return { output: 'ok' } }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', prompt: 'ignored', input: 'x' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  await interpretFlow(graph, 'x', { runAgent })
  assert.equal(seen[0].prompt, undefined)
})
```

2. **Run — fails.**

3. **Implement — `src/features/flows/interpret.ts`.**
   - Extend `RunAgentFn` (line ~15):
```ts
export type RunAgentFn = (node: { id: string; agentId: string; input: string; prompt?: string; model?: string; resume?: boolean; thread?: { key: string; iteration: number } }) => Promise<RunAgentResult>
```
     (`thread` lands here now so Task 7 needs no further signature change.)
   - `runAgentWithReliability` (line ~312) builds the `opts.runAgent({ ... })` call at line ~321. Change it to forward the inline + thread fields. Add a second param carrying the resolved prompt + thread (both need `ctx`, which this closure lacks):
```ts
  const runAgentWithReliability = async (
    node: Extract<FlowNode, { type: 'agent' }>,
    resolvedInput: string,
    extra: { prompt?: string; thread?: FlowContext['thread'] },
  ): Promise<RunAgentResult> => {
    ...
      const call = opts.runAgent({ id: node.id, agentId: node.data.agentId, input: resolvedInput, prompt: extra.prompt, model: node.data.model, resume, thread: extra.thread })
    ...
```
   - In the `agent` arm (line ~546), compute the inline prompt and pass `extra`:
```ts
      const inline = !node.data.agentId?.trim()
      const prompt = inline ? resolveTemplate(node.data.prompt ?? '', ctx) : undefined
      ...
      const res = await runAgentWithReliability(node, resolved, { prompt, thread: ctx.thread })
```
     (Everything else in the arm — structured instruction append, waiting/error/parse handling — is unchanged, so inline structured rides the same path.)

4. **Run — passes** (`interpret-inline-agent.test.ts`).

5. **Implement — `src/lib/llm/model-runner.ts` `generateText`** (after `generateHeadline`, ~line 306). Mirrors `generateStructured`'s provider order + fallback, using a plain `messages.create` (no `output_config`):
```ts
/**
 * One-shot text completion — the cheap seam for inline-prompt flow agents (a
 * "run this prompt" step with no saved AgentTask). Cross-provider fallback like
 * generateStructured; the optional model override only threads onto the Claude
 * path (Qwen resolves its own model). Throws only when every provider failed.
 */
export async function generateText(opts: { system: string; user: string; model?: string; maxTokens?: number }): Promise<string> {
  const overrideModel = opts.model?.trim() || undefined
  const order = structuredProviderOrder({ defaultModel: overrideModel || DEFAULT_AGENT_MODEL, qwen: hasQwen(), anthropic: hasAnthropic() })
  if (order.length === 0) throw new Error('No model provider configured — set ANTHROPIC_API_KEY (or QWEN_API_KEY + QWEN_BASE_URL).')
  const claudeModel = overrideModel && isClaude(overrideModel) ? overrideModel : isClaude(DEFAULT_AGENT_MODEL) ? DEFAULT_AGENT_MODEL : FALLBACK_CLAUDE_MODEL
  let lastError: unknown
  for (const target of order) {
    try {
      const client = target === 'qwen' ? qwenClient() : claudeClient()
      const response = await client.messages.create({
        model: target === 'qwen' ? qwenModel(FALLBACK_QWEN_MODEL) : claudeModel,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.system.trim() ? { system: opts.system } : {}),
        messages: [{ role: 'user', content: opts.user }],
      })
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
    } catch (error) {
      lastError = error
      if (!isProviderAvailabilityError(error)) throw error
    }
  }
  throw lastError
}
```

6. **Implement — `src/features/flows/execute-flow.ts` `runAgent` adapter.** Import `generateText`. At the very top of the adapter's `try` (after the `step` row is created, line ~358), branch on inline before the `runAgentExecution` call:
```ts
      // Inline-prompt agent: a direct one-shot model call, no saved AgentTask.
      // (runAgentExecution requires an ACTIVE AgentTask and cannot run a
      // prompt-only ephemeral agent — see the design note.)
      if (!node.agentId?.trim()) {
        const text = await generateText({ system: node.prompt ?? '', user: node.input, model: node.model })
        await finishStep({ status: 'succeeded', output: jsonValue(text), finishedAt: new Date() })
        return { output: text }
      }
```
   (The surrounding `try/catch` already maps a thrown model error to `{ error }` + a failed step; the interpreter's `onError` handling is unchanged.)

7. **Implement — `src/components/flows/step-card.tsx` `AgentBody`.** When `!node.data.agentId`, show a "Prompt" `TokenTextEditor` (`node.data.prompt`) + a model `<select>` (`node.data.model`) alongside the existing agent picker, with a small "Use an inline prompt instead of a saved agent" affordance. Register the prompt editor key `agent.prompt` in `DEFAULT_EDITOR_KEYS` (optional). Minimal — the copilot/JSON can author it regardless.

8. **Run — passes**, `npx tsc --noEmit`. Manual inline run: an `agent` step with a `prompt`, no `agentId`, returns the model's text.

9. **Commit:** `feat(flows): inline-prompt agent step (ephemeral one-shot model call)`.

---

## Task 7 — Loop-Mode conversation threading

**Files:** `src/features/flows/interpret.ts` (modify), `src/features/agents/execute-agent.ts` (modify — `continueExecutionId` seed mode), `src/features/flows/execute-flow.ts` (modify — thread map), `src/features/flows/__tests__/interpret-loop-thread.test.ts` (create).

**Design (grounded — the hardest gap):** `runAgentExecution` cannot continue a *completed* conversation with a fresh user turn. Its only resume path requires `status ∈ {waiting_for_input, waiting_for_approval}` with a `pendingQuestion` ([execute-agent.ts:413–419](../../../src/features/agents/execute-agent.ts)); a fresh call otherwise does `transcript = runner.start(...)` (line 465) — a brand-new conversation. To thread across iterations we add a minimal **`continueExecutionId`** seed: reload the prior execution's transcript (`coerceToIR`), append the new input as a user turn (`runner.appendUserMessage`), then create a NEW execution seeded with that history and run the normal turn loop. Iterations chain (each carries the prior conversation forward) rather than re-opening one row — the leanest fit for `runAgentExecution`'s settle-per-call model.

**Interfaces**
- Interpreter: `loop` arm sets `ctx.thread` per item when `threadAgent`; forces `concurrency 1`.
- `AgentExecutionJob`/`runAgentExecution` params gain `continueExecutionId?: string`.
- `execute-flow.ts` `runAgent` adapter keeps a run-scoped `Map<threadKey, executionId>`; `threadKey = ${thread.key}:${node.id}`.

### Steps

1. **Write failing interpreter test** — `src/features/flows/__tests__/interpret-loop-thread.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

function graph(threadAgent: boolean, concurrency?: number): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', threadAgent, concurrency, body: ['a'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'Process {{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
}

test('threaded loop passes a stable thread key + incrementing iteration', async () => {
  const seen: ({ key: string; iteration: number } | undefined)[] = []
  const runAgent: RunAgentFn = async (node) => { seen.push(node.thread); return { output: node.input } }
  await interpretFlow(graph(true), ['a', 'b', 'c'], { runAgent })
  assert.deepEqual(seen.map((t) => t?.iteration), [0, 1, 2])
  assert.equal(new Set(seen.map((t) => t?.key)).size, 1)
})

test('threaded loop runs sequentially even if concurrency is set high', async () => {
  let active = 0, maxActive = 0
  const runAgent: RunAgentFn = async (node) => {
    active += 1; maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 5))
    active -= 1
    return { output: node.input }
  }
  await interpretFlow(graph(true, 5), ['a', 'b', 'c'], { runAgent })
  assert.equal(maxActive, 1)
})

test('BACK-COMPAT: unthreaded loop passes no thread', async () => {
  const seen: unknown[] = []
  const runAgent: RunAgentFn = async (node) => { seen.push(node.thread); return { output: node.input } }
  await interpretFlow(graph(false), ['a', 'b'], { runAgent })
  assert.deepEqual(seen, [undefined, undefined])
})
```

2. **Run — fails.**

3. **Implement — `src/features/flows/interpret.ts` `loop` arm** (line ~614):
```ts
    if (node.type === 'loop') {
      const items = loopItems(resolveTemplate(node.data.over, ctx)).slice(0, maxLoop)
      const threaded = node.data.threadAgent === true
      // Threading ONE conversation across iterations requires sequential
      // execution — you cannot append turns to one conversation concurrently.
      const concurrency = threaded ? 1 : (node.data.concurrency ?? 1)
      const perItem = await mapLimit(items, concurrency, async (item, index) => {
        const itemCtx: FlowContext = {
          trigger: ctx.trigger, step: { ...ctx.step }, item, loop: { index, count: items.length },
          variables: ctx.variables, input: ctx.input,
          ...(threaded ? { thread: { key: node.id, iteration: index } } : {}),
        }
        return execBody(node.data.body, itemCtx)
      })
      // ...unchanged control/output handling...
```

4. **Run — passes** (`interpret-loop-thread.test.ts`).

5. **Implement — `src/features/agents/execute-agent.ts` `continueExecutionId`.**
   - Add to `AgentExecutionJob` (line ~47): `continueExecutionId?: string`.
   - In the transcript-init block (line ~464), replace the final `else` with a continue-aware branch:
```ts
  } else if (data.continueExecutionId) {
    // Loop-thread: seed this run's transcript from a prior execution's
    // conversation, then append the new input as a fresh user turn — multi-turn
    // batch memory across loop iterations. A missing/blank prior transcript
    // degrades to a fresh conversation.
    const prior = await prisma.agentExecution.findFirst({
      where: { id: data.continueExecutionId, agentTaskId: agentId, organizationId },
      select: { transcript: true },
    })
    if (Array.isArray(prior?.transcript) && prior.transcript.length) {
      transcript = coerceToIR(prior.transcript as unknown[])
      runner.appendUserMessage(transcript, data.input || agent.objective)
    } else {
      transcript = runner.start(data.input || agent.objective)
    }
  } else {
    transcript = runner.start(data.input || agent.objective)
  }
```
   (`coerceToIR` is already imported at line 41; `runner.appendUserMessage` is part of the `ModelRunner` contract. A new `AgentExecution` row is still created by the existing `else` create branch since `queuedExecution` is null — the thread carries forward via the seeded transcript, not a re-opened row.)

6. **Implement — `src/features/flows/execute-flow.ts` thread map.**
   - Near the top of `runFlowExecution`'s adapters (before `const runAgent`, ~line 328), declare the map:
```ts
  // Loop-thread: the most-recent execution id per (loop, agent-node) thread, so
  // each iteration seeds its conversation from the previous one.
  const threadExecutions = new Map<string, string>()
```
   - In the `runAgent` adapter's `runAgentExecution` call (line ~361), compute continuation and store the result id. Add before the call:
```ts
      const threadKey = node.thread ? `${node.thread.key}:${node.id}` : undefined
      const continueExecutionId = threadKey && node.thread!.iteration > 0 ? threadExecutions.get(threadKey) : undefined
```
   Extend the non-resume call arg with `...(continueExecutionId ? { continueExecutionId } : {})`, and after a successful/settled result, record the id:
```ts
      if (threadKey && result.executionId) threadExecutions.set(threadKey, result.executionId)
```
   (Place the `threadExecutions.set` right after `result` is obtained, before the waiting/succeeded branches, so a continued chain always advances. Threading applies to SAVED agents only in v1 — an inline step returns before this via Task 6's early branch; document.)

7. **Run — passes** (interpreter tests + `npx tsc --noEmit`). Manual inline run: a `loop` with `threadAgent:true` over 3 items where iteration 2's agent references something stated in iteration 0 confirms carried memory (chained executions each seeded from the prior).

8. **Commit:** `feat(flows): loop-mode conversation threading across iterations`.

---

## Task 8 — Error Shield container

**Files:** `src/features/flows/interpret.ts` (modify), `src/features/flows/__tests__/interpret-error-shield.test.ts` (create), `src/components/flows/step-card.tsx` (modify — `ErrorShieldBody` + `renderNodeBody` arm).

**Design (grounded):** `errorShield` is a container like `loop`/`parallel`, executed via `execBody`. Run `body`; if it returns a `fail` control, run `fallback` (with the caught error exposed as `{{error}}`) and shield the failure (the step succeeds with the fallback's output). Only `fail` is shielded — `pause` (waiting), `stop`, and `drop` propagate unchanged (you must not swallow a human-review pause or a deliberate stop). The interpreter's `contained` set must include `errorShield` members so the main walk skips them.

**Interfaces**
- Interpreter: `errorShield` arm in `execNode`; `contained` set extended.
- Persistence: `errorShield` is `onStep`-persisted (a container, not adapter-backed) — no change to `run-step-persistence.ts` (it is not in `ADAPTER_PERSISTED_TYPES`).

### Steps

1. **Write failing test** — `src/features/flows/__tests__/interpret-error-shield.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

function shieldGraph(): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'errorShield', data: { body: ['boom'], fallback: ['fb'] } },
      { id: 'boom', type: 'agent', data: { agentId: 'boom', input: 'go' } },
      { id: 'fb', type: 'agent', data: { agentId: 'ok', input: 'fallback saw: {{error}}' } },
      { id: 'after', type: 'agent', data: { agentId: 'ok', input: 'after' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 's' }, { id: 'e1', source: 's', target: 'after' }],
  }
}

const runAgent: RunAgentFn = async (n) => (n.agentId === 'boom' ? { error: 'kaboom' } : { output: n.input })

test('body failure routes to the fallback and shields the error', async () => {
  const result = await interpretFlow(shieldGraph(), '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'after')
  const shield = result.steps.find((s) => s.nodeId === 's')
  assert.equal(shield?.status, 'succeeded')
  const fb = result.steps.find((s) => s.nodeId === 'fb')
  assert.equal(fb?.output, 'fallback saw: kaboom')
})

test('a succeeding body skips the fallback', async () => {
  const g = shieldGraph()
  const result = await interpretFlow(g, '', { runAgent: async (n) => ({ output: n.agentId === 'boom' ? 'BODY' : n.input }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'fb'), undefined)
})

test('a stop inside the body is NOT shielded', async () => {
  const g: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'errorShield', data: { body: ['stop'], fallback: ['fb'] } },
      { id: 'stop', type: 'stop', data: { reason: 'halt' } },
      { id: 'fb', type: 'agent', data: { agentId: 'ok', input: 'fb' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 's' }],
  }
  const result = await interpretFlow(g, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'fb'), undefined)
})
```

2. **Run — fails.**

3. **Implement — `src/features/flows/interpret.ts`.**
   - Extend the `contained` set (line ~679):
```ts
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body
      : node.type === 'parallel' ? node.data.branches.flat()
      : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
      : [],
    ),
  )
```
   - Add the `errorShield` arm in `execNode` (after the `parallel` arm, line ~652):
```ts
    if (node.type === 'errorShield') {
      const bodyCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item: ctx.item, loop: ctx.loop, variables: ctx.variables, input: ctx.input, thread: ctx.thread }
      const bodyRes = await execBody(node.data.body, bodyCtx)
      const control = bodyRes.control
      // Only a hard failure is shielded → fallback. pause/stop/drop propagate.
      if (control && control.kind === 'fail') {
        const fbCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item: ctx.item, loop: ctx.loop, variables: ctx.variables, input: ctx.input, thread: ctx.thread, error: control.error }
        const fbRes = await execBody(node.data.fallback, fbCtx)
        if (fbRes.control && fbRes.control.kind !== 'drop') {
          // The fallback itself failed/paused/stopped — surface that, unshielded.
          emit({ nodeId: node.id, status: fbRes.control.kind === 'fail' ? 'failed' : fbRes.control.kind === 'pause' ? 'waiting' : 'stopped' })
          return fbRes.control
        }
        const output = fbRes.output
        ctx.step[node.id] = { output }
        emit({ nodeId: node.id, status: 'succeeded', output })
        return { kind: 'ok', output }
      }
      if (control && control.kind !== 'drop') {
        emit({ nodeId: node.id, status: control.kind === 'pause' ? 'waiting' : 'stopped' })
        return control
      }
      const output = bodyRes.output
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }
```
   - The main-walk `next`-skip already hops over `contained` ids (line ~761), so the shield's members never run on the main chain.

4. **Run — passes** (`interpret-error-shield.test.ts`).

5. **Implement — `src/components/flows/step-card.tsx`.** Add an `ErrorShieldBody` (mirrors the `parallel` case body: a short description + an `AddNestedStepMenu` for the body; the two-column body/fallback layout is rendered by the canvas `nestedCards` from Task 2) and a `case 'errorShield':` arm in `renderNodeBody`.

6. **Run — passes**, `npx tsc --noEmit`. Manual inline run: a shield whose body tool fails routes to a fallback agent and the flow continues.

7. **Commit:** `feat(flows): error shield container with body + fallback recovery`.

---

## Task 9 — Copilot grounding for the 5 features

**Files:** `src/lib/flows/copilot-grounding.ts` (modify), `src/lib/flows/__tests__/copilot.test.ts` (append — assert the new clauses/allowed-types are present).

### Steps

1. **Write failing test** — append to `src/lib/flows/__tests__/copilot.test.ts` (import the module's exported `graphRules` if exported, else assert on `buildCopilotGrounding(...).graphRules` in a small unit that stubs prisma — prefer exporting `graphRules` as a `const` and testing it directly):
```ts
import { graphRules } from '../copilot-grounding'
test('graphRules documents the new control-flow node kinds', () => {
  assert.match(graphRules, /router/)
  assert.match(graphRules, /errorShield/)
  assert.match(graphRules, /inline prompt/i)
  assert.match(graphRules, /threadAgent/)
  assert.match(graphRules, /join/)
})
```
   (If `graphRules` is currently a local `const`, export it: `export const graphRules = ...` — a safe, test-only surface change.)

2. **Run — fails.**

3. **Implement — `src/lib/flows/copilot-grounding.ts`.**
   - Add `router, errorShield` to the "Allowed node types" sentence (line ~26).
   - Append these clauses to `graphRules` (before the closing structured-output sentence):
```ts
    'Router node data: {input, instructions, branches:[{id,label,description}]}; an AI picks ONE branch from the input + each branch description. Route edges by branch = the branch id, plus a "default" edge fallback. Give every branch a clear description so the AI can route. Use a router (not switch) when the choice needs judgment rather than a literal comparison. ' +
    'Agent inline-prompt mode: leave agentId empty and set {prompt, model} to run a one-shot prompt with no saved agent (model optional; e.g. claude-haiku-4-5 for cheap classification). Use a saved agentId when the step needs tools/memory; use an inline prompt for a quick reasoning/extraction step. ' +
    'Loop threading: set loop.data.threadAgent true to keep ONE agent conversation across iterations (the agent remembers earlier items); this forces sequential execution. Omit it for independent per-item runs. ' +
    'Parallel join: parallel.data.join is object (default: keyed by branch), array (outputs in branch order), or merge (shallow-merge branch objects); parallel.data.labels names the branches for join=object. ' +
    'Error shield node data: {body:[...ids], fallback:[...ids]}; runs body, and on a body FAILURE runs fallback instead (the caught error is {{error}}). Use it to wrap risky steps with a recovery path. Branching nodes (condition/switch/router) and Input/Output cannot go inside body/fallback. ' +
```

4. **Run — passes**, `npx tsc --noEmit`.

5. **Commit:** `feat(flows): ground the copilot in router/inline-agent/loop-thread/join/error-shield`.

---

## Final verification

- `npm test` — whole suite green (new tests + no regression in `interpret.test.ts`, `validate.test.ts`, `mutate.test.ts`, `graph.test.ts`, `execute-flow-resume.test.ts`).
- `npx tsc --noEmit` — clean (the exhaustive-switch invariant holds).
- Manual inline demo (`EXECUTION_MODE=inline`), one per feature: (a) a router flow picks + routes; (b) a parallel with `join:'array'` returns an ordered array; (c) an inline-prompt agent classifies with no saved agent; (d) a `threadAgent` loop where a later item references an earlier one's context; (e) an error shield routes a failing body to its fallback and the flow continues.
- Back-compat spot-check: an existing flow with a plain `parallel` (no `join`), saved-agent steps, and unthreaded loops runs byte-identically (return value + step rows unchanged).

## Design calls made (with the real-code seam each relies on)

1. **Router = a new `router` node, not `mode:'ai'` on `switch`.** `switch` is a *synchronous* main-chain arm ([interpret.ts:742](../../../src/features/flows/interpret.ts)) whose data is literal `{left,op,right}` comparisons; a router is an *async* LLM pick over `{id,label,description}` branches. Overloading `switch` would fork its clean deterministic path and bloat its data shape for near-zero shared code (only the 2-line "emit branch + `outgoing(id,branch)`" tail is common — and the `router` arm reuses exactly that). **Seam:** the main-chain walker's `switch` arm (routing) + a new injected `opts.routeAi` adapter (purity).
2. **Router AI pick = `generateStructured`, injected as an adapter — NOT `runAgentExecution`.** `generateStructured` ([model-runner.ts:405](../../../src/lib/llm/model-runner.ts)) is a cheap, JSON-schema-**enum**-constrained, cross-provider one-shot — ideal for a deterministic-shaped branch id, and it creates no `AgentExecution`/tools/RAG overhead. The interpreter stays pure by taking `RouteAiFn`; the `execute-flow.ts` adapter wires it. Resume-stability: the walker reuses `opts.completed[routerId]` (the stored branch) so a resumed run never re-picks.
3. **Join = extend `parallel` with a `join` merge strategy, not a new node.** `parallel` **already** reconverges — `Promise.all` fan-out then `{ [branch[0] ?? node.id]: output }` ([interpret.ts:635-648](../../../src/features/flows/interpret.ts)). The only gap is that the shape is fixed and the keys are opaque node ids. Adding `join`/`labels` + a pure `joinBranchOutputs` changes one output line, reuses all fan-out/validation/UI-container machinery, adds no new node kind (so no exhaustive-switch edits), and defaults to byte-identical output. **Seam:** the parallel output-assembly line.
4. **Inline agent = extend the `agent` node (`prompt`+`model`), running a direct `generateText`, not a saved agent.** `runAgentExecution` **requires** an ACTIVE `AgentTask` ([execute-agent.ts:362](../../../src/features/agents/execute-agent.ts)), so it cannot run a prompt-only ephemeral agent. Inline mode is a one-shot `generateText` in the adapter; the interpreter's existing structured-instruction + `parseStructuredAgentOutput` path is reused verbatim, so inline structured output needs no extra machinery. **Seam:** the `runAgent` adapter's pre-`runAgentExecution` branch on empty `agentId`.
5. **Loop-thread = opt-in `loop.threadAgent` (forces concurrency 1) + a new `continueExecutionId` seed on `runAgentExecution`.** The loop arm's per-item `FlowContext` construction ([interpret.ts:619](../../../src/features/flows/interpret.ts)) is where `ctx.thread` is set; the agent arm forwards it to the adapter, which maps `threadKey → executionId` and seeds each iteration's transcript from the prior. **Seam:** loop item-context + a minimal transcript-seed mode in `runAgentExecution`.
6. **Error Shield = a new `errorShield` container (body + fallback), not a step property.** A step-level `onError` can't run a *multi-step fallback path*; a container can. `errorShield` reuses the `loop`/`parallel` `execBody` + container-membership model; only `fail` is shielded (pause/stop/drop propagate). **Seam:** `execBody` + the `contained`-set machinery.

## Where the real code makes a feature harder / different than expected

- **`runAgentExecution` CANNOT run an ephemeral prompt-only agent.** It hard-requires an ACTIVE `AgentTask` (throws `'Agent not found or inactive'`, execute-agent.ts:362). → Inline agent (Task 6) bypasses it entirely with a direct `generateText` call in the adapter. No throwaway `AgentTask` rows are created.
- **There IS a cheap model-runner for the Router.** `generateStructured` (schema-constrained, provider-fallback) and `generateHeadline` (plain `messages.create`) already exist in model-runner.ts. The Router uses `generateStructured` with an `enum` schema; the inline agent uses a new sibling `generateText`. No full agent run needed for either.
- **`parallel` already reconverges today** — it is NOT "single-active-path". `Promise.all` runs all branches and merges into `{ [branchHeadNodeId]: output }` (interpret.ts:635-648). The genuine gap is only *configurability of the merged shape* (opaque node-id keys, fixed object). "Single-active-path continuation" describes `condition`/`switch` on the MAIN chain (only one branch runs); `parallel + join` is the multi-branch-and-merge answer. Join therefore extends `parallel`, and a separate `join` node was rejected as redundant with `data compose`/`transform` (which already build objects from templated fields).
- **The interpreter is pure**, so the Router's LLM call had to become a new injected adapter (`RouteAiFn`) rather than a direct call — an extra seam the other four features didn't need (they ride `runAgent`/container `execBody`).
- **Loop-thread required real new agent-runtime plumbing.** `runAgentExecution`'s only continuation path is the ask-user/approval resume (requires `waiting_*` + `pendingQuestion`, execute-agent.ts:413-419) — it can't continue a *completed* conversation with a new turn. The new `continueExecutionId` seed mode (reload transcript → `coerceToIR` → `appendUserMessage` → run) is the minimal addition. Consequence: threaded iterations **chain** executions (each seeded from the last), they do not share one re-opened row — the leanest fit for the settle-per-call model. v1 threads SAVED agents only (inline steps return before the continuation logic).
- **Adding node kinds DOES break `tsc`** (Track 1's assumption to the contrary was wrong). `NODE_ICON`/`NODE_TONE` are non-`Partial` `Record<FlowNode['type'], …>` (step-card.tsx:109,131) and `defaultData` is a value-returning `switch` with no `default` (mutate.ts:19) — all three fail to compile without the new members. Task 1 fixes them in the same commit; Task 2 completes the `errorShield` two-list container plumbing across ~10 further loop/parallel enumerations in mutate.ts/flow-canvas.tsx and the palette.
- **`errorShield` is a two-list container** (`body` + `fallback`), unlike `loop` (one `body`) and `parallel` (`branches[][]`). Every enumeration that special-cases containers needs a bespoke arm (the fallback list is threaded through `containerPositionOf`/`insertIntoContainer` via a `branchIndex: -1` sentinel). This is the widest mechanical surface in the plan.
- **Router resume non-determinism** is a real correctness trap: without the `opts.completed` reuse, a resumed run could re-pick a different branch than the one whose downstream steps already ran. Handled explicitly in the router walker arm (Task 4).

## Assumptions & deferred UI polish

1. **Router/inline/thread builder editors are minimal.** Task 2 makes `router`/`errorShield` creatable and renders their canvas fan-out/columns; the per-field editors (`RouterBody` branch list, inline `AgentBody` prompt+model, parallel `join`/`labels`, `ErrorShieldBody`) are added in their feature tasks but kept lean — the copilot (Task 9 grounding) and raw JSON can author every field immediately. A richer branch-description editor and a fallback-column "+ add step" affordance are follow-ups.
2. **`join:'object'` labels reuse a new `parallel.data.labels` array** aligned by branch index. Editing labels inline on the canvas branch headers is a follow-up; JSON/copilot set them today.
3. **Loop-thread is saved-agents-only in v1.** An inline-prompt step inside a threaded loop runs stateless each iteration (it returns before the continuation logic). Threading inline prompts would need a transcript store outside `AgentExecution`; deferred.
4. **`generateText` is impure (network)** and is verified by typecheck + the inline-agent interpreter test (fake `runAgent`) + one manual run, not a unit test — matching how `generateHeadline`/`generateStructured` are treated.
5. **Fallback add-affordance.** Task 2 wires `onAddContainerStep` to a shield's *body*; adding to the *fallback* list from the canvas is a follow-up (JSON/duplicate work now). The interpreter/validation already handle a populated fallback.
