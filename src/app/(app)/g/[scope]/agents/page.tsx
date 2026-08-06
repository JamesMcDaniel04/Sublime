'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { ALL_SCOPE, useScope } from '@/lib/client/scoped-href'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { toast } from 'sonner'
import { AlertCircle, Copy, FileText, List, Loader2, MoreHorizontal, Play, Plus, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import { AgentActivityPane, resultText, type RunMutation } from './agent-activity-pane'
import dynamic from 'next/dynamic'
import type { AgentDraft } from './agent-config-form'

// The 1,400-line config form (skills, connectors, schedule, memories) only
// renders once someone opens agent setup — keep it out of the list page's
// initial bundle so /agents paints fast.
const AgentConfigForm = dynamic(() => import('./agent-config-form').then((m) => m.AgentConfigForm), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center py-16">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" />
    </div>
  ),
})
import { AssistantPanel } from './assistant-panel'
// Kept out of the Agents tab's initial bundle/fetches — the Templates
// library carries its own AI-search UI and four data fetches. Loading it
// eagerly meant /agents always paid for both surfaces at once, even for
// someone who never switches tabs. Now it loads (and starts fetching) only
// when `view` actually flips to 'templates'.
const TemplatesExplorer = dynamic(
  () => import('@/components/templates/templates-explorer').then((m) => m.TemplatesExplorer),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <Skeleton className="h-11 w-full rounded-md" />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </div>
    ),
  },
)
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AGENTS_CHANGED_EVENT, notifyAgentsChanged } from '@/components/layout/sidebar'
import { useAuth } from '@/hooks/use-auth'
import { getSnapshot, peekSnapshot, SnapshotError, subscribeSnapshot } from '@/lib/client/snapshot'
import { getCachedJson } from '@/lib/client/use-cached-json'
import { cn } from '@/lib/utils'

import type { Agent, Activity } from '@/lib/types'

type GranolaNote = {
  id: string
  title: string
  owner: { name: string; email: string } | null
  created_at: string | null
}

/** Sentinel selection meaning "setting up a brand-new agent". */
const NEW_AGENT = 'new'

/**
 * Fields the serialized agent (from /api/snapshot and /api/agents) carries
 * beyond the lean client `Agent` type — used to duplicate an agent faithfully
 * and to gate owner-only actions.
 */
type SerializedAgentExtras = {
  isOwner?: boolean
  specialistArea?: string
  requiredIntegrations?: string[]
  goal?: string | null
  allowSubagents?: boolean
  subagentIds?: string[]
  allowFlows?: boolean
  flowIds?: string[]
  autoAnswerFromMemory?: boolean
  requireApproval?: boolean
  alwaysStrategize?: boolean
  maxTurns?: number
  outputFields?: { name: string; type: string; description?: string }[]
}

// Right-pane (assistant) width — user-resizable on desktop, persisted per browser.
const ASSISTANT_WIDTH_KEY = 'dashboard.assistantWidth'
const ASSISTANT_WIDTH_DEFAULT = 480
const ASSISTANT_WIDTH_MIN = 360
const ASSISTANT_WIDTH_MAX = 800

function clampAssistantWidth(width: number) {
  return Math.min(ASSISTANT_WIDTH_MAX, Math.max(ASSISTANT_WIDTH_MIN, width))
}

function isConfigured(agent: Agent) {
  return agent.status === 'active' && Boolean(agent.instructions?.trim())
}

function AgentHQ() {
  const { user } = useAuth()
  const router = useScopedRouter()
  const searchParams = useSearchParams()
  // Which top-level view is showing: the agent HQ panes or the templates
  // library (folded in from the old /templates page). URL-driven so the
  // command palette and legacy /templates links deep-link straight into it.
  const view: 'agents' | 'templates' = searchParams.get('view') === 'templates' ? 'templates' : 'agents'
  const setView = (next: 'agents' | 'templates') => {
    router.replace(next === 'templates' ? '/agents?view=templates' : '/agents', { scroll: false })
  }
  const initialSnapshot = useMemo(() => peekSnapshot(), [])
  const [allAgents, setAgents] = useState<Agent[]>(() => initialSnapshot?.agents || [])
  // Under a goal lens the roster comes from the scoped endpoint rather than the
  // shell snapshot. The snapshot is shared with the sidebar and notification
  // bell — surfaces that should stay global — so it stays unscoped, and only
  // this page swaps its source.
  const scope = useScope()
  const scopedAgentsUrl = scope !== ALL_SCOPE ? `/api/agents?goal=${encodeURIComponent(scope)}` : null
  const { data: scopedAgents } = useCachedJson<{ agents?: Agent[]; unlinkedCount?: number }>(scopedAgentsUrl)
  // Shadows the state deliberately so every downstream reference to `agents`
  // gets the lensed list without touching a single render site. Memoized: the
  // `?? []` fallback would otherwise mint a fresh array each render and churn
  // every downstream hook that lists `agents` as a dependency.
  const agents = useMemo(
    () => (scope !== ALL_SCOPE ? (scopedAgents?.agents ?? []) : allAgents),
    [scope, scopedAgents?.agents, allAgents],
  )
  const unlinkedAgentCount = scopedAgents?.unlinkedCount ?? 0
  const [activities, setActivities] = useState<Activity[]>(() => initialSnapshot?.activities || [])
  const [loading, setLoading] = useState(() => !initialSnapshot)
  const [activityLoadingId, setActivityLoadingId] = useState<string | null>(null)
  const activityLoadedIdsRef = useRef(new Set<string>())
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [configureOpen, setConfigureOpen] = useState(false)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  // The run expanded in the left pane, whose output renders in the right pane.
  const [selectedRun, setSelectedRun] = useState<Activity | null>(null)
  const [describe, setDescribe] = useState('')
  const [building, setBuilding] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [duplicatingAgent, setDuplicatingAgent] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deletingAgent, setDeletingAgent] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState<number | null>(null)
  const [granolaPickerOpen, setGranolaPickerOpen] = useState(false)
  const [granolaFetchingList, setGranolaFetchingList] = useState(false)
  const [granolaFetchingNote, setGranolaFetchingNote] = useState(false)
  const [granolaNotes, setGranolaNotes] = useState<GranolaNote[]>([])
  const [assistantWidth, setAssistantWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return ASSISTANT_WIDTH_DEFAULT
    const saved = Number(window.localStorage.getItem(ASSISTANT_WIDTH_KEY))
    return saved ? clampAssistantWidth(saved) : ASSISTANT_WIDTH_DEFAULT
  })
  const assistantWidthRef = useRef(assistantWidth)
  useEffect(() => subscribeSnapshot((snapshot) => {
    setAgents(snapshot.agents || [])
    setLoading(false)
  }), [])
  // Count for the Templates toggle badge. Cheap: the sidebar already warms
  // /api/agent-templates in the shared client cache. Re-read on view switches
  // so templates created or deleted inside the library update the badge.
  const [templatesCount, setTemplatesCount] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    getCachedJson<{ templates?: unknown[] }>('/api/agent-templates')
      .then((data) => { if (!cancelled) setTemplatesCount(data.templates?.length ?? 0) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [view])

  // Drag-to-resize for the assistant pane's left edge. Grid layout (not the
  // flex row `ResizablePanel` assumes), so the drag math is inlined here and
  // drives `assistantWidth`, which the grid's gridTemplateColumns reads.
  const onAssistantResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = assistantWidthRef.current
    const onMove = (moveEvent: MouseEvent) => {
      // Right pane, so dragging LEFT (smaller clientX) widens it.
      const next = clampAssistantWidth(startWidth + (startX - moveEvent.clientX))
      assistantWidthRef.current = next
      setAssistantWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      try {
        window.localStorage.setItem(ASSISTANT_WIDTH_KEY, String(assistantWidthRef.current))
      } catch {
        /* storage unavailable */
      }
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])
  const resetAssistantWidth = useCallback(() => {
    assistantWidthRef.current = ASSISTANT_WIDTH_DEFAULT
    setAssistantWidth(ASSISTANT_WIDTH_DEFAULT)
    try {
      window.localStorage.setItem(ASSISTANT_WIDTH_KEY, String(ASSISTANT_WIDTH_DEFAULT))
    } catch {
      /* storage unavailable */
    }
  }, [])

  const load = useCallback(async (force = false) => {
    try {
      const snapshot = await getSnapshot(force ? 0 : undefined)
      setAgents(snapshot.agents || [])
      setAuthError(null)
      setAuthStatus(null)
    } catch (error) {
      const status = error instanceof SnapshotError ? error.status ?? 500 : 500
      setAuthStatus(status)
      setAuthError(error instanceof Error ? error.message : `Couldn't load agents (HTTP ${status}).`)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadActivities = useCallback(async (agentId: string, force = false) => {
    setActivityLoadingId(agentId)
    try {
      const url = `/api/agents/activity?agentId=${encodeURIComponent(agentId)}&limit=30`
      const data = await getCachedJson<{ activities?: Activity[] }>(url, force ? 0 : 8_000)
      setActivities((current) => [
        ...current.filter((activity) => activity.agentTaskId !== agentId),
        ...(data.activities || []),
      ])
      activityLoadedIdsRef.current.add(agentId)
    } catch {
      // Keep the last-known activity on transient poll failures.
    } finally {
      setActivityLoadingId((current) => current === agentId ? null : current)
    }
  }, [])

  const refreshAfterRunMutation = useCallback((mutation?: RunMutation) => {
    if (mutation) {
      setActivities((current) => mutation.deleted
        ? current.filter((activity) => activity.id !== mutation.id)
        : current.map((activity) => activity.id === mutation.id && mutation.status
          ? { ...activity, status: mutation.status }
          : activity))
      if (mutation.deleted) {
        setFocusRunId((current) => current === mutation.id ? null : current)
        setSelectedRun((current) => current?.id === mutation.id ? null : current)
      }
    }
    void load(true)
    if (selectedAgentId && selectedAgentId !== NEW_AGENT) void loadActivities(selectedAgentId, true)
  }, [load, loadActivities, selectedAgentId])

  useEffect(() => {
    load().catch(() => setLoading(false))
    // The broad shell model changes slowly; selected-agent runs have their own
    // focused 10-second refresh below.
    const interval = window.setInterval(() => {
      if (!document.hidden) load().catch(() => undefined)
    }, 30000)
    const onVisible = () => {
      if (!document.hidden) load().catch(() => undefined)
    }
    const onChanged = () => load(true).catch(() => undefined)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged)
    }
  }, [load])

  useEffect(() => {
    if (!selectedAgentId || selectedAgentId === NEW_AGENT) return
    void loadActivities(selectedAgentId)
    const interval = window.setInterval(() => {
      if (!document.hidden) void loadActivities(selectedAgentId, true)
    }, 10000)
    const onVisible = () => {
      if (!document.hidden) void loadActivities(selectedAgentId, true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadActivities, selectedAgentId])

  // Land on the most recently updated agent unless a deep link already chose.
  useEffect(() => {
    if (loading || selectedAgentId) return
    if (agents.length) setSelectedAgentId(agents[0].id)
  }, [loading, agents, selectedAgentId])

  // Deep links from the command palette and sidebar: ?agent=<id|new>, ?run=<id>.
  useEffect(() => {
    const agentParam = searchParams.get('agent')
    if (!agentParam) return
    if (agentParam === NEW_AGENT) {
      setSelectedAgentId(NEW_AGENT)
      setConfigureOpen(false)
      setFocusRunId(null)
      router.replace('/agents')
      return
    }
    if (!agents.length) return
    if (agents.some((candidate) => candidate.id === agentParam)) {
      setSelectedAgentId(agentParam)
      setConfigureOpen(false)
      setFocusRunId(null)
    }
    router.replace('/agents')
  }, [searchParams, agents, router])

  useEffect(() => {
    const runParam = searchParams.get('run')
    if (!runParam || loading) return
    const openRun = (activity: Activity) => {
      if (activity.agentTaskId) setSelectedAgentId(activity.agentTaskId)
      setConfigureOpen(false)
      setFocusRunId(activity.id)
    }
    const activity = activities.find((candidate) => candidate.id === runParam)
    if (activity) {
      openRun(activity)
      router.replace('/agents')
      return
    }
    fetch(`/api/workflows/executions?executionId=${runParam}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        const execution = data.items?.[0]?.execution
        if (execution) {
          setActivities((current) => current.some((item) => item.id === execution.id) ? current : [execution, ...current])
          openRun(execution)
        }
      })
      .catch(() => undefined)
      .finally(() => router.replace('/agents'))
  }, [searchParams, activities, loading, router])

  // Escape closes the Granola meeting picker (keyboard parity with the close button).
  useEffect(() => {
    if (!granolaPickerOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setGranolaPickerOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [granolaPickerOpen])

  const selectedAgent = useMemo(
    () => agents.find((candidate) => candidate.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  )

  const agentActivities = useMemo(
    () => (selectedAgent ? activities.filter((activity) => activity.agentTaskId === selectedAgent.id) : []),
    [activities, selectedAgent],
  )

  const hasFailedRun = useMemo(
    () => agentActivities.some((activity) => activity.status.toLowerCase() === 'failed'),
    [agentActivities],
  )

  // The expanded run's output, shown in the right (assistant) pane.
  const runOutput = useMemo(() => {
    if (!selectedRun) return null
    const text = resultText(selectedRun)
    if (!text) return null
    return {
      title: selectedRun.metadata?.title || selectedRun.agentType,
      at: selectedRun.startedAt,
      status: selectedRun.status.toLowerCase(),
      text,
    }
  }, [selectedRun])

  // A different agent's runs are unrelated — clear the shown output on switch.
  useEffect(() => {
    setSelectedRun(null)
  }, [selectedAgentId])

  // Setup opens only when creating a new agent, editing an incomplete agent,
  // or explicitly toggling configuration for the selected agent.
  const creatingNew = selectedAgentId === NEW_AGENT
  const showSetup = creatingNew || Boolean(selectedAgent && (!isConfigured(selectedAgent) || configureOpen))
  const editingAgent = showSetup && selectedAgent && selectedAgentId !== NEW_AGENT ? selectedAgent : null

  const greeting = useMemo(() => {
    if (!selectedAgent) return agents.length ? 'Select an agent to see its activity.' : 'Describe what you need and Sublime builds the agent.'
    const counts: Record<string, number> = {}
    for (const activity of agentActivities) {
      const status = activity.status.toLowerCase()
      counts[status] = (counts[status] || 0) + 1
    }
    const parts: string[] = []
    if (counts.completed) parts.push(`${counts.completed} completed`)
    if (counts.waiting_for_input) parts.push(`${counts.waiting_for_input} need your input`)
    if (counts.failed) parts.push(`${counts.failed} hit errors`)
    if (counts.running) parts.push(`${counts.running} running`)
    return parts.length ? `${parts.join(', ')}.` : 'Ready for the first run.'
  }, [selectedAgent, agents.length, agentActivities])

  const selectAgent = (id: string) => {
    setSelectedAgentId(id)
    setConfigureOpen(false)
    setFocusRunId(null)
  }

  const saveAgent = async (draft: AgentDraft) => {
    // A rejected fetch (offline, dropped connection) must surface like an HTTP
    // failure — previously it propagated silently and the spinner just
    // cleared, with the agent not saved and no explanation.
    const response = await fetch('/api/agents', {
      method: editingAgent ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingAgent ? { ...draft, id: editingAgent.id } : draft),
    }).catch(() => {
      const message = 'Could not save agent — check your connection and try again.'
      toast.error(message)
      throw new Error(message)
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      const message = data.error || `Failed to save agent (HTTP ${response.status}).`
      toast.error(message)
      throw new Error(message)
    }
    const data = await response.json().catch(() => ({}))
    notifyAgentsChanged()
    toast.success(editingAgent ? 'Agent updated.' : 'Agent created.')
    setConfigureOpen(false)
    await load(true)
    if (!editingAgent && data.agent?.id) setSelectedAgentId(data.agent.id)
  }

  const buildFromDescription = async () => {
    if (!describe.trim()) return
    setBuilding(true)
    try {
      const response = await fetch('/api/agents/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: describe, create: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || `Couldn't build the agent (HTTP ${response.status}).`)
        return
      }
      setDescribe('')
      notifyAgentsChanged()
      toast.success(`Created "${data.draft?.title || 'agent'}".`)
      await load(true)
      if (data.agentId) setSelectedAgentId(data.agentId)
    } catch {
      // A rejected fetch (offline, DNS) must not fail silently — every other
      // handler on this page toasts.
      toast.error("Couldn't build the agent — check your connection and try again.")
    } finally {
      setBuilding(false)
    }
  }

  const openGranolaPicker = async () => {
    setGranolaFetchingList(true)
    setGranolaNotes([])
    try {
      const response = await fetch('/api/granola/notes')
      const data = await response.json().catch(() => ({}))
      if (!data.success) {
        toast.error(data.error || 'Granola not connected')
        return
      }
      setGranolaNotes(data.notes || [])
      setGranolaPickerOpen(true)
    } catch {
      toast.error('Could not reach Granola. Please try again.')
    } finally {
      setGranolaFetchingList(false)
    }
  }

  const importGranolaNote = async (note: GranolaNote) => {
    setGranolaFetchingNote(true)
    try {
      const response = await fetch(`/api/granola/notes/${encodeURIComponent(note.id)}`)
      const data = await response.json().catch(() => ({}))
      if (!data.success) {
        toast.error(data.error || 'Could not load that meeting note.')
        return
      }
      const { title, summary } = data.note as { id: string; title: string; summary: string }
      const prefill = `Build an agent based on this meeting. Identify the workflow or task that was requested and create an agent that carries it out.\n\nMeeting: ${title}\n\n${summary}`
      setDescribe(prefill.slice(0, 3800))
      setGranolaPickerOpen(false)
    } catch {
      toast.error('Could not load that meeting note. Please try again.')
    } finally {
      setGranolaFetchingNote(false)
    }
  }

  const duplicateAgent = async (agent: Agent) => {
    const source = agent as Agent & SerializedAgentExtras
    setDuplicatingAgent(true)
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `${agent.title} (copy)`,
          description: agent.description,
          instructions: agent.instructions,
          model: agent.model,
          integrations: agent.integrations,
          specialistArea: source.specialistArea,
          requiredIntegrations: source.requiredIntegrations ?? [],
          skills: agent.skills,
          icon: agent.icon,
          folder: agent.folder,
          visibility: agent.visibility,
          goal: source.goal ?? null,
          allowSubagents: source.allowSubagents,
          subagentIds: source.subagentIds,
          allowFlows: source.allowFlows,
          flowIds: source.flowIds,
          autoAnswerFromMemory: source.autoAnswerFromMemory,
          requireApproval: source.requireApproval,
          alwaysStrategize: source.alwaysStrategize,
          maxTurns: source.maxTurns,
          outputFields: source.outputFields,
          httpTools: (source as { httpTools?: unknown[] }).httpTools ?? [],
          schedule: agent.schedule,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || `Could not duplicate ${agent.title}.`)
        return
      }
      notifyAgentsChanged()
      toast.success(`Duplicated as "${data.agent?.title || `${agent.title} (copy)`}".`)
      await load(true)
      if (data.agent?.id) {
        setSelectedAgentId(data.agent.id)
        setConfigureOpen(false)
        setFocusRunId(null)
      }
    } catch {
      toast.error(`Could not duplicate ${agent.title} — check your connection and try again.`)
    } finally {
      setDuplicatingAgent(false)
    }
  }

  const deleteSelectedAgent = async () => {
    if (!selectedAgent) return
    setDeletingAgent(true)
    try {
      // Same call the sidebar makes; the route is owner-only (404 otherwise).
      const response = await fetch('/api/agents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedAgent.id }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not delete this agent — only its owner can.')
        return
      }
      setDeleteConfirmOpen(false)
      setSelectedAgentId(null)
      setConfigureOpen(false)
      setFocusRunId(null)
      setSelectedRun(null)
      notifyAgentsChanged()
      toast.success(`Deleted ${selectedAgent.title}.`)
      await load(true)
    } catch {
      toast.error('Could not delete this agent — check your connection and try again.')
    } finally {
      setDeletingAgent(false)
    }
  }

  const runAgent = async (agent: Agent) => {
    setRunningId(agent.id)
    try {
      const res = await fetch(`/api/agents/${agent.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        if (data.result?.status === 'waiting_for_input') {
          toast(`${agent.title} needs your input`)
        } else {
          toast.success(`${agent.title} ran`)
        }
        setSelectedAgentId(agent.id)
        setConfigureOpen(false)
        if (data.executionId) setFocusRunId(data.executionId)
        await load(true)
      } else {
        toast.error(data.error || 'Run failed')
      }
    } catch {
      toast.error(`Could not run ${agent.title} — check your connection and try again.`)
    } finally {
      setRunningId(null)
    }
  }

  return (
    <div
      // h-full, NOT h-screen: AppShell already spends the viewport, so <main>
      // is 100vh minus the trial banner. Asking for a second 100vh in there
      // overflows by exactly the banner's height, and the grid's
      // overflow-hidden clips that strip — the chat composer.
      className="flex flex-col lg:h-full lg:overflow-hidden"
    >
      {/* Agents ↔ Templates segmented toggle — the template library lives
          inside HQ now instead of its own sidebar destination. */}
      <div className="flex shrink-0 justify-center border-b bg-muted px-4 py-3">
        <div className="flex items-center rounded-full bg-card p-1 shadow-md ring-1 ring-border">
          <button
            type="button"
            aria-pressed={view === 'agents'}
            onClick={() => setView('agents')}
            className={cn(
              'rounded-full px-5 py-1.5 text-sm font-semibold transition-colors duration-150',
              view === 'agents' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Agents
          </button>
          <button
            type="button"
            aria-pressed={view === 'templates'}
            onClick={() => setView('templates')}
            className={cn(
              'flex items-center gap-2 rounded-full px-5 py-1.5 text-sm font-semibold transition-colors duration-150',
              view === 'templates' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Templates
            {templatesCount !== null && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-xs font-medium leading-none',
                  view === 'templates' ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {templatesCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {view === 'templates' ? (
        <div className="min-h-0 flex-1 lg:overflow-y-auto">
          <TemplatesExplorer />
        </div>
      ) : (
      <>
      {/* lg: rows locked to the viewport (minmax(0,1fr)) — an implicit auto row
          would grow with content and clip each pane's bottom (form buttons,
          chat composer) behind the grid's overflow-hidden. */}
      <div
        className="flex min-h-0 flex-col lg:grid lg:flex-1 lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden"
        style={{ gridTemplateColumns: `minmax(420px,1fr) ${assistantWidth}px` }}
      >
        {/* ── Left pane: activity for the selected agent, or the setup flow ── */}
        <section className="min-w-0 border-b bg-background lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="sticky top-0 z-10 border-b bg-background p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                {agents.length > 0 ? (
                  <Select value={selectedAgent?.id ?? ''} onValueChange={selectAgent}>
                    <SelectTrigger className="h-9 font-medium" aria-label="Select agent">
                      <SelectValue placeholder="New agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>{agent.title}</SelectItem>
                      ))}
                      {/* Hidden work is always counted. Without this, an agent
                          filtered out by the lens is indistinguishable from one
                          that was deleted. */}
                      {unlinkedAgentCount > 0 && (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">
                          {unlinkedAgentCount} not linked to this goal
                        </p>
                      )}
                    </SelectContent>
                  </Select>
                ) : (
                  <h1 className="text-xl font-semibold">{loading ? 'Loading…' : 'Create your first agent'}</h1>
                )}
                <p className="mt-1 truncate text-sm text-muted-foreground" aria-live="polite">
                  Hey, {user?.firstName || 'there'}. {greeting}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {selectedAgent && isConfigured(selectedAgent) && (
                  <>
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={runningId === selectedAgent.id}
                      onClick={() => runAgent(selectedAgent)}
                      aria-label={`Run ${selectedAgent.title}`}
                      title="Run agent"
                    >
                      {runningId === selectedAgent.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setConfigureOpen((open) => !open)}
                      aria-label={configureOpen ? 'Back to activity' : 'Configure agent'}
                      title={configureOpen ? 'Back to activity' : 'Configure agent'}
                      className={cn('transition-colors duration-150', configureOpen && 'bg-indigo-50 text-indigo-700')}
                    >
                      {configureOpen ? <List className="h-4 w-4" /> : <Settings2 className="h-4 w-4" />}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          disabled={duplicatingAgent}
                          aria-label={`More actions for ${selectedAgent.title}`}
                          title="More actions"
                        >
                          {duplicatingAgent ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => void duplicateAgent(selectedAgent)}>
                          <Copy /> Duplicate agent
                        </DropdownMenuItem>
                        {/* Delete is owner-only server-side — don't offer it to non-owners. */}
                        {(selectedAgent as Agent & SerializedAgentExtras).isOwner !== false && (
                          <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => setDeleteConfirmOpen(true)}>
                            <Trash2 /> Delete agent
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
                <Button
                  variant="outline"
                  onClick={() => { setSelectedAgentId(NEW_AGENT); setConfigureOpen(false); setFocusRunId(null) }}
                >
                  <Plus className="mr-1.5 h-4 w-4" /> New agent
                </Button>
              </div>
            </div>
          </div>

          {authError && (
            <div className="m-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                {authStatus === 401 ? (
                  <>
                    <p className="font-medium">You’re not signed in.</p>
                    <p className="mb-2 text-amber-800">This environment has no active session — sign in to load your workspace.</p>
                    <Button size="sm" onClick={() => router.push('/auth/login')}>Sign in</Button>
                  </>
                ) : authStatus === 403 ? (
                  <>
                    <p className="font-medium">Your workspace is still provisioning.</p>
                    <p className="text-amber-800">Reload in a moment. If this persists, the database isn’t reachable for this environment.</p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">{authError}</p>
                    <p className="text-amber-800">The database or auth isn’t configured for this environment.</p>
                  </>
                )}
              </div>
            </div>
          )}

          {loading && (
            <div className="space-y-3 p-4">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          )}

          {!loading && showSetup && (
            <div className="space-y-4 p-4">
              {!editingAgent && (
                <div>
                  {/* Den-style: describe an agent in plain language and build it. */}
                  <div className="flex items-center gap-2 rounded-xl border bg-muted px-3 py-2 transition-shadow duration-150 focus-within:ring-2 focus-within:ring-indigo-200">
                    <Sparkles className="h-4 w-4 shrink-0 text-indigo-500" />
                    <input
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                      placeholder={"Describe an agent to build — e.g. “Every Monday, summarize last week’s GitHub activity and post it to Slack”"}
                      value={describe}
                      disabled={building}
                      onChange={(event) => setDescribe(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && buildFromDescription()}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={granolaFetchingList || building}
                      onClick={openGranolaPicker}
                      title="Import from Granola"
                      className="shrink-0 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {granolaFetchingList ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                      Import
                    </Button>
                    <Button size="sm" loading={building} disabled={!describe.trim()} onClick={buildFromDescription}>
                      Build
                    </Button>
                  </div>
                  {/* Granola meeting picker */}
                  {granolaPickerOpen && (
                    <div className="relative mt-1 max-h-64 origin-top animate-scale-in overflow-y-auto rounded-xl border bg-card shadow-popover">
                      <div className="sticky top-0 flex items-center justify-between border-b bg-card px-3 py-2">
                        <span className="text-xs font-medium text-muted-foreground">Select a meeting to import</span>
                        <button
                          className="rounded p-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground"
                          onClick={() => setGranolaPickerOpen(false)}
                          aria-label="Close picker"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {granolaFetchingNote && (
                        <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading meeting…
                        </div>
                      )}
                      {!granolaFetchingNote && granolaNotes.length === 0 && (
                        <p className="p-4 text-sm text-muted-foreground">No recent meetings found in Granola.</p>
                      )}
                      {!granolaFetchingNote && granolaNotes.map((note) => (
                        <button
                          key={note.id}
                          className="flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors duration-150 last:border-b-0 hover:bg-muted"
                          onClick={() => importGranolaNote(note)}
                        >
                          <span className="truncate text-sm font-medium">{note.title}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {note.owner?.name || note.owner?.email || ''}
                            {note.owner && note.created_at ? ' · ' : ''}
                            {note.created_at ? new Date(note.created_at).toLocaleDateString() : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {editingAgent && !isConfigured(editingAgent) && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Finish setting up this agent to see its activity here.
                </p>
              )}

              <div className="animate-fade-in-up rounded-lg border bg-card p-4 shadow-1">
                <p className="eyebrow mb-3">{editingAgent ? 'Agent setup' : 'Set up manually'}</p>
                <AgentConfigForm
                  key={editingAgent?.id || NEW_AGENT}
                  editingAgent={editingAgent}
                  onSave={saveAgent}
                  onRunAgent={editingAgent ? runAgent : undefined}
                  runningId={runningId}
                  onOpenRun={(runId) => { setConfigureOpen(false); setFocusRunId(runId) }}
                />
              </div>
            </div>
          )}

          {!loading && !showSetup && selectedAgent && activityLoadingId === selectedAgent.id && !activityLoadedIdsRef.current.has(selectedAgent.id) && (
            <div className="space-y-3 p-4">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          )}

          {!loading && !showSetup && selectedAgent && (activityLoadingId !== selectedAgent.id || activityLoadedIdsRef.current.has(selectedAgent.id)) && (
            <AgentActivityPane
              agent={selectedAgent}
              activities={agentActivities}
              focusRunId={focusRunId}
              onChanged={refreshAfterRunMutation}
              onSelectRun={setSelectedRun}
            />
          )}

          {!loading && !showSetup && !selectedAgent && agents.length === 0 && (
            <div className="p-4">
              <EmptyState
                icon={Play}
                title="No runs yet"
                description="Create agent and logs will show here"
              />
            </div>
          )}
        </section>

        {/* ── Right pane: persistent assistant chat for the selected agent ── */}
        <section className="relative flex h-[70vh] min-w-0 flex-col bg-background lg:h-auto lg:min-h-0">
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize assistant panel"
            onMouseDown={onAssistantResizeStart}
            onDoubleClick={resetAssistantWidth}
            title="Drag to resize · double-click to reset"
            className="absolute left-0 top-0 z-20 hidden h-full w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-indigo-200 lg:block"
          />
          <AssistantPanel
            key={selectedAgent?.id ?? 'none'}
            agent={selectedAgent}
            hasFailedRun={hasFailedRun}
            runOutput={runOutput}
            onAgentUpdated={() => load(true).catch(() => undefined)}
          />
        </section>
      </div>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {selectedAgent?.title || 'this agent'}?</DialogTitle>
            <DialogDescription>
              This removes the agent for everyone it is shared with. Its past runs stay in your history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={deletingAgent} onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" loading={deletingAgent} onClick={() => void deleteSelectedAgent()}>
              Delete agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </>
      )}
    </div>
  )
}

export default function AgentHQPage() {
  return (
    <Suspense fallback={null}>
      <AgentHQ />
    </Suspense>
  )
}
