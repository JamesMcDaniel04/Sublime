/**
 * The metric-source vocabulary, shared by the create API, the goal wizard and
 * the template catalogue. Lifted out of the API route so a template cannot
 * name a source the server would reject.
 */
export const METRIC_SOURCES = [
  'stripe',
  'hubspot',
  'salesforce',
  'google_sheets',
  'google_analytics',
  'postgres',
  'url',
  'slack_assisted',
  'gmail_assisted',
  'manual',
] as const

export type MetricSource = (typeof METRIC_SOURCES)[number]

/** Sources that carry no connectionRef: manual has none, url fetches
 *  directly, slack_assisted rides the workspace-level Slack integration. */
export const NO_CONNECTION_SOURCES = new Set<string>([
  'manual',
  'url',
  'slack_assisted',
])
