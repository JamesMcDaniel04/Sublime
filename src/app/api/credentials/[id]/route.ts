import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { mergeCredentialConfig, redactCredential } from '@/lib/credentials/config'
import { credentialScope } from '@/lib/credentials/resolve'
import { invalidateOAuth2Token } from '@/lib/credentials/oauth2'
import type { CredentialType } from '@/lib/credentials/types'
import { credentialInputSchema } from '../route'

export const runtime = 'nodejs'

// GET/PUT/DELETE /api/credentials/[id] — always redacted on read. An update
// merges: omit a secret field to keep the stored one, so editing a header name
// doesn't force re-entering the key.

const idFrom = (pathname: string) => pathname.split('/').at(-1)

const updateSchema = credentialInputSchema.partial({ type: true }).extend({
  name: z.string().min(1).optional(),
  personal: z.boolean().optional(),
  allowedDomains: z.array(z.string()).optional(),
})

/** In-scope row or 404 — never confirm a cross-org id exists. */
async function ownedCredential(id: string, organizationId: string, userId: string) {
  const row = await prisma.credential.findFirst({
    where: { id, ...credentialScope(organizationId, userId) },
    select: { id: true, name: true, type: true, authConfig: true, allowedDomains: true, userId: true, lastUsedAt: true, updatedAt: true },
  })
  if (!row) throw new ApiError('Credential not found', 404, 'NOT_FOUND')
  return row
}

const shape = (row: {
  id: string
  name: string
  type: string
  authConfig: unknown
  allowedDomains: string[]
  userId: string | null
}) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  allowedDomains: row.allowedDomains,
  personal: row.userId !== null,
  config: redactCredential(row.type, row.authConfig),
})

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Credential id is required')
  return { success: true, credential: shape(await ownedCredential(id, auth.organizationId, auth.dbUser.id)) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Credential id is required')
  const existing = await ownedCredential(id, auth.organizationId, auth.dbUser.id)
  const input = updateSchema.parse(await request.json().catch(() => ({})))

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
    const userId = input.personal === undefined ? existing.userId : input.personal ? auth.dbUser.id : null
    const clash = await prisma.credential.findFirst({
      where: { organizationId: auth.organizationId, userId, name: input.name, id: { not: id } },
      select: { id: true },
    })
    if (clash) throw new ApiError('A credential with that name already exists.', 409, 'DUPLICATE_NAME')
  }

  await prisma.credential.updateMany({
    where: { id, organizationId: auth.organizationId },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
      ...(input.personal !== undefined ? { userId: input.personal ? auth.dbUser.id : null } : {}),
      authConfig,
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
  return { success: true, credential: shape(await ownedCredential(id, auth.organizationId, auth.dbUser.id)) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Credential id is required')
  const existing = await ownedCredential(id, auth.organizationId, auth.dbUser.id)
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
