'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, Settings2, Sparkles, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { AgentAvatar, type AgentAvatarStatus } from '@/components/agents/agent-avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { randomAvatarSeed } from '@/lib/agents/avatar'
import { fallbackRoleLabel } from '@/lib/agents/role-label'
import { hasRunHistory, mergeAgentKpis, pickKpiSlots, type AgentKpis } from '@/lib/agents/roster-stats'
import { TeamSignalsBar } from './team-signals-bar'
import type { SerializedWorker } from '@/lib/agents/worker-serialize'
import { cn } from '@/lib/utils'
import type { Agent } from '@/lib/types'

const WORKERS_URL = '/api/workers'
const STATS_URL = '/api/agents/stats'

/** Shown before /api/agents/stats resolves, so tiles never render half-empty. */
const EMPTY_KPIS: AgentKpis = {
  runs: 0, failed: 0, recorded: 0, successRate: null,
  waiting: 0, running: 0, minutesSavedPerRun: null, hoursSaved: null,
}

/**
 * A tile is either a worker — one avatar with several agents under it — or a
 * single agent that works alone. Solo agents are not second-class: an agent
 * with no worker simply IS its own roster identity, which is why introducing
 * workers needed no backfill.
 */
type RosterEntry =
  | { kind: 'worker'; id: string; name: string; avatarSeed: string | null; roleLabel: string | null; members: Agent[]; kpis: AgentKpis }
  | { kind: 'agent'; id: string; name: string; avatarSeed: string | null; roleLabel: string | null; agent: Agent; kpis: AgentKpis }

function statusOf(kpis: AgentKpis): AgentAvatarStatus {
  // Blocked-on-you outranks working: it is the only state that needs a human.
  if (kpis.waiting > 0) return 'waiting'
  if (kpis.running > 0) return 'running'
  return 'idle'
}

/** The dot on the portrait. Green is "here and well" — the resting state a
 *  directory should show — so only the states that need attention take colour. */
const STATUS_DOT: Record<AgentAvatarStatus, string> = {
  running: 'bg-horizon-500 animate-pulse',
  waiting: 'bg-amber-500',
  failed: 'bg-red-500',
  idle: 'bg-emerald-500',
}

/**
 * The two numbers under the divider.
 *
 * Split by a rule rather than spaced apart: two bare numbers side by side read
 * as one figure, and "27 100%" is a sentence nobody can parse at a glance.
 */
function KpiSplit({ kpis }: { kpis: AgentKpis }) {
  const slots = hasRunHistory(kpis) ? pickKpiSlots(kpis) : null
  if (!slots) {
    return (
      <p className="pt-3 text-center text-xs text-muted-foreground">No runs yet</p>
    )
  }
  return (
    <dl className="grid grid-cols-2 pt-2">
      {slots.map((slot, index) => (
        <div key={slot.key} className={cn('text-center', index === 1 && 'border-l border-border/60')}>
          <dd className="text-lg font-semibold leading-tight tabular-nums">{slot.display}</dd>
          <dt className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {slot.label}
          </dt>
        </div>
      ))}
    </dl>
  )
}

function RosterTile({
  entry,
  onOpen,
  onConfigure,
}: {
  entry: RosterEntry
  onOpen: () => void
  onConfigure: () => void
}) {
  const memberCount = entry.kind === 'worker' ? entry.members.length : 1
  const role = entry.roleLabel
    || fallbackRoleLabel(entry.kind === 'agent' ? entry.agent.specialistArea : entry.members[0]?.specialistArea)
  const status = statusOf(entry.kpis)
  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-2xl border bg-card p-3.5 shadow-1 transition-all duration-200',
        'hover:-translate-y-0.5 hover:shadow-lg focus-within:ring-2 focus-within:ring-ring',
      )}
    >
      {/* Above the stretched link so it stays independently clickable. Always
          rendered rather than hover-revealed: a control that only exists on
          hover does not exist on touch, and is invisible to anyone scanning
          for it. */}
      <button
        type="button"
        onClick={onConfigure}
        aria-label={`Settings for ${entry.name}`}
        title="Settings"
        className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>

      {/* The portrait is the card's subject, not a marker beside a name — so it
          leads, centred and large, the way a directory photo does. */}
      <div className="relative mx-auto">
        <AgentAvatar
          agent={{ id: entry.id, avatarSeed: entry.avatarSeed }}
          // lg, not xl: the portrait still leads the card, but a 132px face
          // pushed the name, role and numbers below the fold of a scan — the
          // tile was reading as a poster rather than a directory entry.
          size="lg"
          shape="tile"
          status={status}
          badge={entry.kind === 'agent' ? entry.agent.icon || undefined : undefined}
        />
        <span
          className={cn(
            'absolute bottom-1 right-1 h-3.5 w-3.5 rounded-full border-2 border-card',
            STATUS_DOT[status],
          )}
          aria-hidden
        />
      </div>

      <div className="mt-2 min-w-0 text-center">
        {/* Stretched link: the whole tile activates this one control, so the
            card has a single focusable primary action with a real name. */}
        <button
          type="button"
          onClick={onOpen}
          // block w-full min-w-0: a <button> is inline-block and sizes to its
          // content, so the truncate on the span inside had a box exactly as
          // wide as the text and clipped nothing — the title ran past the card.
          className="block w-full min-w-0 focus:outline-none after:absolute after:inset-0 after:rounded-2xl"
        >
          {/* Two lines, not one: agents get long descriptive names ("New Lead
              → Enrich → Salesforce Opportunity") that a single truncated line
              renders as "New Lead → …", which identifies nothing. */}
          <span className="line-clamp-2 text-sm font-semibold leading-tight" title={entry.name}>
            {entry.name}
          </span>
        </button>

        <span className="mt-1.5 inline-block max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {role}
        </span>

        {/* Blocked-on-you outranks the roster bookkeeping: when a human is the
            thing standing between the agent and its work, say so instead of
            reporting how many agents share the avatar. */}
        {entry.kpis.waiting > 0 ? (
          <p className="mt-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">Needs you</p>
        ) : entry.kind === 'worker' ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {memberCount} {memberCount === 1 ? 'agent' : 'agents'}
          </p>
        ) : null}
      </div>

      <div className="mt-auto border-t border-border/60 pt-0.5">
        <KpiSplit kpis={entry.kpis} />
      </div>
    </div>
  )
}

export function AgentRoster({
  agents,
  loading,
  onOpenAgent,
  onEditAgent,
  onCreateAgent,
  onBrowseTemplates,
}: {
  agents: Agent[]
  loading: boolean
  onOpenAgent: (agentId: string) => void
  onEditAgent: (agentId: string) => void
  onCreateAgent: () => void
  /** Switches to the Templates view — the candidates strand's destination. */
  onBrowseTemplates?: () => void
}) {
  const { data: workerData, refresh: refreshWorkers } = useCachedJson<{ workers?: SerializedWorker[] }>(WORKERS_URL)
  const { data: statsData, refresh: refreshStats } = useCachedJson<{ stats?: Record<string, AgentKpis> }>(STATS_URL)
  const [editing, setEditing] = useState<SerializedWorker | null>(null)

  const workers = useMemo(() => workerData?.workers ?? [], [workerData?.workers])
  const stats = useMemo(() => statsData?.stats ?? {}, [statsData?.stats])

  const entries = useMemo<RosterEntry[]>(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]))
    const claimed = new Set<string>()
    const workerEntries: RosterEntry[] = workers.map((worker) => {
      const members = worker.agentIds.map((id) => byId.get(id)).filter((agent): agent is Agent => Boolean(agent))
      for (const member of members) claimed.add(member.id)
      return {
        kind: 'worker',
        id: worker.id,
        name: worker.name,
        avatarSeed: worker.avatarSeed,
        roleLabel: worker.roleLabel,
        members,
        kpis: mergeAgentKpis(members.map((member) => stats[member.id] ?? EMPTY_KPIS)),
      }
    })
    const soloEntries: RosterEntry[] = agents
      .filter((agent) => !claimed.has(agent.id))
      .map((agent) => ({
        kind: 'agent',
        id: agent.id,
        name: agent.title,
        avatarSeed: agent.avatarSeed ?? null,
        roleLabel: agent.roleLabel ?? null,
        agent,
        kpis: stats[agent.id] ?? EMPTY_KPIS,
      }))
    return [...workerEntries, ...soloEntries]
  }, [agents, workers, stats])

  // One batched generation pass for anything still unlabelled. The ref stops a
  // re-render (or a rejected label the server chose not to store) from turning
  // this into a request loop.
  const requestedRef = useRef(false)
  useEffect(() => {
    if (loading || requestedRef.current) return
    const agentIds = entries.filter((entry) => entry.kind === 'agent' && !entry.roleLabel).map((entry) => entry.id)
    const workerIds = entries.filter((entry) => entry.kind === 'worker' && !entry.roleLabel).map((entry) => entry.id)
    if (agentIds.length === 0 && workerIds.length === 0) return
    requestedRef.current = true
    fetch('/api/agents/role-labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentIds: agentIds.slice(0, 40), workerIds: workerIds.slice(0, 40) }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        // Roles are cosmetic — a failure leaves the department fallback showing.
        if (result?.workerLabels && Object.keys(result.workerLabels).length > 0) void refreshWorkers()
      })
      .catch(() => undefined)
  }, [entries, loading, refreshWorkers])

  const openEntry = useCallback((entry: RosterEntry) => {
    // A worker opens on the agent that does its work; with several, the first
    // one, and the workspace switcher covers the rest.
    const target = entry.kind === 'worker' ? entry.members[0]?.id : entry.id
    if (!target) {
      toast('Add an agent to this worker to give it something to do')
      return
    }
    onOpenAgent(target)
  }, [onOpenAgent])

  const configureEntry = useCallback((entry: RosterEntry) => {
    if (entry.kind === 'agent') {
      onEditAgent(entry.id)
      return
    }
    const worker = workers.find((candidate) => candidate.id === entry.id)
    if (worker) setEditing(worker)
  }, [onEditAgent, workers])

  if (loading && entries.length === 0) {
    return (
      <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-[17rem] rounded-2xl" />
        ))}
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Your team</h1>
          <p className="text-sm text-muted-foreground">
            {entries.length === 0
              ? 'Nobody hired yet'
              : `${entries.length} working for you`}
          </p>
        </div>
        <Button onClick={onCreateAgent}>
          <Plus className="mr-1.5 h-4 w-4" /> Hire an agent
        </Button>
      </div>

      <TeamSignalsBar
        members={entries.map((entry) => ({ id: entry.id, name: entry.name, kpis: entry.kpis }))}
        onOpenAgent={onOpenAgent}
        onBrowseTemplates={onBrowseTemplates ?? onCreateAgent}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {entries.map((entry) => (
          <RosterTile
            key={`${entry.kind}:${entry.id}`}
            entry={entry}
            onOpen={() => openEntry(entry)}
            onConfigure={() => configureEntry(entry)}
          />
        ))}
        <button
          type="button"
          onClick={onCreateAgent}
          className="flex min-h-[13rem] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-muted/40 p-3.5 text-muted-foreground transition-colors duration-150 hover:border-foreground/30 hover:text-foreground"
        >
          <UserPlus className="h-6 w-6" />
          <span className="text-sm font-medium">Hire an agent</span>
        </button>
      </div>

      <WorkerSettingsDialog
        worker={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void refreshWorkers()
          void refreshStats()
        }}
      />
    </div>
  )
}

function WorkerSettingsDialog({
  worker,
  onClose,
  onSaved,
}: {
  worker: SerializedWorker | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [seed, setSeed] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setName(worker?.name ?? '')
    setRole(worker?.roleLabel ?? '')
    setSeed(worker?.avatarSeed ?? null)
  }, [worker])

  if (!worker) return null

  const save = async () => {
    setSaving(true)
    try {
      const response = await fetch('/api/workers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: worker.id, name: name.trim(), roleLabel: role.trim(), avatarSeed: seed }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(result.error || 'Could not save this worker')
        return
      }
      onSaved()
      onClose()
    } catch {
      toast.error('Could not save this worker — check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      const response = await fetch('/api/workers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: worker.id }),
      })
      if (!response.ok) {
        toast.error('Could not remove this worker')
        return
      }
      toast.success(`${worker.name} removed — their agents are back on the roster`)
      onSaved()
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Worker settings</DialogTitle>
          <DialogDescription>
            {worker.agentIds.length} {worker.agentIds.length === 1 ? 'agent works' : 'agents work'} under this name.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-4">
          <AgentAvatar agent={{ id: worker.id, avatarSeed: seed }} size="lg" name={name || worker.name} />
          <Button variant="outline" size="sm" onClick={() => setSeed(randomAvatarSeed())}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Try another look
          </Button>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="worker-name">Name</Label>
            <Input id="worker-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="worker-role">Role</Label>
            <Input
              id="worker-role"
              value={role}
              maxLength={24}
              placeholder="Generated when left blank"
              onChange={(event) => setRole(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">One or two words. Clear it to have one written for you.</p>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" className="text-red-600 hover:text-red-600" disabled={deleting} onClick={() => void remove()}>
            {deleting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
            Remove worker
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button loading={saving} disabled={!name.trim()} onClick={() => void save()}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
