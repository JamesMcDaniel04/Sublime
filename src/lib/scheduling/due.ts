/**
 * Pure, side-effect-free scheduling due-check.
 * No external dependencies — uses only built-in Intl APIs.
 */

export type AgentSchedule = {
  type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron' | 'once'
  /** HH:MM – used by daily, weekly, and once */
  time: string
  /** Standard 5-field cron expression – used by type === 'cron' */
  cron: string
  /** IANA timezone string, e.g. "America/New_York" */
  timezone: string
  /** YYYY-MM-DD calendar date – used only by type === 'once' (with `time`). */
  runAt?: string
  isActive: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads the current date-time components for a given instant in the supplied
 * IANA timezone, using Intl.DateTimeFormat.
 */
function zoneParts(instant: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const p = fmt.formatToParts(instant)
  const get = (type: string) => Number(p.find((x) => x.type === type)!.value)
  return {
    year: get('year'),
    month: get('month'),   // 1-based
    day: get('day'),
    hour: get('hour'),     // 0–23
    minute: get('minute'),
    second: get('second'),
    // day-of-week 0 (Sun)–6 (Sat)
    dow: new Date(get('year'), get('month') - 1, get('day')).getDay(),
  }
}

/**
 * Returns the UTC timestamp for HH:MM on the given Y/M/D (1-based month) in the
 * supplied timezone. Constructs the naive UTC instant with the target wall-clock
 * fields, then measures how far off Intl reports it in the zone and corrects —
 * so DST offsets and half-hour zones resolve to the right instant.
 */
function instantForDate(year: number, month: number, day: number, hhmm: string, tz: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number)
  const naive = Date.UTC(year, month - 1, day, hh, mm, 0, 0)
  const check = zoneParts(new Date(naive), tz)
  const diffMs = ((hh - check.hour) * 60 + (mm - check.minute)) * 60_000
  return new Date(naive + diffMs)
}

/**
 * Returns the UTC timestamp for HH:MM today in the given timezone.
 * "Today" is determined by what `now` looks like in that zone.
 */
function todayInstant(hhmm: string, tz: string, now: Date): Date {
  const p = zoneParts(now, tz)
  return instantForDate(p.year, p.month, p.day, hhmm, tz)
}

// ---------------------------------------------------------------------------
// Minimal 5-field cron matcher
// Supports: * | */n | comma lists | ranges (a-b) for each field
// Fields: minute hour dom month dow
// ---------------------------------------------------------------------------

function matchField(expr: string, value: number, min: number, _max: number): boolean {
  for (const part of expr.split(',')) {
    if (part === '*') return true
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10)
      if (!isNaN(step) && step > 0 && (value - min) % step === 0) return true
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number)
      if (value >= lo && value <= hi) return true
    } else {
      if (parseInt(part, 10) === value) return true
    }
  }
  return false
}

/**
 * Returns true if `now` matches the 5-field cron expression
 * (evaluated in the given timezone).
 */
function matchesCron(expr: string, tz: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minF, hourF, domF, monF, dowF] = fields
  const p = zoneParts(now, tz)
  return (
    matchField(minF, p.minute, 0, 59) &&
    matchField(hourF, p.hour, 0, 23) &&
    matchField(domF, p.day, 1, 31) &&
    matchField(monF, p.month, 1, 12) &&
    matchField(dowF, p.dow, 0, 6)
  )
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns true when the agent with the given schedule is due to run.
 *
 * Pure function — has no side effects; safe to call in tight loops.
 */
export function isDue(
  schedule: AgentSchedule,
  lastExecutedAt: Date | null,
  now: Date,
): boolean {
  if (!schedule.isActive) return false
  if (schedule.type === 'manual') return false

  switch (schedule.type) {
    case 'once': {
      // A one-time run: due once its target instant has passed and it has never
      // run. lastExecutedAt being set after the first run makes it never fire
      // again. runAt is a YYYY-MM-DD date paired with `time` in `timezone`.
      if (!schedule.runAt) return false
      const [y, mo, d] = schedule.runAt.split('-').map(Number)
      if (!y || !mo || !d) return false
      const target = instantForDate(y, mo, d, schedule.time || '09:00', schedule.timezone || 'UTC')
      if (now < target) return false
      return lastExecutedAt === null
    }

    case 'hourly': {
      if (lastExecutedAt === null) return true
      return now.getTime() - lastExecutedAt.getTime() >= 60 * 60_000
    }

    case 'daily': {
      const scheduled = todayInstant(schedule.time || '00:00', schedule.timezone || 'UTC', now)
      if (now < scheduled) return false
      if (lastExecutedAt === null) return true
      return lastExecutedAt < scheduled
    }

    case 'weekly': {
      if (lastExecutedAt !== null) {
        const sevenDaysMs = 7 * 24 * 60 * 60_000
        if (now.getTime() - lastExecutedAt.getTime() < sevenDaysMs) return false
      }
      // Also require that now is past today's scheduled time
      const scheduled = todayInstant(schedule.time || '00:00', schedule.timezone || 'UTC', now)
      if (now < scheduled) return false
      return true
    }

    case 'cron': {
      if (!schedule.cron) return false
      const tz = schedule.timezone || 'UTC'

      // Catch-up based: the agent is due if ANY cron-matching minute exists in
      // the window (since, now]. This means an infrequent dispatch tick still
      // fires a cron like "0 9 * * *" even when the tick minute is not 09:00.
      //
      // since = lastExecutedAt ?? (now - 25h). Clamp the scan so we never
      // iterate more than 400 days of minutes (cap `since` to now - 400 days).
      const MINUTE_MS = 60_000
      const DEFAULT_LOOKBACK_MS = 25 * 60 * 60 * 1000 // 25h
      const MAX_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000 // 400 days

      const sinceMs = lastExecutedAt ? lastExecutedAt.getTime() : now.getTime() - DEFAULT_LOOKBACK_MS
      const flooredSince = Math.max(sinceMs, now.getTime() - MAX_LOOKBACK_MS)

      // Iterate minute-by-minute from `now` backward to (but not including)
      // `since`, truncating seconds/millis. `(since, now]` is half-open at the
      // start, so we stop once the candidate minute is <= since.
      let cursor = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS
      while (cursor > flooredSince) {
        if (matchesCron(schedule.cron, tz, new Date(cursor))) return true
        cursor -= MINUTE_MS
      }
      return false
    }

    default:
      return false
  }
}
