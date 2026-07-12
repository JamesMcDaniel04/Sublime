import { z } from 'zod'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'

/** Comparison operators available to a condition node. */
export const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches'] as const
export type ConditionOp = (typeof CONDITION_OPS)[number]

/** Plain-english operator labels — the ONLY strings the UI may show for ops. */
export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  matches: 'matches pattern',
}

/** Field types a step's output schema can declare (for the datatree picker). */
export const FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'any'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export const outputFieldSchema = z.object({ name: z.string(), type: z.enum(FIELD_TYPES).default('any'), description: z.string().optional() })
export type OutputField = z.infer<typeof outputFieldSchema>

/** A trigger input field: an OutputField plus whether the run must supply it. */
export const triggerInputFieldSchema = outputFieldSchema.extend({ required: z.boolean().optional() })
export type TriggerInputField = z.infer<typeof triggerInputFieldSchema>

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

const triggerNode = z.object({
  id: z.string(),
  type: z.literal('trigger'),
  data: z.object({ trigger: z.any().optional() }),
})
const agentNode = z.object({
  id: z.string(),
  type: z.literal('agent'),
  data: z.object({
    agentId: z.string(),
    label: z.string().optional(),
    note: z.string().optional(),
    input: z.string().optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    // Per-step reliability: retry the agent up to `retries` times with backoff,
    // and abort a single attempt after `timeoutMs`.
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(AGENT_RUN_TIMEOUT_MS).optional(),
    // Declared output schema — fields this step is expected to produce. Powers
    // the datatree field picker for downstream mapping.
    outputFields: z.array(outputFieldSchema).optional(),
    // Agent response contract: 'structured' appends a JSON instruction built
    // from outputFields and fails the step when the reply can't be parsed.
    responseFormat: z.enum(['text', 'structured']).optional(),
    // MS-parity "request human assistance when unsure": when false, a step
    // that pauses to ask a human fails instead of waiting.
    humanAssistance: z.boolean().optional(),
    // Inline-prompt mode: when agentId is blank, the step runs this prompt as an
    // ephemeral one-shot model call (no saved AgentTask). model overrides the
    // default; ignored when agentId is set (a saved agent brings its own model).
    prompt: z.string().optional(),
    model: z.string().optional(),
  }),
})
/** One left/op/right comparison; a condition ANDs/ORs a list of these. */
export const conditionClauseSchema = z.object({ left: z.string(), op: z.enum(CONDITION_OPS), right: z.string() })
const conditionNode = z.object({
  id: z.string(),
  type: z.literal('condition'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    // Multi-criteria: evaluate `clauses` with all (AND) / any (OR). The legacy
    // single left/op/right is still accepted and treated as a one-clause AND.
    match: z.enum(['all', 'any']).optional(),
    clauses: z.array(conditionClauseSchema).optional(),
    left: z.string().optional(),
    op: z.enum(CONDITION_OPS).optional(),
    right: z.string().optional(),
  }),
})
// Ends the flow early with an optional message.
const stopNode = z.object({
  id: z.string(),
  type: z.literal('stop'),
  data: z.object({ label: z.string().optional(), reason: z.string().optional(), note: z.string().optional() }),
})
// Deterministic single MCP tool call against an org connection — no LLM in the
// loop. `args` is a JSON object literal whose string values may use {{tokens}}.
const toolNode = z.object({
  id: z.string(),
  type: z.literal('tool'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    connectionId: z.string(),
    toolName: z.string(),
    args: z.string().optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
  }),
})
// Plain HTTP request (webhook-out) step. URL/headers/body may use {{tokens}}.
// `connectionId` optionally names an MCP connection whose fresh OAuth token is
// injected as the Authorization header at fetch time — the token itself never
// enters the graph, run rows, or logs.
const httpNode = z.object({
  id: z.string(),
  type: z.literal('http'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    connectionId: z.string().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    url: z.string(),
    query: z.string().optional(),
    headers: z.string().optional(),
    body: z.string().optional(),
    cookie: z.string().optional(),
    bodyMode: z.enum(['json', 'text', 'none']).optional(),
    responseType: z.enum(['auto', 'json', 'text']).optional(),
    failOnHttpError: z.boolean().optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
  }),
})
const loopNode = z.object({
  id: z.string(),
  type: z.literal('loop'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    over: z.string(),
    concurrency: z.number().int().min(1).max(20).optional(),
    body: z.array(z.string()),
    // Loop-thread: keep ONE agent conversation across iterations (multi-turn
    // batch memory) instead of a fresh conversation each item. Forces sequential
    // execution (concurrency 1) — you cannot thread one conversation concurrently.
    threadAgent: z.boolean().optional(),
  }),
})
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
// Deterministic "Set fields": build an object from templated assignments. Its
// output is the assembled object; downstream steps map its fields.
const transformNode = z.object({
  id: z.string(),
  type: z.literal('transform'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    // `value` templates are resolved; JSON-looking results are parsed.
    fields: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
    outputFields: z.array(outputFieldSchema).optional(),
  }),
})
// Gate: continues only when the condition passes, else stops the flow (or, in a
// loop body, drops the current item from the collected results).
const filterNode = z.object({
  id: z.string(),
  type: z.literal('filter'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    match: z.enum(['all', 'any']).optional(),
    clauses: z.array(conditionClauseSchema).optional(),
  }),
})
// Multi-way branch: the first case whose condition matches routes to its edge
// (branch=case id); an unmatched signal follows the `default` edge.
const switchNode = z.object({
  id: z.string(),
  type: z.literal('switch'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    cases: z.array(z.object({ id: z.string(), label: z.string().optional(), left: z.string(), op: z.enum(CONDITION_OPS), right: z.string() })).default([]),
  }),
})

/** Operations a variable step can perform on the flow's symbol table. */
export const VARIABLE_OPS = ['initialize', 'set', 'increment', 'decrement', 'appendArray', 'appendString'] as const
export type VariableOp = (typeof VARIABLE_OPS)[number]
/** Types an Initialize variable step can declare (MS Copilot Studio parity). */
export const VARIABLE_TYPES = ['boolean', 'integer', 'float', 'string', 'object', 'array'] as const
export type VariableType = (typeof VARIABLE_TYPES)[number]
/** Display names for variable ops — the ONLY strings surfaces may show for them. */
export const VARIABLE_OP_LABELS: Record<VariableOp, string> = {
  initialize: 'Initialize variable',
  set: 'Set variable',
  increment: 'Increment variable',
  decrement: 'Decrement variable',
  appendArray: 'Append to array variable',
  appendString: 'Append to string variable',
}
/** Display names for variable types (the stored values stay lowercase). */
export const VARIABLE_TYPE_LABELS: Record<VariableType, string> = {
  boolean: 'Boolean',
  integer: 'Integer',
  float: 'Float',
  string: 'String',
  object: 'Object',
  array: 'Array',
}
// Typed symbol table step: initialize declares a variable (varType applies to
// initialize only, default 'string'); the other ops mutate one initialized
// earlier. `value` is templated; readable anywhere via {{var.<name>}}.
const variableNode = z.object({
  id: z.string(),
  type: z.literal('variable'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    op: z.enum(VARIABLE_OPS),
    name: z.string(),
    varType: z.enum(VARIABLE_TYPES).optional(),
    value: z.string().optional(),
  }),
})

/** Pure transforms a data operation step can perform (MS Data Operation parity). */
export const DATA_OPS = ['compose', 'parseJson', 'join', 'csvTable', 'htmlTable', 'filterArray', 'select'] as const
export type DataOp = (typeof DATA_OPS)[number]
// Deterministic data-shaping step between other steps: no LLM, no I/O. `input`
// is templated (usually an exact {{step.x.output}} token so structure survives);
// the op-specific extras are: `separator` (join), `schema` (parseJson — stored
// for the editor, not yet enforced), `clauses` (filterArray, evaluated per item
// against {{item.*}}), `fields` (select's per-item name/value mappings).
// NOTE: the existing `transform`/`filter` node types stay untouched; `data`
// supersedes them for new graphs (picker copy steers — Task 4).
const dataNode = z.object({
  id: z.string(),
  type: z.literal('data'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    op: z.enum(DATA_OPS),
    input: z.string().optional(),
    separator: z.string().optional(),
    schema: z.string().optional(),
    clauses: z.array(conditionClauseSchema).optional(),
    fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  }),
})

// MS-parity "Request information" (human review): a first-class pause with no
// agent involved. The flow stops, asks `message` (templated) of a person, and
// the reply becomes this step's output. `assigneeUserId` routes the
// needs-input notification; unset means the run's owner is asked.
const humanReviewNode = z.object({
  id: z.string(),
  type: z.literal('humanReview'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    message: z.string(),
    assigneeUserId: z.string().optional(),
  }),
})

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

export const flowNodeSchema = z.discriminatedUnion('type', [
  triggerNode, agentNode, conditionNode, loopNode, parallelNode, stopNode, toolNode, httpNode, transformNode, filterNode, switchNode, variableNode, dataNode, humanReviewNode, inputNode, outputNode, subflowNode, routerNode, errorShieldNode,
])
export const flowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  // 'true'/'false' for a condition; a switch case id or 'default' for a switch.
  branch: z.string().optional(),
})
export const flowGraphSchema = z.object({ nodes: z.array(flowNodeSchema), edges: z.array(flowEdgeSchema) })

export type FlowNode = z.infer<typeof flowNodeSchema>
export type FlowEdge = z.infer<typeof flowEdgeSchema>
export type FlowGraph = z.infer<typeof flowGraphSchema>
export type ConditionClause = z.infer<typeof conditionClauseSchema>

/** A fresh graph: one manual trigger, no steps yet. */
export function emptyGraph(): FlowGraph {
  return { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }], edges: [] }
}
