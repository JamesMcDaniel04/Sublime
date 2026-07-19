'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, Copy, Download, Loader2, Play, RotateCcw, ScrollText, Trash2, Webhook, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { MiniCalendar } from '@/components/ui/mini-calendar'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { KnowledgePanel } from '@/app/agents/knowledge-panel'
import { SuggestedImprovementBanner } from '@/components/intelligence/suggested-improvement-banner'
import { normalizeShareValue } from '@/components/share-control'
import { cn } from '@/lib/utils'
import { connectedSlugSet, missingIntegrations } from '@/lib/templates/relevance'

/**
 * The agent configuration form, shared by the config dialog and the dashboard's
 * inline setup pane. Owns the draft state, integration/skill pickers, schedule
 * controls and the recent-runs list for an existing agent.
 */

type SkillSummary = {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations: string[]
}

type ToolChip = {
  key: string
  label: string
  slug: string
  connected: boolean
}

type ConnectionIntegration = {
  id: string
  name: string
}

type AvailableIntegrations = {
  tools: ToolChip[]
  connections: ConnectionIntegration[]
}

type AgentMemory = {
  id: string
  kind: string
  title: string
  content: string
  question: string | null
  status: string
  timesUsed: number
  lastUsedAt: string | null
  sourceExecutionId: string | null
  createdAt: string
}

type AgentWebhook = { url: string; hasSecret: boolean; secret: string | null }

const MEMORY_KIND_LABEL: Record<string, string> = {
  user_answer: 'Answer',
  learning: 'Learning',
  suggestion: 'Suggestion',
}

const MEMORY_KIND_VARIANT: Record<string, 'info' | 'good' | 'warn'> = {
  user_answer: 'info',
  learning: 'good',
  suggestion: 'warn',
}

export type AgentDraft = {
  title: string
  description: string
  instructions: string
  model: string
  integrations: string[]
  /** Template-declared connections that must be live before Run is enabled. */
  requiredIntegrations: string[]
  skills: string[]
  icon: string
  folder: string
  visibility: string
  /** Lets this agent delegate to other agents via the run_agent tool. */
  allowSubagents?: boolean
  /** Restrict which agents it may run. Empty = any of the user's agents. */
  subagentIds?: string[]
  /** The outcome this agent ultimately serves — steers every run + self-evaluation. */
  goal: string
  /** When true, a question closely matching a past answer is auto-answered from memory. */
  autoAnswerFromMemory?: boolean
  /** When true, write-plane tool calls (Slack/Email/HTTP/deliveries) pause for approval. */
  requireApproval?: boolean
  /** Structured output contract: non-empty = runs must return JSON with these properties. */
  outputFields?: { name: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description?: string }[]
  /** When true, every run starts with an explicit numbered plan before any tool call. */
  alwaysStrategize?: boolean
  /** Maximum model/tool turns before a run stops. */
  maxTurns?: number
  schedule: {
    type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron' | 'once'
    time?: string
    cron?: string
    timezone: string
    /** YYYY-MM-DD calendar date for a one-time ('once') run, paired with time. */
    runAt?: string
    isActive: boolean
  }
}

// ~10 common IANA timezones offered in the schedule picker.
const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
] as const

/** The browser's IANA timezone, falling back to UTC (e.g. during SSR). */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const emptyDraft: AgentDraft = {
  title: '',
  description: '',
  instructions: '',
  model: 'claude-sonnet-5',
  integrations: [],
  requiredIntegrations: [],
  skills: [],
  icon: '🤖',
  folder: '',
  visibility: 'private',
  allowSubagents: false,
  subagentIds: [],
  goal: '',
  autoAnswerFromMemory: true,
  requireApproval: false,
  outputFields: [],
  alwaysStrategize: false,
  maxTurns: 16,
  schedule: { type: 'manual', time: '09:00', timezone: 'UTC', isActive: false },
}

// ── Model catalog ───────────────────────────────────────────────────────────
// id must satisfy the runtime's provider routing (model-runner.ts): a `claude*`
// id routes to Anthropic, anything else to the OpenAI-compatible slot (Qwen).
// Claude first (platform default / most capable); logos via IntegrationLogo.
const MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' as const },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' as const },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' as const },
  { id: 'qwen-3.7', label: 'Qwen 3.7', provider: 'qwen' as const },
]

function ModelOption({ provider, label }: { provider: 'anthropic' | 'qwen'; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <IntegrationLogo slug={provider} name={provider === 'anthropic' ? 'Claude' : 'Qwen'} className="h-4 w-4" />
      {label}
    </span>
  )
}

// ── Schedule cadence (visual UI concept mapped onto the backend schedule) ────
// Backend supports type manual|hourly|daily|weekly|cron|once (see due.ts). The
// UI offers only friendly visual cadences and never exposes raw cron.
type Cadence = 'hourly' | 'daily' | 'weekly' | 'daysofweek' | 'once' | 'custom'

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

function cadenceOf(schedule: AgentDraft['schedule']): Cadence {
  if (schedule.type === 'once') return 'once'
  if (schedule.type === 'hourly') return 'hourly'
  if (schedule.type === 'daily') return 'daily'
  if (schedule.type === 'weekly') return 'weekly'
  if (schedule.type === 'cron') {
    const fields = (schedule.cron || '').trim().split(/\s+/)
    if (fields.length === 5 && /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1]) && fields[2] === '*' && fields[3] === '*' && /^(?:[0-6](?:,[0-6])*)$/.test(fields[4])) return 'daysofweek'
    return 'custom'
  }
  return 'daily'
}

/** HH:MM + selected weekdays → a `mm hh * * d,d` cron. */
function dowCron(time: string, days: number[]): string {
  const [hh, mm] = (time || '09:00').split(':').map((n) => parseInt(n, 10))
  const list = days.length ? [...days].sort((a, b) => a - b).join(',') : '1'
  return `${Number.isNaN(mm) ? 0 : mm} ${Number.isNaN(hh) ? 9 : hh} * * ${list}`
}

/** Parse the selected weekdays out of a cron's 5th field, defaulting to
 *  weekdays when the field is absent or not a plain day list (e.g. a legacy
 *  arbitrary cron) so the "days of week" picker always has a sane selection. */
function daysFromCron(cron: string | undefined): number[] {
  const dow = (cron || '').trim().split(/\s+/)[4]
  if (!dow) return [1, 2, 3, 4, 5]
  const parsed = dow.split(',').map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6)
  return parsed.length ? parsed : [1, 2, 3, 4, 5]
}

/** Today as YYYY-MM-DD in local time — the earliest selectable one-time date. */
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Pull HH:MM out of a cron's minute+hour fields for the time input. */
function cronToTime(cron: string): string {
  const [minF, hourF] = (cron || '').trim().split(/\s+/)
  const mm = parseInt(minF, 10)
  const hh = parseInt(hourF, 10)
  if (Number.isNaN(mm) || Number.isNaN(hh)) return '09:00'
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/**
 * Coerce a STORED schedule into the exact shape the pickers render. Rows
 * written by templates, drafts, or legacy clients carry looser values than
 * the draft union: an unknown `type` maps to cron when a cron string exists
 * (else manual), a cron schedule missing its HH:MM derives one from the cron
 * fields so the time input isn't blank, and timezone/isActive get safe
 * defaults instead of leaking undefined into controlled inputs.
 */
function normalizeSchedule(schedule: AgentDraft['schedule']): AgentDraft['schedule'] {
  const KNOWN_TYPES = new Set(['manual', 'hourly', 'daily', 'weekly', 'cron', 'once'])
  const type = (KNOWN_TYPES.has(schedule.type)
    ? schedule.type
    : schedule.cron?.trim() ? 'cron' : 'manual') as AgentDraft['schedule']['type']
  const time = schedule.time?.trim()
    || (type === 'cron' && schedule.cron ? cronToTime(schedule.cron) : '')
    || '09:00'
  return {
    ...schedule,
    type,
    time,
    timezone: schedule.timezone?.trim() || 'UTC',
    isActive: Boolean(schedule.isActive),
  }
}

// Curated agent emojis — all ≤4 UTF-16 code units, so they fit the icon cap.
const AGENT_EMOJIS = [
  '🤖', '📊', '📈', '📉', '✉️', '📬', '🔔', '📅',
  '🗂️', '📝', '🔎', '🎯', '⚡', '🧠', '💬', '📣',
  '🛰️', '🧭', '🚀', '🛎️', '💼', '📌', '🧾', '🔗',
  '⏰', '🗓️', '✅', '⭐', '🔥', '💡', '🏷️', '🪄',
]

function EmojiPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-14 items-center justify-center rounded-md border border-input bg-background text-xl transition-colors hover:bg-accent"
        aria-label="Choose agent emoji"
      >
        {value || '🤖'}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover p-2 shadow-md">
          <div className="grid grid-cols-8 gap-0.5">
            {AGENT_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => { onChange(emoji); setOpen(false) }}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded text-lg hover:bg-accent',
                  value === emoji && 'bg-accent',
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function AgentConfigForm({
  editingAgent,
  template,
  onSave,
  onRunAgent,
  runningId,
  onOpenRun,
  active = true,
  saveLabel,
}: {
  editingAgent?: any
  template?: any
  onSave: (draft: AgentDraft) => Promise<void> | void
  onRunAgent?: (agent: any) => Promise<void> | void
  runningId?: string | null
  /** Where a recent-run row should navigate; defaults to the dashboard deep link. */
  onOpenRun?: (runId: string) => void
  /** Dialogs pass their `open` flag so effects re-run each time they reopen. */
  active?: boolean
  saveLabel?: string
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  // "More settings" disclosure. null = untouched, so it auto-opens whenever an
  // advanced option is already configured (an active schedule or output
  // contract must never be hidden behind a collapsed section).
  const [moreSettingsOpen, setMoreSettingsOpen] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [publishingTemplate, setPublishingTemplate] = useState(false)
  // Snapshot of the draft as last populated/saved, so Run can tell whether
  // there are unsaved edits that must be persisted before executing.
  const baselineRef = useRef<string>(JSON.stringify(emptyDraft))
  const [skillNames, setSkillNames] = useState<Record<string, string>>({})
  const [availableIntegrations, setAvailableIntegrations] = useState<AvailableIntegrations | null>(null)
  const [runs, setRuns] = useState<any[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [memoriesLoading, setMemoriesLoading] = useState(false)
  const [memoriesError, setMemoriesError] = useState('')
  const [webhook, setWebhook] = useState<AgentWebhook | null>(null)
  const [webhookBusy, setWebhookBusy] = useState(false)
  // Auto-open "More settings" when any advanced option is configured — an
  // active schedule, output contract, or webhook must never be hidden.
  const advancedInUse =
    draft.alwaysStrategize === true ||
    (draft.maxTurns ?? 16) !== 16 ||
    (draft.outputFields?.length ?? 0) > 0 ||
    draft.allowSubagents === true ||
    draft.schedule.isActive ||
    webhook != null
  const moreOpen = moreSettingsOpen ?? advancedInUse
  const [dismissingSuggestionId, setDismissingSuggestionId] = useState<string | null>(null)
  // Other agents in the workspace, offered as run_agent targets.
  const [orgAgents, setOrgAgents] = useState<{ id: string; title: string }[]>([])

  useEffect(() => {
    if (!active) return
    fetch('/api/agents', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setOrgAgents((data.agents as { id: string; title: string }[]).map((a) => ({ id: a.id, title: a.title })))
      })
      .catch(() => {})
  }, [active])

  // Load this agent's recent runs when editing.
  useEffect(() => {
    if (!active || !editingAgent?.id) { setRuns([]); return }
    setRunsLoading(true)
    fetch(`/api/workflows/executions?agentId=${editingAgent.id}&limit=8`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => setRuns(Array.isArray(data.items) ? data.items.map((item: any) => item.execution) : []))
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false))
  }, [active, editingAgent])

  // Load this agent's memory when editing. Skipped in create mode — there's no agent id yet.
  useEffect(() => {
    if (!active || !editingAgent?.id) { setMemories([]); return }
    setMemoriesLoading(true)
    setMemoriesError('')
    fetch(`/api/agents/${editingAgent.id}/memories`, { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load memory.')
        return data
      })
      .then((data) => setMemories(data.memories ?? []))
      .catch((cause) => setMemoriesError(cause instanceof Error ? cause.message : 'Could not load memory.'))
      .finally(() => setMemoriesLoading(false))
  }, [active, editingAgent])

  const deleteMemory = async (id: string) => {
    if (!editingAgent?.id) return
    const previous = memories
    setMemories((prev) => prev.filter((m) => m.id !== id))
    try {
      const response = await fetch(`/api/agents/${editingAgent.id}/memories`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      })
      if (!response.ok) throw new Error()
    } catch {
      setMemories(previous)
      toast.error('Could not remove memory.')
    }
  }

  // Suggested improvements (behavioral-intelligence Task 3) are open
  // suggestion-kind memories on this agent — dismiss keeps the row (status:
  // 'dismissed') rather than deleting it, so the dedupe embedding stops the
  // same idea from being re-suggested later.
  // One-click apply: fold the suggestion into the agent's instructions (the
  // user reviews it in the editor before saving) and mark it accepted.
  const applySuggestion = (suggestion: { id: string; title: string; content: string }) => {
    if (!editingAgent?.id) return
    setDraft((prev) => ({
      ...prev,
      instructions: `${prev.instructions.trim()}\n\n${suggestion.content}`.trim(),
    }))
    setMemories((prev) => prev.map((m) => (m.id === suggestion.id ? { ...m, status: 'accepted' } : m)))
    toast.success('Added to instructions — review and save.')
    void fetch(`/api/agents/${editingAgent.id}/memories`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: suggestion.id, status: 'accepted' }),
    }).catch(() => undefined)
  }

  const dismissSuggestion = async (id: string) => {
    if (!editingAgent?.id) return
    setDismissingSuggestionId(id)
    const previous = memories
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'dismissed' } : m)))
    try {
      const response = await fetch(`/api/agents/${editingAgent.id}/memories`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'dismissed' }),
      })
      if (!response.ok) {
        setMemories(previous)
        toast.error('Could not dismiss that suggestion.')
      }
    } finally {
      setDismissingSuggestionId(null)
    }
  }

  const clearAllMemory = async () => {
    if (!editingAgent?.id) return
    if (!window.confirm('Clear everything this agent has learned? This cannot be undone.')) return
    const previous = memories
    setMemories([])
    const response = await fetch(`/api/agents/${editingAgent.id}/memories`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    if (!response.ok) {
      setMemories(previous)
      toast.error('Could not clear memory.')
    }
  }

  // Load skill names for compact skills display
  useEffect(() => {
    fetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          const map: Record<string, string> = {}
          for (const s of data.skills as SkillSummary[]) {
            map[s.id] = s.name
          }
          setSkillNames(map)
        }
      })
      .catch(() => {})
  }, [])

  // Load available integrations when the form becomes active, and refetch when
  // the user returns to the tab — so a tool connected elsewhere (the
  // Connections/MCP pages) shows up here promptly instead of only after a
  // full reload.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const loadAvailable = () => {
      fetch('/api/integrations/available', { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => {
          if (cancelled || !data.success) return
          setAvailableIntegrations({ tools: data.tools ?? [], connections: data.connections ?? [] })
        })
        .catch(() => {})
    }
    loadAvailable()
    const refetchOnReturn = () => { if (!document.hidden) loadAvailable() }
    window.addEventListener('focus', refetchOnReturn)
    document.addEventListener('visibilitychange', refetchOnReturn)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refetchOnReturn)
      document.removeEventListener('visibilitychange', refetchOnReturn)
    }
  }, [active])

  // Populate the draft ONLY when the edited agent/template identity changes (or
  // the form activates) — NOT on every editingAgent object-reference change. The
  // dashboard polls agents every 10s, so depending on the object here would
  // overwrite the user's in-progress edits (name/icon/instructions) each poll,
  // making edits appear to "not save". Keying on the id preserves the draft.
  useEffect(() => {
    const source = editingAgent || template
    const next = source ? {
      ...emptyDraft,
      ...source,
      instructions: source.instructions || source.objective || '',
      integrations: source.integrations || [],
      requiredIntegrations: source.requiredIntegrations || [],
      skills: source.skills || [],
      icon: source.icon || emptyDraft.icon,
      folder: source.folder || '',
      visibility: normalizeShareValue(source.visibility),
      allowSubagents: source.allowSubagents === true,
      subagentIds: Array.isArray(source.subagentIds) ? source.subagentIds : [],
      goal: source.goal || '',
      autoAnswerFromMemory: source.autoAnswerFromMemory !== false,
      requireApproval: source.requireApproval === true,
      outputFields: Array.isArray(source.outputFields) ? source.outputFields : [],
      alwaysStrategize: source.alwaysStrategize === true,
      maxTurns: typeof source.maxTurns === 'number' ? source.maxTurns : 16,
      schedule: normalizeSchedule({ ...emptyDraft.schedule, ...(source.schedule || {}) }),
    } : {
      ...emptyDraft,
      // When creating a fresh agent, default the schedule timezone to the
      // browser's resolved zone so daily/weekly times match the user's clock.
      schedule: { ...emptyDraft.schedule, timezone: browserTimezone() },
    }
    setDraft(next)
    setWebhook(null)
    baselineRef.current = JSON.stringify(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingAgent?.id, template?.id, active])

  const toggleIntegration = (label: string) => {
    const next = draft.integrations.includes(label)
      ? draft.integrations.filter((i) => i !== label)
      : [...draft.integrations, label]
    setDraft({ ...draft, integrations: next })
  }

  const detachSkill = (skillId: string) => {
    setDraft({ ...draft, skills: draft.skills.filter((id) => id !== skillId) })
  }

  const dirty = JSON.stringify(draft) !== baselineRef.current
  const connectedIntegrationSlugs = connectedSlugSet(availableIntegrations?.tools ?? [])
  const checkingRequiredIntegrations = (draft.requiredIntegrations?.length ?? 0) > 0 && !availableIntegrations
  const missingRequiredIntegrations = availableIntegrations
    ? missingIntegrations(draft.requiredIntegrations ?? [], connectedIntegrationSlugs)
    : []

  const submit = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      baselineRef.current = JSON.stringify(draft)
    } finally {
      setSaving(false)
    }
  }

  // Run always executes what's persisted — so unsaved edits MUST be saved
  // first, or the run silently uses the old instructions and edits appear
  // to "not catch". A failed save aborts the run (onSave throws on error).
  const runNow = async () => {
    if (!onRunAgent || !editingAgent) return
    if (checkingRequiredIntegrations) {
      toast('Checking required tool connections. Try again in a moment.')
      return
    }
    if (missingRequiredIntegrations.length) {
      toast.error(`Connect ${missingRequiredIntegrations.join(', ')} before running this agent.`)
      return
    }
    if (dirty) {
      setSaving(true)
      try {
        await onSave(draft)
        baselineRef.current = JSON.stringify(draft)
      } finally {
        setSaving(false)
      }
    }
    await onRunAgent(editingAgent)
  }

  const openRun = (runId: string) => {
    if (onOpenRun) onOpenRun(runId)
    else router.push(`/agents?run=${runId}`)
  }

  const configureWebhook = async (rotate = false) => {
    if (!editingAgent?.id || webhookBusy) return
    if (rotate && !window.confirm('Rotate this webhook secret? Calls using the old secret will stop working immediately.')) return
    setWebhookBusy(true)
    try {
      const response = await fetch(`/api/agents/${editingAgent.id}/trigger-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotate }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not configure the webhook trigger.')
        return
      }
      setWebhook({ url: data.url, hasSecret: Boolean(data.hasSecret), secret: typeof data.secret === 'string' ? data.secret : null })
      if (data.secret) toast.success('Webhook secret created. Copy it now — it is shown only once.')
    } catch {
      toast.error('Could not configure the webhook trigger.')
    } finally {
      setWebhookBusy(false)
    }
  }

  const copyWebhookValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied.`)
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}.`)
    }
  }

  /**
   * Export this agent for another platform. The server does the conversion (and
   * the redaction — an agent's tool credentials never leave), and streams a file
   * back, so this just follows the download.
   */
  const exportAgent = async (target: 'portable' | 'instructions') => {
    if (!editingAgent?.id) return
    try {
      const response = await fetch(`/api/agents/${editingAgent.id}/export?target=${target}`, { cache: 'no-store' })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Export failed')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      // Honour the filename the server chose (slugified agent name + target).
      link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'agent'
      link.click()
      URL.revokeObjectURL(url)
      toast.success(
        target === 'instructions'
          ? 'System prompt downloaded — paste it into any agent builder.'
          : 'Exported. Tool connections were not included — the file lists what to reconnect.',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export failed')
    }
  }

  const publishTemplate = async () => {
    if (!editingAgent) return
    const title = draft.title.trim()
    const instructions = draft.instructions.trim()
    if (!title || !instructions) {
      toast.error('Name and instructions are required before adding a template.')
      return
    }
    setPublishingTemplate(true)
    try {
      const tags = Array.from(new Set([
        'agent',
        ...(draft.folder.trim() ? [draft.folder.trim()] : []),
        ...draft.skills.map((skillId) => skillNames[skillId]).filter((name): name is string => Boolean(name)),
      ]))
      const response = await fetch('/api/agent-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: title,
          description: draft.description.trim() || title,
          category: 'Custom',
          instructions,
          integrations: draft.integrations,
          requiredIntegrations: draft.requiredIntegrations,
          skills: draft.skills,
          tags,
          model: draft.model,
          icon: draft.icon,
          allowSubagents: draft.allowSubagents === true,
          subagentIds: draft.subagentIds ?? [],
          goal: draft.goal,
          autoAnswerFromMemory: draft.autoAnswerFromMemory !== false,
          requireApproval: draft.requireApproval === true,
          alwaysStrategize: draft.alwaysStrategize === true,
          maxTurns: draft.maxTurns ?? 16,
          outputFields: draft.outputFields ?? [],
          schedule: draft.schedule,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not add this agent to templates.')
      toast.success('Added to template catalogue.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add this agent to templates.')
    } finally {
      setPublishingTemplate(false)
    }
  }

  // ── Schedule (visual cadence UI ↔ backend schedule) ───────────────────────
  const cadence = cadenceOf(draft.schedule)
  // The time shown in the time picker: cron-backed cadences carry it in the cron
  // fields, the rest in `time`.
  const scheduleTime = (draft.schedule.type === 'cron')
    ? cronToTime(draft.schedule.cron || '')
    : (draft.schedule.time || '09:00')
  const selectedDays = cadence === 'daysofweek' ? daysFromCron(draft.schedule.cron) : []

  const setScheduleEnabled = (on: boolean) => {
    if (!on) {
      setDraft({ ...draft, schedule: { ...draft.schedule, type: 'manual', isActive: false } })
      return
    }
    // Turning it on from "manual" defaults to a daily cadence.
    const time = draft.schedule.time || '09:00'
    const timezone = draft.schedule.timezone || browserTimezone()
    const base = draft.schedule.type === 'manual'
      ? { type: 'daily' as const, time, timezone }
      : draft.schedule
    setDraft({ ...draft, schedule: { ...base, isActive: true } })
  }

  const setCadence = (next: Cadence) => {
    const time = scheduleTime
    const timezone = draft.schedule.timezone || browserTimezone()
    const schedule: AgentDraft['schedule'] =
      next === 'hourly' ? { type: 'hourly', timezone, isActive: true }
      : next === 'daily' ? { type: 'daily', time, timezone, isActive: true }
      : next === 'weekly' ? { type: 'weekly', time, timezone, isActive: true }
      : next === 'once' ? { type: 'once', runAt: draft.schedule.runAt || todayKey(), time, timezone, isActive: true }
      : { type: 'cron', cron: dowCron(time, selectedDays.length ? selectedDays : [1, 2, 3, 4, 5]), time, timezone, isActive: true }
    setDraft({ ...draft, schedule })
  }

  const setScheduleTime = (time: string) => {
    setDraft({
      ...draft,
      schedule: cadence === 'daysofweek'
        ? { ...draft.schedule, time, cron: dowCron(time, selectedDays) }
        : { ...draft.schedule, time },
    })
  }

  const toggleDay = (day: number) => {
    const next = selectedDays.includes(day)
      ? selectedDays.filter((d) => d !== day)
      : [...selectedDays, day]
    // Never allow zero days — keep at least the toggled one.
    const days = next.length ? next : [day]
    setDraft({ ...draft, schedule: { ...draft.schedule, type: 'cron', cron: dowCron(scheduleTime, days) } })
  }

  const setRunAt = (date: string) => {
    setDraft({ ...draft, schedule: { ...draft.schedule, type: 'once', runAt: date } })
  }

  // Plain-language confirmation of what the current schedule does.
  const scheduleSummary = (() => {
    const tz = draft.schedule.timezone || 'UTC'
    if (cadence === 'hourly') return 'Runs every hour.'
    if (cadence === 'daily') return `Runs every day at ${scheduleTime} (${tz}).`
    if (cadence === 'weekly') return `Runs every 7 days at ${scheduleTime} (${tz}).`
    if (cadence === 'daysofweek') {
      const names = [...selectedDays].sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join(', ')
      return `Runs ${names || '—'} at ${scheduleTime} (${tz}).`
    }
    if (cadence === 'once') return `Runs once on ${draft.schedule.runAt || todayKey()} at ${scheduleTime} (${tz}).`
    if (cadence === 'custom') return `Custom cron preserved exactly: ${draft.schedule.cron || 'not set'} (${tz}).`
    return ''
  })()

  // AI-proposed goal from a run's reflection pass, pending user confirmation —
  // only worth surfacing while the draft has no goal of its own yet.
  const suggestedGoal = typeof editingAgent?.suggestedGoal === 'string' ? editingAgent.suggestedGoal : ''

  return (
    <div className="space-y-4">
      <div>
        <Label>Name</Label>
        <div className="flex gap-2">
          <EmojiPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
          <Input className="flex-1" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </div>
      </div>
      <div>
        <Label>Description</Label>
        <Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Folder</Label>
          <Input
            placeholder="e.g. operations"
            value={draft.folder}
            onChange={(event) => setDraft({ ...draft, folder: event.target.value })}
          />
        </div>
        <div>
          <Label>Sharing</Label>
          {/* Only the owner may change sharing — the API rejects anyone else, so
              don't offer a control that would fail on save. */}
          <Select
            value={normalizeShareValue(draft.visibility)}
            disabled={Boolean(editingAgent) && editingAgent?.isOwner === false}
            onValueChange={(visibility: string) => setDraft({ ...draft, visibility })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="private">Private — only you</SelectItem>
              <SelectItem value="org_viewer">Org can view &amp; run</SelectItem>
              <SelectItem value="org_editor">Org can edit</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>Instructions</Label>
        <Textarea rows={8} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
      </div>
      <div>
        <Label>Larger goal (optional)</Label>
        {suggestedGoal && !draft.goal && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2.5 text-sm text-indigo-900">
            <p><span className="font-semibold">Suggested goal:</span> {suggestedGoal}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, goal: suggestedGoal })}>
              Use it
            </Button>
          </div>
        )}
        <Textarea rows={2} value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} />
        <p className="mt-1 text-xs text-muted-foreground">
          The outcome this agent ultimately serves — it steers every run and self-evaluation.
        </p>
      </div>
      <div>
        <Label>Model</Label>
        <Select value={draft.model} onValueChange={(model) => setDraft({ ...draft, model })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <ModelOption provider={m.provider} label={m.label} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Connected tools picker ───────────────────────────────────── */}
      <div>
        <Label>Connected tools</Label>
        {availableIntegrations ? (
          <div className="mt-2 space-y-3">
            {/* All attachable tools across planes (built-ins, Nango, and
                custom Sublime-MCP connections) in one wrapping row group so
                they flow together rather than breaking onto separate rows. */}
            {(availableIntegrations.tools.length > 0 || availableIntegrations.connections.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {availableIntegrations.tools.map((t) => {
                  const selected = draft.integrations.includes(t.key)
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => toggleIntegration(t.key)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs transition-colors duration-150',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                      )}
                    >
                      <IntegrationLogo slug={t.slug} name={t.label} className="h-4 w-4 bg-white/70" />
                      {t.label}
                      {!t.connected && !selected && (
                        <span className="text-[10px] opacity-60">not configured</span>
                      )}
                      {t.connected && !selected && (
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                      )}
                    </button>
                  )
                })}
                {availableIntegrations.connections.map((c) => {
                  const selected = draft.integrations.includes(c.name)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleIntegration(c.name)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs transition-colors duration-150',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                      )}
                    >
                      <IntegrationLogo slug={c.name.toLowerCase().replace(/[^a-z0-9]+/g, '')} name={c.name} className="h-4 w-4 bg-white/70" />
                      {c.name}
                    </button>
                  )
                })}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Click a tool to attach it to this agent — a green dot means it&apos;s connected and
              ready, but the agent only uses tools you attach here.
            </p>
            <div className="flex items-center gap-2">
              <Link
                href="/integrations?tab=mcp"
                className="text-xs font-medium text-primary hover:underline"
              >
                + Connect a tool
              </Link>
              <span className="text-xs text-muted-foreground">
                — add more in Connections.
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Loading integrations…</p>
        )}
      </div>

      {/* ── Memory + strategy toggles ───────────────────────────────── */}
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Answer from memory automatically</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              When a question closely matches one you&apos;ve answered before, the agent reuses your answer instead of pausing.
            </p>
          </div>
          <Switch
            checked={draft.autoAnswerFromMemory === true}
            onCheckedChange={(on) => setDraft({ ...draft, autoAnswerFromMemory: on })}
          />
        </div>
      </div>
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Require approval for outbound actions</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Slack messages, emails, HTTP calls, and other deliveries pause for your approval before they go out.
            </p>
          </div>
          <Switch
            checked={draft.requireApproval === true}
            onCheckedChange={(on) => setDraft({ ...draft, requireApproval: on })}
          />
        </div>
      </div>

      {/* ── More settings (advanced, collapsed by default) ──────────── */}
      <button
        type="button"
        onClick={() => setMoreSettingsOpen(!moreOpen)}
        aria-expanded={moreOpen}
        className="flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors hover:bg-accent/50"
      >
        <div>
          <span className="text-sm font-medium">More settings</span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Planning, turn limits, structured output, multi-agent, scheduling, and webhooks.
          </p>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
      </button>

      {moreOpen && (
        <>
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Always strategize</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Every run starts with an explicit numbered plan before any tool call.
            </p>
          </div>
          <Switch
            checked={draft.alwaysStrategize === true}
            onCheckedChange={(on) => setDraft({ ...draft, alwaysStrategize: on })}
          />
        </div>
      </div>
      <div className="rounded-lg border p-3">
        <Label htmlFor="max-turns">Maximum turns per run</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">Stops runaway tool loops while allowing longer research jobs when needed.</p>
        <Input
          id="max-turns"
          type="number"
          min={1}
          max={64}
          className="mt-2 w-28"
          value={draft.maxTurns ?? 16}
          onChange={(event) => setDraft({ ...draft, maxTurns: Math.min(64, Math.max(1, Number(event.target.value) || 1)) })}
        />
      </div>

      {/* ── Structured output ───────────────────────────────────────── */}
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Structured output</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Require every run to answer with JSON carrying these properties — each becomes reliable data for flows and integrations.
            </p>
          </div>
          <Switch
            checked={(draft.outputFields?.length ?? 0) > 0}
            onCheckedChange={(on) =>
              setDraft({ ...draft, outputFields: on ? [{ name: 'summary', type: 'string' }] : [] })
            }
          />
        </div>
        {(draft.outputFields?.length ?? 0) > 0 && (
          <div className="mt-3 space-y-2">
            {(draft.outputFields ?? []).map((field, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_130px_36px]">
                <Input
                  value={field.name}
                  placeholder="propertyName"
                  onChange={(e) =>
                    setDraft({ ...draft, outputFields: (draft.outputFields ?? []).map((f, j) => (j === index ? { ...f, name: e.target.value } : f)) })
                  }
                  aria-label={`Output property ${index + 1} name`}
                />
                <select
                  value={field.type}
                  onChange={(e) =>
                    setDraft({ ...draft, outputFields: (draft.outputFields ?? []).map((f, j) => (j === index ? { ...f, type: e.target.value as NonNullable<AgentDraft['outputFields']>[number]['type'] } : f)) })
                  }
                  className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                  aria-label={`Output property ${index + 1} type`}
                >
                  {['string', 'number', 'boolean', 'object', 'array'].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, outputFields: (draft.outputFields ?? []).filter((_, j) => j !== index) })}
                  className="flex items-center justify-center rounded-md text-red-500 hover:bg-red-50"
                  aria-label={`Remove output property ${index + 1}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setDraft({ ...draft, outputFields: [...(draft.outputFields ?? []), { name: '', type: 'string' }] })}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
            >
              + Add property
            </button>
          </div>
        )}
      </div>

      {/* ── Multi-agent handoff ─────────────────────────────────────── */}
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Run other agents</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Let this agent delegate to your other agents (fan-out or pipeline stages) via a run_agent tool.
            </p>
          </div>
          <Switch
            checked={draft.allowSubagents === true}
            onCheckedChange={(on) => setDraft({ ...draft, allowSubagents: on })}
          />
        </div>

        {draft.allowSubagents === true && (() => {
          const candidates = orgAgents.filter((a) => a.id !== editingAgent?.id)
          const selected = draft.subagentIds ?? []
          const allSelected = selected.length === 0
          const toggleAgent = (id: string) => {
            const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
            setDraft({ ...draft, subagentIds: next })
          }
          return (
            <div className="mt-3 border-t pt-3">
              <p className="mb-2 text-xs font-medium text-gray-600">Which agents can it run?</p>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-gray-50">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-600"
                  checked={allSelected}
                  onChange={() => setDraft({ ...draft, subagentIds: [] })}
                />
                <span className="font-medium">All agents</span>
                <span className="text-xs text-gray-400">({candidates.length} available)</span>
              </label>
              {candidates.length > 0 && (
                <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1">
                  {candidates.map((agent) => (
                    <label key={agent.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-gray-50">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-indigo-600"
                        checked={allSelected || selected.includes(agent.id)}
                        onChange={() => toggleAgent(agent.id)}
                      />
                      <span className="truncate">{agent.title}</span>
                    </label>
                  ))}
                </div>
              )}
              {candidates.length === 0 && <p className="px-1 text-xs text-gray-400">No other agents yet — create more to delegate to them.</p>}
            </div>
          )
        })()}
      </div>

      {/* ── Schedule ─────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <div>
            <Label>Schedule enabled</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">Run this agent automatically on a cadence.</p>
          </div>
          <Switch checked={draft.schedule.isActive} onCheckedChange={setScheduleEnabled} />
        </div>

        {draft.schedule.isActive && (
          <div className="space-y-3 border-t pt-3">
            <div>
              <Label>Cadence</Label>
              <Select value={cadence} onValueChange={(value) => setCadence(value as Cadence)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Every 7 days</SelectItem>
                  <SelectItem value="daysofweek">Days of week</SelectItem>
                  <SelectItem value="once">Once (specific date)</SelectItem>
                  {cadence === 'custom' && <SelectItem value="custom" disabled>Custom cron (preserved)</SelectItem>}
                </SelectContent>
              </Select>
            </div>

            {/* Days of week — weekday toggles */}
            {cadence === 'daysofweek' && (
              <div>
                <Label>Repeat on</Label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {DAY_LABELS.map((label, day) => {
                    const on = selectedDays.includes(day)
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleDay(day)}
                        className={cn(
                          'h-8 w-10 rounded-md border text-xs font-medium transition-colors duration-fast',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                        )}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Once — calendar date picker */}
            {cadence === 'once' && (
              <div>
                <Label>Date</Label>
                <div className="mt-1.5">
                  <MiniCalendar value={draft.schedule.runAt} onChange={setRunAt} min={todayKey()} />
                </div>
              </div>
            )}

            {cadence === 'custom' && <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">This schedule uses an advanced cron expression. It will remain unchanged unless you choose another cadence.</p>}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {cadence !== 'hourly' && cadence !== 'custom' && <div>
                <Label>Time</Label>
                <Input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} />
              </div>}
              <div>
                <Label>Timezone</Label>
                <Select
                  value={draft.schedule.timezone}
                  onValueChange={(timezone) => setDraft({ ...draft, schedule: { ...draft.schedule, timezone } })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {/* Keep a browser-detected zone outside the common list selectable. */}
                    {!COMMON_TIMEZONES.includes(draft.schedule.timezone as (typeof COMMON_TIMEZONES)[number]) && draft.schedule.timezone && (
                      <SelectItem value={draft.schedule.timezone}>{draft.schedule.timezone}</SelectItem>
                    )}
                    {COMMON_TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {scheduleSummary && <p className="text-xs text-muted-foreground">{scheduleSummary}</p>}
          </div>
        )}
      </div>

      {/* ── Webhook trigger ─────────────────────────────────────────── */}
      {editingAgent?.id && (
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="flex items-center gap-2"><Webhook className="h-4 w-4" /> Webhook trigger</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">Run this agent from another app with a secret HTTP endpoint.</p>
            </div>
            {!webhook && (
              <Button type="button" variant="outline" size="sm" loading={webhookBusy} onClick={() => configureWebhook(false)}>
                Set up webhook
              </Button>
            )}
          </div>

          {webhook && (
            <div className="space-y-3 border-t pt-3">
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">POST endpoint</p>
                  <button type="button" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => copyWebhookValue(webhook.url, 'Endpoint')}><Copy className="h-3 w-3" /> Copy</button>
                </div>
                <p className="break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{webhook.url}</p>
              </div>

              {webhook.secret ? (
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">x-trigger-secret · shown once</p>
                    <button type="button" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => copyWebhookValue(webhook.secret!, 'Secret')}><Copy className="h-3 w-3" /> Copy</button>
                  </div>
                  <p className="break-all rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 font-mono text-xs text-amber-950">{webhook.secret}</p>
                  <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => copyWebhookValue(`curl -X POST '${webhook.url}' -H 'content-type: application/json' -H 'x-trigger-secret: ${webhook.secret}' --data '{"input":{"account":"Acme"}}'`, 'cURL command')}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy cURL example
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">A secret already exists and cannot be shown again. Rotate it to receive a new value.</p>
              )}

              <Button type="button" variant="ghost" size="sm" loading={webhookBusy} onClick={() => configureWebhook(true)}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Rotate secret
              </Button>
            </div>
          )}
        </div>
      )}
        </>
      )}

      {/* ── Compact Skills display ───────────────────────────────────── */}
      <div>
        <Label>Skills</Label>
        {draft.skills.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {draft.skills.map((skillId) => (
              <span
                key={skillId}
                className="flex items-center gap-1 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground"
              >
                {skillNames[skillId] ?? skillId}
                <button
                  type="button"
                  aria-label={`Remove skill ${skillNames[skillId] ?? skillId}`}
                  onClick={() => detachSkill(skillId)}
                  className="ml-0.5 rounded-full p-0.5 transition-colors duration-150 hover:bg-border"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No skills attached.</p>
        )}
        <p className="mt-1.5 text-xs text-muted-foreground">
          Add skills from the{' '}
          <Link href="/agents?view=templates&tab=skills" className="text-primary hover:underline">
            Templates library
          </Link>
          .
        </p>
      </div>

      {editingAgent?.id && <KnowledgePanel agentId={editingAgent.id} />}

      {editingAgent && (runsLoading || runs.length > 0) && (
        <div>
          <p className="eyebrow mb-2">Recent runs</p>
          {runsLoading ? (
            <p className="text-sm text-gray-500"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => openRun(run.id)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-gray-50"
                  >
                    <span className="truncate text-gray-700">{run.metadata?.headline || run.error || run.status}</span>
                    <span className="shrink-0 text-xs text-gray-500">{new Date(run.startedAt).toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editingAgent?.id && (
        <div className="space-y-3">
          <SuggestedImprovementBanner
            suggestions={memories
              .filter((m) => m.kind === 'suggestion' && m.status === 'open')
              .map((m) => ({ id: m.id, title: m.title, content: m.content }))}
            onDismiss={dismissSuggestion}
            onApply={applySuggestion}
            applyLabel="Add to instructions"
            dismissingId={dismissingSuggestionId}
          />
          <div className="mb-2 flex items-center justify-between">
            <p className="eyebrow">Memory</p>
            {memories.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearAllMemory}
                className="text-red-600 hover:text-red-700"
              >
                Clear all memory
              </Button>
            )}
          </div>
          {memoriesLoading ? (
            <p className="text-sm text-gray-500"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…</p>
          ) : memoriesError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{memoriesError}</p>
          ) : memories.length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-sm text-gray-500">
              Nothing learned yet — memories appear after runs complete.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {memories
                .filter((m) => !(m.kind === 'suggestion' && m.status === 'open'))
                .map((memory) => (
                <li key={memory.id} className="group flex items-start gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center gap-2">
                      <Badge variant={MEMORY_KIND_VARIANT[memory.kind] ?? 'secondary'}>
                        {MEMORY_KIND_LABEL[memory.kind] ?? memory.kind}
                      </Badge>
                      <span className="truncate font-semibold text-gray-700" title={memory.title}>{memory.title}</span>
                    </div>
                    {memory.question && <p className="italic text-gray-500">{memory.question}</p>}
                    <p className="line-clamp-2 text-gray-500">{memory.content}</p>
                    {memory.lastUsedAt && (
                      <p className="mt-0.5 text-xs text-gray-400">Last used {new Date(memory.lastUsedAt).toLocaleDateString()}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteMemory(memory.id)}
                    className="shrink-0 text-gray-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                    aria-label={`Remove memory ${memory.title}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editingAgent && missingRequiredIntegrations.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <p className="font-semibold">Connect required tools before running</p>
          <p className="mt-0.5">Missing: {missingRequiredIntegrations.join(', ')}</p>
          <Link href="/integrations" className="mt-1 inline-block font-semibold underline underline-offset-2">Open integrations</Link>
        </div>
      )}

      <div className="flex gap-2">
        {editingAgent && onRunAgent && (
          <Button
            variant="outline"
            disabled={saving || runningId === editingAgent.id || checkingRequiredIntegrations || missingRequiredIntegrations.length > 0}
            onClick={runNow}
            className="shrink-0"
          >
            {saving || runningId === editingAgent.id
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Play className="mr-1.5 h-4 w-4" />}
            {dirty ? 'Save & run' : 'Run'}
          </Button>
        )}
        {editingAgent && (
          <Button
            variant="outline"
            disabled={saving || publishingTemplate || !draft.title || !draft.instructions}
            loading={publishingTemplate}
            onClick={publishTemplate}
            className="shrink-0"
          >
            Add to templates
          </Button>
        )}
        {/* Take this agent elsewhere. Only meaningful once it is saved (export
            reads the stored agent), and credentials never travel — the file
            lists the tools to reconnect. */}
        {editingAgent && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="shrink-0" disabled={saving}>
                <Download className="mr-1.5 h-4 w-4" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Take this agent elsewhere</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => exportAgent('instructions')}>
                <ScrollText className="h-4 w-4" /> System prompt (paste anywhere)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportAgent('portable')}>
                <Download className="h-4 w-4" /> Portable JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button className="flex-1" disabled={saving || !draft.title || !draft.instructions} onClick={submit}>
          {saving ? 'Saving...' : saveLabel || (editingAgent ? 'Save agent' : 'Create agent')}
        </Button>
      </div>
    </div>
  )
}
