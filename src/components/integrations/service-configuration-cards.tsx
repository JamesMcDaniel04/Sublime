'use client'

import { useEffect, useState } from 'react'
import { KeyRound, TestTube2, Trash2 } from 'lucide-react'
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

export function ServiceConfigurationCards() {
  return <div className="grid gap-6 lg:grid-cols-2"><GranolaCard /></div>
}
