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

export function periodLabel(periodEnd: Date, recurrence: GoalRecurrence): string {
  if (recurrence === 'quarterly') {
    return `Q${Math.floor(periodEnd.getUTCMonth() / 3) + 1}`
  }
  if (recurrence === 'yearly') return String(periodEnd.getUTCFullYear())
  return periodEnd.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
}
