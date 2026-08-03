import { prisma } from '@/lib/prisma'
import type { ToolDefinition } from '@/lib/llm/model-runner'
import type { CopilotTool } from '@/lib/llm/copilot-loop'
import { flowReadScope } from '@/lib/server/visibility'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'

/**
 * Read-only lookups the flows copilot may make mid-turn. Executors are scoped
 * by organizationId + flowReadScope; a miss and a forbidden row return the
 * SAME shape so the model cannot probe other tenants or private flows.
 */

const short = (id: unknown) => String(id ?? '').slice(0, 8)

function clipText(value: unknown, max: number): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

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
    },
    required: ['message', 'opsJson'],
  },
}

export function buildFlowCopilotTools(input: {
  organizationId: string
  userId: string
  currentFlowId: string | null
}): CopilotTool[] {
  const { organizationId, userId, currentFlowId } = input
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
