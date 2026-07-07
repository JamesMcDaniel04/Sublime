/**
 * Approval gate for outbound writes.
 *
 * When an agent is configured with `requireApproval`, its write-plane tool
 * calls (Nango delivery: Slack/Gmail/Salesforce) are not executed inline.
 * Instead an ApprovalRequest is created and the model is told the action is
 * queued; an approver later approves (the write runs) or rejects (it's
 * dropped). Every decision is audited. This avoids pausing/resuming the whole
 * multi-turn run while still gating side effects.
 */

import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import {
  DELIVERY_TOOLS,
  resolveDeliveryConnection,
  type DeliveryCapability,
} from '@/lib/nango/delivery'

/** Write planes that an approval gate applies to (delivery/outbound). */
const WRITE_PLANE = /^nango:(slack|gmail|salesforce)$/

export function requiresApproval(
  agentMetadata: Record<string, unknown> | null | undefined,
  provider: string,
): boolean {
  const flag = agentMetadata?.requireApproval
  return flag === true && WRITE_PLANE.test(provider)
}

export function capabilityFromProvider(provider: string): DeliveryCapability | null {
  const match = WRITE_PLANE.exec(provider)
  return match ? (match[1] as DeliveryCapability) : null
}

export async function createApproval(input: {
  organizationId: string
  executionId: string
  userId: string
  provider: string
  tool: string
  args: Record<string, unknown>
}): Promise<{ id: string }> {
  const capability = capabilityFromProvider(input.provider)
  const summary = `${input.tool} (${capability ?? input.provider})`
  const approval = await prisma.approvalRequest.create({
    data: {
      organizationId: input.organizationId,
      executionId: input.executionId,
      tool: input.tool,
      summary,
      payload: { provider: input.provider, capability, args: input.args, userId: input.userId } as never,
      status: 'pending',
    },
  })
  await recordAudit({
    organizationId: input.organizationId,
    executionId: input.executionId,
    actorUserId: input.userId,
    actorKind: 'agent',
    action: 'approval.requested',
    tool: input.tool,
    resourceType: input.provider,
    resourceId: approval.id,
    payload: input.args,
  })
  return { id: approval.id }
}

export interface ResumeInfo {
  executionId: string
  agentId: string
  organizationId: string
  userId: string
  reply: string
}

export interface DecideResult {
  status: 'approved' | 'rejected'
  executed: boolean
  /** Set when a suspended run should be resumed with the decision result — the
   *  caller (approval route) triggers resumeAgentExecution to avoid a cycle. */
  resume?: ResumeInfo
}

/** Resume info for a run suspended on this approval, or undefined if not suspended. */
async function resumeInfoFor(executionId: string, organizationId: string, reply: string): Promise<ResumeInfo | undefined> {
  const execution = await prisma.agentExecution.findFirst({ where: { id: executionId, organizationId } })
  if (!execution || execution.status !== 'waiting_for_approval' || !execution.agentTaskId) return undefined
  return { executionId: execution.id, agentId: execution.agentTaskId, organizationId, userId: execution.userId, reply }
}

/**
 * Approve (execute the queued write) or reject (drop it) an approval, scoped to
 * the deciding user's organization. Idempotent: a non-pending request returns
 * its current state without re-executing.
 */
export async function decideApproval(input: {
  approvalId: string
  organizationId: string
  deciderUserId: string
  approve: boolean
}): Promise<DecideResult> {
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: input.approvalId, organizationId: input.organizationId },
  })
  if (!approval) throw new Error('Approval not found')
  if (approval.status !== 'pending') {
    return { status: approval.status === 'rejected' ? 'rejected' : 'approved', executed: false }
  }

  if (!input.approve) {
    // Atomic claim: only the request that flips pending→rejected proceeds.
    const claimed = await prisma.approvalRequest.updateMany({
      where: { id: approval.id, organizationId: input.organizationId, status: 'pending' },
      data: { status: 'rejected', decidedById: input.deciderUserId, decidedAt: new Date() },
    })
    if (claimed.count !== 1) return currentDecision(input.approvalId, input.organizationId)
    await recordAudit({
      organizationId: input.organizationId,
      executionId: approval.executionId,
      actorUserId: input.deciderUserId,
      action: 'approval.rejected',
      tool: approval.tool,
      resourceId: approval.id,
    })
    const resume = await resumeInfoFor(
      approval.executionId,
      input.organizationId,
      JSON.stringify({ status: 'rejected', message: 'The approver rejected this action. Do not retry it; continue without it.' }),
    )
    return { status: 'rejected', executed: false, resume }
  }

  // Approve: atomically claim the pending request (pending→approving) so exactly
  // ONE approver executes the delivery. Delivery (Nango) is NOT idempotent, and
  // two concurrent approvals both passed the read above — the claim is the race
  // guard: a losing caller sees status != pending and is a no-op.
  const claimed = await prisma.approvalRequest.updateMany({
    where: { id: approval.id, organizationId: input.organizationId, status: 'pending' },
    data: { status: 'approving', decidedById: input.deciderUserId, decidedAt: new Date() },
  })
  if (claimed.count !== 1) return currentDecision(input.approvalId, input.organizationId)

  const payload = approval.payload as {
    provider: string
    capability: DeliveryCapability | null
    args: Record<string, unknown>
    userId: string
  }
  let executed = false
  let writeResult: unknown = null
  try {
    if (payload.capability) {
      const spec = DELIVERY_TOOLS.find((tool) => tool.capability === payload.capability)
      const connection = await resolveDeliveryConnection(input.organizationId, payload.capability, payload.userId)
      if (spec && connection) {
        writeResult = await spec.run(connection, payload.args)
        executed = true
      }
    }
  } catch (error) {
    // Delivery failed after we claimed it — mark failed (not back to pending) so
    // a possibly-partial, non-idempotent write is never silently re-approved.
    await prisma.approvalRequest.update({ where: { id: approval.id }, data: { status: 'failed' } }).catch(() => undefined)
    await recordAudit({
      organizationId: input.organizationId,
      executionId: approval.executionId,
      actorUserId: input.deciderUserId,
      action: 'approval.failed',
      tool: approval.tool,
      resourceType: payload.provider,
      resourceId: approval.id,
    }).catch(() => undefined)
    throw error
  }

  await prisma.approvalRequest.update({
    where: { id: approval.id },
    data: { status: 'approved' },
  })
  await recordAudit({
    organizationId: input.organizationId,
    executionId: approval.executionId,
    actorUserId: input.deciderUserId,
    action: 'approval.approved',
    tool: approval.tool,
    resourceType: payload.provider,
    resourceId: approval.id,
    payload: payload.args,
  })
  const resume = await resumeInfoFor(
    approval.executionId,
    input.organizationId,
    JSON.stringify({ status: 'approved', executed, result: writeResult }),
  )
  return { status: 'approved', executed, resume }
}

/** Report the settled decision for a request another caller already claimed. */
async function currentDecision(approvalId: string, organizationId: string): Promise<DecideResult> {
  const current = await prisma.approvalRequest.findFirst({ where: { id: approvalId, organizationId } })
  // 'approving' = another approver is mid-execution; surface it as approved
  // (not executed by us) rather than implying it's still actionable.
  return { status: current?.status === 'rejected' ? 'rejected' : 'approved', executed: false }
}
