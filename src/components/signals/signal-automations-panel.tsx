'use client'

import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Radio, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SIGNAL_TYPES } from '@/lib/signals/events'

type Subscription = { id: string; signalType: string; filter: unknown; isActive: boolean; canManage: boolean; agentTask: { id: string; description: string } }
type Agent = { id: string; title: string }
type SignalEvent = { id: string; type: string; accountId?: string | null; opportunityId?: string | null; provenanceUrl?: string | null; receivedAt: string; processedAt?: string | null; _count: { subscriptionRuns: number } }

export function SignalAutomationsPanel() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [events, setEvents] = useState<SignalEvent[]>([])
  const [signalType, setSignalType] = useState<string>(SIGNAL_TYPES[0])
  const [agentId, setAgentId] = useState('')
  const [filterJson, setFilterJson] = useState('{}')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [subscriptionsResponse, agentsResponse, eventsResponse] = await Promise.all([
        fetch('/api/signal-subscriptions', { cache: 'no-store' }), fetch('/api/agents', { cache: 'no-store' }), fetch('/api/signals?limit=20', { cache: 'no-store' }),
      ])
      const [subscriptionsData, agentsData, eventsData] = await Promise.all([subscriptionsResponse.json().catch(() => ({})), agentsResponse.json().catch(() => ({})), eventsResponse.json().catch(() => ({}))])
      if (!subscriptionsResponse.ok || !subscriptionsData.success) throw new Error(subscriptionsData.error || 'Could not load signal automations.')
      if (!agentsResponse.ok || !agentsData.success) throw new Error(agentsData.error || 'Could not load agents.')
      if (!eventsResponse.ok || !eventsData.success) throw new Error(eventsData.error || 'Could not load recent signals.')
      setSubscriptions(subscriptionsData.subscriptions ?? []); setAgents(agentsData.agents ?? []); setEvents(eventsData.signals ?? [])
      setAgentId((current) => current || agentsData.agents?.[0]?.id || '')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load signal automations.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const create = async () => {
    let filter: Record<string, string | number | boolean>
    try {
      const parsed = JSON.parse(filterJson)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      filter = parsed
    } catch { return toast.error('Filter must be a JSON object, such as {"risk_level":"high"}.') }
    setBusy('create')
    try {
      const response = await fetch('/api/signal-subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signalType, agentTaskId: agentId, filter }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not create the automation.')
      toast.success('Signal automation created.'); setFilterJson('{}'); await load()
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Could not create the automation.') }
    finally { setBusy(null) }
  }
  const update = async (subscription: Subscription, method: 'PATCH' | 'DELETE') => {
    setBusy(subscription.id)
    try {
      const response = await fetch(`/api/signal-subscriptions/${encodeURIComponent(subscription.id)}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'PATCH' ? { body: JSON.stringify({ isActive: !subscription.isActive }) } : {}) })
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not update the automation.')
      if (method === 'DELETE') setSubscriptions((current) => current.filter((row) => row.id !== subscription.id))
      else setSubscriptions((current) => current.map((row) => row.id === subscription.id ? { ...row, isActive: !row.isActive } : row))
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Could not update the automation.') }
    finally { setBusy(null) }
  }

  return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Radio className="h-4 w-4" />Inbound event automations</CardTitle></CardHeader><CardContent className="space-y-5">
    {error && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error} <button className="font-medium underline" onClick={() => void load()}>Try again</button></p>}
    <div className="grid gap-3 md:grid-cols-[1fr_1fr_1.3fr_auto]"><div className="space-y-1.5"><Label>Event</Label><Select value={signalType} onValueChange={setSignalType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SIGNAL_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label>Run agent</Label><Select value={agentId} onValueChange={setAgentId}><SelectTrigger><SelectValue placeholder="Choose agent" /></SelectTrigger><SelectContent>{agents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.title}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor="signal-filter">Optional filter JSON</Label><Input id="signal-filter" className="font-mono" value={filterJson} onChange={(event) => setFilterJson(event.target.value)} /></div><Button className="self-end" onClick={() => void create()} loading={busy === 'create'} disabled={!agentId || busy !== null}>Create</Button></div>
    {!loading && subscriptions.length === 0 ? <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No inbound automations yet.</p> : <div className="space-y-2">{subscriptions.map((subscription) => <div key={subscription.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{subscription.signalType}</p><p className="truncate text-xs text-muted-foreground">Runs {subscription.agentTask.description}</p></div><Badge variant={subscription.isActive ? 'good' : 'secondary'}>{subscription.isActive ? 'Active' : 'Paused'}</Badge>{subscription.canManage && <><Switch checked={subscription.isActive} disabled={busy === subscription.id} onCheckedChange={() => void update(subscription, 'PATCH')} aria-label={subscription.isActive ? 'Pause signal automation' : 'Activate signal automation'} /><Button size="icon" variant="ghost" disabled={busy === subscription.id} aria-label="Delete signal automation" onClick={() => void update(subscription, 'DELETE')}><Trash2 className="h-4 w-4" /></Button></>}</div>)}</div>}
    <div><h3 className="mb-2 text-sm font-semibold">Recent inbound signals</h3>{!loading && events.length === 0 ? <p className="text-sm text-muted-foreground">No workspace signals received yet.</p> : <div className="divide-y rounded-lg border">{events.map((event) => <div key={event.id} className="flex flex-wrap items-center gap-3 p-3 text-sm"><div className="min-w-0 flex-1"><p className="font-medium">{event.type}</p><p className="text-xs text-muted-foreground">{event.accountId ? `Account ${event.accountId}` : event.opportunityId ? `Opportunity ${event.opportunityId}` : 'Workspace event'} · {new Date(event.receivedAt).toLocaleString()}</p></div><Badge variant="outline">{event._count.subscriptionRuns} run{event._count.subscriptionRuns === 1 ? '' : 's'}</Badge>{event.provenanceUrl && /^https?:\/\//i.test(event.provenanceUrl) && <a href={event.provenanceUrl} target="_blank" rel="noreferrer" aria-label="Open signal source"><ExternalLink className="h-4 w-4" /></a>}</div>)}</div>}</div>
  </CardContent></Card>
}
