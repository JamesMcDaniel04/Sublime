'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Bot, Loader2, Send, Settings2, Store } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'sonner'
import { AgentAvatar, type AgentAvatarStatus } from '@/components/agents/agent-avatar'
import { OPEN_REQUEST_STATUSES, RequestList } from '@/components/agents/request-list'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useScopedHref } from '@/lib/client/scoped-href'
import { hasRunHistory, pickKpiSlots, type AgentKpis } from '@/lib/agents/roster-stats'
import type { SerializedAgentRequest } from '@/lib/agents/request-serialize'
import { cn } from '@/lib/utils'

type Profile = {
  agent: {
    id: string
    title: string
    description: string
    instructions: string
    roleLabel: string | null
    avatarSeed: string | null
    icon: string
    status: string
    visibility: string
    integrations: string[]
    allowFlows: boolean
    grants: Record<string, 'read' | 'write' | 'blocked'> | null
    runtime: string
    external: { host: string; authType: string; timeoutMinutes: number } | null
    lastExecutedAt: string | null
    createdAt: string
  }
  isOwner: boolean
  worker: { id: string; name: string } | null
  kpis: AgentKpis
  runs: Array<{ id: string; status: string; startedAt: string; completedAt: string | null; triggerType: string; headline: string | null }>
  requests: SerializedAgentRequest[]
  goals: Array<{ id: string; name: string; status: string }>
}

const RUN_DOT: Record<string, string> = {
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-muted-foreground/50',
  running: 'bg-horizon-500 animate-pulse',
  pending: 'bg-muted-foreground/40',
  waiting_for_input: 'bg-amber-500',
  waiting_for_approval: 'bg-amber-500',
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Run by hand',
  schedule: 'On schedule',
  webhook: 'Webhook',
  request: 'Asked',
  slack: 'From Slack',
}

function statusOf(kpis: AgentKpis): AgentAvatarStatus {
  if (kpis.waiting > 0) return 'waiting'
  if (kpis.running > 0) return 'running'
  return 'idle'
}

const relative = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * An agent's profile — the page a teammate has.
 *
 * Until now an agent had a face only on the roster, the one place its identity
 * was least load-bearing. This is where its identity lives: who it is, what
 * it does, how it has performed, what people have asked it, and the goals its
 * work has landed on. It is also the one place you can ask an agent something
 * without first being on a goal.
 */
export default function AgentProfilePage() {
  const params = useParams<{ id: string }>()
  const id = params?.id ?? ''
  const href = useScopedHref()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [missing, setMissing] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const { isAdmin } = useAuth()
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishName, setPublishName] = useState('')
  const [publishVisibility, setPublishVisibility] = useState<'organization' | 'public'>('organization')
  const [publishing, setPublishing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/agents/${id}`, { cache: 'no-store' })
      if (response.status === 404) {
        setMissing(true)
        return
      }
      if (!response.ok) return
      setProfile(await response.json())
    } catch {
      // The next poll retries; a failed fetch is not worth a toast.
    }
  }, [id])

  useEffect(() => {
    if (id) void load()
  }, [id, load])

  // Poll only while an ask is in flight, then stop — requests run for minutes.
  const hasOpen = useMemo(
    () => (profile?.requests ?? []).some((request) => OPEN_REQUEST_STATUSES.has(request.status)),
    [profile?.requests],
  )
  useEffect(() => {
    if (!hasOpen) return
    timer.current = setTimeout(() => void load(), 4000)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [hasOpen, profile, load])

  const ask = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const response = await fetch(`/api/agents/${id}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        toast.error(payload.error || 'Could not send that request.')
        return
      }
      setText('')
      await load()
    } catch {
      toast.error('Could not send that request.')
    } finally {
      setSending(false)
    }
  }

  if (missing) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <EmptyState icon={Bot} title="No such agent" description="It may have been removed, or it belongs to someone else." />
      </div>
    )
  }
  if (!profile) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
    )
  }

  const { agent, kpis } = profile
  const slots = hasRunHistory(kpis) ? pickKpiSlots(kpis) : null

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <Link href={href('/agents')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Your team
      </Link>

      <header className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
        <AgentAvatar agent={{ id: agent.id, avatarSeed: agent.avatarSeed }} size="xl" shape="tile" status={statusOf(kpis)} badge={agent.icon || undefined} name={agent.title} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold leading-tight">{agent.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {agent.roleLabel && (
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">{agent.roleLabel}</span>
            )}
            {profile.worker && <span className="text-muted-foreground">on {profile.worker.name}</span>}
            {agent.visibility === 'private' && <span className="text-xs text-muted-foreground">Private</span>}
            {agent.runtime === 'external' && (
              <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground" title={agent.external?.host ? `Runs at ${agent.external.host}` : 'Runs outside Sublime'}>
                External{agent.external?.host ? ` · ${agent.external.host}` : ''}
              </span>
            )}
            {agent.lastExecutedAt && <span className="text-xs text-muted-foreground">Last worked {relative(agent.lastExecutedAt)}</span>}
          </div>
          {agent.description && agent.description !== agent.title && (
            <p className="mt-2 text-sm text-muted-foreground">{agent.description}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {(profile.isOwner || isAdmin) && (
            <Button variant="outline" size="sm" onClick={() => { setPublishName(agent.title); setPublishOpen(true) }}>
              <Store className="mr-1.5 h-3.5 w-3.5" /> Publish
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href={href(`/agents?agent=${agent.id}`)}>
              <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Settings
            </Link>
          </Button>
        </div>
      </header>

      {/* Publishing snapshots the agent as a package: its job, integrations,
          grants — never its secrets or workspace-local skills. Public means
          every workspace, which is why that option is an admin's alone. */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish {agent.title} to the store</DialogTitle>
            <DialogDescription>
              Others install a copy as a teammate. {agent.runtime === 'external' ? 'They will bring their own credential for your endpoint.' : 'Its instructions, integrations, and permissions travel; its secrets and skills do not.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="text-xs text-muted-foreground">Listing name</span>
              <input value={publishName} onChange={(event) => setPublishName(event.target.value)} className="mt-0.5 w-full rounded-md border bg-background px-2 py-1 text-sm" />
            </label>
            <div className="flex gap-1" role="radiogroup" aria-label="Who can install it">
              {(['organization', 'public'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={publishVisibility === option}
                  disabled={option === 'public' && !isAdmin}
                  title={option === 'public' && !isAdmin ? 'Only a workspace admin can publish to every workspace' : undefined}
                  onClick={() => setPublishVisibility(option)}
                  className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50',
                    publishVisibility === option
                      ? 'border-horizon-300 bg-horizon-50 text-horizon-700 dark:border-horizon-500/40 dark:bg-horizon-500/15 dark:text-horizon-200'
                      : 'border-border/60 bg-card text-muted-foreground hover:bg-accent hover:text-foreground')}
                >
                  {option === 'organization' ? 'This workspace' : 'Every workspace'}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPublishOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={publishing || !publishName.trim()}
              onClick={async () => {
                setPublishing(true)
                try {
                  const response = await fetch('/api/store', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agent.id, name: publishName.trim(), visibility: publishVisibility }) })
                  const payload = await response.json().catch(() => ({}))
                  if (!response.ok) { toast.error(payload.error || 'Could not publish.'); return }
                  toast.success(`Published ${payload.listing?.name ?? agent.title} (v${payload.listing?.version ?? 1})`)
                  setPublishOpen(false)
                } catch {
                  toast.error('Could not publish.')
                } finally {
                  setPublishing(false)
                }
              }}
            >
              {publishing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Store className="mr-1.5 h-3.5 w-3.5" />}
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section aria-label="Performance" className="rounded-2xl border bg-card p-5">
        {slots ? (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {slots.map((slot) => (
              <div key={slot.key}>
                <dd className="text-2xl font-semibold leading-tight tabular-nums">{slot.display}</dd>
                <dt className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{slot.label}</dt>
              </div>
            ))}
            {kpis.failed > 0 && (
              <div>
                <dd className="text-2xl font-semibold leading-tight tabular-nums">{kpis.failed}</dd>
                <dt className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">failed</dt>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">No runs yet. Ask it something below, or run it from settings.</p>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="profile-grants">
        <h2 id="profile-grants" className="text-sm font-semibold">What it may do</h2>
        {agent.runtime === 'external' ? (
          <p className="text-sm text-muted-foreground">
            This agent's work runs outside Sublime{agent.external?.host ? ` at ${agent.external.host}` : ''}. Sublime sends it each ask and receives the answer; what it may touch is governed there, not here.
          </p>
        ) : (<>
        {/* The trust surface: what this teammate is allowed to touch, stated
            per tool rather than inferred from whose account it runs under. */}
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card text-sm">
          {[...agent.integrations.map((key) => ({ key: key.trim().toLowerCase(), label: key })), ...(agent.allowFlows ? [{ key: 'flow', label: 'Saved flows' }] : []), { key: '*', label: 'Everything else' }]
            .filter((row, index, rows) => rows.findIndex((r) => r.key === row.key) === index)
            .map((row) => {
              const level = agent.grants === null ? 'write' : (agent.grants[row.key] ?? agent.grants['*'] ?? 'read')
              return (
                <li key={row.key} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className={cn('truncate', row.key === '*' && 'text-muted-foreground')}>{row.label}</span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium capitalize',
                      level === 'blocked'
                        ? 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-200'
                        : level === 'write'
                          ? 'bg-horizon-50 text-horizon-700 dark:bg-horizon-500/15 dark:text-horizon-200'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {level === 'write' ? 'Read & write' : level}
                  </span>
                </li>
              )
            })}
        </ul>
        <p className="text-xs text-muted-foreground">
          {agent.grants === null ? 'This agent predates permissions and runs unrestricted. Set them in settings.' : 'Change these in settings. A blocked or read-only tool is never offered to the model.'}
        </p>
        </>)}
      </section>

      <section className="space-y-3" aria-labelledby="profile-ask">
        <h2 id="profile-ask" className="text-sm font-semibold">Ask {agent.title}</h2>
        <div className="rounded-lg border border-border/60 bg-card p-2">
          <label htmlFor="profile-ask-input" className="sr-only">What should {agent.title} do?</label>
          <textarea
            id="profile-ask-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void ask()
              }
            }}
            rows={2}
            maxLength={4000}
            placeholder={agent.roleLabel ? `Ask for something within ${agent.roleLabel.toLowerCase()}…` : 'Ask for something specific…'}
            className="w-full resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <p className="px-1.5 text-xs text-muted-foreground">Stays within what this agent does — it will say so if the ask is outside its job.</p>
            <Button type="button" size="sm" onClick={() => void ask()} disabled={!text.trim() || sending}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Ask
            </Button>
          </div>
        </div>
        <RequestList requests={profile.requests} showAgent={false} />
      </section>

      <section className="space-y-3" aria-labelledby="profile-runs">
        <h2 id="profile-runs" className="text-sm font-semibold">Recent work</h2>
        {profile.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card">
            {profile.runs.map((run) => (
              <li key={run.id}>
                <Link href={href(`/agents?run=${run.id}`)} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', RUN_DOT[run.status] ?? 'bg-muted-foreground/40')} aria-hidden />
                  {/* A run with no headline (it failed, or predates headlines)
                      must not repeat the trigger label the right-hand side
                      already shows — "On schedule … On schedule" says nothing. */}
                  <span className={cn('min-w-0 flex-1 truncate', !run.headline && 'text-muted-foreground')}>
                    {run.headline || (run.status === 'failed' ? 'Failed before producing a summary' : 'No summary recorded')}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{TRIGGER_LABEL[run.triggerType] ?? run.triggerType} · {relative(run.startedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {profile.goals.length > 0 && (
        <section className="space-y-3" aria-labelledby="profile-goals">
          <h2 id="profile-goals" className="text-sm font-semibold">Goals its work has landed on</h2>
          <ul className="flex flex-wrap gap-2">
            {profile.goals.map((goal) => (
              <li key={goal.id}>
                <Link href={href(`/goals/${goal.id}`)} className="inline-block rounded-full border border-border/60 bg-card px-3 py-1 text-sm hover:bg-accent">
                  {goal.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
