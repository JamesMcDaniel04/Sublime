/**
 * Connection sweep for member offboarding.
 *
 * Deactivating a member locks them out — but their GRANTS stayed live: Google
 * refresh tokens, Nango connections, Slack bot tokens, and personal MCP
 * servers all kept working, usable by anyone reaching them through org-scoped
 * paths. Offboarding support means revocation, not just lockout: every
 * personal connection is revoked at the provider (best-effort) and deleted
 * locally, each with a `connection.revoked` audit row.
 *
 * Workspace-shared resources (the credential vault, org-shared Nango rows
 * with userId null, PostgresConnection) are deliberately NOT swept — they are
 * org property with provenance, not the member's personal grants.
 *
 * Legs are isolated: one provider being down must not leave the others live.
 */
import { prisma } from '@/lib/prisma'
import { captureError } from '@/lib/observability/sentry'
import { recordConnectionAudit } from '@/lib/connections/audit'
import { deleteGoogleConnection, GOOGLE_NATIVE_PROVIDER } from '@/lib/google/store'
import { revokeToken } from '@/lib/google/oauth'

export type OffboardingSweep = { google: number; nango: number; slack: number; mcp: number }

export async function revokeMemberConnections(input: {
  organizationId: string
  userId: string
  actorUserId: string | null
}): Promise<OffboardingSweep> {
  const { organizationId, userId, actorUserId } = input
  const swept: OffboardingSweep = { google: 0, nango: 0, slack: 0, mcp: 0 }

  // Native Google grants: delete (audited inside the store) + revoke at
  // Google. Undecryptable tokens (rotated key) skip the revoke — our copy is
  // unusable anyway.
  try {
    const rows = await prisma.googleOAuthConnection.findMany({ where: { organizationId, userId }, select: { id: true } })
    for (const row of rows) {
      const deleted = await deleteGoogleConnection({ organizationId, id: row.id, actorUserId })
      if (deleted?.refreshToken) await revokeToken(deleted.refreshToken)
      swept.google += 1
    }
  } catch (error) {
    captureError(error, { source: 'offboarding.google', organizationId, userId })
  }

  // Personal Nango connections (google-native mirrors were already removed by
  // the leg above). Nango holds the provider credentials, so deleting the
  // connection there IS the revocation.
  try {
    // NULL-safe exclusion: `provider: { not: ... }` alone drops NULL rows
    // (SQL three-valued logic), and plain Nango rows have provider = NULL.
    const rows = await prisma.nangoConnection.findMany({
      where: {
        organizationId,
        userId,
        OR: [{ provider: null }, { provider: { not: GOOGLE_NATIVE_PROVIDER } }],
      },
    })
    if (rows.length > 0) {
      let client: { deleteConnection: (providerConfigKey: string, connectionId: string) => Promise<unknown> } | null = null
      let deadline: (<T>(promise: Promise<T>, ms?: number, label?: string) => Promise<T>) | null = null
      if (process.env.NANGO_SECRET_KEY) {
        const { getNangoClient, nangoDeadline } = await import('@/lib/nango/client')
        client = getNangoClient()
        deadline = nangoDeadline
      }
      for (const row of rows) {
        if (client && deadline) {
          try {
            await deadline(client.deleteConnection(row.providerConfigKey, row.connectionId), undefined, 'nango deleteConnection')
          } catch (error) {
            captureError(error, { source: 'offboarding.nango', organizationId, connectionId: row.connectionId })
          }
        }
        await prisma.nangoConnection.deleteMany({ where: { id: row.id, organizationId } })
        await recordConnectionAudit({
          organizationId,
          actorUserId,
          action: 'connection.revoked',
          plane: 'nango',
          provider: row.providerConfigKey,
          connectionId: row.connectionId,
          extra: { reason: 'offboarding', targetUserId: userId },
        })
        swept.nango += 1
      }
    }
  } catch (error) {
    captureError(error, { source: 'offboarding.nangoLeg', organizationId, userId })
  }

  // Slack bindings: revoke the bot token at Slack (it never expires on its
  // own), then delete the binding and its thread sessions.
  try {
    const rows = await prisma.slackWorkspaceConnection.findMany({ where: { organizationId, userId } })
    if (rows.length > 0) {
      const { decryptSecretJson, slackAuthRevoke } = await import('@/lib/slack/connections')
      for (const row of rows) {
        try {
          await slackAuthRevoke(decryptSecretJson(row.botToken))
        } catch {
          // Undecryptable token: nothing to revoke with.
        }
        await prisma.slackThreadSession.deleteMany({ where: { organizationId, bindingId: row.id } })
        await prisma.slackWorkspaceConnection.deleteMany({ where: { id: row.id, organizationId } })
        await recordConnectionAudit({
          organizationId,
          actorUserId,
          action: 'connection.revoked',
          plane: 'slack',
          provider: 'slack',
          connectionId: row.id,
          accountLabel: row.teamName,
          extra: { reason: 'offboarding', targetUserId: userId, teamId: row.teamId },
        })
        swept.slack += 1
      }
    }
  } catch (error) {
    captureError(error, { source: 'offboarding.slack', organizationId, userId })
  }

  // Personal MCP connections: destroying the encrypted authConfig is the only
  // revocation available (MCP has no universal revoke endpoint). Agent
  // bindings that referenced the row null out via the FK's SET NULL.
  try {
    const rows = await prisma.mcpConnection.findMany({ where: { organizationId, userId }, select: { id: true, name: true } })
    for (const row of rows) {
      await prisma.mcpConnection.deleteMany({ where: { id: row.id, organizationId } })
      await recordConnectionAudit({
        organizationId,
        actorUserId,
        action: 'connection.revoked',
        plane: 'mcp',
        provider: row.name,
        connectionId: row.id,
        extra: { reason: 'offboarding', targetUserId: userId },
      })
      swept.mcp += 1
    }
  } catch (error) {
    captureError(error, { source: 'offboarding.mcp', organizationId, userId })
  }

  return swept
}
