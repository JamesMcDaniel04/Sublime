/**
 * Wire shape for an AgentRequest. One definition shared by the routes and the
 * UI, so the composer and the API cannot disagree about what a request looks
 * like — the same reason work-serializer exists for GoalWork.
 */
import { agentDisplayName } from '@/lib/agents/metadata'
import type { RequestStatus } from '@/lib/agents/request-transitions'

export type SerializedAgentRequest = {
  id: string
  text: string
  status: RequestStatus
  origin: string
  result: string | null
  error: string | null
  executionId: string | null
  agentId: string
  agentName: string
  requestedByUserId: string | null
  requesterName: string | null
  createdAt: string
  settledAt: string | null
}

type RequestRow = {
  id: string
  text: string
  status: string
  origin: string
  result: string | null
  error: string | null
  executionId: string | null
  requestedByUserId: string | null
  createdAt: Date
  settledAt: Date | null
  agentTask: { id: string; description: string | null; metadata: unknown }
  requestedBy: { name: string | null } | null
}

export function serializeAgentRequest(row: RequestRow): SerializedAgentRequest {
  return {
    id: row.id,
    text: row.text,
    status: row.status as RequestStatus,
    origin: row.origin,
    result: row.result,
    error: row.error,
    executionId: row.executionId,
    agentId: row.agentTask.id,
    agentName: agentDisplayName(row.agentTask),
    requestedByUserId: row.requestedByUserId,
    // A departed teammate's requests stay readable; the name just goes.
    requesterName: row.requestedBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  }
}

/** The `select` every request listing uses — keeps the shape and the type in step. */
export const AGENT_REQUEST_SELECT = {
  id: true,
  text: true,
  status: true,
  origin: true,
  result: true,
  error: true,
  executionId: true,
  requestedByUserId: true,
  createdAt: true,
  settledAt: true,
  agentTask: { select: { id: true, description: true, metadata: true } },
  requestedBy: { select: { name: true } },
} as const
