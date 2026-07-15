'use client'

import { useEffect, useState } from 'react'
import { Copy, KeyRound, RotateCw, TestTube2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type GranolaState = { configured: boolean; source: 'saved' | 'env' | null }

async function jsonResponse(response: Response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data
}

function GranolaCard() {
  const [state, setState] = useState<GranolaState | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')

  const load = async () => {
    setLoadError('')
    try {
      const data = await jsonResponse(await fetch('/api/integrations/granola', { cache: 'no-store' }))
      setState({ configured: Boolean(data.configured), source: data.source ?? null })
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Could not load Granola configuration.')
    }
  }
  useEffect(() => { void load() }, [])

  const act = async (kind: 'save' | 'test' | 'remove') => {
    setBusy(kind)
    try {
      const response = kind === 'remove'
        ? await fetch('/api/integrations/granola', { method: 'DELETE' })
        : await fetch(kind === 'test' ? '/api/integrations/granola/test' : '/api/integrations/granola', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          })
      const data = await jsonResponse(response)
      toast.success(kind === 'save' ? 'Granola key saved.' : kind === 'test' ? 'Granola connection works.' : 'Saved Granola key removed.')
      if (kind !== 'test') {
        setApiKey('')
        setState({ configured: Boolean(data.configured), source: data.source ?? null })
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Granola request failed.')
    } finally { setBusy(null) }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" />Granola</CardTitle><CardDescription>Connect meeting notes for imports and agent context. Keys are encrypted at rest.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {loadError ? <p className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{loadError} <button className="font-medium underline" onClick={() => void load()}>Retry</button></p> : <p className="text-sm text-muted-foreground">{state?.configured ? `Connected via ${state.source === 'saved' ? 'workspace key' : 'server configuration'}.` : 'Not connected.'}</p>}
        <div className="space-y-1.5"><Label htmlFor="granola-key">API key</Label><Input id="granola-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="grn_…" /></div>
        <div className="flex flex-wrap gap-2"><Button onClick={() => void act('save')} loading={busy === 'save'} disabled={!apiKey.trim() || busy !== null}>Save and verify</Button><Button variant="outline" onClick={() => void act('test')} loading={busy === 'test'} disabled={busy !== null || (!apiKey.trim() && !state?.configured)}><TestTube2 className="mr-1.5 h-4 w-4" />Test</Button>{state?.source === 'saved' && <Button variant="ghost" onClick={() => void act('remove')} loading={busy === 'remove'} disabled={busy !== null}><Trash2 className="mr-1.5 h-4 w-4" />Remove</Button>}</div>
      </CardContent>
    </Card>
  )
}

function PeopleAiWebhookCard() {
  const [secret, setSecret] = useState('')
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const endpoint = typeof window === 'undefined' ? '/api/signals/people-ai' : `${window.location.origin}/api/signals/people-ai`

  const load = async () => {
    setError('')
    try {
      const data = await jsonResponse(await fetch('/api/peopleai/webhook-secret', { cache: 'no-store' }))
      setSecret(data.secret ?? '')
      setConfigured(Boolean(data.configured))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load webhook configuration.') }
  }
  useEffect(() => { void load() }, [])

  const rotate = async () => {
    if (configured && !window.confirm('Rotate the People.ai webhook secret? The previous secret will stop working immediately.')) return
    setBusy(true)
    try {
      const data = await jsonResponse(await fetch('/api/peopleai/webhook-secret', { method: 'POST' }))
      setSecret(data.secret)
      setConfigured(true)
      toast.success(configured ? 'Webhook secret rotated.' : 'Webhook secret created.')
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Could not configure the webhook.') }
    finally { setBusy(false) }
  }
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); toast.success(`${label} copied.`) }
    catch { toast.error(`Could not copy ${label.toLowerCase()}.`) }
  }

  return (
    <Card>
      <CardHeader><CardTitle>People.ai signal webhook</CardTitle><CardDescription>Register this endpoint and signing secret in People.ai to receive Sales AI signals.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error} <button className="font-medium underline" onClick={() => void load()}>Retry</button></p>}
        <div className="space-y-1.5"><Label>Endpoint</Label><div className="flex gap-2"><Input readOnly value={endpoint} /><Button variant="outline" size="icon" aria-label="Copy People.ai webhook endpoint" onClick={() => void copy(endpoint, 'Endpoint')}><Copy className="h-4 w-4" /></Button></div></div>
        {secret && <div className="space-y-1.5"><Label>Signing secret</Label><div className="flex gap-2"><Input readOnly type="password" value={secret} /><Button variant="outline" size="icon" aria-label="Copy People.ai signing secret" onClick={() => void copy(secret, 'Secret')}><Copy className="h-4 w-4" /></Button></div></div>}
        <Button variant={configured ? 'outline' : 'default'} onClick={() => void rotate()} loading={busy}><RotateCw className="mr-1.5 h-4 w-4" />{configured ? 'Rotate secret' : 'Create secret'}</Button>
      </CardContent>
    </Card>
  )
}

export function ServiceConfigurationCards() {
  return <div className="grid gap-6 lg:grid-cols-2"><GranolaCard /><PeopleAiWebhookCard /></div>
}
