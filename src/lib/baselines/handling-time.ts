/**
 * Estimated minutes of human handling per occurrence of an action.
 *
 * This table is the ONE estimated input in an otherwise measured pipeline:
 * volume, cadence, cycle time and rework are counted from observed events, and
 * only minutes-per-action is judged. Keeping it curated, versioned, and
 * identical across customers is what makes a day-one ROI figure auditable — an
 * LLM estimating here would reintroduce exactly the unfalsifiability the
 * baselines layer exists to remove.
 *
 * Values are the click PLUS the thinking around it — the realistic cost of a
 * human doing this once, not the keystroke time.
 *
 * Bump HANDLING_TIME_TABLE_VERSION on any value change. Baselines record the
 * version they were computed under so a revision cannot silently restate
 * historical figures.
 */
export const HANDLING_TIME_TABLE_VERSION = 1

/** Upper bound on an override, mirroring the guard on laborHourlyRate. */
const MAX_OVERRIDE_MINUTES = 480

export const HANDLING_TIME_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  // CRM.
  created_deal: 6,
  deal_stage_changed: 2,
  logged_email: 4,
  logged_call: 3,
  completed_task: 5,

  // Engineering.
  opened_pr: 10,
  opened_issue: 5,
  pushed_commit: 2,
  merged_pr: 4,
  closed_pr: 2,

  // Communication and meetings.
  posted_message: 1,
  replied_in_thread: 1,
  held_meeting: 30,
  took_meeting_notes: 15,
})

function overrideFor(action: string, settings: unknown): number | null {
  const blob = (settings ?? {}) as Record<string, unknown>
  const overrides = blob.handlingTimeOverrides
  // Arrays are objects to typeof, and would index numerically — never an
  // override map.
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return null
  const value = (overrides as Record<string, unknown>)[action]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value <= 0 || value > MAX_OVERRIDE_MINUTES) return null
  return value
}

/**
 * Minutes per occurrence for an action. Org override wins; otherwise the
 * curated default. Null for actions the table does not cover — an unknown
 * action yields no cost estimate rather than a fabricated one.
 */
export function resolveHandlingMinutes(action: string, settings: unknown): number | null {
  const override = overrideFor(action, settings)
  if (override !== null) return override
  return HANDLING_TIME_MINUTES[action] ?? null
}
