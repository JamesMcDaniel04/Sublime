/**
 * Turns a stored schedule into a sentence in the viewer's own timezone.
 * Pure — no I/O, no date scanning — so it is safe to call on every render and
 * exhaustively unit-testable.
 *
 * Deliberately NOT built on nextOccurrence: its cron path scans minute-by-minute
 * and has measured ~13s worst case (see trigger-body.tsx), which is why that
 * editor printed a raw cron string instead of a label.
 *
 * `now` is injected rather than read from the clock because DST makes the
 * answer date-dependent: `0 7 * * *` UTC is 1:00 AM MDT in July and 12:00 AM
 * MST in January. That change is correct — the agent really does fire at a
 * different local time — so tests pin the reference instead of avoiding it.
 */

export type ScheduleLike = {
  type: string
  cron?: string
  time?: string
  timezone?: string
  isActive?: boolean
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]
const FALLBACK = 'On a custom schedule'

/** The hour and minute it fires, plus the days. `days: null` means every day. */
type CronParts = { hour: number; minute: number; days: number[] | null }

/** Cron day-of-week accepts both 0 and 7 for Sunday; normalize to 0-6. */
function parseDayOfWeek(field: string): number[] | null | undefined {
  if (field === '*') return null
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const range = /^([0-7])-([0-7])$/.exec(part)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > end) return undefined
      for (let day = start; day <= end; day += 1) days.add(day % 7)
      continue
    }
    if (!/^[0-7]$/.test(part)) return undefined
    days.add(Number(part) % 7)
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : undefined
}

/** Only the shapes we can phrase honestly. Steps, hour ranges, and
 *  day-of-month all return null so the caller falls back rather than
 *  describing a schedule it does not actually understand. */
function parseCron(expression: string): CronParts | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = Number(fields[0])
  const hour = Number(fields[1])
  if (!/^\d{1,2}$/.test(fields[0]) || minute < 0 || minute > 59) return null
  if (!/^\d{1,2}$/.test(fields[1]) || hour < 0 || hour > 23) return null
  if (fields[2] !== '*' || fields[3] !== '*') return null
  const days = parseDayOfWeek(fields[4])
  if (days === undefined) return null
  return { hour, minute, days }
}

/** How far the wall clock in `timeZone` runs ahead of UTC at `instant`. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0')
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  )
  return asUtc - instant.getTime()
}

/** The instant at which `timeZone` reads the given wall clock. Two passes so a
 *  wall time on the far side of a DST transition still resolves correctly. */
function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month, day, hour, minute)
  const firstPass = new Date(naive - zoneOffsetMs(new Date(naive), timeZone))
  return new Date(naive - zoneOffsetMs(firstPass, timeZone))
}

function datePartsIn(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0')
  return { year: read('year'), month: read('month') - 1, day: read('day') }
}

function weekdayIn(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant)
  return DAY_ABBREVIATIONS.indexOf(name)
}

function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant)
}

function joinDays(days: number[]): string {
  const names = days.map((day) => DAY_NAMES[day])
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Resolve a wall clock in `fromZone` into a concrete instant on or after
 *  `now`, so DST is settled by a real date rather than assumed. */
function occurrenceOn(
  weekday: number | null,
  hour: number,
  minute: number,
  fromZone: string,
  now: Date,
): Date {
  const { year, month, day } = datePartsIn(now, fromZone)
  const base = wallClockToInstant(year, month, day, hour, minute, fromZone)
  if (weekday === null) return base
  // Walk forward at most a week to land on the requested source-zone weekday.
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = wallClockToInstant(year, month, day + offset, hour, minute, fromZone)
    if (weekdayIn(candidate, fromZone) === weekday) return candidate
  }
  return base
}

export function describeSchedule(
  schedule: ScheduleLike,
  viewerTimeZone: string,
  now: Date,
): string {
  const paused = schedule.isActive === false ? ' (paused)' : ''
  const sourceZone = schedule.timezone || 'UTC'

  if (schedule.type === 'manual') return 'Runs manually'
  if (schedule.type === 'once') return `Runs once${paused}`
  if (schedule.type === 'hourly') return `Every hour${paused}`

  if (schedule.type === 'daily' || schedule.type === 'weekly') {
    const [hourText, minuteText] = (schedule.time || '').split(':')
    const hour = Number(hourText)
    const minute = Number(minuteText)
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return `${FALLBACK}${paused}`
    const instant = occurrenceOn(null, hour, minute, sourceZone, now)
    const cadence = schedule.type === 'daily' ? 'Every day' : 'Every week'
    return `${cadence} at ${formatTime(instant, viewerTimeZone)}${paused}`
  }

  if (schedule.type !== 'cron') return `${FALLBACK}${paused}`

  const parsed = parseCron(schedule.cron || '')
  if (!parsed) return `${FALLBACK}${paused}`

  if (parsed.days === null) {
    const instant = occurrenceOn(null, parsed.hour, parsed.minute, sourceZone, now)
    return `Every day at ${formatTime(instant, viewerTimeZone)}${paused}`
  }

  // Map each source-zone weekday through to the viewer's, which is where the
  // day can shift: Monday 01:00 UTC is Sunday evening in Denver.
  const occurrences = parsed.days.map((day) =>
    occurrenceOn(day, parsed.hour, parsed.minute, sourceZone, now),
  )
  const viewerDays = [
    ...new Set(occurrences.map((instant) => weekdayIn(instant, viewerTimeZone))),
  ].sort((a, b) => a - b)
  const time = formatTime(occurrences[0], viewerTimeZone)

  const isWeekdays =
    viewerDays.length === WEEKDAYS.length && WEEKDAYS.every((day) => viewerDays.includes(day))
  if (isWeekdays) return `Weekdays at ${time}${paused}`

  return `Every ${joinDays(viewerDays)} at ${time}${paused}`
}
