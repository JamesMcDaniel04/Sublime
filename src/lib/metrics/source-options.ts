/** Client-safe metric source metadata shared by the wizard and Copilot. */
export type MetricSourceOption = {
  source: string
  group: 'start_now' | 'source_of_truth'
  available?: boolean
  metrics: Array<{
    key: string
    label: string
    unit: 'usd' | 'count' | 'percent'
  }>
  connections: Array<{ ref: string; label: string }>
}

export function sourceIsAvailable(option: MetricSourceOption): boolean {
  return (
    option.available === true ||
    option.source === 'manual' ||
    option.connections.length > 0
  )
}

/**
 * The set of metric sources this workspace can actually read from right now.
 * Shared by the goal template card (dimming unconnected chips) and the
 * template detail modal (marking a recommended source).
 */
export function connectedSourceSet(options: MetricSourceOption[]): Set<string> {
  return new Set(options.filter(sourceIsAvailable).map((option) => option.source))
}
