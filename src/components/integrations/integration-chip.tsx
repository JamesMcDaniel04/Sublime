import type { ReactNode } from 'react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'

/**
 * A labelled pill with the integration's brand logo. Maps a free-text
 * integration name ("Slack", "Sublime MCP", "Email") to a logo slug so
 * template/skill cards and their detail pages render real marks. Anything
 * unmapped falls through to IntegrationLogo's initial-tile fallback.
 *
 * Callers that already know the mark — metric sources resolve theirs from a
 * table, and two of them have no brand at all — pass `logo` and skip the guess.
 */

export function integrationSlug(name: string): string | null {
  const n = name.toLowerCase()
  if (n.includes('sublime')) return 'sublime'
  if (n.includes('slack')) return 'slack'
  if (n.includes('salesforce')) return 'salesforce'
  if (n.includes('snowflake')) return 'snowflake'
  if (n.includes('intercom')) return 'intercom'
  if (n.includes('hubspot')) return 'hubspot'
  if (n.includes('granola')) return 'granola'
  if (n.includes('figma')) return 'figma'
  if (n.includes('gmail') || n.includes('email') || n.includes('mail')) return 'gmail'
  if (n.includes('notion')) return 'notion'
  if (n.includes('jira')) return 'jira'
  if (n.includes('linear')) return 'linear'
  if (n.includes('github')) return 'github'
  if (n.includes('perplexity')) return 'perplexity'
  if (n.includes('asana')) return 'asana'
  if (n.includes('zendesk')) return 'zendesk'
  if (n.includes('airtable')) return 'airtable'
  if (n.includes('monday')) return 'monday'
  if (n.includes('teams')) return 'microsoftteams'
  if (n.includes('zoom')) return 'zoom'
  if (n.includes('calendar')) return 'googlecalendar'
  if (n.includes('sheet')) return 'googlesheets'
  if (n.includes('drive')) return 'googledrive'
  if (n.includes('confluence')) return 'confluence'
  if (n.includes('clickup')) return 'clickup'
  if (n.includes('trello')) return 'trello'
  return null
}

export function IntegrationChip({ name, logo }: { name: string; logo?: ReactNode }) {
  const label = name
  const isHttp = label.toLowerCase().includes('http')
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 py-1 pl-1 pr-2.5 text-xs font-medium text-foreground/80">
      {logo ?? (isHttp ? (
        <span className="flex h-4 w-4 items-center justify-center text-sm leading-none" aria-hidden>🌐</span>
      ) : (
        <IntegrationLogo name={label} slug={integrationSlug(label) ?? integrationSlug(name)} className="h-4 w-4" />
      ))}
      {label}
    </span>
  )
}
