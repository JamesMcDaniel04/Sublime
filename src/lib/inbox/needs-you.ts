/**
 * "Needs you": everything in the workspace that is waiting on THIS person,
 * as one queue.
 *
 * Every source already existed — a run parked on ask_user or a held approval,
 * a flow paused for input, agent work assigned to someone, a goal that needs a
 * decision. What did not exist was one place to see them ordered by how long
 * they have waited, with the decision one key away. At any real volume that
 * queue is the product surface most people touch most days.
 *
 * Pure: the route fetches, this shapes. Oldest first, because the item that
 * has waited longest is the one costing the most.
 */

export type NeedsYouKind = 'ask' | 'approval' | 'flow_wait' | 'work' | 'goal_action'

export type NeedsYouAction =
  | { kind: 'reply'; executionId: string }
  | { kind: 'approve'; executionId: string }
  | { kind: 'use_work'; goalId: string; workId: string }
  | { kind: 'open'; href: string }

export type NeedsYouItem = {
  id: string
  kind: NeedsYouKind
  /** Who or what is asking — an agent's name, a flow's name, a goal's name. */
  subject: string
  /** The question, the held call, the work subject, the recommendation. */
  detail: string
  waitingSince: string
  ageMs: number
  href: string
  actions: NeedsYouAction[]
}

export type WaitingExecutionRow = {
  id: string
  startedAt: Date
  metadata: unknown
  agentTask: { id: string; description: string | null; metadata: unknown } | null
}
export type WaitingFlowRunRow = {
  id: string
  flowId: string
  startedAt: Date
  waiting: { kind: 'input' | 'time'; question?: string } | null
  flow: { name: string }
}
export type PendingWorkRow = {
  id: string
  goalId: string
  subject: string
  produced: string
  createdAt: Date
  goal: { name: string }
}
export type GoalActionRow = {
  id: string
  title: string
  description: string
  targetId: string | null
  createdAt: Date
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function agentName(agent: WaitingExecutionRow['agentTask']): string {
  const title = record(agent?.metadata).title
  return (typeof title === 'string' && title.trim()) || agent?.description?.trim() || 'An agent'
}

export function shapeNeedsYou(
  input: {
    executions: WaitingExecutionRow[]
    flowRuns: WaitingFlowRunRow[]
    work: PendingWorkRow[]
    goalActions: GoalActionRow[]
  },
  now: Date = new Date(),
): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  const age = (since: Date) => Math.max(0, now.getTime() - since.getTime())

  for (const run of input.executions) {
    const meta = record(run.metadata)
    const approval = record(meta.pendingApproval)
    const question = record(meta.pendingQuestion)
    const held = typeof approval.node === 'string' ? approval.node : null
    items.push({
      id: `run:${run.id}`,
      kind: held ? 'approval' : 'ask',
      subject: agentName(run.agentTask),
      detail: held
        ? `wants to run ${held}`
        : (typeof question.question === 'string' && question.question.trim()) || 'asked a question',
      waitingSince: run.startedAt.toISOString(),
      ageMs: age(run.startedAt),
      href: `/agents?run=${run.id}`,
      actions: held ? [{ kind: 'approve', executionId: run.id }] : [{ kind: 'reply', executionId: run.id }],
    })
  }

  for (const run of input.flowRuns) {
    // A timed wait needs nobody; only an input wait is a person's to answer.
    if (!run.waiting || run.waiting.kind !== 'input') continue
    items.push({
      id: `flow:${run.id}`,
      kind: 'flow_wait',
      subject: run.flow.name,
      detail: run.waiting.question?.trim() || 'is waiting for input',
      waitingSince: run.startedAt.toISOString(),
      ageMs: age(run.startedAt),
      href: `/flows/${run.flowId}/activity`,
      actions: [{ kind: 'open', href: `/flows/${run.flowId}/activity` }],
    })
  }

  for (const item of input.work) {
    items.push({
      id: `work:${item.id}`,
      kind: 'work',
      subject: item.goal.name,
      detail: `${item.subject} — ${item.produced}`,
      waitingSince: item.createdAt.toISOString(),
      ageMs: age(item.createdAt),
      href: `/goals/${item.goalId}`,
      // Skip needs a reason (the countable vocabulary the rules learn from),
      // so it stays in the workroom; Use is the one-key decision.
      actions: [{ kind: 'use_work', goalId: item.goalId, workId: item.id }, { kind: 'open', href: `/goals/${item.goalId}` }],
    })
  }

  for (const action of input.goalActions) {
    const href = action.targetId ? `/goals/${action.targetId}` : '/goals'
    items.push({
      id: `goal:${action.id}`,
      kind: 'goal_action',
      subject: action.title,
      detail: action.description,
      waitingSince: action.createdAt.toISOString(),
      ageMs: age(action.createdAt),
      href,
      actions: [{ kind: 'open', href }],
    })
  }

  return items.sort((a, b) => b.ageMs - a.ageMs)
}

/** "12m", "3h", "2d" — enough precision to feel the wait, no more. */
export function formatAge(ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
