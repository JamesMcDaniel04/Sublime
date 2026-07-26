import type { MetricSource } from './types'
import { stripeMetricSource } from './sources/stripe'

const SOURCES: Record<string, MetricSource> = {
  [stripeMetricSource.source]: stripeMetricSource,
}

export function getMetricSource(source: string): MetricSource | null {
  return SOURCES[source] ?? null
}

export function listMetricSources(): MetricSource[] {
  return Object.values(SOURCES)
}
