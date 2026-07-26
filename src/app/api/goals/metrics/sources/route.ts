import { prisma } from '@/lib/prisma'
import { credentialScope } from '@/lib/credentials/resolve'
import { getMetricSource } from '@/lib/metrics/registry'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [credentials, nangoConnections, googleConnections] = await Promise.all([
    prisma.credential.findMany({
      where: {
        ...credentialScope(auth.organizationId, auth.dbUser.id),
        type: { in: ['bearer', 'apiKeyHeader'] },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.nangoConnection.findMany({
      where: {
        organizationId: auth.organizationId,
        providerConfigKey: { in: ['hubspot', 'salesforce', 'salesforce-sandbox'] },
        status: 'connected',
        OR: [{ userId: null }, { userId: auth.dbUser.id }],
      },
      select: { connectionId: true, providerConfigKey: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.googleOAuthConnection.findMany({
      where: {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        service: 'google-sheets',
        status: 'connected',
      },
      select: { id: true, accountEmail: true },
      orderBy: { accountEmail: 'asc' },
    }),
  ])

  const connectionsFor = (source: 'hubspot' | 'salesforce') =>
    nangoConnections
      .filter((connection) =>
        source === 'salesforce'
          ? connection.providerConfigKey.startsWith('salesforce')
          : connection.providerConfigKey === 'hubspot',
      )
      .map((connection) => {
        const metadata =
          connection.metadata &&
          typeof connection.metadata === 'object' &&
          !Array.isArray(connection.metadata)
            ? (connection.metadata as Record<string, unknown>)
            : {}
        return {
          ref: `nango:${connection.connectionId}`,
          label:
            (typeof metadata.accountEmail === 'string' && metadata.accountEmail) ||
            (typeof metadata.name === 'string' && metadata.name) ||
            connection.connectionId,
        }
      })

  const source = (name: string) => ({
    source: name,
    metrics:
      getMetricSource(name)?.availableMetrics('custom_kpi') ??
      [{ key: 'manual.value', label: 'Manually recorded value', unit: 'usd' as const }],
    connections:
      name === 'stripe'
        ? credentials.map((credential) => ({
            ref: `credential:${credential.id}`,
            label: credential.name,
          }))
        : name === 'hubspot' || name === 'salesforce'
          ? connectionsFor(name)
          : name === 'google_sheets'
            ? googleConnections.map((connection) => ({
                ref: `google:${connection.id}`,
                label: connection.accountEmail,
              }))
            : [],
  })

  return {
    success: true,
    sources: ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'manual'].map(source),
  }
})
