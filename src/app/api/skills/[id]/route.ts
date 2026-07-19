import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { getSkill } from '@/lib/skills/compose'
import { recommendTemplatesForSkill } from '@/lib/skills/recommend'
import { SEED_CATALOGUE, serializeSeed } from '@/lib/templates/catalogue'
import { decodeSkillRouteId } from '@/lib/skills/route-id'

function skillIdFromRequest(request: Request): string {
  const raw = new URL(request.url).pathname.split('/').at(-1) || ''
  return decodeSkillRouteId(raw)
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = skillIdFromRequest(request)
  const builtIn = getSkill(id)
  const shared = builtIn
    ? null
    : await systemPrisma.sharedSkill.findFirst({
        where: {
          id,
          isActive: true,
          OR: [
            { visibility: 'public' },
            { organizationId: auth.organizationId, visibility: 'organization' },
            { organizationId: auth.organizationId, userId: auth.dbUser.id, visibility: 'private' },
          ],
        },
      })
  const sharedSkill = shared ? {
    id: shared.id,
    name: shared.name,
    description: shared.description,
    category: shared.category,
    audience: [] as string[],
    tags: Array.isArray(shared.tags) ? shared.tags as string[] : [],
    integrations: Array.isArray(shared.integrations) ? shared.integrations as string[] : [],
    instructions: shared.instructions,
    visibility: shared.visibility,
    custom: true,
    // Only the creating org may edit/delete its community skills — same rule as
    // the /api/skills list route.
    mine: shared.userId === auth.dbUser.id || (shared.organizationId === auth.organizationId && auth.dbUser.role === 'ADMIN'),
  } : null
  const skill = builtIn ? { ...builtIn, visibility: 'built_in', custom: false, mine: false } : sharedSkill
  if (!skill) throw new ApiError('Skill not found', 404, 'NOT_FOUND')

  const templates = recommendTemplatesForSkill(skill, SEED_CATALOGUE, 4).map(serializeSeed)
  return { success: true, skill, templates }
})
