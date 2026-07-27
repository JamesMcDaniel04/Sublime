/**
 * Goal-native seed templates — agents whose subject IS a Sublime goal, built on
 * the native:sublime-goals tool plane (spec 2026-07-27).
 *
 * Kept out of catalogue.ts, which already carries 80 seeds.
 *
 * CRITICAL: 'goals' belongs in `integrations`, never `requiredIntegrations`.
 * Readiness compares required slugs against CONNECTED slugs, and the goals
 * plane has no connection to make (its descriptor is available: () => true,
 * scoped by GoalContribution). Requiring it would render every one of these
 * permanently blocked behind a Connect button that cannot be satisfied.
 *
 * Deliberately absent: a "why is this off track" diagnoser (that is
 * src/lib/goals/recovery.ts) and a weekly pace digest (src/lib/goals/digest.ts).
 */
import type { Department } from './departments'
import type { SeedTemplate } from './catalogue'

export const GOAL_PACE_AUDITOR_KEY = 'goal-pace-auditor'
export const GOAL_METRIC_COLLECTOR_KEY = 'goal-metric-collector'
export const GOAL_PERIOD_CLOSE_KEY = 'goal-period-close-reporter'

/**
 * These agents are department-agnostic: they work on any goal, and their only
 * tools are the goals plane plus glue (Slack/Gmail/HTTP). departmentsForTools
 * classifies glue as no department signal at all, so claiming sales/engineering
 * here would assert domain expertise no tool backs. 'general' is the honest
 * classification and the one the catalogue's anchor invariant expects.
 */
const ANY_DEPARTMENT: Department[] = ['general']

const daily = (hour: number) => ({
  type: 'schedule' as const,
  schedule: {
    type: 'cron' as const,
    cron: `0 ${hour} * * *`,
    time: '',
    timezone: 'UTC',
    isActive: true,
  },
})

const monthly = {
  type: 'schedule' as const,
  schedule: {
    type: 'cron' as const,
    cron: '0 9 1 * *',
    time: '',
    timezone: 'UTC',
    isActive: true,
  },
}

export const GOAL_NATIVE_SEEDS: SeedTemplate[] = [
  {
    seedKey: GOAL_PACE_AUDITOR_KEY,
    name: 'Goal Pace Auditor',
    description:
      'Checks the goal against its pace every morning and posts to Slack only when it is falling behind, naming the gap and the run-rate now needed.',
    departments: ANY_DEPARTMENT,
    requiredIntegrations: ['slack'],
    recommendedIntegrations: [],
    integrations: ['goals', 'slack'],
    kind: 'agent',
    icon: '⏱️',
    estimatedMinutesSaved: 10,
    trigger: daily(8),
    instructions: [
      'You audit one goal against its pace, once a day.',
      '',
      'Call get_pace. If riskLevel is "on_track", post NOTHING and reply "on track, no post" — a daily "still fine" message trains people to ignore you.',
      '',
      'If riskLevel is "at_risk" or "off_track", call get_goal for the target and unit, then post one Slack message that states: the current value against the target, how far behind pace it is, the run-rate now required per day to finish on time, and the number of days remaining. Use the goal\'s unit. Be specific and short — no preamble, no encouragement.',
      '',
      'If riskLevel is "no_data", say so plainly and note when the metric was last read, rather than guessing.',
    ].join('\n'),
  },
  {
    seedKey: GOAL_METRIC_COLLECTOR_KEY,
    name: 'Goal Metric Collector',
    description:
      'Finds the current number for a goal you track by hand — in a Slack channel, an inbox, or a web page — and records it against the goal automatically.',
    departments: ANY_DEPARTMENT,
    requiredIntegrations: [],
    recommendedIntegrations: ['slack', 'gmail'],
    integrations: ['goals', 'slack', 'gmail', 'http'],
    // The one delivery-exempt seed: its output is a datapoint written back to
    // the goal, not a message, so it has no channel to require. See
    // normalizeDelivery in ./catalogue.
    deliversToGoal: true,
    kind: 'agent',
    icon: '📥',
    estimatedMinutesSaved: 15,
    trigger: daily(7),
    instructions: [
      'You keep one manually-tracked goal up to date.',
      '',
      'Call get_goal to learn what is being measured and in what unit. Then find the current value from the source described below, and record it with log_datapoint.',
      '',
      'SOURCE: describe here where the number lives — a Slack channel, a mailbox search, or a URL. Edit this line when you deploy the agent.',
      '',
      'Rules: record a number only when you have actually read it from the source. Never estimate, never interpolate, never carry yesterday\'s value forward. If you cannot find a current reading, call list_datapoints to confirm what was last recorded and report that you found nothing new — leaving the series honest matters more than filling it.',
      '',
      'If log_datapoint refuses because the goal is tracked from a system of record, stop and report the number in your output instead. That refusal is correct and must not be worked around.',
    ].join('\n'),
  },
  {
    seedKey: GOAL_PERIOD_CLOSE_KEY,
    name: 'Goal Period Close Reporter',
    description:
      'When a recurring goal\'s period closes, reports how it actually landed against the target it was set — and how that compares with the period before.',
    departments: ANY_DEPARTMENT,
    requiredIntegrations: ['slack'],
    recommendedIntegrations: [],
    integrations: ['goals', 'slack'],
    kind: 'agent',
    icon: '📆',
    estimatedMinutesSaved: 20,
    trigger: monthly,
    instructions: [
      'You report on recurring goal periods after they close.',
      '',
      'Runs monthly regardless of the goal\'s own cadence. FIRST, call get_goal and list_datapoints and determine whether a period has actually closed since your last run. On a quarterly or yearly goal most runs will find nothing closed — when that is the case, post nothing and reply "no period closed".',
      '',
      'When a period HAS closed, post one Slack message covering: the final value against the target that period was set, whether that is a hit or a miss and by how much, and the change versus the previous period.',
      '',
      'Report the period that closed. Do not forecast the next one and do not recommend actions — a separate recovery plan owns that.',
    ].join('\n'),
  },
]
