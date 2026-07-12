# Implementation Plan — Gumloop Track 1: Flow I/O Contract + Flows-as-Tools + Subflow

**Spec:** [2026-07-11-gumloop-orchestration-subagents-design.md](../specs/2026-07-11-gumloop-orchestration-subagents-design.md) §3 (with §2 locked decisions, §6 seams, §8 error handling, §9 testing). **Track 1 only** — no Track 2 (queued subagents) or Track 3 (sandbox).

## Goal

Give flows a **typed Input/Output contract** so a flow has an explicit callable signature, then expose flows as tools through the one shared tool-planes module and add a synchronous **subflow** node. Concretely:

1. First-class `input` node — named/typed params `{name,type,required,default,description}` with precedence **user > webhook > default**, boundary type coercion, producing `input.<name>` bindings.
2. First-class `output` node — named/typed return fields bound from flow context, giving the flow an explicit typed return object (replacing implicit `lastOutput`).
3. A `flow` member on `FlowToolPlane` + a Flow→ToolDefinition adapter in `tool-planes.ts` (`inputSchema` = the flow's input params; `execute()` = `dispatchFlowExecution` → returns the output-node object), surfaced in `loadTools` behind an org opt-in (`Flow.metadata.agentCallable`).
4. Synchronous `subflow` node — injects a `RunFlowFn` adapter (mirroring the `RunAgent` adapter), calls `runFlowExecution` on the child, blocks on its declared output, maps it back into parent context, and records a `FlowRunStep` linking the child run.
5. Extend `buildCopilotGrounding` so the flow-builder copilot can wire agent→flow calls (and knows the new node kinds).

## Architecture

- **Pure interpreter, injected adapters.** `interpretFlow` ([src/features/flows/interpret.ts](../../../src/features/flows/interpret.ts)) is a pure graph walker; all impurity is delegated through `RunAgentFn`/`RunActionFn`. Track 1 adds `input`/`output`/`subflow` arms to `execNode` and a new injected `RunFlowFn`, mirroring exactly how `agent` nodes inject `RunAgentFn`.
- **One tool universe.** `tool-planes.ts` ([src/features/agents/tool-planes.ts](../../../src/features/agents/tool-planes.ts)) is the single module both `loadTools` (agent runtime, [execute-agent.ts](../../../src/features/agents/execute-agent.ts)) and the flow tool catalog consume. Adding a `flow` plane there makes flows-as-tools appear for agents (Track 1 target) without touching the run loop.
- **Ride the existing dispatch seam.** `dispatchFlowExecution` ([execute-flow.ts](../../../src/features/flows/execute-flow.ts):622) is the flow-as-tool `execute()`; `runFlowExecution` (same file) is the synchronous child call for subflow. The `runAgent` adapter (execute-flow.ts:291–350) is the template for the new `runFlow` adapter (create step row → run → link child → parse output).
- **Pure decision logic extracted + unit-tested.** Type coercion, input precedence, output binding, and flow→JSON-Schema derivation live in new pure modules (`src/lib/flows/io-nodes.ts`, `src/lib/flows/flow-tool.ts`), tested with `node:test` like the existing `src/lib/flows/__tests__/schema-fields.test.ts`.

## Tech Stack

- TypeScript (strict), Zod graph schema (`src/lib/flows/graph.ts`), Prisma (`prisma/schema.prisma`), Next.js app.
- **Test runner:** `node:test` via `npm test` = `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test $(find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -path '*__tests__*')`.
  - Single-file red/green loop: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path/to/file.test.ts>`.
  - Typecheck DB-touching code: `npx tsc --noEmit` (or the repo's `npm run typecheck` if present — confirm in step).
- Test style: `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`, pure functions and the interpreter's injected-adapter harness (fake `runAgent`/`runFlow`). No DB in unit tests — DB-touching code is verified by typecheck + the interpreter/pure seam it delegates to.

## Global Constraints

- **Back-compat (hard invariant):** A flow with **no `input` node** must run with today's `{{trigger.input}}` semantics unchanged; a flow with **no `output` node** must return today's implicit `lastOutput` unchanged. Every existing stored graph parses and runs identically. Covered by an explicit interpreter test (Task 3 + Task 4).
- **No invented APIs.** Reuse real types/signatures: `FieldType`/`OutputField`/`FlowNode` (graph.ts), `FlowContext`/`resolveTemplateValue`/`asStructured` (context.ts), `RunAgentFn`/`RunActionFn`/`InterpretResult` (interpret.ts), `ToolPlaneGroup`/`McpToolClient`/`FlowToolExecutor` (tool-planes.ts), `FlowToolPlane`/`formatFlowToolConnectionId`/`parseFlowToolConnectionId` (tool-connection-id.ts), `dispatchFlowExecution`/`runFlowExecution`/`FlowExecutionJob` (execute-flow.ts), `ToolDefinition` (model-runner.ts).
- **Graceful degradation (spec §8):** flow-as-tool / subflow failures surface as tool errors / `FlowRunStep` failures under the existing `onError` semantics — never a run crash. In queue mode (`EXECUTION_MODE=queue`) a flow-as-tool returns an explicit "requires inline execution" tool error rather than blocking (Track 1 ships on inline prod).
- **Cycle safety:** `tool-planes.ts` must not statically import `execute-flow.ts` (execute-flow imports tool-planes → cycle). The flow plane dispatches via a **dynamic** `import('@/features/flows/execute-flow')` inside its execute closure, mirroring the existing dynamic `import('./signals')` cycle-break in execute-flow.ts:595. Subflow recursion is bounded by a depth cap (`MAX_SUBFLOW_DEPTH`) mirroring the existing signal depth-cap.
- **Secrets:** unchanged — the flow plane exposes only ids/names/schemas + an opaque client closure.
- Commit after each green step (Conventional Commits), one task per branch off `main`.

## File Structure

**Create:**
| File | Responsibility |
|---|---|
| `src/lib/flows/io-nodes.ts` | Pure: `coerceFieldValue`, `resolveInputParams` (precedence+coercion+required), `bindOutputFields`. No prisma/interpreter coupling. |
| `src/lib/flows/__tests__/io-nodes.test.ts` | Unit tests for the above. |
| `src/lib/flows/flow-tool.ts` | Pure: `inputParamsFromGraph`, `outputFieldsFromGraph`, `flowInputJsonSchema`, `flowToolSlug`, `isAgentCallableFlow`, `flowToolGroundingLine`. |
| `src/lib/flows/__tests__/flow-tool.test.ts` | Unit tests for the above. |
| `prisma/migrations/<ts>_flow_run_step_child_flow_run/migration.sql` | Adds `FlowRunStep.childFlowRunId` (subflow → child run link). |

**Modify:**
| File | Change |
|---|---|
| `src/lib/flows/graph.ts` | Add `inputParamSchema`, `input`/`output`/`subflow` node schemas to the discriminated union + exported types. |
| `src/features/flows/context.ts` | Add `input?: Record<string, unknown>` to `FlowContext` (new `{{input.<name>}}` root). |
| `src/features/flows/interpret.ts` | `input`/`output`/`subflow` arms in `execNode`; `RunFlowFn` type + `opts.runFlow`/`opts.webhookInput`; explicit-output terminal return; thread `input` into container ctx + resume rebuild. |
| `src/lib/flows/tool-connection-id.ts` | Add `'flow'` to `FLOW_TOOL_PLANES` + `PREFIXED_PLANES`. |
| `src/lib/flows/validate.ts` | Validation arms + `nodeLabel` cases for `input`/`output`/`subflow`; container-body guard. |
| `src/features/agents/tool-planes.ts` | `loadFlowPlaneGroups` (Flow→ToolPlaneGroup adapter) + `'flow'` case in `resolveFlowToolExecutor`. |
| `src/features/agents/execute-agent.ts` | Wire `loadFlowPlaneGroups` into `loadTools`. |
| `src/features/flows/execute-flow.ts` | `runFlow` adapter (mirrors `runAgent`); thread into `interpretFlow`; `subflowDepth` on `FlowExecutionJob` + depth guard. |
| `prisma/schema.prisma` | `FlowRunStep.childFlowRunId String?`. |
| `src/lib/flows/copilot-grounding.ts` | Callable-flows section + `graphRules` clauses for `input`/`output`/`subflow`. |

---

## Task 1 — Graph schema: `input`, `output`, `subflow` node kinds

**Files:** `src/lib/flows/graph.ts` (modify), `src/lib/flows/__tests__/graph-io-nodes.test.ts` (create).

**Interfaces**
- Consumes: `z` (zod), existing `FIELD_TYPES`, `outputFieldSchema`, `flowNodeSchema` discriminated union.
- Produces:
  - `inputParamSchema` → `type InputParam = { name: string; type: FieldType; required?: boolean; default?: string; description?: string }`.
  - `input` node: `{ id; type: 'input'; data: { label?; note?; params: InputParam[] } }`.
  - `output` node: `{ id; type: 'output'; data: { label?; note?; fields: { name: string; type: FieldType; value: string; description? }[] } }`.
  - `subflow` node: `{ id; type: 'subflow'; data: { label?; note?; flowId: string; input?: string; onError?: 'stop'|'continue'; outputFields?: OutputField[] } }`.

### Steps

1. **Write failing test** — `src/lib/flows/__tests__/graph-io-nodes.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, emptyGraph } from '../graph'

test('flowGraphSchema parses an input node with typed params', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'in', type: 'input', data: { params: [
        { name: 'account', type: 'string', required: true },
        { name: 'limit', type: 'number', default: '10', description: 'max rows' },
      ] } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const inNode = parsed.success && parsed.data.nodes.find((n) => n.type === 'input')
  assert.ok(inNode && inNode.type === 'input')
  assert.equal(inNode.data.params[0].name, 'account')
  assert.equal(inNode.data.params[0].required, true)
})

test('flowGraphSchema parses output and subflow nodes', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'flw_1', input: '{"account":"{{input.account}}"}' } },
      { id: 'out', type: 'output', data: { fields: [{ name: 'score', type: 'number', value: '{{step.sub.output.score}}' }] } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const out = parsed.success && parsed.data.nodes.find((n) => n.type === 'output')
  assert.ok(out && out.type === 'output')
  assert.equal(out.data.fields[0].type, 'number')
})

test('back-compat: emptyGraph and a legacy trigger.inputFields graph still parse', () => {
  assert.equal(flowGraphSchema.safeParse(emptyGraph()).success, true)
  const legacy = flowGraphSchema.safeParse({
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual', inputFields: [{ name: 'q', type: 'string', required: true }] } } }],
    edges: [],
  })
  assert.equal(legacy.success, true)
})
```

2. **Run — fails** (schema doesn't know `input`/`output`/`subflow`): `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/graph-io-nodes.test.ts`.

3. **Implement** — in `src/lib/flows/graph.ts`, after `triggerInputFieldSchema` (line ~28) add the input param schema:
```ts
/** A first-class input node's typed parameter. `default` is a templated/literal string coerced to `type` at runtime. */
export const inputParamSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES).default('string'),
  required: z.boolean().optional(),
  default: z.string().optional(),
  description: z.string().optional(),
})
export type InputParam = z.infer<typeof inputParamSchema>

/** A first-class output node's typed return field, bound from flow context via a templated `value`. */
export const outputFieldBindingSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES).default('any'),
  value: z.string(),
  description: z.string().optional(),
})
export type OutputFieldBinding = z.infer<typeof outputFieldBindingSchema>
```
Then, alongside the other node consts (e.g. after `humanReviewNode`, line ~257), add:
```ts
// First-class INPUT: the flow's typed, named parameter list — its callable
// signature. Values resolve with precedence user > webhook > default and are
// coerced at the boundary, then exposed as {{input.<name>}}. A flow WITHOUT an
// input node keeps today's opaque {{trigger.input}} semantics (back-compat).
const inputNode = z.object({
  id: z.string(),
  type: z.literal('input'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    params: z.array(inputParamSchema).default([]),
  }),
})
// First-class OUTPUT: the flow's typed return object. Each field is bound from
// context by a templated `value` and coerced to `type`. A flow WITHOUT an output
// node returns today's implicit lastOutput (back-compat).
const outputNode = z.object({
  id: z.string(),
  type: z.literal('output'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    fields: z.array(outputFieldBindingSchema).default([]),
  }),
})
// Synchronous SUBFLOW: run a child flow to completion and block on its output.
// `input` is a JSON object string mapping the child's input params to templated
// values (same shape as a tool node's args). The step output is the child's
// output-node object.
const subflowNode = z.object({
  id: z.string(),
  type: z.literal('subflow'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    flowId: z.string(),
    input: z.string().optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
  }),
})
```
Add the three to the union:
```ts
export const flowNodeSchema = z.discriminatedUnion('type', [
  triggerNode, agentNode, conditionNode, loopNode, parallelNode, stopNode, toolNode, httpNode, transformNode, filterNode, switchNode, variableNode, dataNode, humanReviewNode, inputNode, outputNode, subflowNode,
])
```

4. **Run — passes.** Then `npx tsc --noEmit` to confirm the new union members don't break any `node.type` consumer (no exhaustive `never` assertions exist on `node.type` — verified; UI palette registration is a separate out-of-scope follow-up, see Assumptions).

5. **Commit:** `feat(flows): add input/output/subflow node kinds to the graph schema`.

---

## Task 2 — Pure I/O node logic: coercion, input precedence, output binding

**Files:** `src/lib/flows/io-nodes.ts` (create), `src/lib/flows/__tests__/io-nodes.test.ts` (create).

**Interfaces**
- Consumes: `FieldType` (graph.ts), `asStructured` (context.ts), `InputParam`.
- Produces:
  - `coerceFieldValue(type: FieldType, value: unknown): { value: unknown } | { error: string }`.
  - `resolveInputParams(params: InputParamSpec[], sources: InputSources): { values: Record<string, unknown> } | { error: string }` where `InputParamSpec = { name: string; type?: FieldType; required?: boolean; default?: string }`, `InputSources = { user?: Record<string, unknown>; webhook?: Record<string, unknown> }`.
  - `bindOutputFields(fields: OutputBindingSpec[], resolve: (template: string) => unknown): { output: Record<string, unknown> } | { error: string }` where `OutputBindingSpec = { name: string; type?: FieldType; value: string }`.

### Steps

1. **Write failing test** — `src/lib/flows/__tests__/io-nodes.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coerceFieldValue, resolveInputParams, bindOutputFields } from '../io-nodes'

test('coerceFieldValue coerces per type at the boundary', () => {
  assert.deepEqual(coerceFieldValue('number', '42'), { value: 42 })
  assert.deepEqual(coerceFieldValue('boolean', 'true'), { value: true })
  assert.deepEqual(coerceFieldValue('boolean', false), { value: false })
  assert.deepEqual(coerceFieldValue('object', '{"a":1}'), { value: { a: 1 } })
  assert.deepEqual(coerceFieldValue('array', '[1,2]'), { value: [1, 2] })
  assert.deepEqual(coerceFieldValue('string', 7), { value: '7' })
  assert.ok('error' in coerceFieldValue('number', 'abc'))
  assert.ok('error' in coerceFieldValue('object', '[1]'))
})

test('resolveInputParams applies precedence user > webhook > default', () => {
  const params = [
    { name: 'a', type: 'string' as const },
    { name: 'b', type: 'string' as const },
    { name: 'c', type: 'number' as const, default: '5' },
  ]
  const res = resolveInputParams(params, { user: { a: 'U' }, webhook: { a: 'W', b: 'W' } })
  assert.ok('values' in res)
  assert.deepEqual(res.values, { a: 'U', b: 'W', c: 5 })
})

test('resolveInputParams coerces to declared type and errors on required-missing', () => {
  assert.deepEqual(
    resolveInputParams([{ name: 'n', type: 'number' as const }], { user: { n: '10' } }),
    { values: { n: 10 } },
  )
  const missing = resolveInputParams([{ name: 'x', type: 'string' as const, required: true }], { user: {} })
  assert.ok('error' in missing)
  // optional + no value + no default => omitted, not errored
  assert.deepEqual(resolveInputParams([{ name: 'y', type: 'string' as const }], { user: {} }), { values: {} })
})

test('bindOutputFields binds and coerces from a resolver', () => {
  const resolve = (t: string) => ({ '{{step.n.output.score}}': '91', '{{step.n.output.tags}}': '["a"]' } as Record<string, unknown>)[t]
  const res = bindOutputFields(
    [{ name: 'score', type: 'number', value: '{{step.n.output.score}}' }, { name: 'tags', type: 'array', value: '{{step.n.output.tags}}' }],
    resolve,
  )
  assert.deepEqual(res, { output: { score: 91, tags: ['a'] } })
})
```

2. **Run — fails** (module missing).

3. **Implement** — `src/lib/flows/io-nodes.ts`:
```ts
import type { FieldType } from '@/lib/flows/graph'
import { asStructured } from '@/features/flows/context'

export type InputParamSpec = { name: string; type?: FieldType; required?: boolean; default?: string }
export type InputSources = { user?: Record<string, unknown>; webhook?: Record<string, unknown> }
export type OutputBindingSpec = { name: string; type?: FieldType; value: string }

const asText = (value: unknown): string =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** A value is "present" when it is not undefined/null and not a blank string. */
const present = (value: unknown): boolean =>
  value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * Coerce a boundary value to a declared FieldType. Mirrors the variable-step
 * coercion (interpret.ts:coerceVariableValue) but over the datatree FieldType
 * vocabulary (string|number|boolean|object|array|any). Returns a plain-english
 * error the run panel can surface.
 */
export function coerceFieldValue(type: FieldType, value: unknown): { value: unknown } | { error: string } {
  const text = typeof value === 'string' ? value.trim() : undefined
  switch (type) {
    case 'any':
      return { value: typeof value === 'string' ? asStructured(value) : value }
    case 'string':
      return { value: value == null ? '' : typeof value === 'string' ? value : asText(value) }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(text)
      if (text !== '' && text !== undefined && Number.isFinite(n)) return { value: n }
      if (typeof value === 'number' && Number.isFinite(value)) return { value }
      return { error: `expected a number but got "${asText(value)}".` }
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { value }
      if (text?.toLowerCase() === 'true') return { value: true }
      if (text?.toLowerCase() === 'false') return { value: false }
      return { error: `expected true or false but got "${asText(value)}".` }
    }
    case 'object': {
      const parsed = typeof value === 'string' ? safeJson(text ?? '') : value
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed }
      return { error: 'expected a JSON object.' }
    }
    case 'array': {
      const parsed = typeof value === 'string' ? safeJson(text ?? '') : value
      if (Array.isArray(parsed)) return { value: parsed }
      return { error: 'expected a JSON array.' }
    }
  }
}

/**
 * Resolve an input node's params against its sources with precedence
 * user > webhook > default, coercing each to its declared type. A required
 * param with no value anywhere is an error; an optional one is omitted.
 */
export function resolveInputParams(
  params: InputParamSpec[],
  sources: InputSources,
): { values: Record<string, unknown> } | { error: string } {
  const user = asRecord(sources.user)
  const webhook = asRecord(sources.webhook)
  const values: Record<string, unknown> = {}
  for (const param of params) {
    const name = param.name.trim()
    if (!name) continue
    let raw: unknown = present(user?.[name]) ? user![name] : present(webhook?.[name]) ? webhook![name] : undefined
    if (!present(raw)) raw = present(param.default) ? param.default : undefined
    if (!present(raw)) {
      if (param.required) return { error: `Missing required input "${name}".` }
      continue
    }
    const coerced = coerceFieldValue(param.type ?? 'string', raw)
    if ('error' in coerced) return { error: `Input "${name}": ${coerced.error}` }
    values[name] = coerced.value
  }
  return { values }
}

/**
 * Bind an output node's fields into the flow's typed return object. `resolve`
 * evaluates a field's template against the flow context (the interpreter passes
 * `(t) => resolveTemplateValue(t, ctx)`); each result is coerced to `type`.
 */
export function bindOutputFields(
  fields: OutputBindingSpec[],
  resolve: (template: string) => unknown,
): { output: Record<string, unknown> } | { error: string } {
  const output: Record<string, unknown> = {}
  for (const field of fields) {
    const name = field.name.trim()
    if (!name) continue
    const coerced = coerceFieldValue(field.type ?? 'any', resolve(field.value))
    if ('error' in coerced) return { error: `Output "${name}": ${coerced.error}` }
    output[name] = coerced.value
  }
  return { output }
}
```

4. **Run — passes.**

5. **Commit:** `feat(flows): pure input coercion/precedence + output binding for I/O nodes`.

---

## Task 3 — Interpreter: `input` node + `{{input.<name>}}` binding

**Files:** `src/features/flows/context.ts` (modify), `src/features/flows/interpret.ts` (modify), `src/features/flows/__tests__/interpret-input-node.test.ts` (create).

**Interfaces**
- Consumes: `resolveInputParams` (io-nodes.ts), `FlowContext`, `RunAgentFn`.
- Produces: `execNode` `input` arm; `FlowContext.input?: Record<string, unknown>`; `opts.webhookInput?: unknown` (the webhook source; `user` = `ctx.trigger.input`). Sets `ctx.input`, emits a succeeded step with the resolved values as output.

### Steps

1. **Write failing test** — `src/features/flows/__tests__/interpret-input-node.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echo: RunAgentFn = async (node) => ({ output: node.input })

test('input node coerces params and exposes {{input.<name>}}', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'in', type: 'input', data: { params: [
        { name: 'account', type: 'string', required: true },
        { name: 'limit', type: 'number', default: '10' },
      ] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: '{{input.account}} limit={{input.limit}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'in' },
      { id: 'e1', source: 'in', target: 'a' },
    ],
  }
  const result = await interpretFlow(graph, { account: 'Acme' }, { runAgent: echo })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'Acme limit=10')
})

test('input precedence user > webhook, and required-missing fails the node', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'in', type: 'input', data: { params: [{ name: 'q', type: 'string', required: true }] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: '{{input.q}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'in' }, { id: 'e1', source: 'in', target: 'a' }],
  }
  const ok = await interpretFlow(graph, { q: 'user' }, { runAgent: echo, webhookInput: { q: 'hook' } })
  assert.equal(ok.output, 'user')
  const fail = await interpretFlow(graph, {}, { runAgent: echo })
  assert.equal(fail.status, 'failed')
  assert.match(fail.error ?? '', /Missing required input "q"/)
})

test('BACK-COMPAT: a flow with no input node still resolves {{trigger.input}}', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'got {{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const result = await interpretFlow(graph, 'hello', { runAgent: echo })
  assert.equal(result.output, 'got hello')
})

test('input binding is visible inside a loop body', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'in', type: 'input', data: { params: [{ name: 'tag', type: 'string' }] } },
      { id: 'loop', type: 'loop', data: { over: '["a","b"]', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'x', input: '{{input.tag}}:{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'in' }, { id: 'e1', source: 'in', target: 'loop' }],
  }
  const result = await interpretFlow(graph, { tag: 'T' }, { runAgent: echo })
  assert.deepEqual(result.output, ['T:a', 'T:b'])
})
```

2. **Run — fails.**

3. **Implement:**
   - `src/features/flows/context.ts` — add to `FlowContext`:
```ts
  // First-class input node bindings, read via `{{input.<name>}}`. Absent when
  // the flow declares no input node (back-compat: {{trigger.input}} still works).
  input?: Record<string, unknown>
```
   (`readPath` already walks any root property of `ctx`, so `input.<name>` resolves with no change.)
   - `src/features/flows/interpret.ts`:
     - Import: `import { resolveInputParams, bindOutputFields } from '@/lib/flows/io-nodes'` (bindOutputFields used in Task 4).
     - Extend `Opts`:
```ts
  // The webhook-derived payload for a webhook-triggered run — the secondary
  // source for input-node precedence (user > webhook > default). Absent for
  // manual/API/flow-as-tool runs, where the trigger input is the sole user source.
  webhookInput?: unknown
```
     - In `execNode`, add the `input` arm (place it before the `agent` arm, after `transform`):
```ts
    if (node.type === 'input') {
      const resolved = resolveInputParams(node.data.params, {
        user: (ctx.trigger.input && typeof ctx.trigger.input === 'object' && !Array.isArray(ctx.trigger.input))
          ? (ctx.trigger.input as Record<string, unknown>)
          : undefined,
        webhook: (opts.webhookInput && typeof opts.webhookInput === 'object' && !Array.isArray(opts.webhookInput))
          ? (opts.webhookInput as Record<string, unknown>)
          : undefined,
      })
      if ('error' in resolved) {
        emit({ nodeId: node.id, status: 'failed', error: resolved.error })
        return { kind: 'fail', error: resolved.error }
      }
      ctx.input = { ...(ctx.input ?? {}), ...resolved.values }
      ctx.step[node.id] = { output: resolved.values }
      emit({ nodeId: node.id, status: 'succeeded', output: resolved.values })
      return { kind: 'ok', output: resolved.values }
    }
```
     - Thread `input` into the loop item context (line ~543) and parallel branch context (line ~562) by adding `input: ctx.input,` to each `FlowContext` literal.
     - Resume rebuild: in the `if (opts.completed)` preamble (line ~618), inside the existing loop over `Object.entries(opts.completed)`, add after the variable rebuild:
```ts
      if (node?.type === 'input' && output && typeof output === 'object' && !Array.isArray(output)) {
        ctx.input = { ...(ctx.input ?? {}), ...(output as Record<string, unknown>) }
      }
```

4. **Run — passes** (including the back-compat test).

5. **Commit:** `feat(flows): interpret input node with typed coercion + precedence`.

---

## Task 4 — Interpreter: `output` node → explicit typed return

**Files:** `src/features/flows/interpret.ts` (modify), `src/features/flows/__tests__/interpret-output-node.test.ts` (create).

**Interfaces**
- Consumes: `bindOutputFields` (io-nodes.ts), `resolveTemplateValue` (context.ts).
- Produces: `execNode` `output` arm; a `terminalOutput()` that returns the last output node's bound object when one ran, else `lastOutput` (unchanged).

### Steps

1. **Write failing test** — `src/features/flows/__tests__/interpret-output-node.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const stub = (map: Record<string, unknown>): RunAgentFn => async (node) => ({ output: map[node.agentId] ?? node.input })

test('output node returns an explicit typed object instead of lastOutput', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'score', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }], input: 'x' } },
      { id: 'out', type: 'output', data: { fields: [
        { name: 'score', type: 'number', value: '{{step.a.output.score}}' },
        { name: 'label', type: 'string', value: 'done' },
      ] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }, { id: 'e1', source: 'a', target: 'out' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ score: '{"score":91}' }) })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, { score: 91, label: 'done' })
})

test('BACK-COMPAT: a flow with no output node returns lastOutput', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: '{{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const result = await interpretFlow(graph, 'hi', { runAgent: stub({}) })
  assert.equal(result.output, 'hi')
})

test('output node coercion error fails the run', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { fields: [{ name: 'n', type: 'number', value: 'not-a-number' }] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'out' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /Output "n"/)
})
```

2. **Run — fails.**

3. **Implement** in `src/features/flows/interpret.ts`:
   - Declare the capture near `const steps` (line ~288):
```ts
  // The last output node's bound return object (if any). When set, it becomes
  // the flow's returned output in place of the implicit lastOutput.
  let explicitOutput: { value: unknown } | undefined
```
   - Add the `output` arm in `execNode` (after the `input` arm):
```ts
    if (node.type === 'output') {
      const bound = bindOutputFields(node.data.fields, (template) => resolveTemplateValue(template, ctx))
      if ('error' in bound) {
        emit({ nodeId: node.id, status: 'failed', error: bound.error })
        return { kind: 'fail', error: bound.error }
      }
      explicitOutput = { value: bound.output }
      ctx.step[node.id] = { output: bound.output }
      emit({ nodeId: node.id, status: 'succeeded', output: bound.output })
      return { kind: 'ok', output: bound.output }
    }
```
   - Add a helper just before the main `while (current)` loop (line ~644):
```ts
  const terminalOutput = () => (explicitOutput ? explicitOutput.value : lastOutput)
```
   - Replace the terminal **success** returns to prefer the explicit output:
     - the stop/drop success return (line ~667): `return { status: 'succeeded', steps, output: terminalOutput() }`
     - the final return (line ~679): `return { status: 'succeeded', steps, output: terminalOutput() }`
   - Leave the `failed`/`waiting` returns on `lastOutput` (no complete declared output was produced), and leave the trigger-filter-skip early return unchanged.

4. **Run — passes** (including back-compat).

5. **Commit:** `feat(flows): interpret output node as the flow's explicit typed return`.

---

## Task 5 — Validation for `input`/`output`/`subflow` nodes

**Files:** `src/lib/flows/validate.ts` (modify), `src/lib/flows/__tests__/validate.test.ts` (append).

**Interfaces**
- Consumes: `validateFlowGraph`, `FlowNode`.
- Produces: `nodeLabel` cases + structural checks: at most one input node & one output node; param/field names non-empty + unique; subflow needs a `flowId`; subflow `input` must be a JSON object; input/output/subflow may not sit inside a loop/parallel body.

### Steps

1. **Write failing test** — append to `src/lib/flows/__tests__/validate.test.ts`:
```ts
test('input node: rejects blank/duplicate param names and >1 input node', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'in1', type: 'input', data: { params: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] } },
      { id: 'in2', type: 'input', data: { params: [{ name: 'b', type: 'string' }] } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'in1' }],
  })
  const codes = r.errors.map((e) => e.code)
  assert.ok(codes.includes('DUPLICATE_INPUT_PARAM'))
  assert.ok(codes.includes('MULTIPLE_INPUT_NODES'))
})

test('subflow node needs a flowId', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'subflow', data: { flowId: '' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 's' }],
  })
  assert.ok(r.errors.some((e) => e.code === 'MISSING_SUBFLOW_FLOW'))
})

test('input node inside a loop body is rejected', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['in'] } },
      { id: 'in', type: 'input', data: { params: [{ name: 'a', type: 'string' }] } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'loop' }],
  })
  assert.ok(r.errors.some((e) => e.code === 'IO_NODE_IN_CONTAINER'))
})
```

2. **Run — fails.**

3. **Implement** in `src/lib/flows/validate.ts`:
   - `nodeLabel` switch: add `case 'input': return 'Input'`, `case 'output': return 'Output'`, `case 'subflow': return 'Subflow'`.
   - In the per-node loop (after the `humanReview` arm, ~line 456), add:
```ts
    if (node.type === 'input') {
      const names = node.data.params.map((p) => p.name.trim())
      names.forEach((name, index) => {
        if (!name) add(issues, 'error', 'MISSING_INPUT_PARAM_NAME', `${nodeLabel(node)} param ${index + 1} needs a name.`, node.id)
      })
      for (const name of unique(names.filter(Boolean))) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_INPUT_PARAM', `${nodeLabel(node)} has duplicate param "${name}".`, node.id)
        }
      }
    }
    if (node.type === 'output') {
      const names = node.data.fields.map((f) => f.name.trim())
      node.data.fields.forEach((field, index) => {
        if (!field.name.trim()) add(issues, 'error', 'MISSING_OUTPUT_FIELD_NAME', `${nodeLabel(node)} field ${index + 1} needs a name.`, node.id)
      })
      for (const name of unique(names.filter(Boolean))) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_OUTPUT_FIELD', `${nodeLabel(node)} has duplicate field "${name}".`, node.id)
        }
      }
    }
    if (node.type === 'subflow') {
      if (!node.data.flowId.trim()) add(issues, 'error', 'MISSING_SUBFLOW_FLOW', `${nodeLabel(node)} needs a flow to run.`, node.id)
      validateJsonObjectField(issues, node.data.input, `${nodeLabel(node)} input must map to a JSON object.`, node.id)
    }
```
   - After the per-node loop, enforce single input/output nodes (place near `validateVariableNodes(graph, issues)`, ~line 480):
```ts
  const inputNodes = graph.nodes.filter((node) => node.type === 'input')
  for (const dup of inputNodes.slice(1)) {
    add(issues, 'error', 'MULTIPLE_INPUT_NODES', 'A flow can have only one Input step.', dup.id)
  }
  const outputNodes = graph.nodes.filter((node) => node.type === 'output')
  for (const dup of outputNodes.slice(1)) {
    add(issues, 'error', 'MULTIPLE_OUTPUT_NODES', 'A flow can have only one Output step.', dup.id)
  }
```
   - In the container-member guard loop (`for (const memberId of containerMemberIds)`, ~line 492), add:
```ts
    if (member.type === 'input' || member.type === 'output' || member.type === 'subflow') {
      add(issues, 'error', 'IO_NODE_IN_CONTAINER', `${nodeLabel(member)} can't run inside a For each / Parallel body. Use a subflow-per-item instead.`, member.id)
    }
```

4. **Run — passes.**

5. **Commit:** `feat(flows): validate input/output/subflow node structure`.

---

## Task 6 — Flow tool plane: `flow` member + Flow→ToolDefinition adapter (pure derivation)

**Files:** `src/lib/flows/tool-connection-id.ts` (modify), `src/lib/flows/flow-tool.ts` (create), `src/lib/flows/__tests__/flow-tool.test.ts` (create), `src/features/agents/tool-planes.ts` (modify).

**Interfaces**
- Produces (pure, `flow-tool.ts`):
  - `inputParamsFromGraph(graph: FlowGraph): InputParamSpec[]`
  - `outputFieldsFromGraph(graph: FlowGraph): OutputField[]`
  - `flowInputJsonSchema(params: InputParamSpec[]): Record<string, unknown>`
  - `flowToolSlug(name: string): string`
  - `isAgentCallableFlow(metadata: unknown): boolean`
  - `flowToolGroundingLine(flow: { id: string; name: string }, params: InputParamSpec[], outputs: OutputField[]): string`
- Produces (`tool-planes.ts`): `loadFlowPlaneGroups(organizationId, userId, options?)` → `ToolPlaneGroup[]`; a `'flow'` case in `resolveFlowToolExecutor`.
- Consumes: `dispatchFlowExecution` via **dynamic import** (cycle-break).

### Steps

1. **Write failing test** — `src/lib/flows/__tests__/flow-tool.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inputParamsFromGraph, outputFieldsFromGraph, flowInputJsonSchema, flowToolSlug, isAgentCallableFlow } from '../flow-tool'
import { parseFlowToolConnectionId, formatFlowToolConnectionId } from '../tool-connection-id'
import type { FlowGraph } from '@/lib/flows/graph'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'in', type: 'input', data: { params: [
      { name: 'account', type: 'string', required: true, description: 'account name' },
      { name: 'limit', type: 'number' },
    ] } },
    { id: 'out', type: 'output', data: { fields: [{ name: 'score', type: 'number', value: '{{step.a.output.score}}' }] } },
  ],
  edges: [],
}

test('inputParamsFromGraph / outputFieldsFromGraph read the I/O nodes', () => {
  assert.deepEqual(inputParamsFromGraph(graph).map((p) => p.name), ['account', 'limit'])
  assert.deepEqual(outputFieldsFromGraph(graph), [{ name: 'score', type: 'number' }])
  assert.deepEqual(inputParamsFromGraph({ nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }), [])
})

test('flowInputJsonSchema derives a typed JSON Schema with required', () => {
  assert.deepEqual(flowInputJsonSchema(inputParamsFromGraph(graph)), {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'account name' },
      limit: { type: 'number' },
    },
    required: ['account'],
  })
})

test('flowToolSlug + connection id round-trips the flow plane', () => {
  assert.equal(flowToolSlug('Score Account!'), 'score_account')
  const id = formatFlowToolConnectionId('flow', 'flw_1')
  assert.equal(id, 'flow:flw_1')
  assert.deepEqual(parseFlowToolConnectionId(id), { plane: 'flow', ref: 'flw_1' })
})

test('isAgentCallableFlow reads the org opt-in', () => {
  assert.equal(isAgentCallableFlow({ agentCallable: true }), true)
  assert.equal(isAgentCallableFlow({ agentCallable: false }), false)
  assert.equal(isAgentCallableFlow(null), false)
})
```

2. **Run — fails.**

3. **Implement:**
   - `src/lib/flows/tool-connection-id.ts` — extend the plane set:
```ts
export const FLOW_TOOL_PLANES = ['klavis', 'mcp', 'native', 'nango', 'flow'] as const
```
   and add `'flow'` to the prefixed set:
```ts
const PREFIXED_PLANES = new Set<FlowToolPlane>(['klavis', 'native', 'nango', 'flow'])
```
   - `src/lib/flows/flow-tool.ts`:
```ts
import type { FlowGraph, FieldType, OutputField } from '@/lib/flows/graph'
import type { InputParamSpec } from '@/lib/flows/io-nodes'

/** The input node's params as a callable signature (empty when none declared). */
export function inputParamsFromGraph(graph: FlowGraph): InputParamSpec[] {
  const node = graph.nodes.find((n) => n.type === 'input')
  return node?.type === 'input'
    ? node.data.params
        .filter((p) => p.name.trim())
        .map((p) => ({ name: p.name, type: p.type, required: p.required, default: p.default }))
    : []
}

/** The output node's declared fields as OutputFields (empty when none declared). */
export function outputFieldsFromGraph(graph: FlowGraph): OutputField[] {
  const node = graph.nodes.find((n) => n.type === 'output')
  return node?.type === 'output'
    ? node.data.fields
        .filter((f) => f.name.trim())
        .map((f) => ({ name: f.name, type: f.type, ...(f.description ? { description: f.description } : {}) }))
    : []
}

const JSON_SCHEMA_TYPE: Record<Exclude<FieldType, 'any'>, string> = {
  string: 'string', number: 'number', boolean: 'boolean', object: 'object', array: 'array',
}

/** Typed JSON Schema for a flow's input params — the tool's inputSchema. */
export function flowInputJsonSchema(params: InputParamSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const param of params) {
    const name = param.name.trim()
    if (!name) continue
    const type = param.type ?? 'string'
    properties[name] = {
      ...(type === 'any' ? {} : { type: JSON_SCHEMA_TYPE[type] }),
      ...((param as { description?: string }).description ? { description: (param as { description?: string }).description } : {}),
    }
    if (param.required) required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** Slug a flow name into a stable tool suffix (agent tool name = `flow_<slug>`). */
export function flowToolSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'flow'
}

/** Org opt-in gate: only flows explicitly marked agentCallable are exposed as tools. */
export function isAgentCallableFlow(metadata: unknown): boolean {
  return Boolean(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && (metadata as Record<string, unknown>).agentCallable === true)
}

/** One copilot-grounding line describing a callable flow's signature. */
export function flowToolGroundingLine(
  flow: { id: string; name: string },
  params: InputParamSpec[],
  outputs: OutputField[],
): string {
  const inHint = params.map((p) => `${p.name}${p.required ? '*' : ''}:${p.type ?? 'string'}`).join(', ')
  const outHint = outputs.map((f) => `${f.name}:${f.type}`).join(', ')
  return `- ${flow.name} (flowId: ${flow.id})${inHint ? ` inputs: ${inHint}` : ''}${outHint ? ` outputs: ${outHint}` : ''}`
}
```
   - `src/features/agents/tool-planes.ts` — add imports:
```ts
import { flowGraphSchema } from '@/lib/flows/graph'
import { inputParamsFromGraph, flowInputJsonSchema, flowToolSlug, isAgentCallableFlow } from '@/lib/flows/flow-tool'
```
   Note: `formatFlowToolConnectionId` and `type FlowToolPlane` are already imported (line 33).
   Add, after `loadNangoPlaneGroups` (~line 370):
```ts
// ── Flow tool plane (workflows-as-tools) ──────────────────────────────────────

/**
 * Agent-callable flows as a tool plane. Each org-opted flow (metadata.agentCallable)
 * becomes one ToolPlaneGroup whose inputSchema is the flow's input-node params and
 * whose client dispatches the flow and returns its output-node object. Dispatch is
 * a DYNAMIC import to break the execute-flow -> tool-planes cycle. Only surfaces
 * when a userId is available (dispatch runs as that user).
 */
export async function loadFlowPlaneGroups(
  organizationId: string,
  userId: string,
  options: { flowIds?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  const flows = await prisma.flow.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      ...(options.flowIds?.length ? { id: { in: options.flowIds } } : {}),
    },
    take: 100,
  })
  const groups: ToolPlaneGroup[] = []
  for (const flow of flows) {
    if (!isAgentCallableFlow(flow.metadata)) continue
    const parsed = flowGraphSchema.safeParse(flow.publishedGraph ?? flow.graph)
    if (!parsed.success) continue
    const params = inputParamsFromGraph(parsed.data)
    const description = flow.description?.trim() || `Run the "${flow.name}" flow and return its output.`
    const client: McpToolClient = {
      executeTool: async (_serverUrl, _name, args) => {
        const { dispatchFlowExecution } = await import('@/features/flows/execute-flow')
        const res = await dispatchFlowExecution({
          flowId: flow.id,
          organizationId,
          userId,
          input: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
          usePublished: flow.publishedGraph != null,
          trigger: { type: 'signal', via: 'flow-tool' },
        })
        if ('queued' in res) {
          return { error: 'This flow runs in the background; agent-callable flows require inline execution mode.' }
        }
        return res.output ?? null
      },
    }
    groups.push({
      id: formatFlowToolConnectionId('flow', flow.id),
      plane: 'flow',
      name: flow.name,
      provider: 'flow',
      serverUrl: '',
      isWrite: false,
      client,
      tools: [{ name: flowToolSlug(flow.name), description, inputSchema: flowInputJsonSchema(params) }],
    })
  }
  return groups
}
```
   Add a `'flow'` branch to `resolveFlowToolExecutor` (before the trailing `// nango` block, ~line 438):
```ts
  if (plane === 'flow') {
    const flow = await prisma.flow.findFirst({ where: { id: ref, organizationId } })
    if (!flow) throw new Error('The selected flow no longer exists — pick another in the step config.')
    return {
      provider: 'flow',
      isWrite: false,
      execute: async (_name, args) => {
        const { dispatchFlowExecution } = await import('@/features/flows/execute-flow')
        const res = await dispatchFlowExecution({
          flowId: flow.id, organizationId, userId,
          input: args, usePublished: flow.publishedGraph != null, trigger: { type: 'signal', via: 'flow-tool' },
        })
        if ('queued' in res) throw new Error('This flow runs in the background; call it from a subflow step instead.')
        return res.output ?? null
      },
    }
  }
```

4. **Run — passes** (pure tests). Then `npx tsc --noEmit` to confirm `tool-planes.ts` compiles (dynamic import + `ToolPlaneGroup`/`McpToolClient` shapes).

5. **Commit:** `feat(flows): add flow tool plane + Flow->ToolDefinition adapter`.

---

## Task 7 — Surface flows in `loadTools` (agent runtime)

**Files:** `src/features/agents/execute-agent.ts` (modify).

**Interfaces**
- Consumes: `loadFlowPlaneGroups` (tool-planes.ts), existing `pushGroup` in `loadTools`.
- Produces: agent-callable flows discovered as `flow_<slug>` tools (org opt-in), subject to the existing `TOOL_CAP`/relevance selection.

### Steps

1. **Write failing test** — the pure gate is already covered by `flow-tool.test.ts` (`isAgentCallableFlow`) and schema derivation. `loadTools` itself is DB-bound (no unit harness in this repo). Add a focused assertion to `flow-tool.test.ts` that the tool descriptor name derivation matches what `loadTools` will expose:
```ts
import { toolName } from '@/features/agents/tool-planes'
test('agent flow tool name = flow_<slug>', () => {
  assert.equal(toolName('flow', flowToolSlug('Score Account')), 'flow_score_account')
})
```
   Run — passes if the derivation is right; this pins the contract `loadTools` depends on. (The DB wiring below is verified by `npx tsc --noEmit` + a manual inline run.)

2. **Implement** in `src/features/agents/execute-agent.ts`:
   - Import `loadFlowPlaneGroups` from `./tool-planes` (add to the existing import block at line ~15).
   - In `loadTools` (after the Nango block, ~line 291, before `return selectDiscoveredTools(...)`):
```ts
  // ---- Flow tool plane (agent -> flow) -------------------------------------
  // Org-opted flows (metadata.agentCallable) appear as `flow_<slug>` tools whose
  // input schema is the flow's input node and whose result is its output node.
  // Only when an acting user is known (dispatch runs as that user).
  if (ownerUserId) {
    for (const group of await loadFlowPlaneGroups(organizationId, ownerUserId)) pushGroup(group)
  }
```
   (`pushGroup` defaults `namePrefix` to `group.provider` = `'flow'`, so the tool name is `flow_<slug>` — matching the pinned test.)

3. **Run — passes** (`flow-tool.test.ts`), `npx tsc --noEmit`.

4. **Verify end-to-end (inline):** with a seed flow marked `metadata.agentCallable = true` that has an input+output node, confirm an agent whose objective references it can call `flow_<slug>` and receive the output object (manual inline run; `EXECUTION_MODE=inline`).

5. **Commit:** `feat(agents): expose agent-callable flows as tools in loadTools`.

---

## Task 8 — Subflow node: `RunFlowFn` interpreter arm + execute-flow adapter + child-run link

**Files:** `src/features/flows/interpret.ts` (modify), `src/features/flows/__tests__/interpret-subflow.test.ts` (create), `prisma/schema.prisma` (modify) + migration, `src/features/flows/execute-flow.ts` (modify).

**Interfaces**
- Produces (interpreter): `RunFlowFn` + `RunFlowResult` (mirroring `RunAgentFn`/`RunAgentResult`); `opts.runFlow?: RunFlowFn`; `execNode` `subflow` arm (maps parent ctx → child input, blocks on result, applies `onError`).
- Produces (execute-flow): a `runFlow` adapter mirroring `runAgent` (create step → `runFlowExecution` → link `childFlowRunId` → map output); `FlowExecutionJob.subflowDepth?: number` + `MAX_SUBFLOW_DEPTH` guard.
- Produces (schema): `FlowRunStep.childFlowRunId String?`.

### Steps

1. **Write failing test** — `src/features/flows/__tests__/interpret-subflow.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunFlowFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echo: RunAgentFn = async (node) => ({ output: node.input })

test('subflow node maps input, blocks on child output, and binds it back', async () => {
  const calls: { flowId: string; input: unknown }[] = []
  const runFlow: RunFlowFn = async (node) => {
    calls.push({ flowId: node.flowId, input: node.input })
    return { output: { score: 91 } }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'flw_child', input: '{"account":"{{trigger.input}}"}' } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'score={{step.sub.output.score}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }, { id: 'e1', source: 'sub', target: 'a' }],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: echo, runFlow })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls, [{ flowId: 'flw_child', input: { account: 'Acme' } }])
  assert.equal(result.output, 'score=91')
})

test('subflow error respects onError=continue', async () => {
  const runFlow: RunFlowFn = async () => ({ error: 'child failed' })
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c', onError: 'continue' } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'after' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }, { id: 'e1', source: 'sub', target: 'a' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'after')
})

test('nested subflow-per-item: one child call per loop item', async () => {
  const seen: unknown[] = []
  const runFlow: RunFlowFn = async (node) => { seen.push(node.input); return { output: node.input } }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '["a","b"]', body: ['sub'] } },
      { id: 'sub', type: 'subflow', data: { flowId: 'c', input: '{"item":"{{item}}"}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.deepEqual(seen, [{ item: 'a' }, { item: 'b' }])
  assert.deepEqual(result.output, [{ item: 'a' }, { item: 'b' }])
})

test('subflow without a runFlow adapter fails cleanly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo })
  assert.equal(result.status, 'failed')
})
```

2. **Run — fails.**

3. **Implement (interpreter)** in `src/features/flows/interpret.ts`:
   - Add the types near `RunAgentResult`/`RunAgentFn` (line ~13):
```ts
export type RunFlowResult = { output?: unknown; error?: string; waiting?: { status: string; question?: string } }
export type RunFlowFn = (node: { id: string; flowId: string; input: unknown; resume?: boolean }) => Promise<RunFlowResult>
```
   - Extend `Opts` with `runFlow?: RunFlowFn`.
   - Add the `subflow` arm in `execNode` (after the `agent` arm, ~line 536):
```ts
    if (node.type === 'subflow') {
      // Map parent context -> child input (JSON object of templated values, same
      // shape as tool args). No mapping -> pass the current loop item (or {}).
      let childInput: unknown = ctx.item ?? {}
      if (node.data.input?.trim()) {
        try {
          childInput = resolveTemplateValue(JSON.parse(node.data.input), ctx)
        } catch {
          childInput = resolveTemplateValue(node.data.input, ctx)
        }
      }
      const res: RunFlowResult = opts.runFlow
        ? await opts.runFlow({ id: node.id, flowId: node.data.flowId, input: childInput, resume: opts.resumeNodeId === node.id })
        : { error: 'Subflow steps are not supported in this runtime.' }
      if (res.waiting) {
        emit({ nodeId: node.id, status: 'waiting' })
        return { kind: 'pause', nodeId: node.id, question: res.waiting.question }
      }
      if (res.error) {
        emit({ nodeId: node.id, status: 'failed', error: res.error })
        if ((node.data.onError ?? 'stop') === 'continue') return { kind: 'ok', output: undefined }
        return { kind: 'fail', error: res.error }
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      emit({ nodeId: node.id, status: 'succeeded', output })
      return { kind: 'ok', output }
    }
```

4. **Run — passes** (interpreter tests).

5. **Implement (schema + adapter):**
   - `prisma/schema.prisma` — add to `FlowRunStep` (after `agentExecutionId`):
```prisma
  childFlowRunId   String?   // subflow step: the child FlowRun this step ran
```
   - Migration: `npx prisma migrate dev --name flow_run_step_child_flow_run` (adds the nullable column), then `npx prisma generate`.
   - `src/features/flows/execute-flow.ts`:
     - Extend `FlowExecutionJob` with:
```ts
  // Synchronous subflow nesting depth — bounds runaway flow->flow recursion.
  subflowDepth?: number
```
     - Add a module const near the top: `const MAX_SUBFLOW_DEPTH = 5`.
     - Guard at the start of `runFlowExecution` (after the `flow` lookup, before interpret), refusing over-deep nesting:
```ts
  if ((job.subflowDepth ?? 0) > MAX_SUBFLOW_DEPTH) {
    throw new ApiError('Subflow nesting is too deep.', 400, 'SUBFLOW_DEPTH_EXCEEDED')
  }
```
     - Import the type: `import { interpretFlow, type RunAgentFn, type RunActionFn, type RunFlowFn } from './interpret'`.
     - Add the `runFlow` adapter next to `runAgent` (after the `runAgent` closure, ~line 350), mirroring its create-step→run→link→map pattern:
```ts
  // Adapter: each subflow node runs the child flow synchronously and records a
  // FlowRunStep linking the child run. Mirrors the runAgent adapter above.
  const runFlow: RunFlowFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: order++,
        status: 'running',
        input: jsonValue({ flowId: node.flowId, input: node.input }),
        startedAt: new Date(),
      },
    })
    const finishStep = async (data: Record<string, unknown>) => {
      await prisma.flowRunStep.updateMany({ where: { id: step.id, status: 'running' }, data })
    }
    try {
      const res = await runFlowExecution({
        flowId: node.flowId,
        organizationId: job.organizationId,
        userId: job.userId,
        input: node.input,
        usePublished: true,
        trigger: { type: 'signal', via: 'subflow' },
        subflowDepth: (job.subflowDepth ?? 0) + 1,
      })
      if (res.status === 'waiting') {
        await finishStep({ status: 'waiting', childFlowRunId: res.flowRunId, finishedAt: new Date() })
        return { waiting: { status: 'waiting' } }
      }
      if (res.status === 'failed') {
        await finishStep({ status: 'failed', childFlowRunId: res.flowRunId, error: 'The subflow failed.', finishedAt: new Date() })
        return { error: 'The subflow failed.' }
      }
      await finishStep({ status: 'succeeded', childFlowRunId: res.flowRunId, output: jsonValue(res.output), finishedAt: new Date() })
      return { output: res.output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finishStep({ status: 'failed', error: message.slice(0, 300), finishedAt: new Date() })
      return { error: message }
    }
  }
```
     - Thread it into the interpret call (line ~531):
```ts
  const result = await interpretFlow(graph, input, {
    runAgent,
    runAction,
    runFlow,
    onStep,
    ...(resuming ? { completed, resumeNodeId, resumeReply: job.reply } : {}),
  })
```
   Note: `shouldPersistInterpreterStep` governs the interpreter's `onStep` container persistence; the `subflow` adapter persists its own row (like `runAgent`/`runAction`), so `subflow` must be excluded from `shouldPersistInterpreterStep` (verify/update `src/features/flows/run-step-persistence.ts` so it is treated like `agent`/`tool`/`http` — adapter-persisted, not onStep-persisted, avoiding a duplicate row).

6. **Run — passes** (interpreter tests), `npx tsc --noEmit`, then a manual inline nested-flow run to confirm the child `FlowRunStep.childFlowRunId` link and blocked output.

7. **Commit:** `feat(flows): synchronous subflow node with child-run linking`.

---

## Task 9 — Copilot grounding for agent→flow + new node kinds

**Files:** `src/lib/flows/copilot-grounding.ts` (modify), `src/lib/flows/__tests__/flow-tool.test.ts` (append) or a small grounding test.

**Interfaces**
- Consumes: `loadFlowPlaneGroups` is DB-bound; the grounding uses a direct prisma query for agent-callable flows + the pure `flowToolGroundingLine`/`inputParamsFromGraph`/`outputFieldsFromGraph`.
- Produces: a "Callable flows (agent → flow)" section in `contextBlock`, and `graphRules` clauses describing `input`/`output`/`subflow`.

### Steps

1. **Write failing test** — append to `src/lib/flows/__tests__/flow-tool.test.ts`:
```ts
import { flowToolGroundingLine } from '../flow-tool'
test('flowToolGroundingLine renders a callable-flow signature', () => {
  const line = flowToolGroundingLine(
    { id: 'flw_1', name: 'Score Account' },
    [{ name: 'account', type: 'string', required: true }],
    [{ name: 'score', type: 'number' }],
  )
  assert.equal(line, '- Score Account (flowId: flw_1) inputs: account*:string outputs: score:number')
})
```
   (`flowToolGroundingLine` was added in Task 6; this pins its format for the grounding.)

2. **Run — passes** if Task 6 is in place (this test guards the grounding contract). If splitting strictly, write it first against the not-yet-used export.

3. **Implement** in `src/lib/flows/copilot-grounding.ts`:
   - Import: `import { inputParamsFromGraph, outputFieldsFromGraph, flowToolGroundingLine, isAgentCallableFlow } from '@/lib/flows/flow-tool'` and `import { flowGraphSchema } from '@/lib/flows/graph'`.
   - Extend the `graphRules` string: add `input, output, subflow` to the "Allowed node types" list and append these clauses before the closing sentence:
```
'Input node data: {params:[{name,type,required,default,description}]} declares the flow\'s typed callable parameters; type is one of string/number/boolean/object/array/any; read a param anywhere with {{input.<name>}}. A flow without an Input node keeps opaque {{trigger.input}}. ' +
'Output node data: {fields:[{name,type,value,description}]} declares the flow\'s typed return object; each value is a templated binding coerced to type; a flow without an Output node returns its last step output. ' +
'Subflow node data: {flowId,input,onError,outputFields}; flowId is a callable flow from the list below; input is a JSON object string mapping the child flow\'s input params to templated values; the step output is the child flow\'s output object (read {{step.<subflowNodeId>.output.<field>}}). Use a subflow inside a For each body to iterate a flow per item. ' +
```
   - In `buildCopilotGrounding`, fetch agent-callable flows in parallel with the existing `Promise.all` (add a third query), then render a callable-flows block:
```ts
  const callableFlows = await prisma.flow.findMany({
    where: { organizationId, status: 'ACTIVE' },
    select: { id: true, name: true, graph: true, publishedGraph: true, metadata: true },
    take: 50,
  })
  const flowLines = callableFlows
    .filter((flow) => isAgentCallableFlow(flow.metadata))
    .map((flow) => {
      const parsed = flowGraphSchema.safeParse(flow.publishedGraph ?? flow.graph)
      if (!parsed.success) return null
      return flowToolGroundingLine(flow, inputParamsFromGraph(parsed.data), outputFieldsFromGraph(parsed.data))
    })
    .filter((line): line is string => Boolean(line))
```
   Append to `contextBlock`:
```ts
    '',
    `Callable flows (agent -> flow, subflow):\n${flowLines.join('\n') || '- None available'}`,
```

4. **Run — passes** (`flow-tool.test.ts`), `npx tsc --noEmit`.

5. **Commit:** `feat(flows): ground the copilot in agent-callable flows + I/O/subflow nodes`.

---

## Final verification

- `npm test` (whole suite green — new tests + no regression in `interpret.test.ts`, `validate.test.ts`, `execute-flow-resume.test.ts`, `schema-fields.test.ts`).
- `npx tsc --noEmit` clean.
- Manual inline demo (`EXECUTION_MODE=inline`): (a) a flow with input+output nodes runs and returns its typed object; (b) an agent calls `flow_<slug>` and receives that object; (c) a parent flow with a `subflow` node blocks on the child's output and links `childFlowRunId`.
- Back-compat spot-check: an existing flow with no input/output node runs byte-identically (return value + step rows unchanged).

## Assumptions & where the real code differed from the spec

1. **Input param type vocabulary.** The spec (§3.1) writes `type: string|number|boolean|json`. The real codebase has no `json` type — it uses `FieldType = string|number|boolean|object|array|any` (`graph.ts`) for every datatree/output field. **Decision:** input params reuse `FieldType`; the spec's `json` maps to `object`/`array`/`any`. This keeps input params in the same type system as output fields and the existing schema-field derivation, at the cost of splitting "json" into object vs array (a strict improvement in precision).

2. **Coercion is a new function, not the variable coercion.** `interpret.ts` already has `coerceVariableValue` but over `VariableType` (`boolean|integer|float|string|object|array`), a *different* vocabulary (`integer`/`float` vs `number`). Rather than overload it, Task 2 adds a parallel `coerceFieldValue` over `FieldType`. Noted so a reviewer doesn't expect reuse.

3. **`user > webhook > default` precedence has no distinct webhook channel today.** The runtime passes a *single* merged `input` to `interpretFlow`; manual, API, and webhook runs all arrive via `job.input` → `ctx.trigger.input`. **Decision:** the pure `resolveInputParams` fully implements 3-way precedence and is unit-tested with distinct `user`/`webhook` sources; the interpreter sources `user` from `ctx.trigger.input` and `webhook` from a new optional `opts.webhookInput` seam. No current dispatcher populates `webhookInput`, so in practice precedence today reduces to `user > default` — the seam is in place for a webhook dispatcher to wire later (Track 1 does not add that plumbing, as it's outside the stated scope of the 5 items).

4. **Input defaults are literal, not templated.** For simplicity and pure-testability, an input param `default` is coerced as a literal string (not resolved against context). Variable `initialize` resolves its value template, but input defaults model a static fallback; noted in case a reviewer expects templated defaults.

5. **Org opt-in mechanism.** The spec says an org "toggles which flows are agent-callable ('Abilities'-style)" but specifies no field. `Flow.metadata` is an existing `Json?` grab-bag (used elsewhere, e.g. dismiss-suggestion route). **Decision:** the opt-in is `Flow.metadata.agentCallable === true`, read via a pure `isAgentCallableFlow`. No schema column is added for the toggle. A settings UI for it is out of scope (follow-up).

6. **Flow tool STEPS vs subflow.** `resolveFlowToolExecutor` gains a `'flow'` case so a deterministic tool node referencing `flow:<id>` would work, but the flow plane is intentionally **not** added to `loadFlowToolCatalog` — the builder's tool picker will not offer flows as tool-node connections. Flow→flow is the `subflow` node; agent→flow is the tool plane via `loadTools`. This avoids a second, overlapping authoring path. If a reviewer wants flow-tool-steps surfaced in the builder catalog, that's a small follow-on (add a flow branch to `loadFlowToolCatalog`).

7. **Queue mode is a degradation, not a feature.** With `EXECUTION_MODE=queue`, `dispatchFlowExecution` returns `{ queued }` and cannot be awaited, so agent→flow and flow-tool-step return an explicit "requires inline execution" error (spec §8). Synchronous `subflow` calls `runFlowExecution` **directly** (not `dispatchFlowExecution`), so it works in both modes. Track 1 targets inline prod (per MEMORY: `EXECUTION_MODE=inline` until the Render worker + Redis deploy).

8. **Child-run link needs a schema column.** `FlowRunStep` links agent runs via `agentExecutionId` but has no child-flow link. Task 8 adds `FlowRunStep.childFlowRunId String?` (migration). This is a real schema change inside Track 1's scope ("record a FlowRunStep linking the child run").

9. **Subflow recursion bound.** There's no existing depth field on `FlowExecutionJob` (the fire-and-forget signals path caps depth at 3 via the trigger payload). Task 8 adds `subflowDepth` to `FlowExecutionJob` + `MAX_SUBFLOW_DEPTH=5`. Direct self-reference cycles are caught by the depth cap (not a separate cycle set) — matching the signals precedent; a name-set cycle guard is deferred.

10. **Builder palette / React node UI is out of scope.** Spec §3.1 lists "the builder palette" as a touch point, but the task's 5 scope items are backend (interpreter, tool-planes, copilot). No exhaustive `never` switch on `node.type` exists in the runtime, so adding the node kinds does not break typecheck. Authoring the new nodes via the copilot (Task 9 grounding) or JSON works immediately; palette cards in `src/components/flows/node-types.ts`/`step-card.tsx` are a follow-up UI task, called out here so the plan is honest about what a user can click.

11. **`run-step-persistence` interaction.** The interpreter's `onStep` persists container/leaf outcomes per `shouldPersistInterpreterStep`; adapter-backed nodes (`agent`/`tool`/`http`) persist their own rows. The new `subflow` node is adapter-backed, so Task 8 verifies/updates `shouldPersistInterpreterStep` to exclude `subflow` (treat like `agent`) to avoid a duplicate step row. `input`/`output` nodes are *not* adapter-backed, so they persist via `onStep` like `transform`/`variable`/`data` (confirm they fall on the persisted side, or leave them non-persisted like `condition` — either is acceptable; the plan persists them as leaf outcomes for run-panel visibility).
