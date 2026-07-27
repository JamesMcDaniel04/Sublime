import type { GoalSummary } from '@/lib/types'

/** Chip definitions for the dashboard composer, minus icons (the dashboard
 *  attaches lucide icons — this module stays server/test friendly). */
export type GoalPreset = { label: string; prompt: string; sendNow: boolean }

/**
 * Active shared (non-personal) goals — what the "Organization goals" strip
 * and the goal-anchored composer chips are scoped to.
 */
export function activeOrgGoals<T extends Pick<GoalSummary, 'personal' | 'status'>>(
  goals: ReadonlyArray<T>,
): T[] {
  return goals.filter((goal) => !goal.personal && goal.status === 'active')
}

/**
 * Any active goal, personal or org. This is what should gate onboarding —
 * a user who only ever creates a personal goal (the default on /goals/new)
 * must still see the first-run guide's "goal" step complete and the
 * dashboard's no-goals CTA disappear.
 */
export function activeGoals<T extends Pick<GoalSummary, 'status'>>(goals: ReadonlyArray<T>): T[] {
  return goals.filter((goal) => goal.status === 'active')
}

/**
 * Goal-anchored composer chips. Returns null when the org has no active
 * shared goals so the dashboard falls back to its generic presets.
 */
export function goalPresets(
  goals: ReadonlyArray<Pick<GoalSummary, 'name' | 'personal' | 'status'>>,
): GoalPreset[] | null {
  const active = activeOrgGoals(goals)
  if (active.length === 0) return null
  const named = active.slice(0, 2)
  return [
    ...named.map((candidate) => ({
      label: `What moved on ${candidate.name} this week?`,
      prompt: `Summarize recent progress on our goal "${candidate.name}" — what moved, what stalled, and which agent runs contributed.`,
      sendNow: true,
    })),
    {
      label: 'Where am I losing time?',
      prompt:
        'Look across my workspace activity and connections. Where are we losing time to repetitive work that a specialized agent could take over?',
      sendNow: true,
    },
    {
      label: `Propose an agent for ${named[0].name}`,
      prompt: `Propose a specialized agent that would help us hit the goal "${named[0].name}". Describe what it would do, then build it.`,
      sendNow: false,
    },
  ]
}

/** One-line aggregate proof under the goal strip. Null hides the line. */
export function impactSentence(
  impact: { measured: { runsCompleted: number }; goalsTracked: number } | null,
): string | null {
  if (!impact || impact.measured.runsCompleted === 0) return null
  const runs = impact.measured.runsCompleted
  const goals = impact.goalsTracked
  const runNoun = runs === 1 ? 'run' : 'runs'
  const goalNoun = goals === 1 ? 'tracked goal' : 'tracked goals'
  return `Specialized agents have completed ${runs} ${runNoun} across ${goals} ${goalNoun}.`
}

export type FirstRunStep = {
  key: 'connect' | 'goal' | 'deploy'
  label: string
  detail: string
  href: string
  done: boolean
}

/**
 * First-run guide state, derived purely from counts — no persisted
 * "onboarding completed" flag. Steps complete in any order; the guide
 * disappears once all three exist.
 */
export function firstRunSteps(counts: {
  connections: number
  goals: number
  agents: number
}): { steps: FirstRunStep[]; showGuide: boolean } {
  const steps: FirstRunStep[] = [
    {
      key: 'connect',
      label: 'Connect your stack',
      detail:
        counts.connections > 0
          ? `${counts.connections} connected — add more anytime`
          : 'Plug in the tools your team already uses',
      href: '/integrations',
      done: counts.connections > 0,
    },
    {
      key: 'goal',
      label: 'Set a goal',
      detail:
        counts.goals > 0
          ? `${counts.goals} goal${counts.goals === 1 ? '' : 's'} tracked`
          : 'What are you trying to achieve? Quota, ARR, a launch date?',
      href: '/goals/new',
      done: counts.goals > 0,
    },
    {
      key: 'deploy',
      label: 'Deploy specialized agents against it',
      detail:
        counts.agents > 0
          ? `${counts.agents} agent${counts.agents === 1 ? '' : 's'} working`
          : 'Sublime proposes agents once a goal exists',
      href: '/agents',
      done: counts.agents > 0,
    },
  ]
  return { steps, showGuide: steps.some((step) => !step.done) }
}
