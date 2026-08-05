'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * Floating notice for a dead execution backend. /api/health reports
 * queue.workerAlive from the worker's Redis heartbeat; when the queue is
 * configured but no worker is consuming it, every Run click would fail — say
 * so up front instead of letting users discover it run by run. Renders
 * nothing in inline mode (queue unconfigured) or on older health payloads.
 */
export function QueueHealthBanner() {
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        const body = await res.json().catch(() => null)
        const queue = body?.checks?.queue
        if (!cancelled) setOffline(Boolean(queue?.configured) && queue?.workerAlive === false)
      } catch {
        // Network blip — keep the last known state rather than flapping.
      }
    }
    void check()
    const timer = window.setInterval(check, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  if (!offline) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-sm text-amber-600 shadow-sm backdrop-blur dark:text-amber-400">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Execution backend offline — flow runs will fail until the worker reconnects.
      </div>
    </div>
  )
}
