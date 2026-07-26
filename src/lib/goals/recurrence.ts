export type GoalRecurrence = 'monthly' | 'quarterly' | 'yearly'

const MONTHS: Record<GoalRecurrence, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
}

/** Calendar advance with UTC end-of-month clamping. */
export function addPeriod(date: Date, recurrence: GoalRecurrence): Date {
  const result = new Date(date)
  const day = result.getUTCDate()
  result.setUTCDate(1)
  result.setUTCMonth(result.getUTCMonth() + MONTHS[recurrence])
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate()
  result.setUTCDate(Math.min(day, lastDay))
  return result
}

/**
 * Labels derive from the day BEFORE the exclusive periodEnd: a Jan 1 → Apr 1
 * window is Q1 (not Q2), and a Jun 1 → Jul 1 monthly window is Jun (not Jul).
 */
export function periodLabel(periodEnd: Date, recurrence: GoalRecurrence): string {
  const lastDay = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000)
  if (recurrence === 'quarterly') {
    return `Q${Math.floor(lastDay.getUTCMonth() / 3) + 1}`
  }
  if (recurrence === 'yearly') return String(lastDay.getUTCFullYear())
  return lastDay.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
}
