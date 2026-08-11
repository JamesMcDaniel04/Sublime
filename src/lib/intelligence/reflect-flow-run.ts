import { prisma } from '@/lib/prisma'
import { orgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'
import { FLOW_TARGET_MARKER_PREFIX } from '@/lib/intelligence/suggest-workflows'
import type { FlowGraph } from '@/lib/flows/graph'
import { flowObservationErrorClass } from './flow-observations'

/**
 * Evidence-based, flow-level learning pass. It never edits a live workflow:
 * recurring run evidence becomes a reviewable proposal, and accepted/dismissed
 * states are retained as feedback for later synthesis passes.
 */
export async function reflectFlowRun(params: { organizationId: string; flowId: string; flowRunId: string; graph: FlowGraph; status: string; error?: string | null }) {
  if (params.status !== 'failed' || !params.error) return
  const recent = await prisma.flowLearningObservation.findMany({
    where: { organizationId: params.organizationId, flowId: params.flowId, kind: 'run_outcome', outcome: { in: ['failed', 'ambiguous'] } },
    orderBy: { occurredAt: 'desc' },
    take: 10,
    select: { evidence: true },
  })
  const errorClass = flowObservationErrorClass(params.error) ?? 'runtime'
  const repeats = recent.filter((observation) => {
    const evidence = observation.evidence && typeof observation.evidence === 'object' && !Array.isArray(observation.evidence)
      ? observation.evidence as Record<string, unknown>
      : {}
    return evidence.errorClass === errorClass
  }).length
  if (repeats < 2) return

  const failingNode = params.graph.nodes.find((node) => {
    if (node.type === 'trigger') return false
    const label = 'label' in node.data ? node.data.label : undefined
    return params.error?.toLowerCase().includes((label ?? node.id).toLowerCase())
  })
  const failingLabel = failingNode && 'label' in failingNode.data ? failingNode.data.label : undefined
  const title = failingNode ? `Harden ${failingLabel ?? failingNode.id}` : 'Harden repeated workflow failure'
  const agentId = await orgIntelligenceAgentId(params.organizationId)
  const marker = `${FLOW_TARGET_MARKER_PREFIX}${params.flowId}`
  const existing = await prisma.agentMemory.findFirst({
    where: { organizationId: params.organizationId, agentId, kind: 'suggestion', question: marker, title, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  })
  if (existing) return
  const recommendation = errorClass === 'ambiguous_side_effect'
    ? 'Configure the provider’s documented idempotency header or argument before replaying this write; verify the existing provider result first.'
    : errorClass === 'authorization'
      ? 'Reconnect or replace the credential, then verify it before the next run.'
      : failingNode?.type === 'http' || failingNode?.type === 'tool'
        ? 'Add a fallback path. Enable bounded retries only for reads or writes protected by a provider idempotency key.'
        : 'Add an Error shield and a fallback or notification path around the failing portion of the workflow.'
  await prisma.agentMemory.create({ data: {
    organizationId: params.organizationId,
    agentId,
    kind: 'suggestion',
    title,
    content: `${recommendation} Evidence: ${repeats} of the 10 most recent structured run observations failed with class “${errorClass}”.`,
    question: marker,
    sourceExecutionId: params.flowRunId,
  } })
}
