import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { toPortableAgent } from '@/lib/export/portable'
import { toAgentInstructions } from '@/lib/export/instructions'

export const runtime = 'nodejs'

/**
 * GET /api/agents/<id>/export?target=portable|instructions
 *
 * Read access is enough — if you can open a shared agent you can take a copy.
 * An agent is instructions + a model, both of which port anywhere; its tool
 * connections do NOT travel and are listed as requirements instead.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const target = request.nextUrl.searchParams.get('target') ?? 'portable'
  if (target !== 'portable' && target !== 'instructions') {
    throw new ApiError(`Unknown export target "${target}"`, 400, 'UNKNOWN_TARGET')
  }

  const row = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, status: { not: 'DELETED' }, ...agentReadScope(auth.dbUser.id) },
    select: { id: true, description: true, objective: true, goal: true, metadata: true },
  })
  if (!row) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const metadata = readAgentMetadata(row.metadata)
  const title = metadata.title || row.description.split('\n')[0] || 'Untitled agent'
  const doc = toPortableAgent(
    { id: row.id, title, instructions: row.objective, goal: row.goal, model: metadata.model, integrations: metadata.integrations || [] },
    new Date().toISOString(),
  )
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'

  if (target === 'instructions') {
    return new NextResponse(toAgentInstructions(doc), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug}-instructions.md"`,
      },
    })
  }
  return new NextResponse(JSON.stringify(doc, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}.sublime-agent.json"`,
    },
  })
})
