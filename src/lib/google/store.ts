/**
 * Persistence for native Google OAuth connections. The refresh token is
 * AES-GCM encrypted at rest; every record keeps a NangoConnection mirror row
 * (provider 'google-native') so existing read paths stay unchanged.
 */
import { prisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import { recordConnectionAudit } from '@/lib/connections/audit'
import type { GoogleOAuthService } from './oauth'

export const GOOGLE_NATIVE_PROVIDER = 'google-native'

export async function upsertGoogleConnection(input: {
  organizationId: string
  userId: string
  service: GoogleOAuthService
  accountEmail: string
  scopes: string[]
  refreshToken: string
}): Promise<{ id: string }> {
  const refreshTokenEnc = encryptSecret(input.refreshToken)
  const result = await prisma.$transaction(async (tx) => {
    const record = await tx.googleOAuthConnection.upsert({
      where: {
        organizationId_userId_service_accountEmail: {
          organizationId: input.organizationId,
          userId: input.userId,
          service: input.service,
          accountEmail: input.accountEmail,
        },
      },
      create: {
        organizationId: input.organizationId,
        userId: input.userId,
        service: input.service,
        accountEmail: input.accountEmail,
        scopes: input.scopes,
        refreshTokenEnc,
      },
      update: { scopes: input.scopes, refreshTokenEnc, status: 'connected', lastError: null },
    })
    await tx.nangoConnection.upsert({
      where: { organizationId_connectionId: { organizationId: input.organizationId, connectionId: record.id } },
      create: {
        organizationId: input.organizationId,
        userId: input.userId,
        connectionId: record.id,
        providerConfigKey: input.service,
        provider: GOOGLE_NATIVE_PROVIDER,
        status: 'connected',
        metadata: { accountEmail: input.accountEmail },
      },
      update: { status: 'connected', lastError: null, metadata: { accountEmail: input.accountEmail } },
    })
    return { id: record.id }
  })

  // Audited HERE rather than in the callback route so that every writer of a
  // Google grant — current or future — is recorded without having to remember.
  // A re-auth records another grant row on purpose: re-consent can WIDEN
  // scopes, and an auditor needs the scope set as of each grant.
  await recordConnectionAudit({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: 'connection.granted',
    plane: 'google',
    provider: input.service,
    connectionId: result.id,
    accountLabel: input.accountEmail,
    scopes: input.scopes,
  })

  return result
}

/** Org scope is REQUIRED (tenant guard): callers always know the org. */
export async function getGoogleConnection(input: { organizationId: string; id: string }) {
  const record = await prisma.googleOAuthConnection.findFirst({
    where: { id: input.id, organizationId: input.organizationId },
  })
  if (!record) return null
  return {
    id: record.id,
    organizationId: record.organizationId,
    service: record.service,
    refreshToken: decryptSecret(record.refreshTokenEnc),
    status: record.status,
  }
}

export async function markGoogleConnectionError(input: { organizationId: string; id: string }, message: string): Promise<void> {
  await prisma.$transaction([
    prisma.googleOAuthConnection.updateMany({
      where: { id: input.id, organizationId: input.organizationId },
      data: { status: 'error', lastError: message },
    }),
    prisma.nangoConnection.updateMany({
      where: { organizationId: input.organizationId, connectionId: input.id, provider: GOOGLE_NATIVE_PROVIDER },
      data: { status: 'error', lastError: message },
    }),
  ])
}

export async function deleteGoogleConnection(input: { organizationId: string; id: string; actorUserId?: string | null }) {
  const record = await prisma.googleOAuthConnection.findFirst({
    where: { id: input.id, organizationId: input.organizationId },
  })
  if (!record) return null
  await prisma.$transaction([
    prisma.nangoConnection.deleteMany({
      where: { organizationId: input.organizationId, connectionId: record.id, provider: GOOGLE_NATIVE_PROVIDER },
    }),
    prisma.googleOAuthConnection.deleteMany({ where: { id: record.id, organizationId: input.organizationId } }),
  ])
  await recordConnectionAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? record.userId,
    action: 'connection.revoked',
    plane: 'google',
    provider: record.service,
    connectionId: record.id,
    accountLabel: record.accountEmail,
  })

  let refreshToken: string | null = null
  try {
    refreshToken = decryptSecret(record.refreshTokenEnc)
  } catch {
    // Undecryptable token (rotated key) — deletion already happened; revoke is skipped.
  }
  return { refreshToken, service: record.service }
}
