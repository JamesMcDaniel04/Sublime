import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope, agentReadScope } from '@/lib/server/visibility'
import { flowGraphSchema } from '@/lib/flows/graph'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { toPortableFlow } from '@/lib/export/portable'
import { toInstructions } from '@/lib/export/instructions'
import { toN8nWorkflow } from '@/lib/export/n8n'
import { toWorkatoRecipe } from '@/lib/export/workato'
import { toPowerAutomateFlow } from '@/lib/export/power-automate'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const TARGETS = ['portable', 'n8n', 'workato', 'power-automate', 'instructions'] as const
type Target = (typeof TARGETS)[number]

const isTarget = (value: string): value is Target => (TARGETS as readonly string[]).includes(value)

/**
 * GET /api/flows/<id>/export?target=portable|n8n|workato|power-automate|instructions
 *
 * Read access is enough to export — if you can open a shared flow you can take a
 * copy of it. Credentials never travel (see lib/export/portable), so an export
 * cannot leak more than the builder already shows you.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const target = request.nextUrl.searchParams.get('target') ?? 'portable'
  if (!isTarget(target)) throw new ApiError(`Unknown export target "${target}"`, 400, 'UNKNOWN_TARGET')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { name: true, description: true, trigger: true, graph: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const graph = flowGraphSchema.parse(flow.graph)
  // Inline only the agents this graph actually references — and only ones the
  // caller may read, so an export can never widen access to someone else's agent.
  const agentIds = [
    ...new Set(
      graph.nodes
        .filter((node) => node.type === 'agent')
        .map((node) => (node.data as { agentId?: string }).agentId)
        .filter((agentId): agentId is string => Boolean(agentId)),
    ),
  ]
  const rows = agentIds.length
    ? await prisma.agentTask.findMany({
        where: { id: { in: agentIds }, organizationId: auth.organizationId, ...agentReadScope(auth.dbUser.id) },
        select: { id: true, description: true, objective: true, goal: true, metadata: true },
      })
    : []
  const agents = rows.map((row) => {
    const metadata = readAgentMetadata(row.metadata)
    return {
      id: row.id,
      title: metadata.title || row.description.split('\n')[0] || 'Untitled agent',
      instructions: row.objective,
      goal: row.goal,
      model: metadata.model,
      integrations: metadata.integrations || [],
    }
  })

  const portable = toPortableFlow({ name: flow.name, description: flow.description, trigger: flow.trigger, graph }, agents, new Date().toISOString())
  const slug = (flow.name || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow'

  if (target === 'instructions') {
    return new NextResponse(toInstructions(portable), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug}-instructions.md"`,
      },
    })
  }
  // Each target converts the SAME sanitized portable doc — redaction can never
  // be skipped by adding a new target. The deployment origin makes agent steps
  // export as RUNNABLE HTTP calls to their live trigger endpoints (the secret
  // itself is never exported — the user pastes it in the target tool).
  const triggerBaseUrl = request.nextUrl.origin
  const BY_TARGET = {
    n8n: { body: () => toN8nWorkflow(portable, { triggerBaseUrl }), suffix: '.n8n' },
    workato: { body: () => toWorkatoRecipe(portable, { triggerBaseUrl }), suffix: '.workato' },
    'power-automate': { body: () => toPowerAutomateFlow(portable, { triggerBaseUrl }), suffix: '.power-automate' },
    portable: { body: () => portable, suffix: '.sublime' },
  } as const
  const chosen = BY_TARGET[target as keyof typeof BY_TARGET] ?? BY_TARGET.portable
  return new NextResponse(JSON.stringify(chosen.body(), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}${chosen.suffix}.json"`,
    },
  })
})
