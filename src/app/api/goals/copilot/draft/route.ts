import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { listMetricSourceOptions } from '@/lib/metrics/available-sources'
import { CopilotDraftError, draftGoalDashboard } from '@/lib/goals/copilot'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'

const bodySchema = z.object({
  description: z.string().min(1, 'Describe the goal.').max(2000),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { description } = bodySchema.parse(
    await request.json().catch(() => ({})),
  )
  const sources = await listMetricSourceOptions(auth)
  try {
    const { draft, notes } = await draftGoalDashboard({
      description,
      sources,
    })
    return { success: true, draft, notes }
  } catch (error) {
    if (error instanceof CopilotDraftError) {
      throw new ApiError(error.message, 422, 'DRAFT_INVALID')
    }
    apiLogger.warn('goals.copilot: draft failed', {
      error:
        error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
    throw new ApiError(
      'The Copilot could not draft this right now — try again, or start from a template below.',
      502,
      'DRAFT_FAILED',
    )
  }
})
