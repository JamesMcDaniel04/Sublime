import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

const providers = [
  'github',
  'slack',
  'linear',
  'asana',
  'monday',
  'trello',
  'clickup',
  'jira',
  'zendesk',
  'figma',
] as const

type Provider = (typeof providers)[number]
type Metadata = Record<string, unknown>

function toMetadata(value: Prisma.JsonValue): Metadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Metadata
    : {}
}

function stringValue(metadata: Metadata, key: string) {
  return typeof metadata[key] === 'string' ? metadata[key] : undefined
}

function scopesValue(metadata: Metadata, fallback: string[]) {
  return Array.isArray(metadata.scopes)
    ? metadata.scopes.filter((scope): scope is string => typeof scope === 'string')
    : fallback
}

function providerDetails(provider: Provider, metadata: Metadata) {
  switch (provider) {
    case 'github':
      return { username: stringValue(metadata, 'login') }
    case 'slack':
      return { teamName: stringValue(metadata, 'teamName') }
    case 'linear':
    case 'trello':
      return { organization: stringValue(metadata, 'organization') }
    case 'asana':
    case 'clickup':
      return { workspace: stringValue(metadata, 'workspace') }
    case 'monday':
      return { account: stringValue(metadata, 'account') }
    default:
      return {}
  }
}

export async function getIntegrationStatus(userId: string, organizationId: string) {
  const integrations = await prisma.integration.findMany({
    where: {
      isActive: true,
      OR: [{ userId }, { organizationId }],
    },
    select: {
      provider: true,
      metadata: true,
      scopes: true,
      lastSyncAt: true,
      expiresAt: true,
      lastError: true,
    },
  })

  const byProvider = new Map(
    integrations.map(integration => [integration.provider.toLowerCase(), integration]),
  )

  const status = Object.fromEntries(
    providers.map(provider => {
      const integration = byProvider.get(provider)
      if (!integration) {
        return [provider, { connected: false }]
      }

      const metadata = toMetadata(integration.metadata)
      return [
        provider,
        {
          connected: true,
          provider,
          lastSync: integration.lastSyncAt,
          expiresAt: integration.expiresAt,
          lastError: integration.lastError,
          scopes: scopesValue(metadata, integration.scopes),
          reconnectUrl: '/integrations',
          ...providerDetails(provider, metadata),
        },
      ]
    }),
  )

  return status
}
