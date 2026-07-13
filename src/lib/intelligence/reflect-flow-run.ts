import { prisma } from '@/lib/prisma'
import { orgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'
import { FLOW_TARGET_MARKER_PREFIX } from '@/lib/intelligence/suggest-workflows'
import type { FlowGraph } from '@/lib/flows/graph'

/**
 * Evidence-based, flow-level learning pass. It never edits a live workflow:
 * recurring run evidence becomes a reviewable proposal, and accepted/dismissed
 * states are retained as feedback for later synthesis passes.
 */
export async function reflectFlowRun(params: { organizationId: string; flowId: string; flowRunId: string; graph: FlowGraph; status: string; error?: string | null }) {
  if (params.status !== 'failed' || !params.error) return
  const recent = await prisma.flowRun.findMany({
    where: { organizationId: params.organizationId, flowId: params.flowId, status: 'failed' },
    orderBy: { startedAt: 'desc' },
    take: 10,
    select: { error: true },
  })
  const signature = params.error.slice(0, 120)
  const repeats = recent.filter((run) => run.error?.slice(0, 120) === signature).length
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
  const recommendation = failingNode?.type === 'http' || failingNode?.type === 'tool'
    ? 'Add bounded retries for transient errors and place the action in an Error shield with a fallback path.'
    : 'Add an Error shield and a fallback or notification path around the failing portion of the workflow.'
  await prisma.agentMemory.create({ data: {
    organizationId: params.organizationId,
    agentId,
    kind: 'suggestion',
    title,
    content: `${recommendation} Evidence: ${repeats} of the 10 most recent runs failed with “${signature}”.`,
    question: marker,
    sourceExecutionId: params.flowRunId,
  } })
}
