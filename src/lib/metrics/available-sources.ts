import { prisma } from '@/lib/prisma'
import { credentialScope } from '@/lib/credentials/resolve'
import { decryptCredentialConfig } from '@/lib/credentials/config'
import { getMetricSource } from '@/lib/metrics/registry'
import { slackConfigured } from '@/lib/integrations/slack'
import type { MetricSourceOption } from './source-options'
export {
  sourceIsAvailable,
  type MetricSourceOption,
} from './source-options'

/** Which metric card a vault secret belongs to, WITHOUT exposing the secret:
 * a connection string is a Postgres binding, anything else is offered to
 * Stripe. Decryption is local AES — the value never leaves this function. */
function credentialSourceOf(type: string, authConfig: unknown): 'postgres' | 'stripe' {
  try {
    const decrypted = decryptCredentialConfig(type, authConfig) as {
      token?: string
      key?: string
    }
    const secret = decrypted.token ?? decrypted.key ?? ''
    return /^postgres(ql)?:\/\//i.test(secret.trim()) ? 'postgres' : 'stripe'
  } catch {
    return 'stripe'
  }
}

export async function listMetricSourceOptions(auth: {
  organizationId: string
  dbUser: { id: string }
}): Promise<MetricSourceOption[]> {
  const [credentials, nangoConnections, googleConnections, postgresConnections] = await Promise.all([
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
        service: { in: ['google-sheets', 'google-mail', 'google-analytics'] },
        status: 'connected',
      },
      select: { id: true, accountEmail: true, service: true },
      orderBy: { accountEmail: 'asc' },
    }),
    // Org-scoped, not per-user: a connected database is workspace
    // infrastructure, so every member can bind a metric to it.
    prisma.postgresConnection.findMany({
      where: { organizationId: auth.organizationId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])
  const sheetsConnections = googleConnections.filter(
    (connection) => connection.service === 'google-sheets',
  )
  const gmailConnections = googleConnections.filter(
    (connection) => connection.service === 'google-mail',
  )
  const analyticsConnections = googleConnections.filter(
    (connection) => connection.service === 'google-analytics',
  )

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

  // Nobody is locked out of goal tracking. Start-now sources work without
  // another SaaS connection; source-of-truth sources are the upgrade path.
  const START_NOW = ['manual', 'slack_assisted', 'gmail_assisted', 'url'] as const
  const source = (name: string): MetricSourceOption => ({
    source: name,
    group: (START_NOW as readonly string[]).includes(name)
      ? 'start_now'
      : 'source_of_truth',
    available:
      name === 'manual' ||
      name === 'url' ||
      (name === 'slack_assisted' && slackConfigured()) ||
      undefined,
    metrics:
      name === 'manual'
        ? [{ key: 'manual.value', label: 'Manually recorded value', unit: 'usd' }]
        : (getMetricSource(name)?.availableMetrics('custom_kpi') ?? []),
    connections:
      // Postgres offers the native integration's databases FIRST, then any
      // pre-integration vault credential whose secret is a connection string.
      // Both refs resolve at fetch time, so bindings made either way keep
      // reading — see resolveConnection in sources/postgres.ts.
      name === 'postgres'
        ? [
            ...postgresConnections.map((connection) => ({
              ref: `postgres:${connection.id}`,
              label: connection.name,
            })),
            ...credentials
              .filter((credential) => credentialSourceOf(credential.type, credential.authConfig) === 'postgres')
              .map((credential) => ({ ref: `credential:${credential.id}`, label: credential.name })),
          ]
        : name === 'stripe'
        ? credentials
            .filter(
              (credential) =>
                credentialSourceOf(credential.type, credential.authConfig) === name,
            )
            .map((credential) => ({
              ref: `credential:${credential.id}`,
              label: credential.name,
            }))
        : name === 'hubspot' || name === 'salesforce'
          ? connectionsFor(name)
          : name === 'google_sheets'
            ? sheetsConnections.map((connection) => ({
                ref: `google:${connection.id}`,
                label: connection.accountEmail,
              }))
            : name === 'gmail_assisted'
              ? gmailConnections.map((connection) => ({
                  ref: `google:${connection.id}`,
                  label: connection.accountEmail,
                }))
              : name === 'google_analytics'
                ? analyticsConnections.map((connection) => ({
                    ref: `google:${connection.id}`,
                    label: connection.accountEmail,
                  }))
                : [],
  })

  return [
    'manual',
    'slack_assisted',
    'gmail_assisted',
    'url',
    'stripe',
    'hubspot',
    'salesforce',
    'google_sheets',
    'google_analytics',
    'postgres',
  ].map(source)
}
