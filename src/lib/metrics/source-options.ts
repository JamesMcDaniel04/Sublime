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
