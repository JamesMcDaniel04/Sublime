/** Activity source registry (spec §4). */
import type { ActivitySource } from './types'
import { slackActivitySource } from './sources/slack'
import { githubActivitySource } from './sources/github'

const SOURCES: Record<string, ActivitySource> = {
  [slackActivitySource.source]: slackActivitySource,
  [githubActivitySource.source]: githubActivitySource,
}

export function getActivitySource(source: string): ActivitySource | null {
  return SOURCES[source] ?? null
}

export function listActivitySources(): ActivitySource[] {
  return Object.values(SOURCES)
}
