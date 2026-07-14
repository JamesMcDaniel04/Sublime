'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Bell, CheckCircle2, HelpCircle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getSnapshot } from '@/lib/client/snapshot'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type NotificationItem = {
  id: string
  type: string
  level: 'info' | 'success' | 'error' | 'action'
  title: string
  body?: string | null
  executionId?: string | null
  readAt?: string | null
  createdAt: string
}

type PushState = 'unknown' | 'unavailable' | 'available' | 'enabled'
type NotificationDetail = { notification: NotificationItem; processes: string[] }

function levelIcon(level: string) {
  switch (level) {
    case 'error': return <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
    case 'success': return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
    case 'action': return <HelpCircle className="h-4 w-4 shrink-0 text-amber-500" />
    default: return <Info className="h-4 w-4 shrink-0 text-blue-500" />
  }
}

// Flow notifications carry the FLOW id in executionId and deep-link to that
// flow's activity page — a flow run id is not resolvable by the dashboard.
function notificationHref(n: NotificationItem): string {
  if (n.type === 'flow.jam' && n.executionId) return `/flows/${n.executionId}` // straight into the jam
  if (n.type.startsWith('flow.') && n.executionId) return `/flows/${n.executionId}/activity`
  return n.executionId ? `/dashboard?run=${n.executionId}` : '/dashboard'
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

export function NotificationBell({ buttonClassName }: { buttonClassName?: string } = {}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [pushState, setPushState] = useState<PushState>('unknown')
  const [detail, setDetail] = useState<NotificationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    // Shared app-shell snapshot (deduped with the dashboard + sidebar) rather
    // than a dedicated notifications request each tick.
    try {
      const snapshot = await getSnapshot()
      setItems((snapshot.notifications || []) as NotificationItem[])
      setUnread(snapshot.unread || 0)
    } catch {
      // leave the last-known list on a transient failure
    }
  }, [])

  useEffect(() => {
    load().catch(() => {})
    // Poll only while the tab is visible; refresh on return to the tab.
    const timer = window.setInterval(() => {
      if (!document.hidden) load().catch(() => {})
    }, 15000)
    const onVisible = () => {
      if (!document.hidden) load().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  useEffect(() => {
    const probe = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPushState('unavailable')
      const res = await fetch('/api/push/key', { cache: 'no-store' }).catch(() => null)
      const data = res && res.ok ? await res.json() : null
      if (!data?.enabled || !data?.publicKey) return setPushState('unavailable')
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = reg ? await reg.pushManager.getSubscription() : null
      setPushState(sub ? 'enabled' : 'available')
    }
    probe().catch(() => setPushState('unavailable'))
  }, [])

  const markRead = async () => {
    if (!unread) return
    setUnread(0)
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })))
    await fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {})
  }

  const enablePush = async () => {
    try {
      const { publicKey } = await (await fetch('/api/push/key', { cache: 'no-store' })).json()
      if (!publicKey) return
      const reg = await navigator.serviceWorker.register('/sw.js')
      if ((await Notification.requestPermission()) !== 'granted') return
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      })
      setPushState('enabled')
    } catch {
      /* ignore — in-app notifications still work */
    }
  }

  const openDetail = async (notification: NotificationItem) => {
    setOpen(false)
    setDetail({ notification, processes: [] })
    setDetailLoading(true)
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notification.id)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (response.ok) setDetail({ notification: data.notification, processes: data.processes ?? [] })
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="icon"
        className={cn("relative h-9 w-9 shrink-0", buttonClassName)}
        aria-label="Notifications"
        onClick={() => { setOpen((o) => !o); if (!open) markRead() }}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          {/* Bell lives in the left sidebar, so open rightward (left-0); cap
              width so the panel never overflows a narrow mobile drawer. */}
          <div className="absolute left-0 z-40 mt-1 w-80 max-w-[calc(100vw-1.5rem)] rounded-lg border bg-white shadow-lg">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-semibold">Notifications</span>
              {pushState === 'available' && <button className="text-xs font-medium text-indigo-600" onClick={enablePush}>Enable push</button>}
              {pushState === 'enabled' && <span className="text-xs text-gray-400">Push on</span>}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 && <p className="px-3 py-6 text-center text-sm text-gray-400">No notifications yet.</p>}
              {items.map((n) => {
                const content = <>
                  {levelIcon(n.level)}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{n.title}</div>
                    {n.body && <div className="line-clamp-2 text-xs text-gray-500">{n.body}</div>}
                    <div className="mt-0.5 text-[11px] text-gray-400">{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                </>
                const rowClass = cn('flex w-full gap-2 border-b px-3 py-2.5 text-left hover:bg-gray-50', !n.readAt && 'bg-indigo-50/40')
                return n.type === 'intelligence.scan' ? (
                  <button key={n.id} type="button" onClick={() => openDetail(n)} className={rowClass}>{content}</button>
                ) : (
                  <a key={n.id} href={notificationHref(n)} className={rowClass}>{content}</a>
                )
              })}
            </div>
          </div>
        </>
      )}
      <Dialog open={Boolean(detail)} onOpenChange={(next) => { if (!next) setDetail(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What Sublime learned from {detail?.notification.title}</DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <p className="text-sm text-gray-500">Loading process details…</p>
          ) : detail?.processes.length ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">{detail.processes.length} process{detail.processes.length === 1 ? '' : 'es'} understood:</p>
              <ol className="space-y-2">
                {detail.processes.map((process, index) => (
                  <li key={`${index}-${process}`} className="flex gap-3 rounded-lg border bg-gray-50 p-3 text-sm text-gray-700">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">{index + 1}</span>
                    <span>{process}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No concrete processes were identified in this scan.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
