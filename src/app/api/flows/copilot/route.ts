import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { generateStructured } from '@/lib/llm/model-runner'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { readAgentMetadata } from '@/lib/agents/metadata'

// JSON-schema the model must fill: a graph of nodes + edges. Kept loose here
// (objects) and tightened by flowGraphSchema.parse afterwards.
const GRAPH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    nodes: { type: 'array', items: { type: 'object' } },
    edges: { type: 'array', items: { type: 'object' } },
  },
  required: ['nodes', 'edges'],
  additionalProperties: false,
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { description } = z.object({ description: z.string().min(1) }).parse(await request.json())
  const agents = await prisma.agentTask.findMany({
    where: { organizationId: auth.organizationId, status: 'ACTIVE', ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, description: true, metadata: true },
    take: 100,
  })
  const roster = agents
    .map((agent) => ({ id: agent.id, name: readAgentMetadata(agent.metadata).title || agent.description }))
    .filter((entry) => entry.name)

  const system =
    'You design agent pipelines as a JSON graph. Nodes: trigger (exactly one, id "trigger"); agent ' +
    '(data.agentId MUST be an id from the roster; data.input may reference {{trigger.input}}, {{step.<nodeId>.output}}, {{item}}); ' +
    'condition (data: left, op in [eq,neq,gt,gte,lt,lte,contains,matches], right); loop (data: over, concurrency, body=[nodeIds]); ' +
    'parallel (data: branches=[[nodeIds]]). Edges connect node ids; a condition edge has branch "true"/"false". ' +
    'Only use agents from the roster. Return ONLY the graph object.'
  const user = `Roster:\n${roster.map((entry) => `- ${entry.name} (id: ${entry.id})`).join('\n')}\n\nBuild a flow that: ${description}`

  try {
    const raw = await generateStructured({ system, user, schema: GRAPH_JSON_SCHEMA, schemaName: 'flow_graph', maxTokens: 2000 })
    const candidate = flowGraphSchema.parse(JSON.parse(raw))
    // Drop agent nodes that reference an unknown agent id, then prune dangling edges.
    const ids = new Set(roster.map((entry) => entry.id))
    const nodes = candidate.nodes.filter((node) => node.type !== 'agent' || ids.has(node.data.agentId))
    const keep = new Set(nodes.map((node) => node.id))
    const edges = candidate.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target))
    return { success: true, graph: { nodes, edges } }
  } catch {
    return { success: true, graph: emptyGraph() }
  }
})
