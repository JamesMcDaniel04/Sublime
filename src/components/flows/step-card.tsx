'use client'

import { Bot, GitBranch, Repeat, Rows3, Zap, CircleStop, Wrench, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'

export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'waiting' | 'skipped' | 'stopped'

const NODE_ICON: Record<FlowNode['type'], typeof Bot> = {
  trigger: Zap,
  agent: Bot,
  condition: GitBranch,
  loop: Repeat,
  parallel: Rows3,
  stop: CircleStop,
  tool: Wrench,
  http: Globe,
}

const STATUS_DOT: Record<StepStatus, string> = {
  queued: 'bg-gray-300',
  running: 'bg-amber-400 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-blue-500 animate-pulse',
  skipped: 'bg-gray-300',
  stopped: 'bg-slate-500',
}

export function StepCard({
  index,
  type,
  title,
  subtitle,
  status,
  selected,
  onClick,
}: {
  index?: number
  type: FlowNode['type']
  title: string
  subtitle?: string
  status?: StepStatus
  selected?: boolean
  onClick?: () => void
}) {
  const Icon = NODE_ICON[type]
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left shadow-1 transition-all duration-fast',
        'hover:border-indigo-300 hover:shadow-md',
        selected ? 'border-indigo-400 ring-1 ring-indigo-300' : 'border-border/70',
      )}
    >
      {typeof index === 'number' && (
        <span className="w-4 shrink-0 text-right text-xs font-semibold text-muted-foreground">{index}</span>
      )}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      {status && <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', STATUS_DOT[status])} title={status} />}
    </button>
  )
}
