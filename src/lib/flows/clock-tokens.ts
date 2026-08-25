/**
 * `{{now}}` and `{{today}}` tokens.
 *
 * n8n's `$now`/`$today` are the most-reached-for expressions in its docs.
 * Sublime had no equivalent: a timestamp meant a `{{js:}}` escape or a whole
 * code step for something every third flow needs.
 *
 * Two decisions worth knowing, both load-bearing:
 *
 * **The instant is the run's start, not the wall clock at each read.** n8n's
 * `$now` is "this moment", so two tokens in one flow can disagree and a retry
 * writes different values than the attempt it is retrying. These values end up
 * in filenames, output records and idempotency keys, where being stable across
 * a retry is worth more than sub-second accuracy. A flow that wants elapsed
 * time can subtract inside a `{{js:}}` token.
 *
 * **Everything renders in the flow's timezone, defaulting to UTC.** Never the
 * server's: a date rendered in server time is the same class of bug as a
 * schedule that fires in server time, and it is invisible until someone in
 * another region reads the output.
 *
 * Pure and dependency-free — formatting goes through `Intl`, which ships with
 * Node and the browser and already carries the IANA database.
 */

/** Roots this module owns, so the path resolver can dispatch without guessing. */
export const CLOCK_ROOTS: ReadonlySet<string> = new Set(['now', 'today'])

export interface ClockContext {
  /** ISO instant the run started. */
  startedAt: string
  /** IANA zone. Absent means UTC — deliberately not the server zone. */
  timezone?: string
}

/** Parts of a date, resolved once in the target zone. */
type Parts = Record<string, string>

function partsIn(date: Date, timezone: string): Parts | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', hour12: false,
    })
    const out: Parts = {}
    for (const { type, value } of formatter.formatToParts(date)) out[type] = value
    // `hour12: false` yields "24" for midnight in some ICU versions.
    if (out.hour === '24') out.hour = '00'
    return out
  } catch {
    // An invalid IANA zone throws. Fall back rather than fail a run over a
    // typo in a setting — UTC is the documented default anyway.
    return null
  }
}

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
}

/**
 * Resolve a `now.*` / `today.*` path, or undefined when the path is not one of
 * ours — the caller falls through to its normal resolution.
 */
export function clockToken(path: string, ctx: ClockContext): unknown {
  const [root, ...rest] = path.trim().split('.')
  if (!CLOCK_ROOTS.has(root)) return undefined

  const date = new Date(ctx.startedAt)
  if (Number.isNaN(date.getTime())) return undefined

  const zone = ctx.timezone?.trim() || 'UTC'
  const parts = partsIn(date, zone) ?? partsIn(date, 'UTC')
  if (!parts) return undefined

  const ymd = `${parts.year}-${parts.month}-${parts.day}`

  // Bare roots.
  if (rest.length === 0) {
    // `now` is the instant itself — the full ISO string, not a rendering, so
    // it round-trips through Date.parse and sorts lexicographically.
    return root === 'now' ? date.toISOString() : ymd
  }

  // `today` carries no time-of-day parts; asking for one is a mistake worth
  // surfacing as undefined rather than silently answering from `now`.
  const DATE_ONLY = new Set(['date', 'year', 'month', 'day', 'weekday'])
  const key = rest.join('.')
  if (root === 'today' && !DATE_ONLY.has(key)) return undefined

  switch (key) {
    case 'iso': return date.toISOString()
    case 'date': return ymd
    case 'time': return `${parts.hour}:${parts.minute}:${parts.second}`
    case 'epoch': return date.getTime()
    case 'year': return Number(parts.year)
    case 'month': return Number(parts.month)
    case 'day': return Number(parts.day)
    case 'hour': return Number(parts.hour)
    case 'minute': return Number(parts.minute)
    case 'second': return Number(parts.second)
    case 'weekday': return ISO_WEEKDAY[parts.weekday ?? ''] ?? undefined
    case 'timezone': return zone
    // Anything else is undefined rather than a plausible-looking wrong value.
    default: return undefined
  }
}
