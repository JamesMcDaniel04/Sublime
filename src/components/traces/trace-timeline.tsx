'use client'

import {
  Bot,
  Brain,
  Database,
  FileText,
  HelpCircle,
  Lightbulb,
  ListOrdered,
  Wrench,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import { fmtDurationMs, type TraceStatus } from '@/lib/traces/envelope'
import type { TraceSpan } from '@/lib/traces/spans'

/**
 * Renders a trace's span union as a vertical timeline. Consumes the mapper
 * output verbatim (lib/traces/spans.ts) — no fetching, no shaping, so the
 * agent pane and flow surfaces can adopt it later without dragging state
 * along. Legacy retrieval events (no stages/query/scores) simply render
 * without the funnel — absence hides, it never errors.
 *
 * Native <details>/<summary> everywhere something collapses: keyboard and
 * screen-reader semantics come free, keeping the a11y ratchet untouched.
 */

const STATUS_DOT: Record<TraceStatus, string> = {
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  running: 'bg-amber-500',
  waiting: 'bg-blue-500',
  queued: 'bg-gray-300',
  stopped: 'bg-slate-400',
}

const SAFETY_BADGE: Record<string, 'outline' | 'info' | 'warn'> = {
  read: 'outline',
  idempotent_write: 'info',
  unsafe_write: 'warn',
}

const STATUS_BADGE: Record<TraceStatus, 'good' | 'risk' | 'warn' | 'info' | 'outline'> = {
  succeeded: 'good',
  failed: 'risk',
  running: 'info',
  queued: 'info',
  waiting: 'warn',
  stopped: 'outline',
}

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0)) {
    return null
  }
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
        {label}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-muted p-2 text-xs">{json(value)}</pre>
    </details>
  )
}

/** The funnel line: `12 candidates → 7 ≥ floor → 5 reranked → 3 injected (2.1k tokens)`. */
function funnelLine(span: Extract<TraceSpan, { kind: 'retrieval' }>): string | null {
  if (!span.stages) return null
  const stages = span.stages
  const parts = [
    `${stages.candidates} candidate${stages.candidates === 1 ? '' : 's'}`,
    `${stages.afterScoreFloor} ≥ floor`,
  ]
  if (stages.reranked) parts.push(`${stages.afterRerank} reranked`)
  if (span.injected) {
    const tokens = span.injected.tokens >= 1000 ? `${(span.injected.tokens / 1000).toFixed(1)}k` : String(span.injected.tokens)
    parts.push(`${span.injected.count} injected (${tokens} tokens)`)
  }
  return parts.join(' → ')
}

function RetrievalSpan({ span }: { span: Extract<TraceSpan, { kind: 'retrieval' }> }) {
  const funnel = funnelLine(span)
  const Icon = span.channel === 'knowledge' ? FileText : Database
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Icon aria-hidden className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">
          {span.channel === 'knowledge' ? 'Retrieved file knowledge' : 'Retrieved context'}
        </span>
        {span.strategy && <Badge variant="outline">{span.strategy}</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{span.summary}</p>
      {funnel && <p className="mt-1 font-mono text-xs text-muted-foreground">{funnel}</p>}
      {span.query && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Query
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted p-2 text-xs">{span.query}</p>
        </details>
      )}
      {span.hits.length > 0 && (
        <details className="mt-1" open={span.hits.length <= 3}>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            {span.hits.length} hit{span.hits.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 space-y-1">
            {span.hits.map((hit, index) => (
              <li key={index} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 font-mono text-muted-foreground">
                  [{hit.score !== null ? hit.score.toFixed(2) : '—'}]
                </span>
                <span className="shrink-0 text-muted-foreground">{hit.type}</span>
                <span className="min-w-0 flex-1 break-words">{hit.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {span.related.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            {span.related.length} connected entit{span.related.length === 1 ? 'y' : 'ies'}
          </summary>
          <ul className="mt-1 space-y-1">
            {span.related.map((entity, index) => (
              <li key={index} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 text-muted-foreground">{entity.type}</span>
                <span className="min-w-0 flex-1 break-words">{entity.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export function TraceTimeline({ spans }: { spans: TraceSpan[] }) {
  if (spans.length === 0) {
    return <p className="text-sm text-muted-foreground">No recorded steps for this run.</p>
  }
  return (
    <ol className="space-y-2">
      {spans.map((span, index) => (
        <li key={index}>
          <SpanRow span={span} />
        </li>
      ))}
    </ol>
  )
}

function SpanRow({ span }: { span: TraceSpan }) {
  switch (span.kind) {
    case 'thinking':
      return (
        <div className="flex gap-2 px-1 text-sm text-muted-foreground">
          <Brain aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 italic">
            <Markdown>{span.text}</Markdown>
          </div>
        </div>
      )
    case 'plan':
      return (
        <div className="flex gap-2 rounded-lg border bg-card p-3 text-sm">
          <ListOrdered aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <Markdown>{span.text}</Markdown>
          </div>
        </div>
      )
    case 'retrieval':
      return <RetrievalSpan span={span} />
    case 'memory':
      return (
        <div className="flex items-baseline gap-2 px-1 text-sm text-muted-foreground">
          <Lightbulb aria-hidden className="h-4 w-4 shrink-0 self-center" />
          <span>{span.summary}</span>
        </div>
      )
    case 'autoanswer':
      return (
        <div className="rounded-lg border bg-card p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <HelpCircle aria-hidden className="h-4 w-4 text-muted-foreground" />
            {span.question}
          </div>
          <p className="mt-1 text-muted-foreground">{span.answer}</p>
        </div>
      )
    case 'tool':
      return (
        <div className="rounded-lg border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Wrench aria-hidden className="h-4 w-4 text-muted-foreground" />
            <span className="font-mono text-xs font-medium">{span.step.node}</span>
            <span
              aria-hidden
              className={cn('h-2 w-2 rounded-full', STATUS_DOT[span.step.status as TraceStatus] ?? 'bg-gray-300')}
            />
            <span className="text-xs text-muted-foreground">{span.step.status}</span>
          </div>
          <JsonDetails label="Input" value={span.step.input} />
          <JsonDetails label="Output" value={span.step.output} />
          <JsonDetails label="Error" value={span.step.error} />
        </div>
      )
    case 'step':
      return (
        <div className="rounded-lg border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span aria-hidden className={cn('h-2 w-2 rounded-full', STATUS_DOT[span.status])} />
            <span className="font-mono text-xs font-medium">{span.node}</span>
            {span.iterationPath && (
              <span className="text-xs text-muted-foreground">iteration {span.iterationPath}</span>
            )}
            <span className="text-xs text-muted-foreground">{span.status}</span>
          </div>
          {span.effects.length > 0 && (
            <ul className="mt-2 space-y-1">
              {span.effects.map((effect, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{effect.provider}</span>
                  <span className="font-mono text-muted-foreground">{effect.operation}</span>
                  <Badge variant={SAFETY_BADGE[effect.safety] ?? 'outline'}>{effect.safety}</Badge>
                  {effect.attempts > 1 && (
                    <span className="text-muted-foreground">{effect.attempts} attempts</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <JsonDetails label="Input" value={span.input} />
          <JsonDetails label="Output" value={span.output} />
          {span.error && <JsonDetails label="Error" value={span.error} />}
        </div>
      )
    case 'subagent':
      return (
        <details className="rounded-lg border bg-card p-3 text-sm">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2">
            <Bot aria-hidden className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{span.trace.summary.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{span.nodeId}</span>
            <Badge variant={STATUS_BADGE[span.trace.summary.status]}>{span.trace.summary.status}</Badge>
            <span className="tabular-nums text-xs text-muted-foreground">
              {fmtDurationMs(span.trace.summary.durationMs)}
            </span>
          </summary>
          <div className="mt-3 border-l-2 border-muted pl-3">
            <TraceTimeline spans={span.trace.spans} />
          </div>
        </details>
      )
    case 'unknown':
      return <p className="px-1 text-xs text-muted-foreground">{span.label}</p>
    default:
      return null
  }
}
