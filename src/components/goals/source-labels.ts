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
