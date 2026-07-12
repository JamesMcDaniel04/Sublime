import type { FlowNode } from '@/lib/flows/graph'

/** Node types a step can be created as / changed into (everything but trigger). */
export type EditableType = Extract<
  FlowNode['type'],
  'agent' | 'condition' | 'loop' | 'parallel' | 'stop' | 'tool' | 'http' | 'transform' | 'filter' | 'switch' | 'variable' | 'data' | 'humanReview' | 'router' | 'errorShield'
>

export const NODE_TYPES: { value: EditableType; label: string }[] = [
  { value: 'agent', label: 'Run agent' },
  { value: 'tool', label: 'Tool call' },
  { value: 'http', label: 'HTTP request' },
  { value: 'transform', label: 'Set fields' },
  { value: 'data', label: 'Data operation' },
  { value: 'variable', label: 'Variable' },
  { value: 'humanReview', label: 'Request information' },
  { value: 'condition', label: 'If / else' },
  { value: 'switch', label: 'Switch' },
  { value: 'router', label: 'AI router' },
  { value: 'filter', label: 'Filter' },
  { value: 'loop', label: 'For each' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'errorShield', label: 'Error shield' },
  { value: 'stop', label: 'Stop' },
]
