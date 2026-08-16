import { prisma } from '@/lib/prisma'
import type { ToolDefinition } from '@/lib/llm/model-runner'
import type { CopilotTool } from '@/lib/llm/copilot-loop'
import { flowReadScope } from '@/lib/server/visibility'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { riskForNode } from '@/lib/flows/node-test-input'
import type { FlowGraph } from '@/lib/flows/graph'
import { redactedExcerpt } from '@/lib/llm/step-excerpt'

/**
 * Read-only lookups the flows copilot may make mid-turn. Executors are scoped
 * by organizationId + flowReadScope; a miss and a forbidden row return the
 * SAME shape so the model cannot probe other tenants or private flows.
 */

const short = (id: unknown) => String(id ?? '').slice(0, 8)

// Step rows are persisted unredacted for resume; redact on the way to the
// model. See redactedExcerpt for why this and redactSecrets are both needed.
const clipText = redactedExcerpt

export const EDIT_FLOW_TOOL: ToolDefinition = {
  name: 'edit_flow',
  description:
    'Apply edit operations to the current flow. Call this ONCE, at the end, when the user asked for a change. opsJson is a JSON string containing an ARRAY of edit-op objects (the op shapes are defined in your instructions); use "[]" with an explanatory message when you change nothing.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      message: {
        type: 'string',
        description: 'A short, friendly explanation of what you changed or what you need, mentioning node labels.',
      },
      opsJson: {
        type: 'string',
        description: 'A JSON string containing an ARRAY of edit-op objects. Use "[]" when making no changes.',
      },
      demoMocksJson: {
        type: 'string',
        description:
          'OPTIONAL demo run: a JSON string OBJECT keyed by node id, each value a realistic sample output for that step (match the tool\'s outputSchema when known). Provide it to run the flow end-to-end with sample data — cover every step whose connection is missing AND every write step so nothing real is sent. Omit when not offering a demo run.',
      },
      demoInputJson: {
        type: 'string',
        description: 'OPTIONAL, with demoMocksJson: a JSON string OBJECT of trigger input values for the demo run (fill the flow\'s required input fields with realistic samples).',
      },
    },
    required: ['message', 'opsJson'],
  },
}

export function buildFlowCopilotTools(input: {
  organizationId: string
  userId: string
  currentFlowId: string | null
  /** The graph being edited — grounds list_flow_connections. */
  graph?: FlowGraph
}): CopilotTool[] {
  const { organizationId, userId, currentFlowId, graph } = input
  const visibleFlow = (flowId: string) =>
    prisma.flow.findFirst({ where: { id: flowId, organizationId, ...flowReadScope(userId) }, select: { id: true } })

  return [
    {
      definition: {
        name: 'list_flow_runs',
        description:
          "Recent runs of a flow (newest first). Omit flowId for the flow being edited. Filter by status ('running' | 'succeeded' | 'failed' | 'waiting').",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            flowId: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] },
            limit: { type: ['number', 'null'], description: 'Max 20.' },
          },
          required: ['flowId', 'status', 'limit'],
        },
      },
      label: (args) => (args.flowId ? `Listing runs of flow ${short(args.flowId)}…` : 'Listing runs of this flow'),
      execute: async (args) => {
        const flowId = typeof args.flowId === 'string' && args.flowId ? args.flowId : currentFlowId
        if (!flowId) {
          return { error: 'This flow has not been saved yet, so it has no runs. Ask about a specific flowId from get_flow, or skip run inspection.' }
        }
        if (!(await visibleFlow(flowId))) return { error: 'Flow not found.' }
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20)
        const runs = await prisma.flowRun.findMany({
          where: {
            flowId,
            organizationId,
            ...(typeof args.status === 'string' && args.status ? { status: args.status } : {}),
          },
          orderBy: { startedAt: 'desc' },
          take: limit,
          select: { id: true, status: true, startedAt: true, finishedAt: true, error: true },
        })
        return {
          runs: runs.map((run) => ({
            id: run.id,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            error: run.error ? clipText(run.error, 300) : null,
          })),
        }
      },
    },
    {
      definition: {
        name: 'get_flow_run',
        description:
          'Per-node step results for one run: status, input/output excerpts, error. Use after list_flow_runs to see where a run went wrong.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { runId: { type: 'string' } },
          required: ['runId'],
        },
      },
      label: (args) => `Reading flow run ${short(args.runId)}…`,
      execute: async (args) => {
        const run = await prisma.flowRun.findFirst({
          where: { id: String(args.runId ?? ''), organizationId, flow: { ...flowReadScope(userId) } },
          include: { steps: { orderBy: { order: 'asc' } } },
        })
        if (!run) return { error: 'Run not found.' }
        return {
          id: run.id,
          status: run.status,
          error: run.error ?? null,
          steps: run.steps.map((step) => ({
            nodeId: step.nodeId,
            status: step.status,
            input: clipText(step.input, 800) || null,
            output: clipText(step.output, 800) || null,
            error: clipText(step.error, 800) || null,
          })),
        }
      },
    },
    {
      definition: {
        name: 'get_tool_schema',
        description:
          "A connected tool's input/output JSON schema — check exact argument names/types before wiring a tool node.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { connectionId: { type: 'string' }, toolName: { type: 'string' } },
          required: ['connectionId', 'toolName'],
        },
      },
      label: (args) => `Checking the ${String(args.toolName ?? 'tool')} schema…`,
      execute: async (args) => {
        const catalog = await loadFlowToolCatalog(organizationId, {
          userId,
          connectionIds: [String(args.connectionId ?? '')],
        })
        const connection = catalog.find((entry) => entry.id === String(args.connectionId ?? ''))
        const tool = connection?.tools.find((entry) => entry.name === String(args.toolName ?? ''))
        if (!tool) return { error: 'Tool not found.' }
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? null,
          outputSchema: tool.outputSchema ?? null,
          risk: tool.risk ?? null,
        }
      },
    },
    {
      definition: {
        name: 'list_flow_connections',
        description:
          "Connection health for the flow being edited: which steps' connections are live, unverified, or missing entirely, and which steps perform writes. Use before proposing a demo run (mock every missing-connection step and every write step) and when telling the user what to connect.",
        inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      },
      label: () => 'Checking this flow’s connections…',
      execute: async () => {
        const nodes = (graph?.nodes ?? []).filter(
          (node): node is Extract<FlowGraph['nodes'][number], { type: 'tool' | 'http' }> =>
            node.type === 'tool' || node.type === 'http',
        )
        const usedIds = Array.from(new Set(nodes.map((node) => node.data.connectionId).filter((id): id is string => Boolean(id))))
        const catalog = usedIds.length
          ? await loadFlowToolCatalog(organizationId, { userId, connectionIds: usedIds, takeConnections: usedIds.length }).catch(() => [])
          : []
        const byId = new Map(catalog.map((connection) => [connection.id, connection]))
        const labelOf = (node: { type: string; data: { label?: string } }) => node.data.label?.trim() || node.type
        return {
          steps: nodes.map((node) => {
            const connectionId = node.data.connectionId ?? null
            const connection = connectionId ? byId.get(connectionId) : undefined
            return {
              nodeId: node.id,
              label: labelOf(node),
              connectionId,
              connected: connectionId ? Boolean(connection) : node.type === 'http',
              verification: connection?.verification?.state ?? null,
              risk: riskForNode(node as FlowGraph['nodes'][number]),
            }
          }),
          writeSteps: (graph?.nodes ?? [])
            .filter((node) => riskForNode(node) !== 'read')
            .map((node) => ({ nodeId: node.id, label: (node.data as { label?: string }).label?.trim() || node.type })),
        }
      },
    },
    {
      definition: {
        name: 'get_flow',
        description: "Another visible flow's graph — to copy a working pattern or wire a subflow node.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { flowId: { type: 'string' } },
          required: ['flowId'],
        },
      },
      label: (args) => `Reading flow ${short(args.flowId)}…`,
      execute: async (args) => {
        const flow = await prisma.flow.findFirst({
          where: { id: String(args.flowId ?? ''), organizationId, ...flowReadScope(userId) },
          select: { id: true, name: true, description: true, graph: true, trigger: true, status: true },
        })
        if (!flow) return { error: 'Flow not found.' }
        return flow
      },
    },
  ]
}
