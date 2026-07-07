'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  HelpCircle,
  Loader2,
  Network,
  Play,
  Send,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/ui/markdown'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { cn } from '@/lib/utils'
import type { Activity, Agent } from '@/lib/types'

/**
 * Activity log for the selected agent: runs grouped by status, each row
 * expandable in place to its conversation, output, tool calls and errors.
 * Reuses the existing execution-detail endpoint and follow-up reply plumbing.
 */

export type RunStep = {
  id: string
  node: string
  status: string
  input?: any
  output?: any
  error?: any
  startedAt?: string | null
  completedAt?: string | null
}

type RunDetails = {
  execution: Activity
  steps: RunStep[]
  events: Array<{ id: string; kind: string; payload?: any; ts: string }>
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>
}

export const groupOrder = ['running', 'waiting_for_input', 'failed', 'completed'] as const

export const groupLabels: Record<string, string> = {
  running: 'Running',
  waiting_for_input: 'Needs input',
  failed: 'Error',
  completed: 'Success',
}

function activityStatus(activity: Activity) {
  return activity.status.toLowerCase()
}

/** Per-run outcome icon: green check for success, red X for a failed run, and
 *  distinct marks for in-progress / needs-input, so every row reads at a glance. */
function runStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-label="Success" />
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-label="Failed" />
    case 'running':
    case 'pending':
      return <CircleDashed className="h-4 w-4 shrink-0 animate-spin text-blue-600" aria-label="Running" />
    case 'waiting_for_input':
      return <HelpCircle className="h-4 w-4 shrink-0 text-amber-500" aria-label="Needs input" />
    default:
      return <AlertCircle className="h-4 w-4 shrink-0 text-gray-400" aria-label={status} />
  }
}

export function resultText(activity?: Activity | null) {
  if (!activity) return ''
  if (activity.error) return activity.error
  const value = activity.output?.summary ?? activity.output?.response ?? activity.output
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function stepDuration(step: RunStep): string | null {
  if (!step.startedAt || !step.completedAt) return null
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function asJson(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

// A step node is `provider.tool` (e.g. "granola.list_notes", "jira.discover_…",
// "nango:slack.send_message"). Derive the provider's brand logo so the process
// log shows real company marks instead of a generic wrench. Returns null for
// non-provider steps (e.g. "ask_user") so those keep the wrench.
const PROVIDER_NAMES: Record<string, string> = {
  slack: 'Slack', gmail: 'Gmail', salesforce: 'Salesforce', granola: 'Granola',
  email: 'Email', den: 'Den', jira: 'Jira', github: 'GitHub',
  notion: 'Notion', hubspot: 'HubSpot', clickup: 'ClickUp', linear: 'Linear',
  asana: 'Asana', confluence: 'Confluence', trello: 'Trello',
}
// Where the logo slug differs from the provider key (Simple Icons has no
// "email"/"people.ai" mark; use Resend / fall through to an initial tile).
const PROVIDER_LOGO_SLUGS: Record<string, string> = { email: 'resend' }

function stepProvider(node: string): { slug: string; name: string } | null {
  if (!node.includes('.')) return null // ask_user and other non-tool steps
  let provider = node.split('.')[0]
  if (provider.startsWith('nango:')) provider = provider.slice('nango:'.length) // nango:slack → slack
  if (!provider) return null
  // Custom MCP connections carry their slugified connection name as the
  // provider (e.g. "Den MCP" → den_mcp), so an exact-key lookup
  // misses them — fall back to a known provider key contained in the slug so
  // those steps still get the right brand mark instead of an initial tile.
  const knownKey =
    provider in PROVIDER_NAMES
      ? provider
      : Object.keys(PROVIDER_NAMES).find((key) => provider.includes(key))
  if (knownKey) {
    return { slug: PROVIDER_LOGO_SLUGS[knownKey] ?? knownKey, name: PROVIDER_NAMES[knownKey] }
  }
  const prettyName = provider
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  return { slug: PROVIDER_LOGO_SLUGS[provider] ?? provider, name: prettyName }
}

// One tool call: header always visible; inputs/outputs expand on click so a
// successful call's data is inspectable, not hidden behind a bare status badge.
// A call still in flight shows a live spinner ("Calling…") rather than a badge.
function ToolCallCard({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false)
  const duration = stepDuration(step)
  const failed = step.status === 'failed'
  const running = step.status === 'running'
  const waiting = step.status === 'waiting'
  const input = asJson(step.input)
  const output = asJson(step.error ?? step.output)
  const hasDetail = Boolean(input || output)
  return (
    <div className={cn('rounded-lg border bg-white text-sm', running && 'border-blue-200')}>
      <button
        type="button"
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="flex min-w-0 items-center gap-2">
          {(() => {
            const provider = stepProvider(step.node)
            return provider ? (
              <IntegrationLogo slug={provider.slug} name={provider.name} className="h-4 w-4 shrink-0 rounded-sm" />
            ) : (
              <Wrench className={cn('h-3.5 w-3.5 shrink-0', running ? 'text-blue-500' : 'text-gray-400')} />
            )
          })()}
          <span className="truncate font-mono text-xs">{step.node}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {duration && <span className="text-xs text-gray-500">{duration}</span>}
          {running ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-blue-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Calling…
            </span>
          ) : waiting ? (
            <Badge variant="warn">waiting</Badge>
          ) : failed ? (
            <Badge variant="risk">{step.status}</Badge>
          ) : (
            <Badge variant="outline">{step.status}</Badge>
          )}
          {hasDetail && <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200', open && 'rotate-180')} />}
        </span>
      </button>
      {open && hasDetail && (
        <div className="space-y-2 border-t px-3 py-2">
          {input && (
            <div>
              <p className="mono-label mb-1">Input</p>
              <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-xs">{input}</pre>
            </div>
          )}
          {output && (
            <div>
              <p className="mono-label mb-1">{failed ? 'Error' : 'Output'}</p>
              <pre className={cn('overflow-x-auto rounded p-2 text-xs', failed ? 'bg-red-50 text-red-700' : 'bg-gray-50')}>{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The agent's narration for one turn, shown as a reasoning step in the timeline.
function ThinkingCard({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-white/60 px-3 py-2">
      <p className="mono-label mb-1 flex items-center gap-1.5 text-gray-400">
        <Sparkles className="h-3 w-3" /> Thinking
      </p>
      <div className="text-sm text-gray-600"><Markdown>{text}</Markdown></div>
    </div>
  )
}

// Correlated-context facts are assembled server-side and often embed a raw
// JSON blob (e.g. `Output: {"summary":"…"}` or `Sales AI status: {"error":"…"}`)
// that renders as escaped JSON noise. Replace each flat {...} blob with its most
// meaningful string field so the fact reads as prose. Applied at display time so
// it cleans up facts indexed before the server-side formatting fix too.
function humanizeFact(text: string): string {
  return text.replace(/\{[^{}]*\}/g, (blob) => {
    try {
      const obj = JSON.parse(blob) as Record<string, unknown>
      if (obj && typeof obj === 'object') {
        for (const key of ['summary', 'response', 'error', 'message', 'text']) {
          const value = obj[key]
          if (typeof value === 'string' && value.trim()) return value.trim()
        }
        const strings = Object.values(obj).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        if (strings.length) return strings.join(' — ')
      }
    } catch {
      // Not valid JSON — leave the original text untouched.
    }
    return blob
  })
}

// Fact types sourced from Den Sales AI (vs. internal run/agent nodes), so
// they render with the Den brand mark to show where the data came from.
const SALES_AI_FACT_TYPES = new Set(['opportunity', 'account', 'signal'])

// Renders the graph-RAG context the agent pulled in before acting — the visible
// "brain" step: which Sales AI signals, prior runs, and related entities it
// correlated. Collapsed to the summary by default; expandable to the facts.
function ContextCard({ summary, hits, related }: { summary: string; hits: ContextFact[]; related: ContextFact[] }) {
  const [open, setOpen] = useState(false)
  const total = hits.length + related.length
  return (
    <div className="rounded-lg border border-dashed border-horizon-200 bg-horizon-50/40 px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
        disabled={total === 0}
      >
        <Network className="h-3 w-3 shrink-0 text-horizon-600" />
        <span className="mono-label text-horizon-700">Correlated context</span>
        {total > 0 && <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      <p className="mt-1 text-sm text-gray-600">{summary}</p>
      {open && total > 0 && (
        <ul className="mt-2 space-y-1 border-t pt-2">
          {[...hits, ...related].map((fact, i) => (
            <li key={i} className="flex items-start gap-1.5 whitespace-pre-wrap text-xs text-gray-600">
              {SALES_AI_FACT_TYPES.has((fact.type || '').toLowerCase()) && (
                <IntegrationLogo slug="den" name="Den" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span>
                <span className="mono-label mr-1.5 text-gray-400">{fact.type}</span>
                {humanizeFact(fact.text)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Merge thinking events and tool-call steps into one chronological process
// timeline, so the log reads as the agent's reasoning interleaved with its calls.
type ContextFact = { type: string; text: string }
type TimelineItem =
  | { key: string; ts: number; kind: 'thinking'; text: string }
  | { key: string; ts: number; kind: 'tool'; step: RunStep }
  | { key: string; ts: number; kind: 'context'; summary: string; hits: ContextFact[]; related: ContextFact[] }

function buildTimeline(details: RunDetails | null): TimelineItem[] {
  if (!details) return []
  const items: TimelineItem[] = []
  for (const event of details.events ?? []) {
    if (event.kind === 'agent.thinking' && event.payload?.text) {
      items.push({ key: `t-${event.id}`, ts: new Date(event.ts).getTime(), kind: 'thinking', text: String(event.payload.text) })
    }
    if (event.kind === 'context.retrieved') {
      items.push({
        key: `c-${event.id}`,
        ts: new Date(event.ts).getTime(),
        kind: 'context',
        summary: String(event.payload?.summary ?? 'Retrieved correlated context'),
        hits: Array.isArray(event.payload?.hits) ? (event.payload.hits as ContextFact[]) : [],
        related: Array.isArray(event.payload?.related) ? (event.payload.related as ContextFact[]) : [],
      })
    }
  }
  for (const step of details.steps ?? []) {
    const ts = step.startedAt ? new Date(step.startedAt).getTime() : 0
    items.push({ key: `s-${step.id}`, ts, kind: 'tool', step })
  }
  return items.sort((a, b) => a.ts - b.ts)
}

function RunRow({
  activity,
  expanded,
  onToggle,
  onChanged,
}: {
  activity: Activity
  expanded: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const [details, setDetails] = useState<RunDetails | null>(null)
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const status = activityStatus(activity)
  const isActive = ['running', 'pending', 'waiting_for_input'].includes(status)
  const timeline = buildTimeline(details)

  useEffect(() => {
    if (!expanded) {
      setDetails(null)
      return
    }
    let cancelled = false
    const fetchDetails = () =>
      fetch(`/api/workflows/executions?executionId=${activity.id}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((data) => { if (!cancelled) setDetails(data.items?.[0] || null) })
        .catch(() => { if (!cancelled) setDetails(null) })
    fetchDetails()
    // While a run is active, poll its detail so thinking and tool calls stream in
    // (near-real-time) without a full-page refetch.
    const timer = isActive ? window.setInterval(fetchDetails, 2000) : undefined
    return () => { cancelled = true; if (timer) window.clearInterval(timer) }
  }, [expanded, activity.id, status, isActive])

  const sendReply = async () => {
    if (!reply.trim() || replying) return
    setReplying(true)
    try {
      await fetch(`/api/executions/${activity.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: reply }),
      })
      setReply('')
      onChanged()
    } finally {
      setReplying(false)
    }
  }

  return (
    <div className="border-b">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'grid w-full grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-gray-50',
          expanded && 'bg-gray-50',
        )}
      >
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200', expanded && 'rotate-180')} />
        {runStatusIcon(status)}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{activity.metadata?.title || activity.agentType}</div>
          <div className="line-clamp-1 text-xs text-gray-500">
            {activity.metadata?.pendingQuestion?.question || activity.metadata?.headline || activity.error || resultText(activity) || 'In progress'}
          </div>
        </div>
        <time className="shrink-0 font-mono text-xs tabular-nums text-gray-400">{new Date(activity.startedAt).toLocaleString()}</time>
      </button>

      {expanded && (
        <div className="space-y-4 border-t bg-gray-50/60 px-4 py-4">
          {activity.error && (
            <pre className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{activity.error}</pre>
          )}

          {status === 'waiting_for_input' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-900"><HelpCircle className="h-4 w-4" /> Agent needs your input</h4>
              <p className="mb-3 whitespace-pre-wrap text-sm text-amber-900">{activity.metadata?.pendingQuestion?.question || 'The agent asked a question.'}</p>
              <div className="flex gap-2">
                <Input
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && sendReply()}
                  placeholder="Reply to the agent..."
                />
                <Button size="icon" disabled={replying || !reply.trim()} onClick={sendReply}>
                  {replying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}

          {/* Process timeline: the agent's reasoning interleaved with its tool
              calls, streaming in while the run is active. Conversation with the
              agent lives in the assistant pane on the right, not here. */}
          <div>
            <h4 className="eyebrow mb-2 flex items-center gap-2">
              <Wrench className="h-4 w-4" /> Process
              {timeline.length ? <span className="text-gray-400">· {timeline.length}</span> : null}
            </h4>
            <div className="space-y-2">
              {timeline.map((item) => (
                <div key={item.key} className="animate-fade-in">
                  {item.kind === 'thinking'
                    ? <ThinkingCard text={item.text} />
                    : item.kind === 'context'
                      ? <ContextCard summary={item.summary} hits={item.hits} related={item.related} />
                      : <ToolCallCard step={item.step} />}
                </div>
              ))}
              {isActive && (
                <p className="flex items-center gap-2 px-1 text-sm text-blue-600">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Agent is working…
                </p>
              )}
              {!details && <p className="text-sm text-gray-500"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading run detail…</p>}
              {details && !timeline.length && !isActive && <p className="text-sm text-gray-500">No steps recorded for this run.</p>}
            </div>
          </div>

          {/* The run's OUTPUT is shown in the assistant pane on the right (that
              surface holds agent output + the conversation); the left pane is
              logs + status only. */}
        </div>
      )}
    </div>
  )
}

export function AgentActivityPane({
  agent,
  activities,
  focusRunId,
  onChanged,
  onSelectRun,
}: {
  agent: Agent
  activities: Activity[]
  /** Deep-linked run to auto-expand (e.g. ?run= or a fresh manual run). */
  focusRunId?: string | null
  onChanged: () => void
  /** Fires with the expanded run (or null) so the right pane can show its output. */
  onSelectRun?: (activity: Activity | null) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Collapse when switching agents; expand the focused run when one arrives.
  useEffect(() => {
    setExpandedId(focusRunId ?? null)
  }, [focusRunId, agent.id])

  // Surface the expanded run (kept fresh as activities poll) to the parent so
  // the assistant pane can render its output.
  useEffect(() => {
    onSelectRun?.(activities.find((activity) => activity.id === expandedId) ?? null)
  }, [expandedId, activities, onSelectRun])

  if (!activities.length) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Play}
          title="No runs yet"
          description={`Run ${agent.title} to see its activity here.`}
        />
      </div>
    )
  }

  return (
    <div>
      {groupOrder.map((groupStatus) => {
        const items = activities.filter((activity) => activityStatus(activity) === groupStatus)
        if (!items.length) return null
        return (
          <div key={groupStatus}>
            <div className="flex items-center gap-2 border-b bg-gray-50 px-4 py-2 text-sm font-medium">
              {groupStatus === 'completed' ? <CheckCircle2 className="h-4 w-4 text-green-600" /> :
                groupStatus === 'running' ? <CircleDashed className="h-4 w-4 animate-spin text-blue-600" /> :
                groupStatus === 'waiting_for_input' ? <HelpCircle className="h-4 w-4 text-amber-500" /> :
                <AlertCircle className="h-4 w-4 text-red-600" />}
              {groupLabels[groupStatus]} <span className="font-mono text-xs tabular-nums text-gray-400">{items.length}</span>
            </div>
            {items.map((activity) => (
              <RunRow
                key={activity.id}
                activity={activity}
                expanded={expandedId === activity.id}
                onToggle={() => setExpandedId((current) => (current === activity.id ? null : activity.id))}
                onChanged={onChanged}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
