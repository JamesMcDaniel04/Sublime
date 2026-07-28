'use client'

/**
 * Makes gating legible. A goal capped at at_risk by its composition must say
 * why, or the risk badge reads as arbitrary.
 *
 * 'unbound' is toned 'unknown' rather than 'warn': nothing bound yet is a setup
 * state, not a failure, and colouring it red would punish a user who is still
 * mid-configuration.
 */
import { AlertTriangle, CircleCheck, CircleHelp } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { CompositionState } from '@/lib/goals/composition'
import { slotLabel } from './slot-labels'

export type CompositionSummary = {
  tone: 'ok' | 'warn' | 'unknown'
  headline: string
  detail: string[]
}

export function compositionSummary(
  state: CompositionState | null | undefined,
): CompositionSummary | null {
  if (!state) return null

  const detail: string[] = []
  if (state.missing.length > 0) {
    detail.push(`Not bound yet: ${state.missing.map(slotLabel).join(', ')}.`)
  }
  if (state.variancePct !== null) {
    const direction = state.variancePct < 0 ? 'below' : 'above'
    detail.push(
      `Drivers sum ${Math.abs(state.variancePct).toFixed(1)}% ${direction} the reported number.`,
    )
  }
  for (const gate of state.breachedGates) {
    const reason = state.reasons.find((entry) => entry.startsWith(gate))
    detail.push(
      reason
        ? `${slotLabel(gate)} ${reason.slice(gate.length).trim()}`
        : `${slotLabel(gate)} is below its floor.`,
    )
  }
  // Staleness and source failures come only from the gate reasons, so surface
  // those verbatim rather than paraphrasing them.
  for (const reason of state.reasons) {
    if (reason.startsWith('Driver ')) detail.push(reason)
  }

  if (state.reconciliation === 'unmeasured' || state.level === 'unbound') {
    return { tone: 'unknown', headline: 'Composition not bound yet', detail }
  }
  if (
    state.reconciliation === 'drifted' ||
    state.level === 'partial' ||
    state.breachedGates.length > 0
  ) {
    return {
      tone: 'warn',
      headline:
        state.reconciliation === 'drifted'
          ? 'Drivers do not reconcile to the headline'
          : 'Composition incomplete',
      detail,
    }
  }
  return { tone: 'ok', headline: 'Drivers reconcile to the headline', detail }
}

const TONE = {
  ok: { icon: CircleCheck, className: 'border-success/30 bg-success/5' },
  warn: { icon: AlertTriangle, className: 'border-warning/30 bg-warning/5' },
  unknown: { icon: CircleHelp, className: 'border-border bg-muted/30' },
} as const

const ICON_TONE = {
  ok: 'text-success',
  warn: 'text-warning',
  unknown: 'text-muted-foreground',
} as const

export function CompositionStrip({
  state,
}: {
  readonly state: CompositionState | null | undefined
}) {
  const summary = compositionSummary(state)
  if (!summary) return null
  const { icon: Icon, className } = TONE[summary.tone]
  return (
    <Card className={cn('flex items-start gap-3 p-4', className)}>
      <Icon
        className={cn('mt-0.5 h-4 w-4 shrink-0', ICON_TONE[summary.tone])}
        aria-hidden
      />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{summary.headline}</p>
        {summary.detail.map((line) => (
          <p key={line} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
        {state && (
          <p className="text-xs text-muted-foreground">
            {state.boundPct}% of required drivers bound
            {state.derived !== null && ` · drivers sum to ${state.derived.toLocaleString('en-US')}`}
          </p>
        )}
      </div>
    </Card>
  )
}
