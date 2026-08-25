/**
 * Flow-level settings, read out of `Flow.metadata`.
 *
 * `metadata` is a Json grab-bag shared with behavioural provenance, and
 * `errorFlowId` was already living there with each reader re-deriving it by
 * hand. This is the one typed reader, so a setting is declared once and every
 * caller resolves it identically.
 *
 * Kept in `metadata` rather than promoted to columns deliberately: that is
 * where the existing setting lives, and flow settings are read with the flow
 * row rather than queried across flows. A setting that later needs an index
 * can graduate to a column then.
 */

/** Zones come from user input, so validity is checked rather than assumed. */
export function isValidTimezone(zone: string | undefined | null): boolean {
  if (typeof zone !== 'string' || !zone.trim()) return false
  try {
    // Throws RangeError on an unknown zone. Intl carries the IANA database in
    // both Node and the browser, so this needs no dependency and no list to
    // keep current.
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * Who may invoke this flow as a tool.
 *
 * `any`  — callable by an agent through the `flow:` tool plane (the default,
 *          and today's behaviour).
 * `none` — never callable as a tool. The flow still runs from its own
 *          trigger, its schedule, and a subflow step; this closes the AGENT
 *          door only.
 *
 * n8n's callerPolicy has more values because its concern is cross-workflow
 * calls between owners. Sublime's `flow:` plane is already org- and
 * read-scoped, so the question that remains is simply whether an agent may
 * decide to run this flow — and that is a yes/no.
 */
export type FlowCallerPolicy = 'any' | 'none'

/**
 * May this flow be offered to, and executed by, an agent?
 *
 * Absent means YES: every existing flow is agent-callable today and silently
 * removing them would break live agents. But an UNRECOGNISED value means NO —
 * unlike `timezone`, which degrades to a default. A governance control that
 * cannot parse its own setting must fail closed; the cost of wrongly denying
 * is a confused author, and the cost of wrongly allowing is an agent running
 * something nobody sanctioned.
 */
export function flowCallableAsTool(metadata: unknown): boolean {
  const bag =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {}
  const policy = bag.callerPolicy
  if (policy === undefined || policy === null) return true
  return policy === 'any'
}

export interface FlowSettings {
  /**
   * IANA zone for schedules and `{{now}}`/`{{today}}`.
   *
   * Defaults to UTC, deliberately NOT the server's zone: a flow must produce
   * the same result wherever it is deployed, and a schedule that silently
   * follows the host is the bug this setting exists to fix.
   */
  timezone: string
  /** Published flow to run when this one fails. */
  errorFlowId?: string
  /** Whether an agent may invoke this flow as a tool. */
  callerPolicy: FlowCallerPolicy
}

export const DEFAULT_FLOW_TIMEZONE = 'UTC'

export function flowSettings(metadata: unknown): FlowSettings {
  const bag =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {}

  const rawZone = typeof bag.timezone === 'string' ? bag.timezone.trim() : ''
  const errorFlowId = typeof bag.errorFlowId === 'string' && bag.errorFlowId.trim() ? bag.errorFlowId : undefined

  return {
    // An invalid zone degrades to the default rather than failing the run —
    // a typo in a setting should not take a flow offline.
    timezone: isValidTimezone(rawZone) ? rawZone : DEFAULT_FLOW_TIMEZONE,
    // Reported through the same predicate the enforcement points use, so the
    // builder can never show a policy the runtime does not apply.
    callerPolicy: flowCallableAsTool(metadata) ? 'any' : 'none',
    ...(errorFlowId ? { errorFlowId } : {}),
  }
}

/**
 * Zones offered in the builder.
 *
 * A curated list rather than the full IANA set (~600 entries): a select that
 * long is unusable, and the stored value is validated independently — an
 * imported flow carrying a zone outside this list still runs in it.
 * `Intl.supportedValuesOf('timeZone')` is deliberately not used, since its
 * result varies by runtime and would reorder the menu across deploys.
 */
export const FLOW_TIMEZONES: readonly string[] = [
  'UTC',
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon',
  'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam',
  'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Moscow',
  'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Cairo',
  'Asia/Jerusalem', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata',
  'Asia/Bangkok', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai',
  'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland',
]
