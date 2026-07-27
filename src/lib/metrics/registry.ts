import type { MetricSource } from './types'
import { stripeMetricSource } from './sources/stripe'
import { hubspotMetricSource } from './sources/hubspot'
import { salesforceMetricSource } from './sources/salesforce'
import { googleSheetsMetricSource } from './sources/google-sheets'
import { googleAnalyticsMetricSource } from './sources/google-analytics'
import { postgresMetricSource } from './sources/postgres'
import { urlMetricSource } from './sources/url'
import { slackAssistedMetricSource } from './sources/slack-assisted'
import { gmailAssistedMetricSource } from './sources/gmail-assisted'

const SOURCES: Record<string, MetricSource> = {
  [stripeMetricSource.source]: stripeMetricSource,
  [hubspotMetricSource.source]: hubspotMetricSource,
  [salesforceMetricSource.source]: salesforceMetricSource,
  [googleSheetsMetricSource.source]: googleSheetsMetricSource,
  [googleAnalyticsMetricSource.source]: googleAnalyticsMetricSource,
  [postgresMetricSource.source]: postgresMetricSource,
  [urlMetricSource.source]: urlMetricSource,
  [slackAssistedMetricSource.source]: slackAssistedMetricSource,
  [gmailAssistedMetricSource.source]: gmailAssistedMetricSource,
}

export function getMetricSource(source: string): MetricSource | null {
  return SOURCES[source] ?? null
}

export function listMetricSources(): MetricSource[] {
  return Object.values(SOURCES)
}
