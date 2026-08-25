/**
 * Schedule <-> cron conversion for the agent config form.
 *
 * Promoted verbatim from private helpers inside agent-config-form.tsx (1,673
 * lines) for the same reason goalReadWhere was promoted out of a route: logic
 * that decides WHEN an agent runs should be reachable by a test. Embedded in
 * the component it was not, so an off-by-one in the day-of-week list or a
 * silent fallback would have shipped as "the agent runs on the wrong day"
 * with nothing to catch it.
 *
 * Pure and synchronous by design — no clock, no DOM, no Intl (browserTimezone
 * stays in the component, since it is the one piece that reads the
 * environment). That is what makes the table of cases exhaustive rather than
 * sampled.
 */

/** The schedule slice of AgentDraft, spelled here so this module owns no UI types. */
export type ScheduleDraft = {
  type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron' | 'once'
  time?: string
  cron?: string
  timezone: string
  /** YYYY-MM-DD calendar date for a one-time ('once') run, paired with time. */
  runAt?: string
  isActive: boolean
}

/** The cadence concept the picker shows, mapped onto the backend schedule. */
export type Cadence = 'hourly' | 'daily' | 'weekly' | 'daysofweek' | 'once' | 'custom'

/**
 * Which cadence the picker should show for a schedule.
 *
 * A cron only counts as 'daysofweek' when it is EXACTLY the shape this UI
 * emits — literal minute and hour, wildcard day-of-month and month, and a
 * comma list of 0-6. Anything richer (steps, ranges, month restrictions) stays
 * 'custom' so the form never silently rewrites an expression a user
 * hand-authored.
 */
export function cadenceOf(schedule: ScheduleDraft): Cadence {
  if (schedule.type === 'once') return 'once'
  if (schedule.type === 'hourly') return 'hourly'
  if (schedule.type === 'daily') return 'daily'
  if (schedule.type === 'weekly') return 'weekly'
  if (schedule.type === 'cron') {
    const fields = (schedule.cron || '').trim().split(/\s+/)
    if (
      fields.length === 5 &&
      /^\d+$/.test(fields[0]) &&
      /^\d+$/.test(fields[1]) &&
      fields[2] === '*' &&
      fields[3] === '*' &&
      /^(?:[0-6](?:,[0-6])*)$/.test(fields[4])
    ) {
      return 'daysofweek'
    }
    return 'custom'
  }
  return 'daily'
}

/**
 * "HH:MM" + selected weekdays -> cron. An empty selection falls back to a
 * SINGLE day rather than a wildcard: widening a schedule to every day is the
 * dangerous direction, since it multiplies how often the agent runs.
 */
export function dowCron(time: string, days: number[]): string {
  const [hh, mm] = (time || '09:00').split(':').map((n) => parseInt(n, 10))
  const list = days.length ? [...days].sort((a, b) => a - b).join(',') : '1'
  // One invariant: whatever comes in, what goes out is a VALID cron. An
  // invalid one does not throw on save — it simply never matches, so the agent
  // quietly stops running, which is the worst way for a scheduler to fail.
  //
  // isFinite, not isNaN: a time with no colon ("garbage") splits to ONE
  // element, so mm destructures to undefined rather than NaN — and
  // Number.isNaN(undefined) is false, so the old guard let it through and
  // emitted the literal string "undefined" into the cron.
  return `${clamp(mm, 0, 59, 0)} ${clamp(hh, 0, 23, 9)} * * ${list}`
}

/** A cron field value, or `fallback` when the input cannot be one. */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/**
 * The weekday list a cron selects, for the picker. Days outside 0-6 are
 * dropped rather than shown, because the picker has no control that can
 * represent them; if nothing survives, weekdays are the default.
 */
export function daysFromCron(cron: string | undefined): number[] {
  const dow = (cron || '').trim().split(/\s+/)[4]
  if (!dow) return [1, 2, 3, 4, 5]
  const parsed = dow.split(',').map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6)
  return parsed.length ? parsed : [1, 2, 3, 4, 5]
}

/** The "HH:MM" a cron's minute/hour fields represent; 09:00 when unparseable. */
export function cronToTime(cron: string): string {
  const [minF, hourF] = (cron || '').trim().split(/\s+/)
  const mm = parseInt(minF, 10)
  const hh = parseInt(hourF, 10)
  if (Number.isNaN(mm) || Number.isNaN(hh)) return '09:00'
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/**
 * Fill in a schedule loaded from the API so the form has something to bind to.
 * An unrecognised type carrying a cron is treated as a cron schedule rather
 * than reset to manual — resetting would quietly disable a live agent.
 */
export function normalizeSchedule(schedule: ScheduleDraft): ScheduleDraft {
  const KNOWN_TYPES = new Set(['manual', 'hourly', 'daily', 'weekly', 'cron', 'once'])
  const type = (KNOWN_TYPES.has(schedule.type)
    ? schedule.type
    : schedule.cron?.trim() ? 'cron' : 'manual') as ScheduleDraft['type']
  const time = schedule.time?.trim()
    || (type === 'cron' && schedule.cron ? cronToTime(schedule.cron) : '')
    || '09:00'
  return {
    ...schedule,
    type,
    time,
    timezone: schedule.timezone?.trim() || 'UTC',
    isActive: Boolean(schedule.isActive),
  }
}
