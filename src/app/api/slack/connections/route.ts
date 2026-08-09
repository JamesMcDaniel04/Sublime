import { z } from 'zod'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { encryptSecretJson, serializeSlackConnection, slackAuthTest } from '@/lib/slack/connections'

const createSchema = z.object({
  botToken: z.string().min(1),
  signingSecret: z.string().min(1),
})

// ── GET — list org bindings (redacted) ────────────────────────────────────
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const connections = await prisma.slackWorkspaceConnection.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
    orderBy: { createdAt: 'desc' },
  })
  return { success: true, connections: connections.map(serializeSlackConnection) }
}, { requires: 'member' })

// ── POST — create/refresh a binding ───────────────────────────────────────
export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = createSchema.parse(await request.json())
  // Verify the token against Slack and capture the workspace identity —
  // a bad token never reaches the database.
  let identity: Awaited<ReturnType<typeof slackAuthTest>>
  try {
    identity = await slackAuthTest(data.botToken)
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Slack token verification failed', 400, 'SLACK_AUTH_FAILED')
  }
  const secrets = {
    teamName: identity.teamName,
    botUserId: identity.botUserId,
    botToken: encryptSecretJson(data.botToken) as unknown as Prisma.InputJsonValue,
    signingSecret: encryptSecretJson(data.signingSecret) as unknown as Prisma.InputJsonValue,
    status: 'active',
  }
  const connection = await prisma.slackWorkspaceConnection.upsert({
    where: { organizationId_userId_teamId: { organizationId: auth.organizationId, userId: auth.dbUser.id, teamId: identity.teamId } },
    create: { organizationId: auth.organizationId, userId: auth.dbUser.id, teamId: identity.teamId, ...secrets },
    update: secrets,
  })
  return { success: true, connection: serializeSlackConnection(connection) }
}, { requires: 'member' })

// ── DELETE — remove a binding (and its thread sessions) ──────────────────
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const url = new URL(request.url)
  const id = url.searchParams.get('id') || z.object({ id: z.string().min(1) }).parse(await request.json()).id
  const existing = await prisma.slackWorkspaceConnection.findFirst({ where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id } })
  if (!existing) throw new ApiError('Slack connection not found', 404, 'NOT_FOUND')
  await prisma.slackThreadSession.deleteMany({ where: { organizationId: auth.organizationId, bindingId: existing.id } })
  await prisma.slackWorkspaceConnection.delete({ where: { id: existing.id, organizationId: auth.organizationId, userId: auth.dbUser.id } })
  return { success: true }
}, { requires: 'member' })
