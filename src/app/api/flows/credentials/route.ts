import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope } from '@/lib/server/visibility'
import { contributionResourceIds, resolveGoalScope } from '@/lib/server/goal-scope'
import { collectFlowCredentialRefs, type FlowRef } from '@/lib/flows/credential-usage'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { loadVerifications } from '@/lib/connections/record-verification'
import { toVerification, type Verification } from '@/lib/connections/verification'
import { DELIVERY_PROVIDERS, resolveDeliveryConnection, type DeliveryCapability } from '@/lib/nango/delivery'

export const runtime = 'nodejs'

/**
 * GET /api/flows/credentials — every credential/connection the caller's
 * visible flows depend on, with health and per-flow usage.
 *
 * Backs the Flows page credentials tab. Deliberately DB-only: names, flags,
 * and recorded verification rows — no live probing (the "check now" button
 * calls /api/connections/verify for that), so listing stays cheap.
 *
 * Kinds:
 *   - mcp        — an McpConnection row (raw id refs)
 *   - credential — a vault Credential (http generic auth)
 *   - account    — nango:<capability> / native:<provider> / postgres:<id>
 *
 * `native:http` and `native:email` are credential-less built-ins — nothing to
 * manage, so they are excluded. A ref whose backing row no longer exists (or
 * belongs to someone else — credentials and personal MCP servers are per-user)
 * is still returned with `missing: true`: the flow will fail on it, which is
 * exactly what this tab exists to surface.
 */

export type FlowCredentialItem = {
  /** Catalog/verification key — also what /api/connections/verify accepts. */
  key: string
  kind: 'mcp' | 'credential' | 'account'
  name: string
  detail?: string
  /** account sub-plane, for choosing the reconnect affordance. */
  plane?: 'nango' | 'native' | 'postgres'
  /** MCP: platform-managed slug — enables the OAuth reauthorize flow. */
  provider?: string
  /** Vault credential id / MCP row id / postgres row id (for item routes). */
  id: string
  /** Nango provider config key for reconnect/disconnect. */
  integrationId?: string
  configPath?: string
  missing?: boolean
  inactive?: boolean
  connected?: boolean
  verification: Verification
  flows: FlowRef[]
}

type ConnectionRef = { id: string; ref: string; usedBy: FlowRef[] }
type VerificationRows = Awaited<ReturnType<typeof loadVerifications>>

const CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  basic: 'Basic auth',
  bearer: 'Bearer token',
  custom: 'Custom headers',
  digest: 'Digest auth',
  apiKeyHeader: 'API key (header)',
  apiKeyQuery: 'API key (query)',
  oauth1: 'OAuth 1.0',
  oauth2: 'OAuth 2.0',
}

const MCP_AUTH_LABELS: Record<string, string> = { none: 'No auth', api_key: 'API key', oauth2: 'OAuth' }

const capitalize = (value: string) => (value ? value[0].toUpperCase() + value.slice(1) : value)

function mcpItem(
  entry: ConnectionRef,
  row: { name: string; provider: string | null; authType: string; isActive: boolean } | undefined,
  verifications: VerificationRows,
): FlowCredentialItem {
  const item: FlowCredentialItem = {
    key: entry.id,
    kind: 'mcp',
    id: entry.ref,
    name: row?.name ?? 'Removed MCP server',
    verification: toVerification(verifications.get(entry.id)),
    flows: entry.usedBy,
  }
  if (!row) item.missing = true
  else {
    item.detail = MCP_AUTH_LABELS[row.authType] ?? row.authType
    if (row.provider) item.provider = row.provider
    if (!row.isActive) item.inactive = true
  }
  return item
}

function credentialItem(
  id: string,
  row: { name: string; type: string; isActive: boolean } | undefined,
  usedBy: FlowRef[],
  verifications: VerificationRows,
): FlowCredentialItem {
  const item: FlowCredentialItem = {
    key: `credential:${id}`,
    kind: 'credential',
    id,
    name: row?.name ?? 'Removed or inaccessible credential',
    configPath: '/integrations?tab=credentials',
    verification: toVerification(verifications.get(`credential:${id}`)),
    flows: usedBy,
  }
  if (!row) item.missing = true
  else {
    item.detail = CREDENTIAL_TYPE_LABELS[row.type] ?? row.type
    if (!row.isActive) item.inactive = true
  }
  return item
}

function nangoItem(
  entry: ConnectionRef,
  connection: { providerConfigKey: string } | null,
  known: boolean,
  verifications: VerificationRows,
): FlowCredentialItem {
  const fallbackIntegrationId = known ? DELIVERY_PROVIDERS[entry.ref as DeliveryCapability][0] : undefined
  const item: FlowCredentialItem = {
    key: entry.id,
    kind: 'account',
    plane: 'nango',
    id: entry.ref,
    name: `${capitalize(entry.ref)} account`,
    detail: connection ? connection.providerConfigKey : 'Not connected',
    connected: Boolean(connection),
    verification: toVerification(verifications.get(entry.id)),
    flows: entry.usedBy,
  }
  const integrationId = connection?.providerConfigKey ?? fallbackIntegrationId
  if (integrationId) item.integrationId = integrationId
  if (!known) item.missing = true
  return item
}

function postgresItem(
  entry: ConnectionRef,
  row: { name: string; displayTarget: string; status: string } | undefined,
  verifications: VerificationRows,
): FlowCredentialItem {
  const item: FlowCredentialItem = {
    key: entry.id,
    kind: 'account',
    plane: 'postgres',
    id: entry.ref,
    name: row?.name ?? 'Removed Postgres connection',
    configPath: '/integrations/postgres',
    connected: row?.status === 'connected',
    verification: toVerification(verifications.get(entry.id)),
    flows: entry.usedBy,
  }
  if (row?.displayTarget) item.detail = row.displayTarget
  if (!row) item.missing = true
  return item
}

function nativeItem(entry: ConnectionRef, configured: boolean, verifications: VerificationRows): FlowCredentialItem {
  const item: FlowCredentialItem = {
    key: entry.id,
    kind: 'account',
    plane: 'native',
    id: entry.ref,
    name: `${capitalize(entry.ref)} (built-in)`,
    configPath: entry.ref === 'granola' ? '/integrations/granola' : '/integrations',
    connected: configured,
    verification: toVerification(verifications.get(entry.id)),
    flows: entry.usedBy,
  }
  if (!configured) item.detail = 'Not configured'
  return item
}

/** Whether the org has the backing config for a credential-bearing built-in. */
async function nativeConfigured(organizationId: string, userId: string, ref: string): Promise<boolean> {
  if (ref === 'granola') {
    const secret = await prisma.integrationSecret.findFirst({ where: { organizationId, userId, provider: 'granola', isActive: true }, select: { id: true } })
    return Boolean(secret)
  }
  if (ref === 'slack') {
    const workspace = await prisma.slackWorkspaceConnection.findFirst({ where: { organizationId, userId, status: 'active' }, select: { id: true } })
    return Boolean(workspace)
  }
  return true
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const scope = await resolveGoalScope(auth, request.nextUrl.searchParams.get('goal'))
  const readScope = flowReadScope(auth.dbUser.id)
  const linkedIds = scope.kind === 'goal'
    ? await contributionResourceIds(auth.organizationId, scope.goal.id, 'flow')
    : null

  const flows = await prisma.flow.findMany({
    where: { organizationId: auth.organizationId, AND: [readScope, ...(linkedIds ? [{ id: { in: linkedIds } }] : [])] },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    // Both graphs: an active flow RUNS publishedGraph, so a credential only
    // referenced there is still load-bearing.
    select: { id: true, name: true, graph: true, publishedGraph: true },
  })

  const refs = collectFlowCredentialRefs(
    flows.map((flow) => ({ id: flow.id, name: flow.name, graphs: [flow.graph, flow.publishedGraph] })),
  )

  const parsed: Array<ConnectionRef & { plane: string }> = [...refs.connections.entries()].map(([id, usedBy]) => ({
    id,
    usedBy,
    ...parseFlowToolConnectionId(id),
  }))
  const mcpRefs = parsed.filter((entry) => entry.plane === 'mcp')
  const nangoRefs = parsed.filter((entry) => entry.plane === 'nango')
  const postgresRefs = parsed.filter((entry) => entry.plane === 'postgres')
  const nativeRefs = parsed.filter(
    (entry) => entry.plane === 'native' && entry.ref !== 'http' && entry.ref !== 'email',
  )
  const credentialIds = [...refs.credentials.keys()]

  const [mcpRows, postgresRows, credentialRows, verifications] = await Promise.all([
    mcpRefs.length
      ? prisma.mcpConnection.findMany({
          // mcpConnectionScope minus the isActive narrowing: a deactivated
          // server referenced by a flow should read as inactive, not vanish.
          where: {
            id: { in: mcpRefs.map((entry) => entry.ref) },
            organizationId: auth.organizationId,
            OR: [{ userId: auth.dbUser.id }, { userId: null, provider: { not: null } }],
          },
          select: { id: true, name: true, provider: true, authType: true, isActive: true },
        })
      : [],
    postgresRefs.length
      ? prisma.postgresConnection.findMany({
          where: { id: { in: postgresRefs.map((entry) => entry.ref) }, organizationId: auth.organizationId },
          select: { id: true, name: true, displayTarget: true, status: true },
        })
      : [],
    credentialIds.length
      ? prisma.credential.findMany({
          // Same hard per-user scope as resolution (lib/credentials/resolve.ts):
          // someone else's credential in a shared flow is not yours to manage.
          where: { id: { in: credentialIds }, organizationId: auth.organizationId, userId: auth.dbUser.id },
          select: { id: true, name: true, type: true, isActive: true },
        })
      : [],
    loadVerifications(auth.organizationId, [
      ...refs.connections.keys(),
      ...credentialIds.map((id) => `credential:${id}`),
    ]),
  ])

  const mcpById = new Map(mcpRows.map((row) => [row.id, row]))
  const postgresById = new Map(postgresRows.map((row) => [row.id, row]))
  const credentialById = new Map(credentialRows.map((row) => [row.id, row]))

  // Nango capabilities resolve to the connection DELIVERY would pick for this
  // user (own first, org-shared fallback) — the same rule execution uses.
  const nangoResolved = await Promise.all(
    nangoRefs.map(async (entry) => {
      const known = entry.ref in DELIVERY_PROVIDERS
      const connection = known
        ? await resolveDeliveryConnection(auth.organizationId, entry.ref as DeliveryCapability, auth.dbUser.id).catch(() => null)
        : null
      return { entry, connection, known }
    }),
  )
  const nativeStates = await Promise.all(
    nativeRefs.map(async (entry) => ({ entry, configured: await nativeConfigured(auth.organizationId, auth.dbUser.id, entry.ref) })),
  )

  const items: FlowCredentialItem[] = [
    ...mcpRefs.map((entry) => mcpItem(entry, mcpById.get(entry.ref), verifications)),
    ...credentialIds.map((id) => credentialItem(id, credentialById.get(id), refs.credentials.get(id) ?? [], verifications)),
    ...nangoResolved.map(({ entry, connection, known }) => nangoItem(entry, connection, known, verifications)),
    ...postgresRefs.map((entry) => postgresItem(entry, postgresById.get(entry.ref), verifications)),
    ...nativeStates.map(({ entry, configured }) => nativeItem(entry, configured, verifications)),
  ]

  items.sort((a, b) => a.name.localeCompare(b.name))
  return { success: true, items }
}, { requires: 'member' })
