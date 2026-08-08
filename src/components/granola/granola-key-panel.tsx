'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, KeyRound, Plug } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

/** Exactly what GET/POST/DELETE /api/integrations/granola return — the key
 *  itself is never part of the response, so this panel can only ever show
 *  whether one is configured and where it came from. */
type GranolaState = { configured: boolean; source: 'user' | null }

/**
 * Personal Granola API key management inside the current organization.
 *
 * Granola authenticates with a workspace API key rather than OAuth, so it has
 * no Connect flow — the routes have existed since the notes tools shipped, but
 * nothing rendered them, which left every org without the GRANOLA_API_KEY
 * deployment fallback staring at an empty notes picker with no way to fix it.
 *
 * The stored key is encrypted and never returned, so an org key is shown as a
 * state ("Connected") and replaced wholesale rather than edited — the same
 * posture as the credential vault and the Postgres connection strings.
 */
export function GranolaKeyPanel() {
  const [state, setState] = useState<GranolaState | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [removing, setRemoving] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/integrations/granola', { cache: 'no-store' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not load the Granola connection.')
      setState({ configured: Boolean(body.configured), source: body.source ?? null })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load the Granola connection.')
      setState({ configured: false, source: null })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    const key = apiKey.trim()
    if (!key) return
    setSaving(true)
    try {
      const response = await fetch('/api/integrations/granola', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not save the Granola API key.')
      setState({ configured: Boolean(body.configured), source: body.source ?? null })
      setApiKey('')
      toast.success('Granola connected. Recent notes are being imported in the background.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the Granola API key.')
    } finally {
      setSaving(false)
    }
  }

  /** Tests the pasted key when there is one, otherwise the saved key —
   *  exactly the fallback the route implements. */
  const test = async () => {
    setTesting(true)
    try {
      const key = apiKey.trim()
      const response = await fetch('/api/integrations/granola/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(key ? { apiKey: key } : {}),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not reach Granola.')
      toast.success(key ? 'That key works. Save it to connect Granola.' : 'Granola is reachable with the saved key.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not reach Granola.')
    } finally {
      setTesting(false)
    }
  }

  const remove = async () => {
    if (!window.confirm('Remove the saved Granola API key? Agents lose access to your meeting notes.')) return
    setRemoving(true)
    try {
      const response = await fetch('/api/integrations/granola', { method: 'DELETE' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not remove the Granola API key.')
      setState({ configured: Boolean(body.configured), source: body.source ?? null })
      toast.success('Granola disconnected from your account.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove the Granola API key.')
    } finally {
      setRemoving(false)
    }
  }

  if (!state) return <Skeleton className="h-56 max-w-2xl rounded-xl" />

  const userKey = state.source === 'user'

  return (
    <div className="max-w-2xl space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
          </span>
          <div>
            <p className="text-sm font-medium">Granola API key</p>
            <p className="text-xs text-muted-foreground">
              {userKey
                ? 'Your key is saved for you only. It is encrypted at rest and never shown again.'
                : 'Create a key in Granola › Settings › API and paste it here.'}
            </p>
          </div>
        </div>
        {state.configured
          ? <Badge variant="good"><CheckCircle2 className="mr-1 h-3 w-3" />Connected</Badge>
          : <Badge variant="secondary">Not connected</Badge>}
      </div>

      <form
          className="space-y-2"
          onSubmit={(event) => { event.preventDefault(); void save() }}
        >
          <Label htmlFor="granola-api-key">{userKey ? 'Replace your saved key' : 'API key'}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="granola-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={userKey ? 'Paste a new key to replace your saved one' : 'gr_…'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button type="submit" loading={saving} disabled={saving || !apiKey.trim()}>
              <Plug className="mr-1.5 h-4 w-4" />{userKey ? 'Replace' : 'Connect'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The key is verified against Granola before it is saved, so a bad key never reaches the workspace.
          </p>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={testing}
              disabled={testing || (!apiKey.trim() && !state.configured)}
              onClick={() => void test()}
            >
              Test connection
            </Button>
            {userKey && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                loading={removing}
                disabled={removing}
                onClick={() => void remove()}
              >
                Remove key
              </Button>
            )}
          </div>
      </form>
    </div>
  )
}
