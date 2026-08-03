/**
 * Display names for the activity-ledger sources.
 *
 * Deliberately a plain table rather than an import from
 * `@/lib/activity/registry`: that module pulls every adapter (and therefore
 * Prisma and the integration clients) into whatever imports it, which a client
 * component cannot do. Unknown sources fall back to a title-cased slug, so a
 * new adapter shows up readable here before anyone edits this file.
 */
const SOURCE_LABELS: Record<string, string> = {
  slack: 'Slack',
  github: 'GitHub',
  google_calendar: 'Google Calendar',
  hubspot: 'HubSpot',
  granola: 'Granola',
}

/** The sources with an adapter today — the filter chips on the activity page.
 *  Keep in step with `@/lib/activity/registry` (which cannot be imported into
 *  a client bundle, see above). */
export const ACTIVITY_SOURCES = ['slack', 'github', 'google_calendar', 'hubspot', 'granola'] as const

export function activitySourceLabel(source: string): string {
  return (
    SOURCE_LABELS[source] ??
    source
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  )
}
