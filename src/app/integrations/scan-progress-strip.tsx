'use client'

import { useMemo, useState } from 'react'
import { X, Sparkles } from 'lucide-react'
import { useCachedJson } from '@/lib/client/use-cached-json'

type Notification = {
  id: string
  type: string
  title: string
  body: string | null
  createdAt: string
}

const DISMISSED_KEY = 'bs:dismissed-scan-strip'

/**
 * "Your data takes shape" — a slim, dismissible strip surfacing the most
 * recent connection-scan learnings (stage 02 of the behavioral-intelligence
 * UX narrative). Renders nothing when there's no scan activity yet, so it
 * never shows empty-state noise.
 */
export function ScanProgressStrip() {
  const { data } = useCachedJson<{ notifications?: Notification[] }>('/api/notifications?limit=30')
  const [dismissedIds, setDismissedIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      return JSON.parse(window.localStorage.getItem(DISMISSED_KEY) || '[]') as string[]
    } catch {
      return []
    }
  })

  const scans = useMemo(
    () => (data?.notifications ?? []).filter((n) => n.type === 'intelligence.scan').slice(0, 3),
    [data],
  )
  const visible = scans.filter((n) => !dismissedIds.includes(n.id))

  if (visible.length === 0) return null

  function dismiss(id: string) {
    const next = [...dismissedIds, id]
    setDismissedIds(next)
    try {
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      /* best-effort only */
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        Your data takes shape
      </p>
      <div className="space-y-1.5">
        {visible.map((n) => (
          <div key={n.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate text-foreground/90">
              Learning from <span className="font-medium">{n.title}</span>
              {n.body ? ` — ${n.body}` : ''}
            </span>
            <button
              type="button"
              onClick={() => dismiss(n.id)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
