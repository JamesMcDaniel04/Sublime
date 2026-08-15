/**
 * Complete organization teardown: external resources first (best-effort),
 * then the graph, then the org row — whose FK cascades (completed in WS-R4
 * Task 1) delete every owned row. Each external leg is isolated: a Nango
 * outage must not block the DB delete.
 *
 * Deleting rows only destroys OUR copies of tokens. The grants themselves
 * stay live at the provider until revoked, so Google refresh tokens and Slack
 * bot tokens get explicit best-effort revocation before their rows cascade.
 */

import { systemPrisma } from '@/lib/prisma'
import { captureError } from '@/lib/observability/sentry'
import { graphRagPersistent, getGraphRagStore } from '@/lib/rag/get-store'

export type TeardownResult = { nango: number; google: number; slack: number; graphCleared: boolean }

export async function teardownOrganization(
  organizationId: string,
  options: { actorUserId?: string | null } = {},
): Promise<TeardownResult> {
  let nango = 0
  let google = 0
  let slack = 0
  let graphCleared = false

  // systemPrisma: org teardown enumerates the org's own rows by org id — the
  // guard's org-scope requirement is satisfied semantically but these run
  // outside any authenticated request context.
  try {
    if (process.env.NANGO_SECRET_KEY) {
      const { getNangoClient, nangoDeadline } = await import('@/lib/nango/client')
      const client = getNangoClient()
      const connections = await systemPrisma.nangoConnection.findMany({ where: { organizationId } })
      for (const connection of connections) {
        try {
          await nangoDeadline(client.deleteConnection(connection.providerConfigKey, connection.connectionId), undefined, 'nango deleteConnection')
          nango += 1
        } catch (error) {
          captureError(error, { source: 'orgTeardown.nango', organizationId, connectionId: connection.connectionId })
        }
      }
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.nangoLeg', organizationId })
  }

  // Native Google grants: revoke each refresh token at Google before the row
  // cascades away. An undecryptable token (rotated key) is skipped — our copy
  // is unusable, and Google GC's the grant on its own schedule.
  try {
    const rows = await systemPrisma.googleOAuthConnection.findMany({ where: { organizationId } })
    if (rows.length > 0) {
      const { decryptSecret } = await import('@/lib/crypto/secrets')
      const { revokeToken } = await import('@/lib/google/oauth')
      for (const row of rows) {
        try {
          await revokeToken(decryptSecret(row.refreshTokenEnc))
          google += 1
        } catch {
          // Undecryptable token: nothing to revoke with.
        }
      }
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.googleLeg', organizationId })
  }

  // Slack bot tokens: a pasted xoxb token never expires on its own.
  try {
    const rows = await systemPrisma.slackWorkspaceConnection.findMany({ where: { organizationId } })
    if (rows.length > 0) {
      const { decryptSecretJson, slackAuthRevoke } = await import('@/lib/slack/connections')
      for (const row of rows) {
        try {
          await slackAuthRevoke(decryptSecretJson(row.botToken))
          slack += 1
        } catch {
          // Undecryptable token: nothing to revoke with.
        }
      }
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.slackLeg', organizationId })
  }

  try {
    if (graphRagPersistent()) {
      await getGraphRagStore().clear?.(organizationId)
      graphCleared = true
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.graph', organizationId })
  }

  // Written BEFORE the delete; the SET NULL FK orphans (rather than deletes)
  // this row when the org goes, so workspace deletion can no longer erase its
  // own audit trail.
  try {
    const { recordAudit } = await import('@/lib/audit')
    await recordAudit({
      organizationId,
      actorUserId: options.actorUserId ?? null,
      actorKind: options.actorUserId ? 'user' : 'system',
      action: 'organization.deleted',
      resourceType: 'organization',
      resourceId: organizationId,
      detail: { nangoConnectionsDeleted: nango, googleTokensRevoked: google, slackTokensRevoked: slack },
    })
  } catch (error) {
    captureError(error, { source: 'orgTeardown.audit', organizationId })
  }

  await systemPrisma.organization.delete({ where: { id: organizationId } })
  return { nango, google, slack, graphCleared }
}
