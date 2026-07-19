/**
 * Pure helpers for the flow builder page — graph walking (spine, loop and
 * parallel parents), value parsing/preview for test runs, and small
 * formatting utilities. Extracted from page.tsx (WS-R6 god-component debt):
 * everything here is stateless and independently testable; the page keeps
 * only component logic.
 */
import { type FlowGraph, type FlowNode, type OutputField } from '@/lib/flows/graph'
import { httpOutputFields, outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import type { ToolCatalog } from '@/components/flows/tool-catalog-type'

/** Ordered main-chain ids from the trigger, for upstream-token help. */
export function spineIds(graph: FlowGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const nextId = (node: FlowNode): string | undefined => {
    const edges = graph.edges.filter((e) => e.source === node.id)
    return (node.type === 'condition' ? edges.find((e) => e.branch === 'true') ?? edges[0] : edges[0])?.target
  }
  const ids: string[] = []
  const seen = new Set<string>()
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    ids.push(current.id)
    const next = nextId(current)
    current = next ? byId.get(next) : undefined
  }
  return ids
}

export function parentLoop(graph: FlowGraph, nodeId: string | null): { loop: Extract<FlowNode, { type: 'loop' }>; index: number } | null {
  if (!nodeId) return null
  for (const node of graph.nodes) {
    if (node.type !== 'loop') continue
    const index = node.data.body.indexOf(nodeId)
    if (index >= 0) return { loop: node, index }
  }
  return null
}

export function parentParallelBranch(graph: FlowGraph, nodeId: string | null): { parallelId: string; branch: string[]; index: number } | null {
  if (!nodeId) return null
  for (const node of graph.nodes) {
    if (node.type !== 'parallel') continue
    for (const branch of node.data.branches) {
      const index = branch.indexOf(nodeId)
      if (index >= 0) return { parallelId: node.id, branch, index }
    }
  }
  return null
}

export function parseFlowValue(value: unknown) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function triggerInputFields(graph: FlowGraph) {
  const triggerNode = graph.nodes.find((node): node is Extract<FlowNode, { type: 'trigger' }> => node.type === 'trigger')
  return triggerInputFieldsFromTrigger(triggerNode?.data.trigger)
}

export function outputFieldsForNode(node: FlowNode | undefined, toolCatalog: ToolCatalog): OutputField[] | undefined {
  if (!node) return undefined
  if (node.type === 'agent') return node.data.outputFields
  if (node.type === 'http') return node.data.outputFields?.length ? node.data.outputFields : httpOutputFields()
  if (node.type !== 'tool') return undefined
  if (node.data.outputFields?.length) return node.data.outputFields
  const tool = toolCatalog
    .find((connection) => connection.id === node.data.connectionId)
    ?.tools.find((entry) => entry.name === node.data.toolName)
  const fields = outputFieldsFromJsonSchema(tool?.outputSchema ?? node.data.actionOutputSchema)
  return fields.length ? fields : undefined
}

export function previewLoopItems(value: unknown): unknown[] {
  const parsed = parseFlowValue(value)
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const key of ['items', 'records', 'results', 'data']) {
      const candidate = (parsed as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) return candidate
    }
    return []
  }
  if (typeof parsed !== 'string') return []
  const trimmed = parsed.trim()
  if (!trimmed) return []
  const lines = trimmed.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const commaParts = trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  return commaParts.length > 1 ? commaParts : [trimmed]
}

export function sampleLoopItem(loop: Extract<FlowNode, { type: 'loop' }>, lastOutputs: Record<string, unknown>, testInput: string): unknown {
  const token = loop.data.over.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1]
  let value: unknown = loop.data.over
  if (token === 'trigger.input') {
    value = testInput
  } else if (token?.startsWith('step.')) {
    const [, nodeId, outputKey, ...rest] = token.split('.')
    if (outputKey === 'output') {
      value = lastOutputs[nodeId]
      for (const part of rest) {
        if (value == null || typeof value !== 'object') {
          value = undefined
          break
        }
        value = (value as Record<string, unknown>)[part]
      }
    }
  }
  return previewLoopItems(value)[0]
}

export function clampZoom(value: number): number {
  return Math.min(1.5, Math.max(0.5, value))
}

export function filenameSlug(value: string): string {
  return (value || 'flow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'flow'
}
