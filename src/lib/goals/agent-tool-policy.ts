/**
 * Write policy for the sublime-goals agent tool plane. Pure — no I/O, no
 * Prisma — so the rules that protect the tracked number are exhaustively
 * unit-testable.
 *
 * MetricDatapoint is unique on (goalMetricId, bucketKey), so a same-day write
 * REPLACES that day's row rather than appending. An unrestricted write could
 * therefore overwrite a synced Stripe reading with a model's guess. The
 * allowlist removes that structurally: a metric owned by a system of record has
 * no reachable write path at all.
 */

/** Sources where a human or an AI already supplies the number, so an agent
 *  write cannot displace a system of record. */
export const AGENT_WRITABLE_SOURCES: ReadonlySet<string> = new Set([
  'manual',
  'slack_assisted',
  'gmail_assisted',
])

/**
 * Origin stamped on an agent-written datapoint. Reuses the EXISTING 'assisted'
 * value that slack_assisted/gmail_assisted syncs already produce, so the UI's
 * "AI-read" labeling applies with no migration and no UI change. Never
 * introduce a distinct 'agent' origin without updating every reader.
 */
export const AGENT_DATAPOINT_ORIGIN = 'assisted' as const

/**
 * How to name each read-only source in a refusal. Deliberately local rather
 * than reusing the UI's SOURCE_LABELS ("Postgres / SQL", "I'll record values
 * myself") — those read as form options, not as the name of a system of record
 * in an error sentence.
 */
const OWNER_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  google_sheets: 'Google Sheets',
  postgres: 'Postgres',
  url: 'a URL',
}

export function canWriteDatapoint(source: string): boolean {
  return AGENT_WRITABLE_SOURCES.has(source)
}

export function writeRefusalMessage(source: string): string {
  const owner = OWNER_LABELS[source] ?? source
  return `Cannot write this goal's value — it is tracked from ${owner}. Report the number in your output instead.`
}

/**
 * Reject the two timestamps that would let a model fabricate history: a future
 * reading, and one pre-dating the goal itself. Backfilling older periods stays
 * a human action through the CSV import path.
 */
export function assertCapturedAt(capturedAt: Date, goalCreatedAt: Date, now: Date): void {
  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error('capturedAt is not a valid date')
  }
  if (capturedAt.getTime() > now.getTime()) {
    throw new Error('capturedAt cannot be in the future')
  }
  if (capturedAt.getTime() < goalCreatedAt.getTime()) {
    throw new Error(
      'capturedAt cannot pre-date the goal — use CSV import to backfill history',
    )
  }
}
