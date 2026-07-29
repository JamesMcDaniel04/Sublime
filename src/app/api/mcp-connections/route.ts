import { z } from 'zod'
import { credentialScope } from '@/lib/credentials/resolve'
import { Prisma } from '@prisma/client'
import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  buildAuthConfig,
  mergeAuthConfig,
  redactConfig,
} from '@/lib/crypto/secrets'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { cacheDelete } from '@/lib/cache'
import { scanConnection, purgeConnectionLearnings } from '@/lib/intelligence/connection-scan'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { assertIntegrationCapacity } from '@/lib/billing/enforce'

// Mirror of execute-agent's toolDiscoveryCacheKey (org-scoped) — kept in sync
// deliberately; busting it makes a connection edit take effect before the TTL.
const toolDiscoveryCacheKey = (organizationId: string, serverUrl: string) => `mcptools:${organizationId}:${serverUrl}`

/** SSRF guard for a user-supplied URL field; rejects private/internal targets. */
async function requirePublicUrl(url: string | undefined, field: string): Promise<void> {
  if (!url) return
  try {
    await assertPublicUrl(url)
  } catch (error) {
    if (error instanceof SsrfError) throw new ApiError(`${field} is not allowed: ${error.message}`, 400, 'INVALID_URL')
    throw error
  }
}

// ── Zod schema ───────────────────────────────────────────────────────────

const mcpConnectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  serverUrl: z.string().url(),
  authType: z.enum(['none', 'api_key', 'oauth2']).default('none'),
  // api_key fields — an inline key, or a vault Credential backing it
  apiKey: z.string().optional(),
  credentialId: z.string().optional(),
  headerName: z.string().optional(),
  // oauth2 fields
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  tokenUrl: z.string().optional(),
  scopes: z.string().optional(),
  // common
  isActive: z.boolean().optional(),
})

// ── Serialiser (redacts secrets) ─────────────────────────────────────────

function serializeConnection(conn: {
  id: string
  organizationId: string
  provider: string | null
  userId: string | null
  name: string
  description: string | null
  serverUrl: string
  authType: string
  authConfig: unknown
  isActive: boolean
  lastVerifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: conn.id,
    organizationId: conn.organizationId,
    provider: conn.provider,
    userId: conn.userId,
    name: conn.name,
    description: conn.description,
    serverUrl: conn.serverUrl,
    isActive: conn.isActive,
    lastVerifiedAt: conn.lastVerifiedAt,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    auth: redactConfig(conn.authType, conn.authConfig),
  }
}

// ── GET — list org's connections ─────────────────────────────────────────

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const connections = await prisma.mcpConnection.findMany({
    where: {
      organizationId: auth.organizationId,
      OR: [
        { userId: auth.dbUser.id },
        // Only platform-managed service rows are workspace-wide. User-added
        // credentials are always personal and never fall back across members.
        { userId: null, provider: { not: null } },
      ],
    },
    orderBy: { createdAt: 'desc' },
  })

  return {
    success: true,
    connections: connections.map(serializeConnection),
  }
}, { requires: 'member' })

/**
 * A referenced credential must belong to the caller before it is stored: the
 * id travels in a request body, and an unchecked one would let a connection
 * point at another tenant's secret.
 */
async function assertOwnedCredential(credentialId: string | undefined, organizationId: string, userId: string) {
  if (!credentialId) return
  const owned = await prisma.credential.findFirst({
    where: { id: credentialId, ...credentialScope(organizationId, userId) },
    select: { id: true },
  })
  if (!owned) throw new ApiError('That credential is not available to this workspace.', 404, 'NOT_FOUND')
}

// ── POST — create a connection ────────────────────────────────────────────

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = mcpConnectionSchema.parse(await request.json())
  await assertIntegrationCapacity(auth.organizationId)
  await requirePublicUrl(data.serverUrl, 'serverUrl')
  await requirePublicUrl(data.tokenUrl, 'tokenUrl')

  await assertOwnedCredential(data.credentialId, auth.organizationId, auth.dbUser.id)

  const authConfig = buildAuthConfig({
    authType: data.authType,
    apiKey: data.apiKey,
    credentialId: data.credentialId,
    headerName: data.headerName,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    tokenUrl: data.tokenUrl,
    scopes: data.scopes,
  })

  const connection = await prisma.mcpConnection.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      name: data.name,
      description: data.description ?? null,
      serverUrl: data.serverUrl,
      authType: data.authType,
      authConfig: authConfig as Prisma.InputJsonValue,
      isActive: data.isActive ?? true,
    },
  })

  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'connection_added', resourceType: 'connection', resourceId: connection.id,
    context: { provider: connection.provider ?? connection.name },
  })

  // Fire-and-forget usage scan (api-key/none connections are already fully
  // authorized at create time — oauth2 connections through this endpoint are
  // set up via the separate oauth start/callback flow, which scans on its own
  // success path). `after` (Next 15) keeps this alive past the response.
  if (connection.isActive && (data.authType === 'api_key' || data.authType === 'none')) {
    const organizationId = auth.organizationId
    const userId = auth.dbUser.id
    const connectionRef = connection.id
    const connectionName = connection.name
    after(() =>
      scanConnection({ organizationId, userId, plane: 'mcp', connectionRef, connectionName }).catch(() => undefined),
    )
  }

  return { success: true, connection: serializeConnection(connection) }
}, { requires: 'member' })

// ── PUT — update a connection ─────────────────────────────────────────────

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z
    .object({ id: z.string().min(1) })
    .merge(mcpConnectionSchema.partial())
    .parse(await request.json())

  const existing = await prisma.mcpConnection.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, userId: auth.dbUser.id },
  })
  if (!existing) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
  if (existing.provider) {
    throw new ApiError('This connection is managed by the platform and cannot be edited or deleted.', 403, 'PROVIDER_MANAGED')
  }

  await requirePublicUrl(body.serverUrl, 'serverUrl')
  await requirePublicUrl(body.tokenUrl, 'tokenUrl')

  // Merge authConfig: preserve secrets not provided in this update
  const existingConfig =
    existing.authConfig &&
    typeof existing.authConfig === 'object' &&
    !Array.isArray(existing.authConfig)
      ? (existing.authConfig as Record<string, unknown>)
      : {}

  await assertOwnedCredential(body.credentialId, auth.organizationId, auth.dbUser.id)

  const newAuthType = body.authType ?? existing.authType
  const authConfig = mergeAuthConfig(existingConfig, {
    authType: newAuthType as 'none' | 'api_key' | 'oauth2',
    apiKey: body.apiKey,
    credentialId: body.credentialId,
    headerName: body.headerName,
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    tokenUrl: body.tokenUrl,
    scopes: body.scopes,
  })

  const connection = await prisma.mcpConnection.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.serverUrl !== undefined && { serverUrl: body.serverUrl }),
      authType: newAuthType,
      authConfig: authConfig as Prisma.InputJsonValue,
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  })

  // Bust cached tool discovery so a changed serverUrl/auth is picked up now,
  // not after the TTL.
  await cacheDelete(toolDiscoveryCacheKey(auth.organizationId, existing.serverUrl))
  if (body.serverUrl && body.serverUrl !== existing.serverUrl) {
    await cacheDelete(toolDiscoveryCacheKey(auth.organizationId, body.serverUrl))
  }

  return { success: true, connection: serializeConnection(connection) }
}, { requires: 'member' })

// ── DELETE — remove a connection ──────────────────────────────────────────

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  // Support id in JSON body or query param
  let id: string | undefined

  const url = new URL(request.url)
  const queryId = url.searchParams.get('id')

  if (queryId) {
    id = queryId
  } else {
    const body = z
      .object({ id: z.string().min(1) })
      .parse(await request.json())
    id = body.id
  }

  const existing = await prisma.mcpConnection.findFirst({
    where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id },
  })
  if (!existing) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
  if (existing.provider) {
    throw new ApiError('This connection is managed by the platform and cannot be edited or deleted.', 403, 'PROVIDER_MANAGED')
  }

  await prisma.mcpConnection.delete({ where: { id: existing.id, organizationId: auth.organizationId } })

  // Pairs with connection_added: without a removal event the ledger treats a
  // churned connector as permanently held, and correlation mining over-counts
  // integrations nobody kept.
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'connection_removed', resourceType: 'connection', resourceId: existing.id,
    context: { provider: existing.provider ?? existing.name },
  })

  // Best-effort purge of this connection's scan-derived learnings (Task
  // 4.5) — never blocks the disconnect response; purgeConnectionLearnings
  // already logs its own failures, `.catch` here is belt-and-suspenders.
  // `after` (Next 15) keeps this running past the response on serverless —
  // a bare `void` promise can be killed at response end there (same
  // reasoning as the scanConnection call in POST above).
  const organizationId = auth.organizationId
  const connectionId = existing.id
  after(() =>
    purgeConnectionLearnings({ organizationId, plane: 'mcp', connectionRef: connectionId }).catch(() => undefined),
  )

  return { success: true }
}, { requires: 'member' })
