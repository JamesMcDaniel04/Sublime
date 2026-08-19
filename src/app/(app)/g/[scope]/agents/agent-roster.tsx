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

function KpiRow({ kpis }: { kpis: AgentKpis }) {
  if (!hasRunHistory(kpis)) {
    return <p className="text-sm text-muted-foreground">No runs yet</p>
  }
  const slots = pickKpiSlots(kpis)
  return (
    <dl className="flex items-baseline gap-5">
      {slots.map((slot) => (
        <div key={slot.key}>
          <dd className="text-lg font-semibold leading-tight tabular-nums">{slot.display}</dd>
          <dt className="text-xs text-muted-foreground">{slot.label}</dt>
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
  return (
    <div
      className={cn(
        'group relative flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-1 transition-all duration-200',
        'hover:-translate-y-0.5 hover:shadow-lg focus-within:ring-2 focus-within:ring-ring',
      )}
    >
      {/* Above the stretched link so it stays independently clickable. */}
      <button
        type="button"
        onClick={onConfigure}
        aria-label={`Settings for ${entry.name}`}
        title="Settings"
        className="absolute right-3 top-3 z-10 rounded-md border bg-card p-1.5 text-muted-foreground opacity-0 shadow-1 transition-opacity duration-150 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>

      <div className="flex items-start gap-4">
        <AgentAvatar
          agent={{ id: entry.id, avatarSeed: entry.avatarSeed }}
          size="lg"
          status={statusOf(entry.kpis)}
          badge={entry.kind === 'agent' ? entry.agent.icon || undefined : undefined}
        />
        <div className="min-w-0 flex-1 pr-6">
          {/* Stretched link: the whole tile activates this one control, so the
              card has a single focusable primary action with a real name. */}
          <button
            type="button"
            onClick={onOpen}
            className="text-left after:absolute after:inset-0 after:rounded-xl focus:outline-none"
          >
            <span className="block truncate font-semibold leading-tight">{entry.name}</span>
          </button>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{role}</p>
          {entry.kind === 'worker' && (
            <p className="mt-1 text-xs text-muted-foreground">
              {memberCount} {memberCount === 1 ? 'agent' : 'agents'}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-end justify-between gap-3">
        <KpiRow kpis={entry.kpis} />
        {entry.kpis.waiting > 0 && (
          <span className="relative z-10 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
            Needs you
          </span>
        )}
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
}: {
  agents: Agent[]
  loading: boolean
  onOpenAgent: (agentId: string) => void
  onEditAgent: (agentId: string) => void
  onCreateAgent: () => void
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
          <Skeleton key={index} className="h-44 rounded-xl" />
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
          className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-5 text-muted-foreground transition-colors duration-150 hover:border-foreground/30 hover:text-foreground"
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
