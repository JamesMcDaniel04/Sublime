import { z } from 'zod'
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { buildAuthConfig } from '@/lib/crypto/secrets'
import { getGranolaApiKey, testGranolaApiKey } from '@/lib/integrations/granola'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

async function granolaState(organizationId: string, userId: string) {
  const resolved = await getGranolaApiKey(organizationId, userId)
  return {
    configured: Boolean(resolved),
    source: resolved?.source ?? null,
  }
}

// ── GET — connection state (never returns the key) ────────────────────────

export const GET = withAuthenticatedApi(async (_request, auth) => {
  return { success: true, ...(await granolaState(auth.organizationId, auth.dbUser.id)) }
}, { requires: 'member' })

// ── POST — validate and save the user's Granola API key (encrypted) ──────

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { apiKey } = z
    .object({ apiKey: z.string().trim().min(1) })
    .parse(await request.json())

  const test = await testGranolaApiKey(apiKey)
  if (!test.ok) {
    if (test.status === 401 || test.status === 403) {
      throw new ApiError('Granola rejected that API key. Check the key and try again.', 400, 'INVALID_KEY')
    }
    throw new ApiError('Could not reach Granola to verify the key. Please try again.', 502, 'UPSTREAM_ERROR')
  }

  const authConfig = buildAuthConfig({ authType: 'api_key', apiKey }) as Prisma.InputJsonObject

  const secret = await prisma.integrationSecret.upsert({
    where: {
      organizationId_userId_provider: { organizationId: auth.organizationId, userId: auth.dbUser.id, provider: 'granola' },
    },
    update: { authType: 'api_key', authConfig, isActive: true },
    create: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      provider: 'granola',
      authType: 'api_key',
      authConfig,
      isActive: true,
    },
  })

  // On-connect learning leg (same as the OAuth connectors): start the notes
  // backfill the moment a working key lands. Fire-and-forget; the checkpoint
  // contract makes a re-save resume, not duplicate.
  void import('@/lib/activity/backfill')
    .then(({ startActivityBackfill }) =>
      startActivityBackfill({
        organizationId: auth.organizationId,
        source: 'granola',
        connectionRef: secret.id,
        window: '90d',
      }),
    )
    .catch(() => undefined)

  return { success: true, ...(await granolaState(auth.organizationId, auth.dbUser.id)) }
}, { requires: 'member' })

// ── DELETE — remove only the acting user's key ────────────────────────────

export const DELETE = withAuthenticatedApi(async (_request, auth) => {
  await prisma.integrationSecret.deleteMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, provider: 'granola' },
  })

  return { success: true, ...(await granolaState(auth.organizationId, auth.dbUser.id)) }
}, { requires: 'member' })
