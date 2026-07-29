import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { readShellSnapshot } from '@/lib/server/snapshot'
import { mirroredConnectionStatus } from '@/lib/server/nango-status'
import { googleOAuthConfigured } from '@/lib/google/oauth'

/**
 * One authenticated request for the first signed-in paint. This avoids paying
 * auth and serverless invocation overhead independently for the roster,
 * workspace chrome, connection badges, and profile role.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [snapshot, connections] = await Promise.all([
    readShellSnapshot(auth),
    mirroredConnectionStatus(auth.organizationId, auth.dbUser.id),
  ])

  return {
    success: true,
    userId: auth.user.id,
    snapshot,
    connectionStatus: {
      success: true,
      connections,
      nativeGoogle: googleOAuthConfigured(),
      mirrored: true,
    },
    profile: {
      success: true,
      profile: {
        name: auth.dbUser.name,
        email: auth.dbUser.email,
        imageUrl: auth.dbUser.imageUrl,
        role: auth.dbUser.role,
      },
    },
  }
}, { requires: 'member' })
