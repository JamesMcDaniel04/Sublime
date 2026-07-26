import { prisma } from '@/lib/prisma'
import { credentialScope } from '@/lib/credentials/resolve'
import { decryptCredentialConfig } from '@/lib/credentials/config'
import { getMetricSource } from '@/lib/metrics/registry'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/** Which metric card a vault secret belongs to, WITHOUT exposing the secret:
 *  a connection string is a Postgres binding, anything else is offered to
 *  Stripe. Decryption is local AES — the value never leaves this function. */
function credentialSourceOf(type: string, authConfig: unknown): 'postgres' | 'stripe' {
  try {
    const decrypted = decryptCredentialConfig(type, authConfig) as { token?: string; key?: string }
    const secret = decrypted.token ?? decrypted.key ?? ''
    return /^postgres(ql)?:\/\//i.test(secret.trim()) ? 'postgres' : 'stripe'
  } catch {
    return 'stripe'
  }
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [credentials, nangoConnections, googleConnections] = await Promise.all([
    prisma.credential.findMany({
      where: {
        ...credentialScope(auth.organizationId, auth.dbUser.id),
        type: { in: ['bearer', 'apiKeyHeader'] },
      },
      select: { id: true, name: true, type: true, authConfig: true },
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
    // The manual descriptor belongs ONLY to the manual source — a registry
    // gap for a connector source must yield no metrics, not a mislabeled one.
    metrics:
      name === 'manual'
        ? [{ key: 'manual.value', label: 'Manually recorded value', unit: 'usd' as const }]
        : (getMetricSource(name)?.availableMetrics('custom_kpi') ?? []),
    connections:
      name === 'stripe' || name === 'postgres'
        ? credentials
            .filter((credential) => credentialSourceOf(credential.type, credential.authConfig) === name)
            .map((credential) => ({
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
    sources: ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres', 'manual'].map(source),
  }
})
