import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { decryptSecretJson } from '@/lib/slack/connections'
import { listSlackChannels } from '@/lib/slack/api'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Slack connection id is required')
  const connection = await prisma.slackWorkspaceConnection.findFirst({
    where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id, status: 'active' },
  })
  if (!connection) throw new ApiError('Slack connection not found', 404, 'NOT_FOUND')
  try {
    const channels = await listSlackChannels(decryptSecretJson(connection.botToken))
    return { success: true, channels }
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Could not list Slack channels', 502, 'SLACK_CHANNELS_FAILED')
  }
}, { requires: 'member' })
