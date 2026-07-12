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
  // The resume target as a KEY, not a bare id — `completedKey(resumeNodeId,
  // resumeIterationPath)` — so a resume matches EXACTLY the one iteration
  // that paused, not every not-yet-completed iteration of that node id (see
  // interpret.ts's resume guards, which compare against this instead of the
  // bare `resumeNodeId`). For a non-loop pause (no iterationPath) this is
  // byte-identical to `resumeNodeId`.
  resumeKey?: string
  pausedApprovalIds: Set<string>
}

// Same parse the completed-map side uses (below) — so the two sides' keys
// always agree on format.
const parseIterationPath = (iterationPath: string | null): number[] | undefined =>
  iterationPath ? iterationPath.split('.').map(Number) : undefined

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
  let resumeKey: string | undefined
  const pausedApprovalIds = new Set<string>()
  for (const step of priorSteps) {
    if (step.status === 'succeeded' || step.status === 'skipped') {
      completed[completedKey(step.nodeId, parseIterationPath(step.iterationPath))] = step.output
    }
    if (step.status === 'waiting') {
      const approvalId = (step.output as { waiting?: { approvalId?: string } } | null)?.waiting?.approvalId
      if (typeof approvalId === 'string' && approvalId) pausedApprovalIds.add(approvalId)
      if (!CONTAINER_NODE_TYPES.has(nodeTypeById.get(step.nodeId) ?? '')) {
        resumeNodeId = step.nodeId
        resumeExecutionId = step.agentExecutionId ?? undefined
        resumeKey = completedKey(step.nodeId, parseIterationPath(step.iterationPath))
      }
    }
  }
  return { completed, resumeNodeId, resumeExecutionId, resumeKey, pausedApprovalIds }
}
