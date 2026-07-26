'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CheckCircle2, Circle } from 'lucide-react'
import { getCachedJson } from '@/lib/client/use-cached-json'
import { getSnapshot } from '@/lib/client/snapshot'
import { firstRunSteps } from '@/lib/goals/dashboard-copy'

/**
 * Goal-first onboarding: the brand narrative as three soft-ordered steps.
 * State derives from live counts — no persisted onboarding flag; the card
 * disappears once connections, a goal, and an agent all exist.
 */
export function FirstRunGuide({ goalsCount }: { readonly goalsCount: number | null }) {
  const [connections, setConnections] = useState<number | null>(null)
  const [agents, setAgents] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    getCachedJson<{ connections?: Record<string, { connected: boolean }> }>(
      '/api/nango/status',
      60_000,
    )
      .then((data) => {
        if (!cancelled)
          setConnections(
            Object.values(data.connections ?? {}).filter((status) => status.connected).length,
          )
      })
      .catch(() => {
        if (!cancelled) setConnections(0)
      })
    getSnapshot()
      .then((snapshot) => {
        if (!cancelled) setAgents(snapshot.agents.length)
      })
      .catch(() => {
        if (!cancelled) setAgents(0)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (connections === null || agents === null || goalsCount === null) return null
  const { steps, showGuide } = firstRunSteps({ connections, goals: goalsCount, agents })
  if (!showGuide) return null

  return (
    <div className="mb-4 rounded-2xl border bg-card p-4 shadow-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Connect. Connect the dots. Deploy. Prove it.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {steps.map((step) => (
          <Link
            key={step.key}
            href={step.href}
            className="group flex items-start gap-2.5 rounded-xl border bg-background p-3 transition-colors hover:bg-muted"
          >
            {step.done ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden />
            ) : (
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-sm font-medium">
                {step.label}
                <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{step.detail}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
