'use client'

/**
 * Onboarding pull toward the intelligence gates. Shows the next concrete step
 * until the platform can start recommending: connect >= 3 tools, then let
 * real usage accrue, then a short learning period. Renders nothing once
 * suggestions can flow (they arrive through the notification bell from then
 * on), so this never competes with the assistant for attention afterward.
 *
 * The three phases (Connect -> Capture -> Learn) are a real sequence: you
 * can't capture usage before connecting, or learn a routine before usage
 * accrues. The progress track encodes that order, so the color also tells the
 * user where they are on the path to their first suggestion.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plug, Sparkles } from 'lucide-react'
import { getCachedJson } from '@/lib/client/use-cached-json'
import { cn } from '@/lib/utils'

type Readiness = {
  connections: { total: number; needed: number; ready: boolean }
  usage: { events: number; needed: number; ready: boolean }
  personal?: {
    hasActivity: boolean
    learningDaysLeft: number
    inLearningPeriod: boolean
    eligiblePatterns: number
    openSuggestion: boolean
  }
  ready: boolean
}

type Stage =
  | { kind: 'connect'; needed: number; total: number }
  | { kind: 'usage'; events: number }
  | { kind: 'learning'; daysLeft: number }
  | { kind: 'watching' }

/** The single most relevant "why nothing yet" stage: org gates first, then
 *  the personal learning gate. Returns null once suggestions can flow (an open
 *  suggestion exists, or eligible patterns are already feeding synthesis). */
function stageOf(r: Readiness): Stage | null {
  if (!r.connections.ready) return { kind: 'connect', needed: r.connections.needed, total: r.connections.total }
  if (!r.usage.ready) return { kind: 'usage', events: r.usage.events }
  const p = r.personal
  if (!p) return null
  if (p.openSuggestion || p.eligiblePatterns > 0) return null
  if (p.inLearningPeriod) return { kind: 'learning', daysLeft: p.learningDaysLeft }
  return { kind: 'watching' }
}

const PHASES = ['Connect', 'Capture', 'Learn']
const PHASE_INDEX: Record<Stage['kind'], number> = { connect: 0, usage: 1, learning: 2, watching: 3 }

/** The three-phase path to a first suggestion, filled up to the current stage. */
function ProgressTrack({ stepIndex }: { readonly stepIndex: number }) {
  return (
    <div className="mt-3 flex items-end gap-2">
      {PHASES.map((label, i) => {
        const done = stepIndex > i
        const active = stepIndex === i
        return (
          <div key={label} className="flex flex-1 flex-col gap-1">
            <div
              className={cn(
                'h-1.5 rounded-full transition-colors',
                done && 'bg-gradient-to-r from-indigo-500 to-violet-500',
                active && 'bg-gradient-to-r from-indigo-500 to-violet-500 opacity-70 motion-safe:animate-pulse',
                !done && !active && 'bg-indigo-100 dark:bg-white/10',
              )}
            />
            <span
              className={cn(
                'text-[10px] font-medium uppercase tracking-wide',
                done || active ? 'text-indigo-600 dark:text-indigo-300' : 'text-muted-foreground/50',
              )}
            >
              {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function LearningProgressCard() {
  const [readiness, setReadiness] = useState<Readiness | null>(null)

  useEffect(() => {
    let cancelled = false
    getCachedJson<{ readiness?: Readiness }>('/api/intelligence/readiness', 60_000)
      .then((data) => {
        if (!cancelled && data?.readiness) setReadiness(data.readiness)
      })
      .catch(() => {
        /* the card simply doesn't render */
      })
    return () => { cancelled = true }
  }, [])

  const stage = readiness ? stageOf(readiness) : null
  if (!stage) return null

  const Icon = stage.kind === 'connect' ? Plug : Sparkles

  return (
    <div className="mb-4 rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50 via-violet-50/70 to-white p-4 shadow-1 dark:border-indigo-400/20 dark:from-indigo-500/10 dark:via-violet-500/10 dark:to-transparent">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-sm ring-1 ring-inset ring-white/20 dark:from-indigo-400 dark:to-violet-400">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          {stage.kind === 'connect' && (
            <>
              <p className="font-semibold text-foreground">
                Connect {stage.needed} more {stage.needed === 1 ? 'tool' : 'tools'} and Sublime starts learning how you work
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {stage.total} of 3 connected. Once Sublime can see how you work across tools, it suggests agents and flows grounded in what you actually do, not generic ones.
              </p>
              <Link
                href="/integrations"
                className="mt-1.5 inline-block font-semibold text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-300"
              >
                Open integrations
              </Link>
            </>
          )}
          {stage.kind === 'usage' && (
            <>
              <p className="font-semibold text-foreground">Sublime is learning how you work</p>
              <p className="mt-0.5 text-muted-foreground">
                {stage.events} usage {stage.events === 1 ? 'signal' : 'signals'} captured so far. Keep running agents, flows, and your connected tools. Once enough real usage accrues, evidence-backed suggestions arrive in your notifications.
              </p>
            </>
          )}
          {stage.kind === 'learning' && (
            <>
              <p className="font-semibold text-foreground">Sublime is in its learning period</p>
              <p className="mt-0.5 text-muted-foreground">
                Your tools are connected and usage is flowing. To make sure suggestions reflect a real routine and not a one-off, Sublime watches for about {stage.daysLeft} more {stage.daysLeft === 1 ? 'day' : 'days'} before it proposes anything.
              </p>
            </>
          )}
          {stage.kind === 'watching' && (
            <>
              <p className="font-semibold text-foreground">Watching for repeatable routines</p>
              <p className="mt-0.5 text-muted-foreground">
                Everything is connected and Sublime is learning, but it hasn&apos;t seen the same task repeat enough to suggest automating it yet. Keep working the way you normally do. The moment a routine emerges, you&apos;ll get an evidence-backed suggestion.
              </p>
            </>
          )}
        </div>
      </div>
      <ProgressTrack stepIndex={PHASE_INDEX[stage.kind]} />
    </div>
  )
}
