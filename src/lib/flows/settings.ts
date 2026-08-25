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
