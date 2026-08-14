import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { listSkills } from '@/lib/skills/compose'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'
import { entitlementPlanFor } from '@/lib/billing/entitlements'
import { memberDisplayName } from '@/lib/server/member-display'

const skillSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  category: z.string().max(40).default('Community'),
  instructions: z.string().min(1).max(20000),
  tags: z.array(z.string().max(30)).max(10).default([]),
  integrations: z.array(z.string().max(60)).max(10).default([]),
  visibility: z.enum(['private', 'organization', 'public']).optional(),
})

function serializeShared(
  skill: {
    id: string
    name: string
    description: string
    category: string
    instructions: string
    tags: unknown
    integrations: unknown
    authorName: string
    organizationId: string
    userId: string | null
    visibility: string
  },
  viewerOrgId: string,
  viewerUserId: string,
  viewerRole: string,
) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    audience: [] as string[],
    tags: Array.isArray(skill.tags) ? (skill.tags as string[]) : [],
    integrations: Array.isArray(skill.integrations) ? (skill.integrations as string[]) : [],
    authorName: skill.authorName,
    instructions: skill.instructions,
    visibility: skill.visibility,
    custom: true,
    mine: skill.userId === viewerUserId || (skill.organizationId === viewerOrgId && viewerRole === 'ADMIN'),
  }
}

// GET — built-ins plus private, workspace, and explicitly public skills.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  // systemPrisma is required for the explicitly public cross-org branch.
  const shared = await systemPrisma.sharedSkill.findMany({
    where: {
      isActive: true,
      OR: [
        { visibility: 'public' },
        { organizationId: auth.organizationId, visibility: 'organization' },
        { organizationId: auth.organizationId, userId: auth.dbUser.id, visibility: 'private' },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  return {
    success: true,
    skills: [
      ...shared.map((skill) => serializeShared(skill, auth.organizationId, auth.dbUser.id, auth.dbUser.role)),
      ...listSkills().map((skill) => ({ ...skill, visibility: 'built_in', custom: false, mine: false })),
    ],
  }
}, { requires: 'member' })

// POST — workspace-only by default; public publishing is always explicit.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = skillSchema.parse(await request.json())
  const planCapabilities = capabilitiesForPlan(entitlementPlanFor(auth.dbUser.organization))
  const visibility = data.visibility ?? 'private'
  if (planCapabilities.skillSharing === 'private' && visibility !== 'private') {
    throw new ApiError('Workspace and public skill sharing are available on Team plans and above.', 403, 'PLAN_LIMIT')
  }
  const skill = await prisma.sharedSkill.create({
    data: {
      ...data,
      visibility,
      // Was the publisher's raw email when no display name was set.
      authorName: memberDisplayName(auth.dbUser),
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    },
  })
  return { success: true, skill: serializeShared(skill, auth.organizationId, auth.dbUser.id, auth.dbUser.role) }
}, { requires: 'member' })

// PUT — edit your own community skill.
export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(skillSchema.partial()).parse(await request.json())
  if (body.visibility && capabilitiesForPlan(entitlementPlanFor(auth.dbUser.organization)).skillSharing === 'private' && body.visibility !== 'private') {
    throw new ApiError('Workspace and public skill sharing are available on Team plans and above.', 403, 'PLAN_LIMIT')
  }
  const ownerScope = auth.dbUser.role === 'ADMIN' ? {} : { userId: auth.dbUser.id }
  const existing = await prisma.sharedSkill.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, isActive: true, ...ownerScope },
  })
  if (!existing) throw new ApiError('Skill not found (you can only edit skills you published)', 404, 'NOT_FOUND')
  const { id, ...patch } = body
  // SECURITY FIX: the write itself was unscoped (relying only on the findFirst
  // ownership check above) — re-assert organizationId on the mutating query too.
  const skill = await prisma.sharedSkill.update({
    where: { id, organizationId: auth.organizationId },
    data: patch,
  })
  return { success: true, skill: serializeShared(skill, auth.organizationId, auth.dbUser.id, auth.dbUser.role) }
}, { requires: 'member' })

// DELETE — retract your own community skill (soft delete; agents referencing it
// simply stop composing it).
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const ownerScope = auth.dbUser.role === 'ADMIN' ? {} : { userId: auth.dbUser.id }
  const result = await prisma.sharedSkill.updateMany({
    where: { id, organizationId: auth.organizationId, ...ownerScope },
    data: { isActive: false },
  })
  if (!result.count) throw new ApiError('Skill not found (you can only remove skills you published)', 404, 'NOT_FOUND')
  return { success: true }
}, { requires: 'member' })
