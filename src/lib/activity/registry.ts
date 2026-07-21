/** Activity source registry (spec §4). */
import type { ActivitySource } from './types'
import { slackActivitySource } from './sources/slack'
import { githubActivitySource } from './sources/github'
import { googleCalendarActivitySource } from './sources/google-calendar'
import { hubspotActivitySource } from './sources/hubspot'

const SOURCES: Record<string, ActivitySource> = {
  [slackActivitySource.source]: slackActivitySource,
  [githubActivitySource.source]: githubActivitySource,
  [googleCalendarActivitySource.source]: googleCalendarActivitySource,
  [hubspotActivitySource.source]: hubspotActivitySource,
}

export function getActivitySource(source: string): ActivitySource | null {
  return SOURCES[source] ?? null
}

export function listActivitySources(): ActivitySource[] {
  return Object.values(SOURCES)
}
