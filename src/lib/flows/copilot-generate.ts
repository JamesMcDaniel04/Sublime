/**
 * Server-side flow-graph generation, extracted from the `/api/flows/copilot`
 * route so other server callers (behavioral-intelligence workflow synthesis)
 * can generate a runnable draft graph without going through HTTP.
 *
 * Owns the generate -> validate -> repair loop; callers own everything
 * upstream of it (grounding/system+user prompt construction) and everything
 * downstream (turning a graph into a response or a Flow row).
 */
import { generateStructured } from '@/lib/llm/model-runner'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import { normalizeGeneratedFlowGraphInput, repairGeneratedFlowGraph, validationIssuesForModel } from '@/lib/flows/copilot'
import { validateFlowGraph, type FlowValidationResult } from '@/lib/flows/validate'
import type { FlowToolCatalogConnection } from '@/lib/flows/tool-catalog'

// Anthropic strict structured outputs can't express a free-form object
// ({type:'object'} with no declared properties collapses to {} under
// additionalProperties:false), and node/edge shapes vary too much per node
// type to enumerate as a strict schema. So the model returns the whole graph
// as a JSON STRING inside a wrapper object, and we JSON.parse that string
// ourselves — see parseGeneratedGraphReply below.
const GRAPH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    graphJson: {
      type: 'string',
      description: 'The complete flow graph as a JSON string: {"nodes": [...], "edges": [...]}',
    },
  },
  required: ['graphJson'],
  additionalProperties: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Tolerantly extract the graph object from a structured-output reply shaped
 * as {graphJson: "..."}. Strips ```json fences from the inner string before
 * parsing. Falls back to treating the raw reply itself as the graph JSON
 * (pre-wrapper shape) for backward safety, in case the model ever emits the
 * graph directly instead of through the string wrapper.
 */
function parseGeneratedGraphReply(raw: string): unknown {
  const outer = JSON.parse(raw)
  const graphJson = isRecord(outer) ? outer.graphJson : undefined
  if (typeof graphJson !== 'string') return outer
  const trimmed = graphJson.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return JSON.parse(fenced ? fenced[1].trim() : trimmed)
}

export type GenerateFlowGraphResult = {
  graph: FlowGraph
  validation: FlowValidationResult
  needsAttention: { nodeId?: string; message: string }[]
}

/**
 * Generate (or repair) a flow graph from a system/user prompt pair, with up
 * to two automatic repair rounds against the validator. Throws on
 * unrecoverable errors (bad JSON, schema mismatch, LLM failure) — callers
 * decide how to degrade (the interactive route returns {success:false}; the
 * background synthesizer just logs and skips creating a draft flow).
 */
export async function generateFlowGraph(params: {
  system: string
  user: string
  roster: { id: string; name: string }[]
  toolCatalog: FlowToolCatalogConnection[]
}): Promise<GenerateFlowGraphResult> {
  const { system, user, roster, toolCatalog } = params
  const validationContext = {
    agents: roster.map((agent) => ({ id: agent.id, title: agent.name })),
    toolCatalog,
  }

  const raw = await generateStructured({ system, user, schema: GRAPH_JSON_SCHEMA, schemaName: 'flow_graph', maxTokens: 3500, cacheSystem: true })
  let graph = repairGeneratedFlowGraph(flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(parseGeneratedGraphReply(raw))), { agents: roster, toolCatalog })
  let validation = validateFlowGraph(graph, { ...validationContext, requireRunnable: graph.nodes.length > 1 })

  for (let round = 0; round < 2 && !validation.ok; round += 1) {
    const repairUser = [
      user,
      '',
      'The graph below did not pass validation. Return a corrected full graph object that fixes every error while preserving the user request.',
      '',
      `Validation errors:\n${validationIssuesForModel(validation)}`,
      '',
      `Broken graph:\n${JSON.stringify(graph)}`,
    ].join('\n')
    const repairedRaw = await generateStructured({ system, user: repairUser, schema: GRAPH_JSON_SCHEMA, schemaName: 'flow_graph_repair', maxTokens: 3500, cacheSystem: true })
    graph = repairGeneratedFlowGraph(flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(parseGeneratedGraphReply(repairedRaw))), { agents: roster, toolCatalog })
    validation = validateFlowGraph(graph, { ...validationContext, requireRunnable: graph.nodes.length > 1 })
  }

  const needsAttention = [...validation.errors, ...validation.warnings].map((issue) => ({ nodeId: issue.nodeId, message: issue.message }))
  return { graph, validation, needsAttention }
}
