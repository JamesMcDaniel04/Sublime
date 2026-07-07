'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { MiniCalendar } from '@/components/ui/mini-calendar'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { KnowledgePanel } from '@/app/dashboard/knowledge-panel'
import { cn } from '@/lib/utils'

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
  strataTools: ToolChip[]
  connections: ConnectionIntegration[]
}

export type AgentDraft = {
  title: string
  description: string
  instructions: string
  model: string
  priority: string
  integrations: string[]
  skills: string[]
  icon: string
  folder: string
  visibility: 'shared' | 'private'
  /** Lets this agent delegate to other agents via the run_agent tool. */
  allowSubagents?: boolean
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
  priority: 'medium',
  integrations: [],
  skills: [],
  icon: '🤖',
  folder: '',
  visibility: 'shared',
  allowSubagents: false,
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
type Cadence = 'daily' | 'daysofweek' | 'once'

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

function cadenceOf(schedule: AgentDraft['schedule']): Cadence {
  if (schedule.type === 'once') return 'once'
  if (schedule.type === 'daily') return 'daily'
  // Everything else recurring — day-of-week crons plus legacy weekly / hourly /
  // every-other-day / arbitrary crons — surfaces as the flexible "days of week"
  // picker; a legacy schedule converts to a clean cron on its next save.
  return 'daysofweek'
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

/** Legacy 'hourly' ≡ cron '0 * * * *'; represent it as cron so the cadence UI
 *  (which has no Hourly preset) round-trips it losslessly via "Advanced". */
function normalizeSchedule(schedule: AgentDraft['schedule']): AgentDraft['schedule'] {
  if (schedule.type === 'hourly') return { ...schedule, type: 'cron', cron: schedule.cron || '0 * * * *' }
  return schedule
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
  const [saving, setSaving] = useState(false)
  // Snapshot of the draft as last populated/saved, so Run can tell whether
  // there are unsaved edits that must be persisted before executing.
  const baselineRef = useRef<string>(JSON.stringify(emptyDraft))
  const [skillNames, setSkillNames] = useState<Record<string, string>>({})
  const [availableIntegrations, setAvailableIntegrations] = useState<AvailableIntegrations | null>(null)
  const [strataQuery, setStrataQuery] = useState('')
  const [runs, setRuns] = useState<any[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

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
  // Connections/MCP pages, or a Klavis OAuth popup) shows up here promptly
  // instead of only after a full reload.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const loadAvailable = () => {
      fetch('/api/integrations/available', { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => {
          if (cancelled || !data.success) return
          setAvailableIntegrations({ tools: data.tools ?? [], strataTools: data.strataTools ?? [], connections: data.connections ?? [] })
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
      skills: source.skills || [],
      icon: source.icon || emptyDraft.icon,
      folder: source.folder || '',
      visibility: source.visibility || 'shared',
      allowSubagents: source.allowSubagents === true,
      schedule: normalizeSchedule({ ...emptyDraft.schedule, ...(source.schedule || {}) }),
    } : {
      ...emptyDraft,
      // When creating a fresh agent, default the schedule timezone to the
      // browser's resolved zone so daily/weekly times match the user's clock.
      schedule: { ...emptyDraft.schedule, timezone: browserTimezone() },
    }
    setDraft(next)
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
    else router.push(`/dashboard?run=${runId}`)
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
      next === 'daily' ? { type: 'daily', time, timezone, isActive: true }
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
    if (cadence === 'daily') return `Runs every day at ${scheduleTime} (${tz}).`
    if (cadence === 'daysofweek') {
      const names = [...selectedDays].sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join(', ')
      return `Runs ${names || '—'} at ${scheduleTime} (${tz}).`
    }
    if (cadence === 'once') return `Runs once on ${draft.schedule.runAt || todayKey()} at ${scheduleTime} (${tz}).`
    return ''
  })()

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
          <Label>Visibility</Label>
          <Select value={draft.visibility} onValueChange={(visibility: AgentDraft['visibility']) => setDraft({ ...draft, visibility })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="shared">Workspace</SelectItem>
              <SelectItem value="private">Private</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>Instructions</Label>
        <Textarea rows={8} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
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
            {/* All attachable tools across planes (built-ins, Nango, Klavis, and
                custom Den-MCP connections) in one wrapping row group so
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

            {/* Klavis Strata catalogue — searchable; each server is opt-in so an
                agent carries only the tools it needs, not all of them. */}
            {availableIntegrations.strataTools.length > 0 && (
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">
                    Klavis tools
                    {(() => {
                      const n = draft.integrations.filter((k) => k.toLowerCase().startsWith('strata:')).length
                      return n > 0 ? <span className="ml-1 text-muted-foreground">· {n} attached</span> : null
                    })()}
                  </p>
                  <Input
                    value={strataQuery}
                    onChange={(event) => setStrataQuery(event.target.value)}
                    placeholder="Search Klavis tools"
                    className="h-8 w-48 text-xs"
                  />
                </div>
                <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
                  {availableIntegrations.strataTools
                    .filter((t) => !strataQuery.trim() || t.label.toLowerCase().includes(strataQuery.trim().toLowerCase()))
                    .slice(0, 60)
                    .map((t) => {
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
                        </button>
                      )
                    })}
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Click a tool to attach it to this agent — a green dot means it&apos;s connected and
              ready, but the agent only uses tools you attach here.
            </p>
            <div className="flex items-center gap-2">
              <Link
                href="/connections"
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
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="daysofweek">Days of week</SelectItem>
                  <SelectItem value="once">Once (specific date)</SelectItem>
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

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Time</Label>
                <Input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} />
              </div>
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
          <Link href="/templates" className="text-primary hover:underline">
            Templates page
          </Link>
          .
        </p>
      </div>

      {editingAgent?.id && <KnowledgePanel agentId={editingAgent.id} />}

      {editingAgent && (
        <div>
          <p className="eyebrow mb-2">Recent runs</p>
          {runsLoading ? (
            <p className="text-sm text-gray-500"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-gray-500">No runs yet.</p>
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

      <div className="flex gap-2">
        {editingAgent && onRunAgent && (
          <Button
            variant="outline"
            disabled={saving || runningId === editingAgent.id}
            onClick={runNow}
            className="shrink-0"
          >
            {saving || runningId === editingAgent.id
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Play className="mr-1.5 h-4 w-4" />}
            {dirty ? 'Save & run' : 'Run'}
          </Button>
        )}
        <Button className="flex-1" disabled={saving || !draft.title || !draft.instructions} onClick={submit}>
          {saving ? 'Saving...' : saveLabel || (editingAgent ? 'Save agent' : 'Create agent')}
        </Button>
      </div>
    </div>
  )
}
