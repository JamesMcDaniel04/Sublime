'use client'

import { useCallback, useEffect, useState } from 'react'
import { Play, Plus, Radio, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { SignalAutomationsPanel } from '@/components/signals/signal-automations-panel'

type Signal = { id: string; name: string; question: string; scope: 'account' | 'opportunity'; updatedAt: string }

export default function SignalsPage() {
  const [signals, setSignals] = useState<Signal[]>([])
  const [name, setName] = useState('')
  const [question, setQuestion] = useState('')
  const [scope, setScope] = useState<'account' | 'opportunity'>('account')
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const response = await fetch('/api/signals/custom', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not load signals.')
      setSignals(data.signals ?? [])
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : 'Could not load signals.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy('create')
    try {
      const response = await fetch('/api/signals/custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, question, scope }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.signal) throw new Error(data.error || 'Could not create the signal.')
      setSignals((current) => [data.signal, ...current]); setName(''); setQuestion(''); toast.success('Signal saved.')
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Could not create the signal.') }
    finally { setBusy(null) }
  }
  const remove = async (signal: Signal) => {
    if (!window.confirm(`Delete “${signal.name}”?`)) return
    setBusy(signal.id)
    try {
      const response = await fetch(`/api/signals/custom?id=${encodeURIComponent(signal.id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not delete the signal.')
      setSignals((current) => current.filter((row) => row.id !== signal.id)); toast.success('Signal deleted.')
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Could not delete the signal.') }
    finally { setBusy(null) }
  }
  const run = async (signal: Signal) => {
    const target = targets[signal.id]?.trim(); if (!target) return toast.error('Enter a target first.')
    setBusy(signal.id); setAnswers((current) => ({ ...current, [signal.id]: '' }))
    try {
      const response = await fetch(`/api/signals/custom/${encodeURIComponent(signal.id)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.answer) throw new Error(data.error || 'Could not run the signal.')
      setAnswers((current) => ({ ...current, [signal.id]: data.answer }))
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Could not run the signal.') }
    finally { setBusy(null) }
  }

  return <div className="space-y-6"><PageHeader eyebrow="Sales AI" title="Signals" description="Route inbound People.ai events to agents and run reusable Sales AI questions." />
    <SignalAutomationsPanel />
    <Card><CardHeader><CardTitle className="text-base">Create signal</CardTitle></CardHeader><CardContent><form className="grid gap-4 lg:grid-cols-[1fr_180px]" onSubmit={create}><div className="space-y-2"><Label htmlFor="signal-name">Name</Label><Input id="signal-name" value={name} onChange={(event) => setName(event.target.value)} required /></div><div className="space-y-2"><Label>Scope</Label><Select value={scope} onValueChange={(value) => setScope(value as typeof scope)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="account">Account</SelectItem><SelectItem value="opportunity">Opportunity</SelectItem></SelectContent></Select></div><div className="space-y-2 lg:col-span-2"><Label htmlFor="signal-question">Question</Label><Textarea id="signal-question" value={question} onChange={(event) => setQuestion(event.target.value)} required placeholder="What changed in this account and what should I do next?" /></div><div className="lg:col-span-2"><Button type="submit" loading={busy === 'create'} disabled={busy !== null}><Plus className="mr-1.5 h-4 w-4" />Save signal</Button></div></form></CardContent></Card>
    {loadError ? <Card className="border-red-200"><CardContent className="p-4 text-sm text-red-700">{loadError} <button className="font-medium underline" onClick={() => void load()}>Try again</button></CardContent></Card> : !loading && signals.length === 0 ? <EmptyState icon={Radio} title="No custom signals yet" description="Create a reusable Sales AI question above." /> : <div className="grid gap-4 lg:grid-cols-2">{signals.map((signal) => <Card key={signal.id}><CardHeader><CardTitle className="flex items-start justify-between gap-3 text-base"><span>{signal.name}</span><Button size="icon" variant="ghost" aria-label={`Delete ${signal.name}`} disabled={busy !== null} onClick={() => void remove(signal)}><Trash2 className="h-4 w-4" /></Button></CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">{signal.question}</p><div className="flex flex-col gap-2 sm:flex-row"><Input value={targets[signal.id] ?? ''} onChange={(event) => setTargets((current) => ({ ...current, [signal.id]: event.target.value }))} placeholder={signal.scope === 'account' ? 'Account name or ID' : 'Opportunity ID'} /><Button onClick={() => void run(signal)} loading={busy === signal.id} disabled={busy !== null}><Play className="mr-1.5 h-4 w-4" />Run</Button></div>{answers[signal.id] && <div className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{answers[signal.id]}</div>}</CardContent></Card>)}</div>}
  </div>
}
