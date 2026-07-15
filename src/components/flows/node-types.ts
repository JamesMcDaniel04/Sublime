import {
  Bot, Braces, CircleStop, Filter, GitBranch, Globe, Play, Repeat, Rows3, ShieldCheck, SlidersHorizontal,
  Split, Timer, UserCheck, Variable, Workflow, Wrench, type LucideIcon,
} from 'lucide-react'
import type { FlowNode } from '@/lib/flows/graph'

/** Node types a step can be created as / changed into (everything but trigger). */
export type EditableType = Extract<
  FlowNode['type'],
  'agent' | 'condition' | 'loop' | 'parallel' | 'stop' | 'tool' | 'http' | 'transform' | 'filter' | 'switch' | 'variable' | 'data' | 'humanReview' | 'router' | 'errorShield' | 'respondWebhook' | 'wait' | 'repeatUntil' | 'input' | 'output' | 'subflow'
>

export const NODE_TYPES: { value: EditableType; label: string }[] = [
  { value: 'agent', label: 'Run agent' },
  { value: 'tool', label: 'Tool call' },
  { value: 'http', label: 'HTTP request' },
  { value: 'respondWebhook', label: 'Respond to webhook' },
  { value: 'wait', label: 'Wait' },
  { value: 'transform', label: 'Set fields' },
  { value: 'data', label: 'Data operation' },
  { value: 'variable', label: 'Variable' },
  { value: 'humanReview', label: 'Request information' },
  { value: 'condition', label: 'If / else' },
  { value: 'switch', label: 'Switch' },
  { value: 'router', label: 'AI router' },
  { value: 'filter', label: 'Filter' },
  { value: 'loop', label: 'For each' },
  { value: 'repeatUntil', label: 'Repeat until' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'errorShield', label: 'Error shield' },
  { value: 'subflow', label: 'Run workflow' },
  { value: 'input', label: 'Workflow inputs' },
  { value: 'output', label: 'Workflow output' },
  { value: 'stop', label: 'Stop' },
]

/** Human label for a node type (falls back to the raw type for unlisted ones). */
export const NODE_TYPE_LABEL: Record<string, string> = Object.fromEntries(NODE_TYPES.map((t) => [t.value, t.label]))

/**
 * Icon + colour per node type. Shared by the picker and the DAG canvas's compact
 * widgets so a step looks the same wherever it appears.
 */
export const NODE_ICON: Record<string, LucideIcon> = {
  trigger: Play,
  agent: Bot,
  tool: Wrench,
  http: Globe,
  transform: SlidersHorizontal,
  condition: GitBranch,
  switch: Split,
  router: Split,
  filter: Filter,
  loop: Repeat,
  repeatUntil: Repeat,
  parallel: Rows3,
  errorShield: ShieldCheck,
  stop: CircleStop,
  variable: Variable,
  data: Braces,
  humanReview: UserCheck,
  wait: Timer,
  subflow: Workflow,
  input: Play,
  output: CircleStop,
  respondWebhook: Globe,
}

export const NODE_TONE: Record<string, string> = {
  trigger: 'bg-slate-900 text-white',
  agent: 'bg-slate-900 text-white',
  tool: 'bg-orange-500 text-white',
  http: 'bg-emerald-600 text-white',
  transform: 'bg-violet-500 text-white',
  condition: 'bg-amber-500 text-white',
  switch: 'bg-fuchsia-600 text-white',
  router: 'bg-fuchsia-600 text-white',
  filter: 'bg-lime-600 text-white',
  loop: 'bg-sky-500 text-white',
  repeatUntil: 'bg-sky-500 text-white',
  parallel: 'bg-cyan-600 text-white',
  errorShield: 'bg-teal-600 text-white',
  stop: 'bg-red-500 text-white',
  variable: 'bg-purple-600 text-white',
  data: 'bg-violet-600 text-white',
  humanReview: 'bg-blue-600 text-white',
  wait: 'bg-blue-500 text-white',
  subflow: 'bg-indigo-600 text-white',
  input: 'bg-teal-600 text-white',
  output: 'bg-teal-700 text-white',
  respondWebhook: 'bg-emerald-700 text-white',
}

export const nodeIconOf = (type: string): LucideIcon => NODE_ICON[type] ?? Wrench
export const nodeToneOf = (type: string): string => NODE_TONE[type] ?? 'bg-slate-700 text-white'
