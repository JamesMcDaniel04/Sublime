/**
 * Re-runnable graph-RAG backfill for an organization.
 *
 * Seeds the graph from provider-neutral platform records already stored in the
 * workspace: agents, completed executions, and inbound signals. Stable node
 * ids make the operation idempotent, while caps keep large workspaces bounded.
 */

import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { commitGraph, nodeIds, type PendingNode } from './indexer'
import { ragEnabled } from './get-store'
import type { GraphEdge } from './store'

export interface BackfillResult {
  agents: number
  executions: number
  signals: number
  skipped?: string
}

const CAPS = { agents: 200, executions: 300, signals: 500 }

const clip = (text: string, max = 1500) => (text.length > max ? text.slice(0, max) : text)
const safe = (value: unknown) => {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? {})
  } catch {
    return ''
  }
}

export async function backfillOrganization(organizationId: string): Promise<BackfillResult> {
  if (!ragEnabled()) return { agents: 0, executions: 0, signals: 0, skipped: 'rag-disabled' }

  const nodes: PendingNode[] = []
  const edges: GraphEdge[] = []

  const agents = await prisma.agentTask.findMany({
    where: { organizationId, status: { not: 'DELETED' }, agentType: { not: 'SYSTEM' } },
    take: CAPS.agents,
    orderBy: { createdAt: 'desc' },
  })
  for (const agent of agents) {
    const metadata = (agent.metadata && typeof agent.metadata === 'object' ? agent.metadata : {}) as Record<string, unknown>
    const title = (metadata.title as string) || agent.description?.split('\n')[0] || 'Untitled agent'
    nodes.push({
      id: nodeIds.agent(agent.id),
      type: 'agent',
      text: clip(`Agent "${title}". ${agent.description ?? ''} Objective: ${agent.objective ?? ''}`, 1200),
      props: { agentId: agent.id, title },
      ownerUserId: agent.userId ?? null,
      visibility: agent.visibility === 'private' ? 'private' : 'shared',
    })
  }

  const executions = await prisma.agentExecution.findMany({
    where: { organizationId, status: 'completed' },
    take: CAPS.executions,
    orderBy: { startedAt: 'desc' },
    omit: { transcript: true },
    include: { agentTask: { select: { userId: true, visibility: true } } },
  })
  for (const execution of executions) {
    nodes.push({
      id: nodeIds.run(execution.id),
      type: 'run',
      text: clip(`Agent run (${execution.status}). Output: ${safe(execution.output)}`),
      props: { status: execution.status, agentTaskId: execution.agentTaskId },
      ownerUserId: execution.agentTask?.userId ?? null,
      visibility: execution.agentTask?.visibility === 'private' ? 'private' : 'shared',
    })
    if (execution.agentTaskId) {
      edges.push({ organizationId, from: nodeIds.run(execution.id), to: nodeIds.agent(execution.agentTaskId), rel: 'ran_agent' })
    }
    if (execution.signalId) {
      edges.push({ organizationId, from: nodeIds.signal(execution.signalId), to: nodeIds.run(execution.id), rel: 'triggered_run' })
    }
  }

  const signals = await prisma.signal.findMany({
    where: { organizationId },
    take: CAPS.signals,
    orderBy: { receivedAt: 'desc' },
  })
  for (const signal of signals) {
    nodes.push({
      id: nodeIds.signal(signal.id),
      type: 'signal',
      text: clip(`Workspace signal: ${signal.type}. ${safe(signal.payload)}`),
      props: { signalType: signal.type, accountId: signal.accountId, opportunityId: signal.opportunityId },
    })
    if (signal.accountId) {
      nodes.push({ id: nodeIds.account(signal.accountId), type: 'account', text: `Account ${signal.accountId}`, props: { accountId: signal.accountId } })
      edges.push({ organizationId, from: nodeIds.signal(signal.id), to: nodeIds.account(signal.accountId), rel: 'about_account' })
    }
    if (signal.opportunityId) {
      nodes.push({ id: nodeIds.opportunity(signal.opportunityId), type: 'opportunity', text: `Opportunity ${signal.opportunityId}`, props: { opportunityId: signal.opportunityId } })
      edges.push({ organizationId, from: nodeIds.signal(signal.id), to: nodeIds.opportunity(signal.opportunityId), rel: 'about_opportunity' })
    }
    if (signal.accountId && signal.opportunityId) {
      edges.push({ organizationId, from: nodeIds.opportunity(signal.opportunityId), to: nodeIds.account(signal.accountId), rel: 'belongs_to' })
    }
  }

  const byId = new Map<string, PendingNode>()
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node)
  const deduped = [...byId.values()]

  for (let index = 0; index < deduped.length; index += 64) {
    await commitGraph(organizationId, deduped.slice(index, index + 64), [])
  }
  if (edges.length) await commitGraph(organizationId, [], edges)

  const result = { agents: agents.length, executions: executions.length, signals: signals.length }
  apiLogger.info('rag backfill complete', { organizationId, ...result })
  return result
}
