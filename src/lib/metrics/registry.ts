import type { MetricSource } from './types'
import { stripeMetricSource } from './sources/stripe'
import { hubspotMetricSource } from './sources/hubspot'
import { salesforceMetricSource } from './sources/salesforce'
import { googleSheetsMetricSource } from './sources/google-sheets'
import { postgresMetricSource } from './sources/postgres'

const SOURCES: Record<string, MetricSource> = {
  [stripeMetricSource.source]: stripeMetricSource,
  [hubspotMetricSource.source]: hubspotMetricSource,
  [salesforceMetricSource.source]: salesforceMetricSource,
  [googleSheetsMetricSource.source]: googleSheetsMetricSource,
  [postgresMetricSource.source]: postgresMetricSource,
}

export function getMetricSource(source: string): MetricSource | null {
  return SOURCES[source] ?? null
}

export function listMetricSources(): MetricSource[] {
  return Object.values(SOURCES)
}
