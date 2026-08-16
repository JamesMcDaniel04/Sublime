import { prisma } from '@/lib/prisma'
import type { ToolDefinition } from '@/lib/llm/model-runner'
import type { CopilotTool } from '@/lib/llm/copilot-loop'
import { agentReadScope } from '@/lib/server/visibility'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { redactedExcerpt } from '@/lib/llm/step-excerpt'
import { loadRunDetail } from './assistant-context'

/**
 * Read-only lookups the agents copilot may make mid-turn. Every executor is
 * scoped by organizationId (and agentId where relevant); a miss and a
 * forbidden row return the SAME shape so the model cannot probe other orgs.
 */

const short = (id: unknown) => String(id ?? '').slice(0, 8)

// Step rows are persisted unredacted for replay; redact on the way to the
// model. See redactedExcerpt for why this and redactSecrets are both needed.
const clipText = redactedExcerpt

export const PROPOSE_CONFIG_TOOL: ToolDefinition = {
  name: 'propose_config_change',
  description:
    'Propose a configuration change for this agent. Call this ONCE, at the end, only when the user asked for a change. Fill only the fields that should change; the user reviews and confirms in the interface — never claim the change was applied.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', description: 'One sentence describing the change.' },
      title: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      instructions: { type: ['string', 'null'], description: 'Complete replacement instructions, not a diff.' },
      model: { type: ['string', 'null'] },
      integrations: { type: ['array', 'null'], items: { type: 'string' } },
      skills: { type: ['array', 'null'], items: { type: 'string' } },
      schedule: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['manual', 'hourly', 'daily', 'weekly', 'cron'] },
          time: { type: 'string', description: '24h HH:MM start time; empty string when not applicable.' },
          cron: { type: 'string', description: 'Cron expression; empty string unless type is "cron".' },
          timezone: { type: 'string', description: 'IANA timezone, e.g. UTC.' },
          isActive: { type: 'boolean' },
        },
        required: ['type', 'time', 'cron', 'timezone', 'isActive'],
      },
    },
    required: ['summary', 'title', 'description', 'instructions', 'model', 'integrations', 'skills', 'schedule'],
  },
}

export function buildAgentCopilotTools(input: {
  agentId: string
  organizationId: string
  userId: string
}): CopilotTool[] {
  const { agentId, organizationId, userId } = input
  return [
    {
      definition: {
        name: 'list_runs',
        description:
          "List this agent's recent runs (newest first). Filter by status ('completed' | 'failed' | 'running') and page with `before` (ISO timestamp).",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: ['string', 'null'] },
            limit: { type: ['number', 'null'], description: 'Max 20.' },
            before: { type: ['string', 'null'], description: 'ISO timestamp cursor.' },
          },
          required: ['status', 'limit', 'before'],
        },
      },
      label: () => 'Listing recent runs',
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20)
        const runs = await prisma.agentExecution.findMany({
          where: {
            agentTaskId: agentId,
            organizationId,
            ...(typeof args.status === 'string' && args.status ? { status: args.status } : {}),
            ...(typeof args.before === 'string' && args.before ? { startedAt: { lt: new Date(args.before) } } : {}),
          },
          omit: { transcript: true },
          orderBy: { startedAt: 'desc' },
          take: limit,
        })
        return {
          runs: runs.map((run) => ({
            id: run.id,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            completedAt: run.completedAt ? run.completedAt.toISOString() : null,
            error: clipText((run.metadata as Record<string, unknown> | null)?.error, 300) || null,
          })),
        }
      },
    },
    {
      definition: {
        name: 'get_run',
        description:
          'Full detail for one run of this agent: every step with tool calls (inputs/outputs/errors) and the run conversation. Use after list_runs to inspect a specific run.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { runId: { type: 'string' } },
          required: ['runId'],
        },
      },
      label: (args) => `Reading run ${short(args.runId)}…`,
      execute: async (args) => {
        const detail = await loadRunDetail(agentId, organizationId, String(args.runId ?? ''))
        return detail ?? { error: 'Run not found.' }
      },
    },
    {
      definition: {
        name: 'get_step_output',
        description:
          "One step's full input/output/error at a larger clip than get_run provides. Use when the get_run excerpt was truncated at the interesting part.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { runId: { type: 'string' }, stepId: { type: 'string' } },
          required: ['runId', 'stepId'],
        },
      },
      label: (args) => `Inspecting step ${short(args.stepId)} of run ${short(args.runId)}…`,
      execute: async (args) => {
        const step = await prisma.workflowStep.findFirst({
          where: {
            id: String(args.stepId ?? ''),
            executionId: String(args.runId ?? ''),
            execution: { agentTaskId: agentId, organizationId },
          },
        })
        if (!step) return { error: 'Step not found.' }
        return {
          tool: step.node,
          status: step.status,
          input: clipText(step.input, 4000) || null,
          output: clipText(step.output, 4000) || null,
          error: clipText(step.error, 4000) || null,
        }
      },
    },
    {
      definition: {
        name: 'get_tool_schema',
        description:
          "A connected tool's input/output JSON schema from the workspace tool catalog. Use to check whether a run's tool call arguments were malformed.",
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
        name: 'list_workspace_agents',
        description:
          'Other agents visible to this user in the workspace (id, title, schedule, integrations) — for comparing configuration with a sibling that works.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      },
      label: () => 'Listing workspace agents',
      execute: async () => {
        const agents = await prisma.agentTask.findMany({
          where: { organizationId, ...agentReadScope(userId) },
          orderBy: { updatedAt: 'desc' },
          take: 25,
        })
        return {
          agents: agents.map((agent) => {
            const metadata = readAgentMetadata(agent.metadata)
            return {
              id: agent.id,
              title: metadata.title || agent.description.slice(0, 80),
              status: agent.status,
              schedule: agent.schedule,
              integrations: metadata.integrations ?? [],
              model: metadata.model ?? null,
            }
          }),
        }
      },
    },
  ]
}
