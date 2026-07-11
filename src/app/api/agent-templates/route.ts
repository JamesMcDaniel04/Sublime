import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.string().default('Custom'),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  model: z.string().default('gpt-4o'),
  exampleOutput: z.string().optional(),
  icon: z.string().trim().max(8).optional(),
  allowSubagents: z.boolean().optional(),
})

function serializeTemplate(template: any, viewerOrgId?: string) {
  const config = template.configuration && typeof template.configuration === 'object' ? template.configuration as any : {}
  return {
    id: template.id,
    name: template.name,
    description: template.description || '',
    category: template.type,
    instructions: config.instructions || template.description || '',
    integrations: config.integrations || [],
    skills: config.skills || [],
    tags: config.tags || [],
    model: config.model || 'gpt-4o',
    exampleOutput: config.exampleOutput || '',
    icon: config.icon || '',
    allowSubagents: config.allowSubagents === true,
    custom: true,
    authorName: config.authorName || '',
    // Only the creating org may edit/delete a community template.
    mine: Boolean(viewerOrgId) && template.organizationId === viewerOrgId,
  }
}

const builtInTemplates: Array<Record<string, unknown>> = []

export const GET = withAuthenticatedApi(async (request, auth) => {
  // Community templates are a PUBLIC library: readable by every workspace,
  // writable only by the creator's org (PUT/DELETE below stay org-scoped).
  // systemPrisma: cross-org read by design — same exemption as /api/skills GET.
  const stored = await systemPrisma.agentTemplate.findMany({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  const templates = [
    ...builtInTemplates.map((t) => ({ ...t, custom: false, mine: false })),
    ...stored.map((t) => serializeTemplate(t, auth.organizationId)),
  ]
  const limit = Number(request.nextUrl.searchParams.get('limit'))
  return { success: true, templates: limit > 0 ? templates.slice(0, limit) : templates }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = templateSchema.parse(await request.json())
  const template = await prisma.agentTemplate.create({
    data: {
      name: data.name,
      description: data.description,
      type: data.category,
      configuration: {
        instructions: data.instructions,
        integrations: data.integrations,
        skills: data.skills,
        tags: data.tags,
        model: data.model,
        ...(data.exampleOutput ? { exampleOutput: data.exampleOutput } : {}),
        ...(data.icon ? { icon: data.icon } : {}),
        ...(data.allowSubagents ? { allowSubagents: true } : {}),
        authorName: auth.dbUser.name || auth.dbUser.email || '',
      },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })
  return { success: true, template: serializeTemplate(template, auth.organizationId) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(templateSchema.partial()).parse(await request.json())
  const existing = await prisma.agentTemplate.findFirst({
    where: { id: body.id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  const config = (existing.configuration && typeof existing.configuration === 'object' ? existing.configuration : {}) as any
  const template = await prisma.agentTemplate.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.category !== undefined && { type: body.category }),
      configuration: {
        ...config,
        ...(body.instructions !== undefined && { instructions: body.instructions }),
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...(body.skills !== undefined && { skills: body.skills }),
        ...(body.tags !== undefined && { tags: body.tags }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.exampleOutput !== undefined && { exampleOutput: body.exampleOutput }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.allowSubagents !== undefined && { allowSubagents: body.allowSubagents }),
      },
    },
  })
  return { success: true, template: serializeTemplate(template, auth.organizationId) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.agentTemplate.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (!result.count) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  return { success: true }
})
