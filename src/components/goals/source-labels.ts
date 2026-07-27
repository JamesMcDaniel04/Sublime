import type { MetricSource } from '@/lib/goals/metric-sources'

export const SOURCE_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  google_sheets: 'Google Sheets',
  postgres: 'Postgres / SQL',
  manual: "I'll record values myself",
  url: 'A URL that reports the number',
  slack_assisted: 'Slack channel (AI-read)',
  gmail_assisted: 'Report emails (AI-read)',
}

export const SOURCE_HINTS: Record<string, string> = {
  url: 'We fetch the page or JSON on every sync and parse the number.',
  slack_assisted:
    'AI reads recent messages and extracts the latest value — every reading is labeled AI-read.',
  gmail_assisted:
    'AI reads matching report emails and extracts the latest value — every reading is labeled AI-read.',
}

/**
 * Metric source → brand-logo slug for IntegrationLogo.
 *
 * An explicit table rather than IntegrationChip's substring guess on the
 * display label: "Stripe" and "Postgres / SQL" carry no keyword that guess
 * matches, so they used to render as initial tiles. `null` means the source has
 * no company behind it — `url` fetches any page, `manual` is you typing the
 * number — and renders a glyph instead of a letter. Keyed on MetricSource so a
 * new source cannot compile without a logo decision.
 */
export const SOURCE_ICON_SLUGS: Record<MetricSource, string | null> = {
  stripe: 'stripe',
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  google_sheets: 'googlesheets',
  postgres: 'postgresql',
  slack_assisted: 'slack',
  gmail_assisted: 'gmail',
  url: null,
  manual: null,
}
