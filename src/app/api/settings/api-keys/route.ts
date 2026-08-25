import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { generateApiKey, normalizeScopes, API_SCOPES, API_KEY_PREFIX } from '@/lib/api-keys/keys'

/**
 * Managing the workspace's API keys.
 *
 * Admin-only (`settings:workspace`): a key grants standing, non-interactive
 * access to the workspace's automation, which is a bigger grant than most
 * things a member can do through the UI.
 *
 * The plaintext is returned exactly once, at creation. There is no endpoint
 * that reveals it later, because none can exist — only the hash is kept.
 */

const createSchema = z.object({
  action: z.literal('create'),
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string()).min(1),
  /** Days until it stops working. Absent means it does not expire. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})

const revokeSchema = z.object({
  action: z.literal('revoke'),
  id: z.string().min(1),
})

const bodySchema = z.discriminatedUnion('action', [createSchema, revokeSchema])

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const keys = await prisma.apiKey.findMany({
    where: { organizationId: auth.organizationId },
    select: {
      id: true, name: true, prefix: true, scopes: true,
      lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return {
    success: true,
    // `hash` is deliberately absent from the select above. It is not secret in
    // the way the key is — it cannot be reversed — but publishing it would let
    // anyone who reads this response verify guesses offline at their leisure.
    keys: keys.map((key) => ({
      ...key,
      // What a key looks like in a list, so a leaked key can be matched to a
      // row by sight and revoked.
      display: `${API_KEY_PREFIX}${key.prefix}…`,
      status: key.revokedAt ? 'revoked'
        : key.expiresAt && key.expiresAt <= new Date() ? 'expired'
        : 'active',
    })),
    availableScopes: API_SCOPES,
  }
}, { requires: 'settings:workspace' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json())

  if (body.action === 'revoke') {
    // Scoped by organization: an id alone must never be enough to revoke
    // another workspace's key.
    const updated = await prisma.apiKey.updateMany({
      where: { id: body.id, organizationId: auth.organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    if (updated.count === 0) throw new ApiError('Key not found.', 404, 'NOT_FOUND')

    await recordAudit({
      organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
      action: 'api_key.revoked', resourceType: 'api_key', resourceId: body.id,
    })
    return { success: true }
  }

  const scopes = normalizeScopes(body.scopes)
  // Refused rather than silently narrowed: a key created with a typo'd scope
  // would fail later at the point of use, somewhere far from this decision.
  if (scopes.length === 0) {
    throw new ApiError('None of those scopes are recognised.', 400, 'INVALID_SCOPES')
  }

  const generated = generateApiKey()
  const created = await prisma.apiKey.create({
    data: {
      organizationId: auth.organizationId,
      createdById: auth.dbUser.id,
      name: body.name,
      prefix: generated.prefix,
      hash: generated.hash,
      scopes,
      ...(body.expiresInDays
        ? { expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000) }
        : {}),
    },
    select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, createdAt: true },
  })

  await recordAudit({
    organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
    action: 'api_key.created', resourceType: 'api_key', resourceId: created.id,
    detail: { name: body.name, scopes },
  })

  return {
    success: true,
    key: created,
    // The only time this is ever returned. There is no way to retrieve it
    // again, which the client must tell the user before they navigate away.
    plaintext: generated.plaintext,
    warning: 'Copy this key now — it cannot be shown again.',
  }
}, { requires: 'settings:workspace' })
