/** Metric source registry (goals spec) — the ActivitySource pattern applied
 * to point-in-time readings instead of event streams. Adapters never hold
 * raw tokens beyond the call. */
export interface MetricSourceContext {
  organizationId: string
  /** User who authorized the binding. Required for personal credentials. */
  userId?: string
  /** 'credential:<id>' | 'nango:<connectionId>' | 'google:<id>' | 'postgres:<id>' | null */
  connectionRef: string | null
  config: Record<string, unknown>
}

export interface MetricReading {
  value: number
  asOf: Date
}

export interface MetricDescriptor {
  key: string
  label: string
  unit: 'usd' | 'count' | 'percent'
}

export interface MetricSource {
  source: string
  availableMetrics(goalKind: string): MetricDescriptor[]
  fetchValue(ctx: MetricSourceContext, metricKey: string): Promise<MetricReading>
}

/** 'credential:abc' → 'abc'; throws on plane mismatch so a misfiled binding
 * fails loudly at fetch time, not silently with someone else's connection. */
export function refId(connectionRef: string | null, plane: 'credential' | 'nango' | 'google' | 'postgres'): string {
  const prefix = `${plane}:`
  if (!connectionRef || !connectionRef.startsWith(prefix)) {
    throw new Error(`Metric binding expected a ${plane} connection, got '${connectionRef ?? 'none'}'`)
  }
  return connectionRef.slice(prefix.length)
}
