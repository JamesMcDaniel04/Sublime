import type { FlowNode } from '@/lib/flows/graph'

/**
 * Which optional "advanced" parameters each node type supports, for the
 * "Advanced parameters — Showing N of M" section on step cards and in the
 * settings drawer.
 *
 * NOT the http node: it uses the n8n-style Options / Add option panel in
 * components/flows/nodes/http-options instead. Listing http here again would
 * resurrect the bug that motivated the split — two panels editing `bodyMode`
 * with different option sets, where touching the advanced one silently
 * rewrote a GraphQL body to JSON.
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
  | 'queryArrayFormat'
  // Auto-aggregation controls: agents pull upstream context by default;
  // source nodes are included in that aggregate by default.
  | 'includeUpstream'
  | 'excludeFromContext'
  // n8n-parity per-item fan-out: run this step once per item of the
  // predecessor's list output. Executed by interpret.ts; it lived in the
  // schema with no control at all until it was listed here.
  | 'forEachItem'

const BY_TYPE: Partial<Record<FlowNode['type'], AdvancedParamKey[]>> = {
  agent: ['includeUpstream', 'onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'],
  tool: ['excludeFromContext', 'forEachItem', 'onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'],
  // `code` is deliberately without forEachItem: graph.ts strips the field on a
  // code node, so offering it would present a control that silently does
  // nothing. A code step fans out over its own items instead.
  code: ['excludeFromContext', 'onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'],
  loop: ['concurrency', 'disabled'],
  // Previously absent, so both fell through to ['disabled'] — which is why
  // their fan-out had nowhere to live.
  transform: ['forEachItem', 'disabled'],
  data: ['forEachItem', 'disabled'],
}

export function advancedParamKeys(type: FlowNode['type']): AdvancedParamKey[] {
  // Triggers can't be deactivated; http keeps its own Options panel (see the
  // header comment). Every other type supports at least Execution on/off.
  if (type === 'trigger' || type === 'http') return BY_TYPE[type] ?? []
  return BY_TYPE[type] ?? ['disabled']
}

/** How many of the node's advanced params are explicitly set. */
export function advancedParamsSetCount(node: FlowNode): number {
  const data = node.data as Record<string, unknown>
  return advancedParamKeys(node.type).filter((key) => data[key] !== undefined).length
}
