import { z } from 'zod'
import { Prisma } from '@/generated/prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { materializeAgent } from '@/lib/templates/materialize-agent'
import { DEFAULT_NEW_AGENT_GRANTS } from '@/lib/agents/grants'
import { encryptExternalAuth } from '@/lib/agents/external-agent'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { installRequiresSecret, parseDefinition } from '@/lib/store/listing'

export const runtime = 'nodejs'

const bodySchema = z.object({
  /** The installer's own credential for an authenticated external listing. */
  secret: z.string().max(4000).optional(),
  workerId: z.string().min(1).optional(),
  /** Apply the listing's current version to the agent this workspace already installed. */
  update: z.boolean().optional(),
  /** Overwrite an installed agent that was edited locally since install. */
  force: z.boolean().optional(),
})

const listingIdFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-2) ?? '')

/**
 * POST /api/store/[id]/install — a listing becomes a teammate on this roster.
 *
 * Native: the same materializeAgent a template takes, then the listing's own
 * grants and goal. External: an agent with runtime 'external' and a binding
 * to the PUBLISHER's endpoint with the INSTALLER's credential. Either way an
 * AgentInstall remembers the version, so an update can be offered later —
 * and refused when the agent was edited locally, unless forced.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const listingId = listingIdFrom(request.nextUrl.pathname)
  const body = bodySchema.parse(await request.json().catch(() => ({})))

  // systemPrisma: visibility is the scope (see /api/store GET).
  const listing = await systemPrisma.storeListing.findFirst({
    where: { id: listingId, isActive: true, OR: [{ visibility: 'public' }, { publisherOrganizationId: auth.organizationId }] },
  })
  if (!listing) throw new ApiError('Listing not found', 404, 'NOT_FOUND')
  const definition = parseDefinition(listing.definition)
  if (!definition) throw new ApiError('This listing cannot be installed', 400, 'BAD_DEFINITION')

  const existing = await prisma.agentInstall.findFirst({
    where: { organizationId: auth.organizationId, listingId: listing.id },
    include: { agentTask: { select: { id: true, updatedAt: true, status: true } } },
  })

  if (existing && existing.agentTask.status === 'ACTIVE') {
    if (!body.update) throw new ApiError('Already installed', 409, 'ALREADY_INSTALLED')
    if (existing.agentTask.updatedAt > existing.updatedAt && !body.force) {
      throw new ApiError('This agent was edited here since it was installed; pass force to overwrite those edits', 409, 'LOCAL_EDITS')
    }
    await applyDefinition(existing.agentTaskId, auth.organizationId, definition, body.secret)
    await prisma.agentInstall.updateMany({
      where: { id: existing.id, organizationId: auth.organizationId },
      data: { installedVersion: listing.version },
    })
    return { success: true, agentId: existing.agentTaskId, installedVersion: listing.version, updated: true }
  }

  if (installRequiresSecret(definition) && !body.secret) {
    throw new ApiError('This listing authenticates to its endpoint; provide your credential', 400, 'SECRET_REQUIRED')
  }

  let agentId: string
  if (definition.kind === 'native') {
    const n = definition.native
    agentId = await materializeAgent(
      {
        title: n.title, description: n.description, instructions: n.instructions, model: n.model ?? undefined,
        integrations: n.integrations, workerId: body.workerId ?? null,
        extraMetadata: n.outputFields.length ? { outputFields: n.outputFields, responseFormat: 'structured' } : {},
      },
      auth.organizationId,
      auth.dbUser.id,
    )
    // The listing's own grant and goal win over provisioning's defaults.
    await prisma.agentTask.updateMany({
      where: { id: agentId, organizationId: auth.organizationId },
      data: { goal: n.goal, grants: n.grants === null ? Prisma.DbNull : n.grants },
    })
  } else {
    const e = definition.external
    await assertPublicUrl(e.endpointUrl).catch((error) => {
      throw new ApiError(`The listing's endpoint was refused: ${error instanceof Error ? error.message : String(error)}`, 400, 'ENDPOINT_REFUSED')
    })
    const agent = await prisma.agentTask.create({
      data: {
        agentType: 'CUSTOM', runtime: 'external', description: e.description || e.title, objective: e.objective,
        schedule: { type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false }, status: 'ACTIVE', visibility: 'private',
        organizationId: auth.organizationId, userId: auth.dbUser.id, grants: DEFAULT_NEW_AGENT_GRANTS,
        ...(body.workerId ? { workerId: body.workerId } : {}),
        metadata: { title: e.title, description: e.description, integrations: [], skills: [], icon: '' },
      },
      select: { id: true },
    })
    agentId = agent.id
    await prisma.externalAgentBinding.create({
      data: {
        organizationId: auth.organizationId, agentTaskId: agentId, endpointUrl: e.endpointUrl, authType: e.authType,
        authConfig: encryptExternalAuth({ authType: e.authType, headerName: e.headerName, secret: body.secret }) as never,
        timeoutMinutes: e.timeoutMinutes,
      },
    })
  }

  await prisma.agentInstall.create({
    data: { organizationId: auth.organizationId, listingId: listing.id, agentTaskId: agentId, installedVersion: listing.version, installedById: auth.dbUser.id },
  })
  return { success: true, agentId, installedVersion: listing.version, updated: false }
}, { requires: 'member' })

/** Apply a listing's current definition to an installed agent (an update). */
async function applyDefinition(agentId: string, organizationId: string, definition: NonNullable<ReturnType<typeof parseDefinition>>, secret?: string) {
  if (definition.kind === 'native') {
    const n = definition.native
    const current = await prisma.agentTask.findFirst({ where: { id: agentId, organizationId }, select: { metadata: true } })
    const metadata = current?.metadata && typeof current.metadata === 'object' ? (current.metadata as Record<string, unknown>) : {}
    await prisma.agentTask.updateMany({
      where: { id: agentId, organizationId },
      data: {
        objective: n.instructions, goal: n.goal, grants: n.grants === null ? Prisma.DbNull : n.grants,
        description: n.description || n.title,
        // JSON round-trip: strips undefined and narrows unknown[] to what Prisma's InputJsonValue accepts.
        metadata: JSON.parse(JSON.stringify({ ...metadata, title: n.title, description: n.description, integrations: n.integrations, ...(n.model ? { model: n.model } : {}), outputFields: n.outputFields.length ? n.outputFields : undefined })) as never,
      },
    })
    return
  }
  const e = definition.external
  await assertPublicUrl(e.endpointUrl).catch((error) => {
    throw new ApiError(`The listing's endpoint was refused: ${error instanceof Error ? error.message : String(error)}`, 400, 'ENDPOINT_REFUSED')
  })
  const binding = await prisma.externalAgentBinding.findFirst({ where: { agentTaskId: agentId, organizationId } })
  const priorConfig = binding?.authConfig && typeof binding.authConfig === 'object' ? (binding.authConfig as Record<string, unknown>) : {}
  // The installer's credential is theirs: kept on update unless they supply a new one.
  const authConfig = secret
    ? encryptExternalAuth({ authType: e.authType, headerName: e.headerName, secret })
    : { ...priorConfig, ...(e.headerName ? { headerName: e.headerName } : {}) }
  await prisma.agentTask.updateMany({ where: { id: agentId, organizationId }, data: { objective: e.objective, description: e.description || e.title } })
  if (binding) {
    await prisma.externalAgentBinding.updateMany({ where: { id: binding.id, organizationId }, data: { endpointUrl: e.endpointUrl, authType: e.authType, authConfig: authConfig as never, timeoutMinutes: e.timeoutMinutes } })
  }
}
