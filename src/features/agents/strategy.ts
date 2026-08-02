/**
 * Strategize-mode heuristics + the goal/strategy prompt sections. Pure module
 * (no Prisma/LLM imports) so it is trivially unit-testable.
 */

export const STRATEGIZE_RETRIEVAL = { topK: 10, hops: 3 }

export function shouldStrategize(params: { objective: string; metadata: Record<string, unknown>; toolCount: number }): boolean {
  if (params.metadata.alwaysStrategize === true) return true
  if (params.objective.length > 1200) return true
  if (Number(params.metadata.maxTurns) > 16) return true
  if (params.toolCount > 25) return true
  return false
}

export function goalSection(goal: string | null | undefined): string {
  const trimmed = goal?.trim()
  if (!trimmed) return ''
  return `## Larger goal\nEverything you do this run should serve this goal: ${trimmed}\nWhen choices arise, pick the option that best advances it, and evaluate your final output against it.`
}

/**
 * Tells a goal-linked agent to record what it produces.
 *
 * Injected from the tools actually loaded for the run rather than baked into
 * stored instructions. Two reasons: stored text drifts from tool availability
 * (an agent linked to a goal AFTER creation would never be told), and an
 * instruction to call a tool the agent does not hold is worse than silence.
 *
 * Without this the whole work ledger is inert — the tools exist, the queue
 * renders, and every funnel reads zero because nothing was ever told to log.
 */
export function goalWorkSection(tools: { name: string }[]): string {
  const names = new Set(tools.map((tool) => tool.name))
  if (!names.has('log_work')) return ''

  const lines = [
    '## Recording your work',
    'This goal keeps a record of the work done toward it, and a person reviews that record. Anything you produce that a human should act on must be logged, or it is invisible to them.',
  ]

  if (names.has('list_work')) {
    lines.push(
      'Before you produce anything, call list_work. Do not redraft a subject that is still waiting on a human, and look at what people marked skipped — that is them telling you to stop producing that kind of thing. Adjust who and what you target accordingly.',
    )
  }

  lines.push(
    'Call log_work once per subject — one call per deal, lead, account or person. NEVER make one call that summarizes a batch: the record exists so a human can act on each item and say whether it landed, and a summary destroys both.',
    'Pass `subjectRef` (the source record id) so you do not re-draft the same subject next run, `assigneeHint` (the record owner, by name or email) so it reaches the right person, and put the finished artifact in `body`, ready to use with no editing.',
    'Logging is not delivery and does not replace it. Record the work, then finish the run as instructed.',
  )

  return lines.join('\n')
}

export function strategizeSection(): string {
  return [
    '## Think before acting',
    'This task is complex. Before calling ANY other tool, record a short plan with set_plan: the steps you will take, in order, each a short imperative sentence, ending with what "done" looks like. Then execute it.',
    'As you work, keep the plan honest with update_plan: mark each step done when it completes. When a step fails or returns something unexpected, mark it failed and pass revisedSteps with your new approach — never silently continue on a plan that reality has already broken.',
  ].join('\n')
}
