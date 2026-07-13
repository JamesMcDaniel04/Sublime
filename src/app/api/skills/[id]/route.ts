import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { getSkill } from '@/lib/skills/compose'
import { recommendTemplatesForSkill } from '@/lib/skills/recommend'
import { SEED_CATALOGUE, serializeSeed } from '@/lib/templates/catalogue'

function skillIdFromRequest(request: Request): string {
  const raw = new URL(request.url).pathname.split('/').at(-1) || ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export const GET = withAuthenticatedApi(async (request) => {
  const id = skillIdFromRequest(request)
  const builtIn = getSkill(id)
  const shared = builtIn
    ? null
    : await systemPrisma.sharedSkill.findFirst({ where: { id, isActive: true } })
  const skill = builtIn ?? (shared ? {
    id: shared.id,
    name: shared.name,
    description: shared.description,
    category: shared.category,
    audience: [] as string[],
    tags: Array.isArray(shared.tags) ? shared.tags as string[] : [],
    integrations: [] as string[],
    instructions: shared.instructions,
  } : null)
  if (!skill) throw new ApiError('Skill not found', 404, 'NOT_FOUND')

  const templates = recommendTemplatesForSkill(skill, SEED_CATALOGUE, 4).map(serializeSeed)
  return { success: true, skill, templates }
})
