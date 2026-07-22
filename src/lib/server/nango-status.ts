import { prisma } from '@/lib/prisma'

export type ConnectionStatus = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
  native?: boolean
}

export const GOOGLE_NATIVE_PROVIDER = 'google-native'

/** Fast, per-user connection state from the runtime's database mirror. */
export async function mirroredConnectionStatus(organizationId: string, userId: string): Promise<Record<string, ConnectionStatus>> {
  const rows = await prisma.nangoConnection.findMany({
    where: { organizationId, userId },
    select: {
      connectionId: true,
      providerConfigKey: true,
      provider: true,
      status: true,
      lastError: true,
      updatedAt: true,
    },
  })
  const connections: Record<string, ConnectionStatus> = {}
  for (const row of rows) {
    const existing = connections[row.providerConfigKey]
    const connected = row.status === 'connected'
    connections[row.providerConfigKey] = {
      connected: existing ? existing.connected || connected : connected,
      connectionIds: [...(existing?.connectionIds ?? []), row.connectionId],
      provider: row.provider || row.providerConfigKey,
      error: existing?.error ?? row.lastError ?? undefined,
      lastSync: row.updatedAt.toISOString(),
      native: (existing?.native ?? false) || row.provider === GOOGLE_NATIVE_PROVIDER,
    }
  }
  return connections
}
