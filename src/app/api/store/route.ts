import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope } from '@/lib/server/visibility'
import { containsSecretKey, installRequiresSecret, parseDefinition, slugify, snapshotDefinition, updateAvailable } from '@/lib/store/listing'

export const runtime = 'nodejs'

const publishSchema = z.object({
  agentId: z.string().min(1),
  slug: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  visibility: z.enum(['organization', 'public']).default('organization'),
})

/**
 * GET /api/store — listings this workspace may install: everything public,
 * plus its own. Each carries this workspace's install state so the UI can
 * offer Install, Installed, or Update without a second call.
 *
 * systemPrisma: StoreListing has no organizationId — public listings are
 * cross-workspace by design — so the visibility clause IS the scope.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [listings, installs] = await Promise.all([
    systemPrisma.storeListing.findMany({
      where: { isActive: true, OR: [{ visibility: 'public' }, { publisherOrganizationId: auth.organizationId }] },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: { publisher: { select: { id: true, name: true } } },
    }),
    prisma.agentInstall.findMany({
      where: { organizationId: auth.organizationId },
      select: { listingId: true, agentTaskId: true, installedVersion: true },
    }),
  ])
  const installByListing = new Map(installs.map((row) => [row.listingId, row]))
  return {
    success: true,
    listings: listings.flatMap((row) => {
      const definition = parseDefinition(row.definition)
      if (!definition) return []
      const install = installByListing.get(row.id) ?? null
      return [{
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        category: row.category,
        kind: row.kind,
        visibility: row.visibility,
        version: row.version,
        updatedAt: row.updatedAt,
        publisher: row.publisher,
        mine: row.publisherOrganizationId === auth.organizationId,
        requiresSecret: installRequiresSecret(definition),
        integrations: definition.kind === 'native' ? definition.native.integrations : [],
        endpointHost: definition.kind === 'external' ? safeHost(definition.external.endpointUrl) : null,
        install: install
          ? { agentTaskId: install.agentTaskId, installedVersion: install.installedVersion, updateAvailable: updateAvailable(install.installedVersion, row.version) }
          : null,
      }]
    }),
  }
}, { requires: 'member' })

/**
 * POST /api/store — publish an agent as a package, or re-publish to bump its
 * version. The owner may publish to their workspace; making a listing PUBLIC
 * is an admin's call, because it puts the workspace's name on something
 * every other workspace can install.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = publishSchema.parse(await request.json())
  if (body.visibility === 'public' && !auth.isAdmin) {
    throw new ApiError('Only a workspace admin can publish to every workspace', 403, 'FORBIDDEN')
  }
  const agent = await prisma.agentTask.findFirst({
    where: { id: body.agentId, organizationId: auth.organizationId, status: 'ACTIVE', agentType: { not: 'SYSTEM' }, ...agentReadScope(auth.dbUser.id) },
    include: { externalBinding: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  if (agent.userId !== auth.dbUser.id && !auth.isAdmin) {
    throw new ApiError('Only the agent owner can publish it', 403, 'FORBIDDEN')
  }

  let definition
  try {
    definition = snapshotDefinition(agent, agent.externalBinding)
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Cannot publish this agent', 400, 'NOT_PUBLISHABLE')
  }
  // The invariant, asserted rather than trusted: a listing never stores a secret.
  if (containsSecretKey(definition)) throw new ApiError('Refusing to publish a definition that carries a secret', 500, 'SECRET_IN_DEFINITION')

  const name = body.name ?? (definition.kind === 'native' ? definition.native.title : definition.external.title)
  const slug = body.slug ?? slugify(name)
  const description = body.description ?? (definition.kind === 'native' ? definition.native.description : definition.external.description)

  // systemPrisma: the listing model carries no organizationId (see GET); the
  // publisher id is this workspace's own, so the write is still tenant-bound.
  const existing = await systemPrisma.storeListing.findUnique({
    where: { publisherOrganizationId_slug: { publisherOrganizationId: auth.organizationId, slug } },
    select: { id: true, version: true },
  })
  const listing = existing
    ? await systemPrisma.storeListing.update({
        where: { id: existing.id },
        data: {
          name, description, kind: definition.kind, visibility: body.visibility,
          ...(body.category ? { category: body.category } : {}),
          definition: definition as never, sourceAgentTaskId: agent.id, publishedById: auth.dbUser.id,
          version: existing.version + 1, isActive: true,
        },
      })
    : await systemPrisma.storeListing.create({
        data: {
          publisherOrganizationId: auth.organizationId, slug, name, description, kind: definition.kind,
          visibility: body.visibility, category: body.category ?? 'Community',
          definition: definition as never, sourceAgentTaskId: agent.id, publishedById: auth.dbUser.id,
        },
      })
  return { success: true, listing: { id: listing.id, slug: listing.slug, name: listing.name, kind: listing.kind, visibility: listing.visibility, version: listing.version } }
}, { requires: 'member' })

function safeHost(url: string): string {
  try { return new URL(url).host } catch { return url }
}
