import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { slackIngressUrl } from '@/lib/slack/connections'
import { buildSlackManifest } from '@/lib/slack/manifest'
import { slackTriggerConfigOf } from '@/lib/slack/route-event'

// GET — a ready-to-paste Slack app manifest for this binding, slash commands
// pre-filled from the org's active slack-triggered flows. Org-scoped: a
// binding in another org 404s exactly like it doesn't exist.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  const binding = await prisma.slackWorkspaceConnection.findFirst({
    where: { id: id ?? '', organizationId: auth.organizationId },
  })
  if (!binding) throw new ApiError('Slack connection not found', 404, 'NOT_FOUND')
  const flows = await prisma.flow.findMany({
    where: { organizationId: auth.organizationId, status: 'ACTIVE' },
    select: { trigger: true },
    take: 200,
  })
  const commands = flows
    .map((flow) => slackTriggerConfigOf(flow.trigger)?.command)
    .filter((command): command is string => Boolean(command))
  const manifest = buildSlackManifest({
    appName: binding.teamName ? `Sublime (${binding.teamName})` : 'Sublime Bot',
    ingressUrl: slackIngressUrl(binding.id),
    commands,
  })
  return { success: true, manifest }
}, { requires: 'member' })
