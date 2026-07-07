import { z } from 'zod'

/** Comparison operators available to a condition node. */
export const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches'] as const
export type ConditionOp = (typeof CONDITION_OPS)[number]

/** Field types a step's output schema can declare (for the datatree picker). */
export const FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'any'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export const outputFieldSchema = z.object({ name: z.string(), type: z.enum(FIELD_TYPES).default('any') })
export type OutputField = z.infer<typeof outputFieldSchema>

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
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
    // Declared output schema — fields this step is expected to produce. Powers
    // the datatree field picker for downstream mapping.
    outputFields: z.array(outputFieldSchema).optional(),
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
    onError: z.enum(['stop', 'continue']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
  }),
})
// Plain HTTP request (webhook-out) step. URL/headers/body may use {{tokens}}.
const httpNode = z.object({
  id: z.string(),
  type: z.literal('http'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    url: z.string(),
    headers: z.string().optional(),
    body: z.string().optional(),
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
  }),
})
const parallelNode = z.object({
  id: z.string(),
  type: z.literal('parallel'),
  data: z.object({ label: z.string().optional(),
    note: z.string().optional(), branches: z.array(z.array(z.string())) }),
})

export const flowNodeSchema = z.discriminatedUnion('type', [triggerNode, agentNode, conditionNode, loopNode, parallelNode, stopNode, toolNode, httpNode])
export const flowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  branch: z.enum(['true', 'false']).optional(),
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
