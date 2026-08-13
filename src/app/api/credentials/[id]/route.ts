import type { Prisma } from '@/generated/prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { withElevatedAccess } from '@/lib/server/elevated'
import { mergeCredentialConfig, redactCredential } from '@/lib/credentials/config'
import { credentialScope } from '@/lib/credentials/resolve'
import { invalidateOAuth2Token } from '@/lib/credentials/oauth2'
import type { CredentialType } from '@/lib/credentials/types'
import { normalizeAllowedDomains } from '@/lib/credentials/plan'
import { credentialInputSchema } from '../route'

export const runtime = 'nodejs'

// GET/PUT/DELETE /api/credentials/[id] — always redacted on read. An update
// merges: omit a secret field to keep the stored one, so editing a header name
// doesn't force re-entering the key.

const idFrom = (pathname: string) => pathname.split('/').at(-1)

const updateSchema = credentialInputSchema.partial({ type: true }).extend({
  name: z.string().min(1).optional(),
  allowedDomains: z.array(z.string()).min(1, 'Add at least one allowed domain.').optional(),
})

/** In-scope row or 404 — never confirm a cross-org id exists. */
async function ownedCredential(id: string, organizationId: string) {
  const row = await prisma.credential.findFirst({
    where: { id, ...credentialScope(organizationId) },
    select: {
      id: true, name: true, type: true, authConfig: true, allowedDomains: true, lastUsedAt: true, updatedAt: true,
      // Provenance — who added it. Not an ownership fence for READS (any
      // member may list and use it), but it decides whether MUTATING it is a
      // cross-owner act. See mutableBy below.
      createdById: true, userId: true,
    },
  })
  if (!row) throw new ApiError('Credential not found', 404, 'NOT_FOUND')
  return row
}

type CredentialProvenance = { id: string; name: string; createdById: string | null; userId: string | null }

/**
 * Run a credential mutation, elevating when it targets a credential somebody
 * else added.
 *
 * Credentials are workspace resources: everyone can SEE and USE them. That is
 * deliberate — it is what keeps keys out of personal environments. But "shared
 * use" is not "shared authority": silently re-pointing a colleague's
 * production credential at another host, or deleting it out from under the
 * flows that depend on it, is a cross-owner act, and cross-owner acts in this
 * codebase go through withElevatedAccess so they are gated AND recorded
 * together (see elevated.ts — one code path, one audit row).
 *
 * A pre-vault row with no recorded author (createdById and userId both null)
 * belongs to the workspace rather than to a person, so it is admin-only to
 * mutate: nobody can claim it by having been the last to touch it.
 */
async function withCredentialMutation<T>(
  auth: Parameters<Parameters<typeof withAuthenticatedApi>[0]>[1],
  credential: CredentialProvenance,
  action: 'admin.resource.update',
  fn: () => Promise<T>,
): Promise<T> {
  const author = credential.createdById ?? credential.userId
  if (author && author === auth.dbUser.id) return fn()
  return withElevatedAccess(
    auth,
    { action, resourceType: 'credential', resourceId: credential.id, targetUserId: author, detail: { name: credential.name } },
    fn,
  )
}

const shape = (row: {
  id: string
  name: string
  type: string
  authConfig: unknown
  allowedDomains: string[]
}) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  allowedDomains: row.allowedDomains,
  config: redactCredential(row.type, row.authConfig),
})

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Credential id is required')
  return { success: true, credential: shape(await ownedCredential(id, auth.organizationId)) }
}, { requires: 'member' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Credential id is required')
  const existing = await ownedCredential(id, auth.organizationId)
  const input = updateSchema.parse(await request.json().catch(() => ({})))
  return withCredentialMutation(auth, existing, 'admin.resource.update', async () => {
    const allowedDomains = input.allowedDomains ? normalizeAllowedDomains(input.allowedDomains) : undefined
    if (input.allowedDomains && !allowedDomains?.length) throw new ApiError('Allowed domains must be valid hostnames.', 400, 'INVALID_ALLOWED_DOMAINS')

    // A type change re-keys which fields are secret, so the config is rebuilt
    // from scratch rather than merged — merging across types would leave the old
    // type's encrypted fields orphaned in the blob.
    // Prisma types `type` as string; the row was written through the same
    // validated enum, so narrowing here is safe.
    const type = (input.type ?? existing.type) as CredentialType
    const changingType = input.type !== undefined && input.type !== existing.type
    const authConfig = changingType
      ? mergeCredentialConfig({}, { ...input, type })
      : mergeCredentialConfig(existing.authConfig as Record<string, unknown>, { ...input, type })

    if (input.name && input.name !== existing.name) {
      const clash = await prisma.credential.findFirst({
        where: { organizationId: auth.organizationId, name: input.name, isActive: true, id: { not: id } },
        select: { id: true },
      })
      if (clash) throw new ApiError('A credential with that name already exists in this workspace.', 409, 'DUPLICATE_NAME')
    }

    await prisma.credential.updateMany({
      where: { id, organizationId: auth.organizationId },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(allowedDomains ? { allowedDomains } : {}),
        authConfig: authConfig as Prisma.InputJsonValue,
      },
  })
  // An OAuth2 client-credentials token minted from the OLD secret must not
  // keep authorizing requests until it happens to expire.
  invalidateOAuth2Token(id)
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'credential.update',
    resourceType: 'credential',
    resourceId: id,
    detail: { name: input.name ?? existing.name, type },
  })
  return { success: true, credential: shape(await ownedCredential(id, auth.organizationId)) }
  })
}, { requires: 'member' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Credential id is required')
  const existing = await ownedCredential(id, auth.organizationId)
  return withCredentialMutation(auth, existing, 'admin.resource.update', async () => {
    await prisma.credential.deleteMany({ where: { id, organizationId: auth.organizationId } })
    invalidateOAuth2Token(id)
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'credential.delete',
      resourceType: 'credential',
      resourceId: id,
      detail: { name: existing.name, type: existing.type },
    })
    return { success: true }
  })
}, { requires: 'member' })
