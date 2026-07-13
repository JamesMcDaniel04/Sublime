/**
 * Shared tool→department taxonomy. ANCHOR tools imply a department; GLUE tools
 * (slack/gmail/notion/sheets/http/…) never assign one alone. Reused by the
 * seed catalogue (authoring cross-check), relevance sorting, and the BI
 * auto-template tagging in template-from-run.ts. Pure — no I/O.
 */
export type Department = 'sales' | 'engineering' | 'marketing' | 'finance' | 'csm' | 'general'

/** Canonical department display/sort order. */
export const DEPARTMENTS = ['sales', 'engineering', 'marketing', 'finance', 'csm', 'general'] as const

/** User-facing catalogue filters. `general` is a BI fallback classification,
 * not a product department tab. */
export const PRODUCT_DEPARTMENTS = ['sales', 'engineering', 'marketing', 'finance', 'csm'] as const

/** Anchor tool (canonical slug) → the departments it implies. */
const ANCHOR_DEPARTMENTS: Record<string, Department[]> = {
  github: ['engineering'],
  linear: ['engineering'],
  jira: ['engineering'],
  confluence: ['engineering'],
  figma: ['engineering', 'marketing'],
  salesforce: ['sales', 'finance', 'csm'],
  hubspot: ['sales', 'marketing', 'csm'],
  zendesk: ['csm'],
  intercom: ['csm'],
  snowflake: ['finance'],
  granola: ['sales', 'csm'],
  monday: ['engineering', 'marketing'],
  asana: ['engineering', 'marketing'],
  clickup: ['engineering', 'marketing'],
  trello: ['engineering', 'marketing'],
}

/** Glue tools — plumbing every department shares; never a department signal alone. */
const GLUE = new Set(['slack', 'gmail', 'email', 'notion', 'google_sheets', 'google_drive', 'google_calendar', 'http'])

/**
 * Normalize any connector chip key / label / logo-slug to the canonical
 * integration vocabulary. Substring precedence mirrors integration-chip's
 * integrationSlug(), but returns the runtime-matchable underscore slug.
 */
export function canonicalIntegrationSlug(raw: string): string {
  const n = raw.toLowerCase().replace(/^strata:/, '').trim()
  if (n.includes('salesforce')) return 'salesforce'
  if (n.includes('slack')) return 'slack'
  if (n.includes('hubspot')) return 'hubspot'
  if (n.includes('snowflake')) return 'snowflake'
  if (n.includes('intercom')) return 'intercom'
  if (n.includes('zendesk')) return 'zendesk'
  if (n.includes('confluence')) return 'confluence'
  if (n.includes('linear')) return 'linear'
  if (n.includes('jira')) return 'jira'
  if (n.includes('github')) return 'github'
  if (n.includes('granola')) return 'granola'
  if (n.includes('asana')) return 'asana'
  if (n.includes('monday')) return 'monday'
  if (n.includes('clickup')) return 'clickup'
  if (n.includes('trello')) return 'trello'
  if (n.includes('figma')) return 'figma'
  if (n.includes('notion')) return 'notion'
  if (n.includes('sheet')) return 'google_sheets'
  if (n.includes('drive')) return 'google_drive'
  if (n.includes('calendar')) return 'google_calendar'
  if (n.includes('gmail')) return 'gmail'
  if (n.includes('resend') || n.includes('mail')) return 'email' // resend's chip label is "Email" → generic email glue slug
  if (n.includes('http')) return 'http'
  return n.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** Union of departments implied by the given tool slugs; ['general'] when none. */
export function departmentsForTools(slugs: string[]): Department[] {
  const hits = new Set<Department>()
  for (const raw of slugs) {
    const slug = canonicalIntegrationSlug(raw)
    if (GLUE.has(slug)) continue
    for (const dept of ANCHOR_DEPARTMENTS[slug] ?? []) hits.add(dept)
  }
  const ordered = DEPARTMENTS.filter((d): d is Department => d !== 'general' && hits.has(d))
  return ordered.length ? ordered : ['general']
}
