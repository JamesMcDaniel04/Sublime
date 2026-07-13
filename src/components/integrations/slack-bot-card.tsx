'use client'

import { useCallback, useEffect, useState } from 'react'
import { Copy, Download, History, MessageSquare, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type SlackConnection = {
  id: string
  teamId: string
  teamName: string | null
  botUserId: string
  status: string
  ingressUrl: string
}

type BackfillWindow = '90d' | '1y' | 'all'

type ActivityBackfill = {
  id: string
  source: string
  connectionRef: string
  window: BackfillWindow
  status: 'pending' | 'running' | 'partial' | 'done' | 'failed'
  eventsIngested: number
  updatedAt: string
}

const HISTORY_WINDOWS: Array<{ value: BackfillWindow; label: string }> = [
  { value: '90d', label: 'Last 90 days' },
  { value: '1y', label: 'Last year' },
  { value: 'all', label: 'All available history' },
]

function backfillStatus(backfill: ActivityBackfill): string {
  const count = backfill.eventsIngested.toLocaleString()
  if (backfill.status === 'failed') return `History learning failed after ${count} events. Choose a window to retry.`
  if (backfill.status === 'done') return `History learned — ${count} events`
  if (backfill.status === 'partial') return `Learning from history — ${count} events (partial)`
  return `Learning from history — ${count} events (${backfill.status})`
}

export function SlackBotCard() {
  const [connections, setConnections] = useState<SlackConnection[]>([])
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [backfills, setBackfills] = useState<ActivityBackfill[]>([])
  const [startingBackfill, setStartingBackfill] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/slack/connections')
      const data = await res.json()
      if (res.ok) setConnections(data.connections ?? [])
    } catch {
      // listing failure is non-fatal; the card just shows the connect form
    }
  }, [])

  const loadBackfills = useCallback(async () => {
    try {
      const res = await fetch('/api/activity/backfill')
      const data = await res.json()
      if (res.ok) setBackfills(data.backfills ?? [])
    } catch {
      // Progress is supplementary; a transient read failure is retried while active.
    }
  }, [])

  useEffect(() => {
    void load()
    void loadBackfills()
  }, [load, loadBackfills])

  const hasActiveBackfill = backfills.some((backfill) => backfill.status === 'pending' || backfill.status === 'running')
  useEffect(() => {
    if (!hasActiveBackfill) return
    const timer = window.setInterval(() => { void loadBackfills() }, 5_000)
    return () => window.clearInterval(timer)
  }, [hasActiveBackfill, loadBackfills])

  const connect = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/slack/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, signingSecret }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Slack token verification failed.')
        return
      }
      toast.success(`Connected ${data.connection.teamName ?? data.connection.teamId}.`)
      setBotToken('')
      setSigningSecret('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async (id: string) => {
    const res = await fetch(`/api/slack/connections?id=${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Slack bot disconnected.')
      await load()
    } else toast.error('Could not disconnect.')
  }

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Ingress URL copied.')
    } catch {
      toast.error('Could not copy the URL.')
    }
  }

  const downloadManifest = async (id: string) => {
    const res = await fetch(`/api/slack/connections/${id}/manifest`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.manifest) {
      toast.error('Could not build the manifest.')
      return
    }
    const blob = new Blob([JSON.stringify(data.manifest, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'slack-app-manifest.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  const startBackfill = async (connectionRef: string, historyWindow: BackfillWindow) => {
    setStartingBackfill(`${connectionRef}:${historyWindow}`)
    try {
      const res = await fetch('/api/activity/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'slack', connectionRef, window: historyWindow }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Could not start history learning.')
        return
      }
      toast.success(data.mode === 'inline-partial'
        ? 'History learning started. This environment will process a bounded first pass.'
        : 'History learning queued.')
      setBackfills((current) => [
        {
          id: data.backfillId,
          source: 'slack',
          connectionRef,
          window: historyWindow,
          status: 'pending',
          eventsIngested: 0,
          updatedAt: new Date().toISOString(),
        },
        ...current.filter((backfill) => backfill.connectionRef !== connectionRef || backfill.source !== 'slack'),
      ])
      await loadBackfills()
    } finally {
      setStartingBackfill(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" /> Slack bot
        </CardTitle>
        <CardDescription>
          Let flows respond to @mentions, DMs, channel messages, and slash commands. Paste the bot token and signing secret from your Slack app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connections.map((connection) => {
          const backfill = backfills.find((row) => row.source === 'slack' && row.connectionRef === connection.id)
          const active = backfill?.status === 'pending' || backfill?.status === 'running'
          return (
          <div key={connection.id} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {connection.teamName ?? connection.teamId}{' '}
                <span className="text-xs text-slate-500">({connection.status})</span>
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={() => disconnect(connection.id)} title="Disconnect">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="break-all rounded bg-white px-2 py-1.5 font-mono text-[11px]">{connection.ingressUrl}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => copyUrl(connection.ingressUrl)}>
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy ingress URL
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => downloadManifest(connection.id)}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> Download app manifest
              </Button>
            </div>
            <div className="space-y-2 border-t border-slate-200 pt-3">
              <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                <History className="h-4 w-4" /> Learn from history
              </div>
              <p className="text-xs text-slate-500">
                Reconstruct activity from messages the bot can access. Live learning continues automatically.
              </p>
              <div className="flex flex-wrap gap-2">
                {HISTORY_WINDOWS.map(({ value, label }) => (
                  <Button
                    key={value}
                    type="button"
                    variant={backfill?.window === value ? 'secondary' : 'outline'}
                    size="sm"
                    disabled={active || startingBackfill !== null}
                    loading={startingBackfill === `${connection.id}:${value}`}
                    onClick={() => startBackfill(connection.id, value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {backfill ? (
                <div className="space-y-1.5" aria-live="polite">
                  <p className="text-xs text-slate-600">{backfillStatus(backfill)}</p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Slack history learning progress">
                    <div className={`h-full rounded-full ${
                      backfill.status === 'failed'
                        ? 'w-1/3 bg-red-400'
                        : backfill.status === 'done'
                          ? 'w-full bg-emerald-500'
                          : backfill.status === 'partial'
                            ? 'w-3/4 bg-amber-500'
                            : 'w-2/3 animate-pulse bg-blue-500'
                    }`} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          )
        })}
        <div className="grid gap-2">
          <input
            className="h-9 rounded-md border border-slate-200 px-3 font-mono text-sm"
            type="password"
            value={botToken}
            placeholder="Bot token (xoxb-…)"
            onChange={(event) => setBotToken(event.target.value)}
          />
          <input
            className="h-9 rounded-md border border-slate-200 px-3 font-mono text-sm"
            type="password"
            value={signingSecret}
            placeholder="Signing secret"
            onChange={(event) => setSigningSecret(event.target.value)}
          />
          <Button type="button" onClick={connect} loading={saving} disabled={!botToken.trim() || !signingSecret.trim()}>
            {connections.length ? 'Connect another workspace' : 'Connect Slack bot'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
