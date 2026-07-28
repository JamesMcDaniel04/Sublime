/**
 * The block injected into a goal-linked agent's prompt: what its work has
 * taught us, and the rules that follow from it. Pure so the copy is testable
 * and so nothing here can reach a database mid-run.
 *
 * Deliberately descriptive. It reports what people did with the work and what
 * they said happened next; it never claims the work CAUSED the goal to move.
 */
import type { WorkFunnel } from '@/lib/goals/work-stats'

export type FeedbackRule = {
  id: string
  statement: string
  skippedCount: number
  totalCount: number
  topSkipReason: string | null
  exploreRate: number
}

export type FeedbackInput = {
  goalName: string
  stats: WorkFunnel
  skipReasons: Array<{ reason: string; count: number }>
  rules: FeedbackRule[]
}

/** Raw enum values must never reach a prompt — they read as internal state. */
const REASON_WORDS: Record<string, string> = {
  too_early: 'too early',
  wrong_contact: 'wrong contact',
  wrong_content: 'wrong content',
  already_handled: 'already handled',
  not_relevant: 'not relevant',
  other: 'other',
}

const humanReason = (reason: string) => REASON_WORDS[reason] ?? reason.replace(/_/g, ' ')

/** 0.2 → "1 in 5". A bare decimal in a prompt invites reinterpretation. */
function asRatio(rate: number): string {
  const denominator = Math.max(2, Math.round(1 / (rate > 0 ? rate : 0.2)))
  return `1 in ${denominator}`
}

export function renderWorkFeedback(input: FeedbackInput): string {
  const hasStats = input.stats.produced > 0
  // A block that says "0 produced" on a brand-new goal is noise, not feedback.
  if (!hasStats && input.rules.length === 0) return ''

  const lines = ['## What your work has taught us']

  if (hasStats) {
    const { produced, used, worked } = input.stats
    lines.push(
      '',
      `On this goal, your last 30 days: ${produced} produced · ${used} used · ${worked} worked.`,
    )
    const skipped = produced - used
    if (skipped > 0 && input.skipReasons.length > 0) {
      const reasons = input.skipReasons
        .map((entry) => `${humanReason(entry.reason)} ×${entry.count}`)
        .join(', ')
      lines.push(`People skipped ${skipped} — reasons: ${reasons}.`)
    }
  }

  if (input.rules.length > 0) {
    lines.push('', 'Rules you must follow:')
    for (const rule of input.rules) {
      lines.push(`- ${rule.statement}`)
      const reason = rule.topSkipReason ? `, mostly "${humanReason(rule.topSkipReason)}"` : ''
      lines.push(`  (${rule.skippedCount} of ${rule.totalCount} skipped${reason})`)
      lines.push(
        `  Probe: work roughly ${asRatio(rule.exploreRate)} of these anyway and pass ` +
          `probeRuleId "${rule.id}" to log_work, so we find out if this still holds.`,
      )
    }
  }

  return lines.join('\n')
}
