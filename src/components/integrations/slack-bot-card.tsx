'use client'

import { useCallback, useEffect, useState } from 'react'
import { Copy, Download, MessageSquare, Trash2 } from 'lucide-react'
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

export function SlackBotCard() {
  const [connections, setConnections] = useState<SlackConnection[]>([])
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/slack/connections')
      const data = await res.json()
      if (res.ok) setConnections(data.connections ?? [])
    } catch {
      // listing failure is non-fatal; the card just shows the connect form
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

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
        {connections.map((connection) => (
          <div key={connection.id} className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
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
          </div>
        ))}
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
