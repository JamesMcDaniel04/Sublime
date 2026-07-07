import type { NextRequest } from 'next/server'
import type { AgentTask } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import type { AuthContext } from '@/lib/server/auth'
import { agentVisibilityScope } from '@/lib/server/visibility'

/**
 * Shared helpers for the agent-scoped assistant chat routes (`/chat` and
 * `/chat/sessions`). Kept out of `route.ts` so both handlers use one agent-id
 * extractor and one access check.
 */

/** Synthetic session id for pre-sessions flat threads (sessionId IS NULL). */
export const LEGACY_SESSION_ID = 'legacy'

/** The agent id is the path segment right after `/agents/`. */
export function agentIdFromRequest(request: NextRequest): string {
  const segments = request.nextUrl.pathname.split('/')
  const index = segments.indexOf('agents')
  const id = index >= 0 ? segments[index + 1] : undefined
  if (!id) throw new ApiError('Agent id is required')
  return id
}

/** Load the agent, enforcing tenant + per-rep visibility. Throws 404 otherwise. */
export async function requireAgent(id: string, auth: AuthContext): Promise<AgentTask> {
  const agent = await prisma.agentTask.findFirst({
    where: {
      id,
      organizationId: auth.organizationId,
      status: { not: 'DELETED' },
      ...agentVisibilityScope(auth.dbUser.id),
    },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return agent
}

/** A conversation title derived from the first user message. */
export function deriveTitle(message: string): string {
  const text = message.trim().replace(/\s+/g, ' ')
  if (!text) return 'New chat'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
