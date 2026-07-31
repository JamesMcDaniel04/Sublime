'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Bell, CheckCircle2, HelpCircle, Info, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/use-auth'
import { getSnapshot } from '@/lib/client/snapshot'
import { notificationHref } from '@/lib/notifications/notification-href'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SuggestionApprovalDialog } from '@/components/intelligence/suggestion-approval-dialog'
import { toast } from 'sonner'

type NotificationItem = {
  id: string
  type: string
  level: 'info' | 'success' | 'error' | 'action'
  title: string
  body?: string | null
  executionId?: string | null
  readAt?: string | null
  createdAt: string
  /** null = org-wide broadcast — only admins may delete those. */
  userId?: string | null
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

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

export function NotificationBell({ buttonClassName }: { buttonClassName?: string } = {}) {
  const router = useRouter()
  const { isAdmin } = useAuth()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [pushState, setPushState] = useState<PushState>('unknown')
  const [detail, setDetail] = useState<NotificationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  // The intelligence.user-suggestion notification whose approve/deny dialog is open.
  const [suggestionNotification, setSuggestionNotification] = useState<NotificationItem | null>(null)
  // Jam invites already seen this session — null until the first snapshot so
  // invites that predate opening the app surface only in the bell, not as a
  // burst of stale toasts.
  const seenJamInvitesRef = useRef<Set<string> | null>(null)

  const load = useCallback(async () => {
    // Shared app-shell snapshot (deduped with the dashboard + sidebar) rather
    // than a dedicated notifications request each tick.
    try {
      const snapshot = await getSnapshot()
      const notifications = (snapshot.notifications || []) as NotificationItem[]
      setItems(notifications)
      setUnread(snapshot.unread || 0)
      // A Flow Jam invite is a live "come work with me NOW" signal, not archive
      // material — surface new ones as an actionable toast that takes the
      // invitee straight into the flow they were invited to.
      const invites = notifications.filter((n) => n.type === 'flow.jam.invite' && !n.readAt)
      // First load must NOT silently seed unread invites as "seen" — an invite
      // that landed before this page session (the teammate clicked Invite while
      // you were navigating or opening the app) would then never prompt at all.
      // Prompt for any unread invite still fresh enough to be a live session;
      // older unread ones stay visible in the bell list.
      const isFirstLoad = seenJamInvitesRef.current === null
      const seen = (seenJamInvitesRef.current ??= new Set<string>())
      const FRESH_INVITE_MS = 30 * 60 * 1000
      for (const invite of invites) {
        if (seen.has(invite.id)) continue
        seen.add(invite.id)
        if (isFirstLoad && Date.now() - new Date(invite.createdAt).getTime() > FRESH_INVITE_MS) continue
        toast(invite.title, {
          description: invite.body || undefined,
          duration: 15000,
          action: { label: 'Join jam', onClick: () => router.push(notificationHref(invite)) },
        })
      }
    } catch {
      // leave the last-known list on a transient failure
    }
  }, [router])

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
      if (!sub) return setPushState('available')
      // The browser still holding a subscription is NOT proof it delivers:
      // the server row may have been deleted (workspace teardown, account
      // switch). Confirm with the server; a missing row means re-enrolling is
      // needed, so show 'available' rather than a false 'enabled'.
      const check = await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`, { cache: 'no-store' }).catch(() => null)
      const checkData = check && check.ok ? await check.json() : null
      setPushState(checkData?.registered === false ? 'available' : 'enabled')
    }
    probe().catch(() => setPushState('unavailable'))
  }, [])

  const markRead = async () => {
    if (!unread) return
    const previousUnread = unread
    const previousItems = items
    setUnread(0)
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })))
    try {
      const response = await fetch('/api/notifications/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      if (!response.ok) throw new Error()
    } catch {
      setUnread(previousUnread)
      setItems(previousItems)
      toast.error('Could not mark notifications as read.')
    }
  }

  const enablePush = async () => {
    try {
      const { publicKey } = await (await fetch('/api/push/key', { cache: 'no-store' })).json()
      if (!publicKey) return toast.error('Push notifications are not configured for this workspace.')
      const reg = await navigator.serviceWorker.register('/sw.js')
      if ((await Notification.requestPermission()) !== 'granted') return toast.error('Browser notification permission was not granted.')
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } }
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      })
      if (!response.ok) {
        await sub.unsubscribe()
        return toast.error('Could not enable push notifications.')
      }
      setPushState('enabled')
      toast.success('Push notifications enabled.')
    } catch {
      toast.error('Could not enable push notifications.')
    }
  }

  const disablePush = async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = reg ? await reg.pushManager.getSubscription() : null
      if (sub) {
        const response = await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' })
        if (!response.ok) return toast.error('Could not disable push notifications.')
        await sub.unsubscribe()
      }
      setPushState('available')
      toast.success('Push notifications disabled.')
    } catch {
      // Keep the truthful enabled state when unsubscribe fails.
      toast.error('Could not disable push notifications.')
    }
  }

  const dismiss = async (notification: NotificationItem) => {
    const previous = items
    setItems((current) => current.filter((n) => n.id !== notification.id))
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notification.id)}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error)
      }
    } catch (cause) {
      setItems(previous)
      toast.error(cause instanceof Error && cause.message ? cause.message : 'Could not dismiss the notification.')
    }
  }

  const openDetail = async (notification: NotificationItem) => {
    setOpen(false)
    setDetail({ notification, processes: [] })
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notification.id)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.notification) {
        setDetailError(data.error || 'Could not load process details.')
      } else {
        setDetail({ notification: data.notification, processes: data.processes ?? [] })
      }
    } catch {
      setDetailError('Could not load process details.')
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
          <div className="absolute left-0 z-40 mt-1 w-80 max-w-[calc(100vw-1.5rem)] rounded-lg border bg-card shadow-lg">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-semibold">Notifications</span>
              {pushState === 'available' && <button className="text-xs font-medium text-indigo-600" onClick={enablePush}>Enable push</button>}
              {pushState === 'enabled' && <button className="text-xs font-medium text-muted-foreground hover:text-red-600" onClick={disablePush}>Disable push</button>}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No notifications yet.</p>}
              {items.map((n) => {
                const content = <>
                  {levelIcon(n.level)}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{n.title}</div>
                    {n.body && <div className="line-clamp-2 text-xs text-muted-foreground">{n.body}</div>}
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                </>
                const rowClass = 'flex min-w-0 flex-1 gap-2 px-3 py-2.5 text-left'
                return (
                  <div key={n.id} className={cn('flex w-full items-start border-b hover:bg-muted', !n.readAt && 'bg-indigo-50/40')}>
                    {n.type === 'intelligence.scan' ? (
                      <button type="button" onClick={() => openDetail(n)} className={rowClass}>{content}</button>
                    ) : n.type === 'intelligence.user-suggestion' ? (
                      /* A suggestion expands into its approve/deny dialog —
                         never a bare navigation. */
                      <button type="button" onClick={() => { setOpen(false); setSuggestionNotification(n) }} className={rowClass}>{content}</button>
                    ) : (
                      /* Client-side route (no full-page reload); a button keeps
                         Enter/Space keyboard activation like the old link. */
                      <button
                        type="button"
                        className={rowClass}
                        onClick={() => { setOpen(false); router.push(notificationHref(n)) }}
                      >
                        {content}
                      </button>
                    )}
                    {/* Broadcast rows (userId null) are deletable by admins only —
                        the DELETE route 404s for everyone else, so don't offer it. */}
                    {(n.userId !== null || isAdmin) && (
                      <button
                        type="button"
                        aria-label="Dismiss notification"
                        title="Dismiss"
                        className="mr-2 mt-3 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => void dismiss(n)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
      <SuggestionApprovalDialog
        open={Boolean(suggestionNotification)}
        onClose={() => setSuggestionNotification(null)}
        onActioned={() => {
          // The suggestion was approved or denied — its notification row is
          // now stale; clear it so the bell doesn't advertise handled work.
          if (suggestionNotification) void dismiss(suggestionNotification)
        }}
      />
      <Dialog open={Boolean(detail)} onOpenChange={(next) => { if (!next) setDetail(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What Sublime learned from {detail?.notification.title}</DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <p className="text-sm text-muted-foreground">Loading process details…</p>
          ) : detailError ? (
            <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{detailError}</p>
          ) : detail?.processes.length ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{detail.processes.length} process{detail.processes.length === 1 ? '' : 'es'} understood:</p>
              <ol className="space-y-2">
                {detail.processes.map((process, index) => (
                  <li key={`${index}-${process}`} className="flex gap-3 rounded-lg border bg-muted p-3 text-sm text-muted-foreground">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">{index + 1}</span>
                    <span>{process}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No concrete processes were identified in this scan.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
