import { completedKey } from './completed-key'

// A pause bubbles a 'waiting' row up through every enclosing loop/parallel/
// errorShield — each at a HIGHER order than the leaf it wraps (see
// resolveResumeState below) — so these node types never qualify as the resume
// target even though their own 'waiting' row sorts later than the leaf's.
const CONTAINER_NODE_TYPES = new Set(['loop', 'parallel', 'errorShield'])

export type PriorStepRow = {
  nodeId: string
  status: string
  output: unknown
  agentExecutionId: string | null
  iterationPath: string | null
}

export type ResumeState = {
  completed: Record<string, unknown>
  resumeNodeId?: string
  resumeExecutionId?: string
  pausedApprovalIds: Set<string>
}

/**
 * Reconstruct resume state from a run's persisted steps (order asc). A pause
 * bubbles a 'waiting' row up through every enclosing loop/parallel/errorShield
 * — each at a HIGHER order than the leaf it wraps — so plain last-wins-by-
 * order picks the container, not the leaf that's actually waiting on a reply.
 * Only a non-container row may become the resume target.
 */
export function resolveResumeState(priorSteps: PriorStepRow[], nodeTypeById: Map<string, string>): ResumeState {
  const completed: Record<string, unknown> = {}
  let resumeNodeId: string | undefined
  let resumeExecutionId: string | undefined
  const pausedApprovalIds = new Set<string>()
  for (const step of priorSteps) {
    if (step.status === 'succeeded' || step.status === 'skipped') {
      const path = step.iterationPath ? step.iterationPath.split('.').map(Number) : undefined
      completed[completedKey(step.nodeId, path)] = step.output
    }
    if (step.status === 'waiting') {
      const approvalId = (step.output as { waiting?: { approvalId?: string } } | null)?.waiting?.approvalId
      if (typeof approvalId === 'string' && approvalId) pausedApprovalIds.add(approvalId)
      if (!CONTAINER_NODE_TYPES.has(nodeTypeById.get(step.nodeId) ?? '')) {
        resumeNodeId = step.nodeId
        resumeExecutionId = step.agentExecutionId ?? undefined
      }
    }
  }
  return { completed, resumeNodeId, resumeExecutionId, pausedApprovalIds }
}
