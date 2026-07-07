'use client'

import { useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/ui/markdown'
import type { StepStatus } from './step-card'

export type RunStep = {
  nodeId: string
  status: StepStatus
  order: number
  error?: string | null
  input?: unknown
  output?: unknown
  startedAt?: string | null
  finishedAt?: string | null
}
export type FlowRunDetail = {
  id: string
  status: string
  startedAt?: string
  finishedAt?: string | null
  output?: unknown
  error?: string | null
  steps: RunStep[]
}

const STATUS_TEXT: Record<string, string> = {
  succeeded: 'text-emerald-600',
  failed: 'text-red-600',
  waiting: 'text-blue-600',
  running: 'text-amber-600',
  skipped: 'text-gray-400',
  stopped: 'text-slate-500',
  queued: 'text-gray-400',
}

function preview(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Prose step outputs render as Markdown; structured data stays monospaced. */
function OutputView({ value }: { value: unknown }) {
  const isProse =
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.trim()[0] !== '{' &&
    value.trim()[0] !== '['
  if (isProse) {
    return (
      <div className="max-h-56 overflow-auto rounded border border-border/60 bg-background px-2.5 py-2">
        <Markdown className="text-xs [&_p]:leading-5">{value as string}</Markdown>
      </div>
    )
  }
  return <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 text-xs">{preview(value)}</pre>
}

function StepRow({ step, label }: { step: RunStep; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-border/60 last:border-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="flex-1 truncate text-sm">{label}</span>
        <span className={cn('text-xs font-medium capitalize', STATUS_TEXT[step.status] || 'text-muted-foreground')}>{step.status}</span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3 pl-8">
          {step.error && <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{step.error}</p>}
          <div>
            <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</p>
            <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 text-xs">{preview((step.input as { prompt?: unknown })?.prompt ?? step.input)}</pre>
          </div>
          <div>
            <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Output</p>
            <OutputView value={step.output} />
          </div>
        </div>
      )}
    </div>
  )
}

export function RunPanel({
  runs,
  selected,
  onSelectRun,
  onClose,
  labelForNode,
}: {
  runs: { id: string; status: string; startedAt?: string }[]
  selected: FlowRunDetail | null
  onSelectRun: (runId: string) => void
  onClose: () => void
  labelForNode: (nodeId: string) => string
}) {
  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Runs</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="border-b border-border p-2">
        <select
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none"
          value={selected?.id ?? ''}
          onChange={(e) => onSelectRun(e.target.value)}
        >
          {runs.length === 0 && <option value="">No runs yet</option>}
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.status} · {run.startedAt ? new Date(run.startedAt).toLocaleString() : run.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <p className="p-4 text-sm text-muted-foreground">Run the flow to see step-by-step results here.</p>
        ) : (
          <>
            <div className="border-b border-border px-3 py-2">
              <span className={cn('text-xs font-semibold capitalize', STATUS_TEXT[selected.status])}>{selected.status}</span>
              {selected.error && <p className="mt-1 text-xs text-red-600">{selected.error}</p>}
            </div>
            {selected.steps.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No steps recorded.</p>
            ) : (
              selected.steps.map((step, i) => <StepRow key={`${step.nodeId}-${i}`} step={step} label={labelForNode(step.nodeId)} />)
            )}
          </>
        )}
      </div>
    </div>
  )
}
