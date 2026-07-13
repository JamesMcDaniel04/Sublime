import type { FlowNode } from '@/lib/flows/graph'

/**
 * The single source of truth for which optional "advanced" parameters each
 * node type supports. Powers the MS-style "Advanced parameters — Showing N of
 * M" section on step cards and in the settings drawer.
 */
export type AdvancedParamKey =
  | 'onError'
  | 'retries'
  | 'timeoutMs'
  | 'bodyMode'
  | 'responseType'
  | 'failOnHttpError'
  | 'concurrency'
  | 'disabled'
  | 'mockOutput'
  | 'retryDelayMs'
  | 'followRedirects'
  | 'maxRedirects'

const BY_TYPE: Partial<Record<FlowNode['type'], AdvancedParamKey[]>> = {
  agent: ['onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'],
  tool: ['onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'],
  http: ['bodyMode', 'responseType', 'failOnHttpError', 'onError', 'retries', 'retryDelayMs', 'timeoutMs', 'followRedirects', 'maxRedirects', 'disabled', 'mockOutput'],
  loop: ['concurrency'],
}

export function advancedParamKeys(type: FlowNode['type']): AdvancedParamKey[] {
  return BY_TYPE[type] ?? []
}

/** How many of the node's advanced params are explicitly set. */
export function advancedParamsSetCount(node: FlowNode): number {
  const data = node.data as Record<string, unknown>
  return advancedParamKeys(node.type).filter((key) => data[key] !== undefined).length
}
