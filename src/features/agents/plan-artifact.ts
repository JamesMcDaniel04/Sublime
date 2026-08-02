/**
 * The persisted in-run plan: the numbered plan strategize mode used to leave
 * in model text, made a real artifact. Pure state machine + tool definitions;
 * execute-agent.ts owns persistence (AgentExecution.plan) and wiring.
 *
 * Design: never a gate. The tools are how the plan becomes real; a model that
 * ignores them still runs, and auditPlan turns that neglect into findings the
 * reflection pass (and therefore the next run's critique) gets to see.
 */
import type { ToolDefinition } from '@/lib/llm/model-runner'

export type PlanStepStatus = 'pending' | 'done' | 'failed' | 'skipped'

export type PlanStep = {
  n: number
  title: string
  status: PlanStepStatus
  note?: string
}

export type RunPlan = {
  steps: PlanStep[]
  revisions: Array<{ turn: number; reason: string }>
}

export type PlanAuditFinding = 'plan_never_set' | 'steps_left_pending' | 'failed_step_no_revision'

const MAX_STEPS = 20
const MAX_TITLE = 200
const MAX_NOTE = 500

export function createPlan(titles: string[]): RunPlan {
  const steps = titles
    .map((title) => title.trim().slice(0, MAX_TITLE))
    .filter((title) => title.length > 0)
    .slice(0, MAX_STEPS)
    .map((title, index) => ({ n: index + 1, title, status: 'pending' as const }))
  return { steps, revisions: [] }
}

export function applyPlanUpdate(
  plan: RunPlan,
  update: { stepN: number; status: PlanStepStatus; note?: string; revisedSteps?: string[]; turn: number },
): { plan?: RunPlan; error?: string } {
  const target = plan.steps.find((step) => step.n === update.stepN)
  if (!target) {
    return { error: `No step ${update.stepN} in the current plan. Steps: ${plan.steps.map((s) => s.n).join(', ')}` }
  }
  const note = update.note?.trim().slice(0, MAX_NOTE)
  if (update.revisedSteps && update.revisedSteps.length > 0) {
    if (update.status !== 'failed') {
      return { error: 'revisedSteps is only valid when marking a step failed.' }
    }
    if (!note) {
      return { error: 'A plan revision needs a note explaining why the approach changed.' }
    }
    if (createPlan(update.revisedSteps).steps.length === 0) {
      return { error: 'revisedSteps needs at least one non-empty step.' }
    }
  }
  let steps = plan.steps.map((step) =>
    step.n === update.stepN ? { ...step, status: update.status, ...(note ? { note } : {}) } : step,
  )
  let revisions = plan.revisions
  if (update.revisedSteps && update.revisedSteps.length > 0) {
    // A revision replaces everything still pending AFTER the updated step and
    // renumbers so step numbers stay unique — the model addresses steps by n.
    const kept = steps.filter((step) => step.n <= update.stepN || step.status !== 'pending')
    const fresh = createPlan(update.revisedSteps).steps
    steps = [...kept, ...fresh].map((step, index) => ({ ...step, n: index + 1 }))
    revisions = [...revisions, { turn: update.turn, reason: note! }]
  }
  return { plan: { steps, revisions } }
}

/** Deterministic plan-vs-actual findings at run end. Order is stable:
 *  never-set, then pending leftovers, then unrevised failures. */
export function auditPlan(plan: RunPlan | null, strategize: boolean): PlanAuditFinding[] {
  if (!plan || plan.steps.length === 0) return strategize ? ['plan_never_set'] : []
  const findings: PlanAuditFinding[] = []
  if (plan.steps.some((step) => step.status === 'pending')) findings.push('steps_left_pending')
  if (plan.steps.some((step) => step.status === 'failed') && plan.revisions.length === 0) {
    findings.push('failed_step_no_revision')
  }
  return findings
}

export const PLAN_TOOLS: ToolDefinition[] = [
  {
    name: 'set_plan',
    description:
      'Record your numbered plan for this run before doing any other work. Each step is a short imperative sentence. Call this once, first; use update_plan as steps complete, fail, or change.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'The plan, in order. One short imperative sentence per step.',
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'update_plan',
    description:
      'Update one plan step as you work: mark it done, failed, or skipped. When a step failed and you are changing approach, pass revisedSteps — the remaining steps that replace what is still pending — and say why in note.',
    inputSchema: {
      type: 'object',
      properties: {
        stepN: { type: 'number', description: 'The step number being updated.' },
        status: { type: 'string', enum: ['done', 'failed', 'skipped'], description: 'The step outcome.' },
        note: { type: 'string', description: 'One sentence: what happened, or why the plan changed.' },
        revisedSteps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only when re-planning after a failure: the steps that replace everything still pending.',
        },
      },
      required: ['stepN', 'status'],
    },
  },
]
