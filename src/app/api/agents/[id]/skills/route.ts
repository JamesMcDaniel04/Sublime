import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentWriteScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { getSkill } from '@/lib/skills/compose'

function agentIdFromRequest(request: Request): string {
  const parts = new URL(request.url).pathname.split('/')
  const raw = parts.at(-2) || ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Attach one valid built-in or published skill without overwriting other agent fields. */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const agentId = agentIdFromRequest(request)
  const { skillId } = z.object({ skillId: z.string().min(1) }).parse(await request.json())

  const skillExists = Boolean(getSkill(skillId)) || Boolean(await systemPrisma.sharedSkill.findFirst({
    where: { id: skillId, isActive: true },
    select: { id: true },
  }))
  if (!skillExists) throw new ApiError('Skill not found', 404, 'NOT_FOUND')

  const agent = await prisma.agentTask.findFirst({
    where: {
      id: agentId,
      organizationId: auth.organizationId,
      status: { not: 'DELETED' },
      ...agentWriteScope(auth.dbUser.id),
    },
    select: { id: true, metadata: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const metadata = readAgentMetadata(agent.metadata)
  const skills = Array.from(new Set([...(metadata.skills ?? []), skillId]))
  await prisma.agentTask.update({
    where: { id: agent.id, organizationId: auth.organizationId },
    data: { metadata: { ...metadata, skills } },
  })

  return { success: true, skills }
})
