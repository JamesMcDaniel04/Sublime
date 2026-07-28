'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type Health = {
  windowDays: number
  gates: {
    connections: { total: number; ready: boolean }
    usage: { events: number; ready: boolean }
  }
  suggestions: { open: number; accepted: number; dismissed: number; acceptRate: number | null; adopted: number }
  patterns: { open: number }
  activity: { firstEventAt: string | null; lastEventAt: string | null }
}

function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold">{value}</p>
    </div>
  )
}

// Admin-only "is the platform learning?" rollup (org-scoped): gate states,
// suggestion funnel and adoption, pattern inventory, ledger freshness.
export function IntelligenceHealthCard() {
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/intelligence/health', { cache: 'no-store' })
        const data = await response.json().catch(() => ({}))
        if (!cancelled && response.ok && data.health) setHealth(data.health as Health)
      } catch {
        /* card doesn't render */
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (!health) return null

  const gateLabel = health.gates.connections.ready
    ? health.gates.usage.ready ? 'Learning & suggesting' : 'Capturing usage'
    : 'Awaiting connections'
  const acceptRate = health.suggestions.acceptRate === null
    ? '—'
    : `${Math.round(health.suggestions.acceptRate * 100)}%`
  const lastEvent = health.activity.lastEventAt
    ? new Date(health.activity.lastEventAt).toLocaleDateString()
    : 'never'

  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader><CardTitle>Intelligence health</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          How the learning loop is performing for this workspace (last {health.windowDays} days). Status: <span className="font-medium text-foreground">{gateLabel}</span>.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Connections" value={`${health.gates.connections.total} (gate ${health.gates.connections.ready ? 'met' : 'not met'})`} />
          <Stat label="Usage signals" value={`${health.gates.usage.events} (gate ${health.gates.usage.ready ? 'met' : 'not met'})`} />
          <Stat label="Open patterns" value={String(health.patterns.open)} />
          <Stat label="Suggestions accepted" value={`${health.suggestions.accepted} of ${health.suggestions.accepted + health.suggestions.dismissed}`} />
          <Stat label="Accept rate" value={acceptRate} />
          <Stat label="Adopted (live flows)" value={String(health.suggestions.adopted)} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Latest captured activity: {lastEvent}.</p>
      </CardContent>
    </Card>
  )
}
