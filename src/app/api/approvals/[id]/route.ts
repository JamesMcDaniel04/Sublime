import { z } from 'zod'
import { NextRequest } from 'next/server'
import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { apiLogger } from '@/lib/logger'
import { decideApproval } from '@/lib/agents/approval'
import { resumeAgentExecution } from '@/features/agents/execute-agent'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'

const schema = z.object({ decision: z.enum(['approve', 'reject']) })

export const runtime = 'nodejs'
export const maxDuration = 1200

export const POST = withAuthenticatedApi(async (request: NextRequest, auth) => {
  const id = request.nextUrl.pathname.split('/').pop() || ''
  const { decision } = schema.parse(await request.json())
  try {
    const { resume, resumeFlow, ...result } = await decideApproval({
      approvalId: id,
      organizationId: auth.organizationId,
      deciderUserId: auth.dbUser.id,
      approve: decision === 'approve',
    })
    // Resume the suspended run with the decision result — fire-and-forget so the
    // approval response returns promptly (the run continues on the worker).
    if (resume) {
      void resumeAgentExecution(resume).catch((error) =>
        apiLogger.error('approval resume failed', { executionId: resume.executionId, error: error instanceof Error ? error.message : String(error) }),
      )
    }
    // A flow run paused on a tool-step approval resumes the same way: the
    // decision payload rides in as the reply and the paused step consumes it.
    if (resumeFlow) {
      void dispatchFlowExecution({
        flowId: resumeFlow.flowId,
        organizationId: resumeFlow.organizationId,
        userId: resumeFlow.userId,
        flowRunId: resumeFlow.flowRunId,
        reply: resumeFlow.reply,
        usePublished: resumeFlow.usePublished,
      }).catch((error) =>
        apiLogger.error('approval flow resume failed', { flowRunId: resumeFlow.flowRunId, error: error instanceof Error ? error.message : String(error) }),
      )
    }
    return { success: true, ...result }
  } catch (error) {
    if (error instanceof Error && error.message === 'Approval not found') {
      throw new ApiError('Approval not found', 404, 'NOT_FOUND')
    }
    throw error
  }
})
