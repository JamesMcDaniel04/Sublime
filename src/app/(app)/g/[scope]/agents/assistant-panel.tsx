'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { streamCopilot } from '@/lib/client/copilot-stream'
import { Check, Clock, Loader2, MessageSquare, Plus, Send } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HtmlPreview, looksLikeHtml } from '@/components/ui/html-preview'
import { Markdown } from '@/components/ui/markdown'
import { notifyAgentsChanged } from '@/components/layout/sidebar'
import { cn } from '@/lib/utils'
import type { Agent } from '@/lib/types'
import { describeSchedule } from '@/lib/scheduling/describe-schedule'
import { useViewerTimeZone } from '@/lib/scheduling/use-viewer-time-zone'

/**
 * Persistent assistant chat for the selected agent. The thread is agent-scoped
 * (not per-execution): the server grounds answers in the agent's config and
 * recent runs, and change requests come back as proposals the user applies via
 * the existing agent update API after an explicit confirm.
 */

type ProposalSchedule = {
  type: string
  time?: string
  cron?: string
  timezone: string
  isActive: boolean
}

type AssistantProposal = {
  summary: string
  title?: string
  description?: string
  instructions?: string
  model?: string
  integrations?: string[]
  skills?: string[]
  schedule?: ProposalSchedule
}

type ChatMessage = {
  id: string
  role: string
  content: string
  createdAt: string
  proposal?: AssistantProposal | null
  appliedAt?: string | null
  /** Tool-activity labels streamed during this reply ("Reading run 4f2a…"). */
  activity?: string[]
  /** True while this reply is still streaming in. */
  streaming?: boolean
}

type SessionSummary = {
  id: string
  title: string
  updatedAt: string
  messageCount: number
}

/** Compact relative time for the history list, e.g. "just now", "2h", "3d". */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  return `${Math.floor(days / 30)}mo`
}

function scheduleLabel(schedule: ProposalSchedule, viewerTimeZone: string): string {
  return describeSchedule(schedule, viewerTimeZone, new Date())
}

function proposalRows(
  proposal: AssistantProposal,
  viewerTimeZone: string,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  if (proposal.title) rows.push({ label: 'Name', value: proposal.title })
  if (proposal.description) rows.push({ label: 'Description', value: proposal.description })
  if (proposal.instructions) rows.push({ label: 'Instructions', value: proposal.instructions })
  if (proposal.model) rows.push({ label: 'Model', value: proposal.model })
  if (proposal.integrations) rows.push({ label: 'Connected tools', value: proposal.integrations.join(', ') || 'none' })
  if (proposal.skills) rows.push({ label: 'Skills', value: proposal.skills.join(', ') || 'none' })
  if (proposal.schedule) rows.push({ label: 'Schedule', value: scheduleLabel(proposal.schedule, viewerTimeZone) })
  return rows
}

function ProposalCard({
  message,
  applying,
  onApply,
}: {
  message: ChatMessage
  applying: boolean
  onApply: () => void
}) {
  const proposal = message.proposal
  const viewerTimeZone = useViewerTimeZone(proposal?.schedule?.timezone || 'UTC')
  if (!proposal) return null
  const rows = proposalRows(proposal, viewerTimeZone)
  return (
    <div className="mt-2 rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="eyebrow">Proposed changes</p>
        {message.appliedAt && (
          <Badge variant="outline" className="gap-1 border-green-200 text-green-700">
            <Check className="h-3 w-3" /> Applied
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{proposal.summary}</p>
      {rows.length > 0 && (
        <dl className="mt-2 space-y-2 border-t pt-2">
          {rows.map((row) => (
            <div key={row.label}>
              <dt className="mono-label">{row.label}</dt>
              <dd className="mt-0.5 max-h-36 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!message.appliedAt && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" disabled={applying} onClick={onApply}>
            {applying ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
            Apply changes
          </Button>
        </div>
      )}
    </div>
  )
}

export function AssistantPanel({
  agent,
  hasFailedRun,
  runOutput,
  onAgentUpdated,
}: {
  agent: Agent | null
  hasFailedRun?: boolean
  /** The run expanded on the left, whose output renders at the top here. */
  runOutput?: { title: string; at: string; status: string; text: string } | null
  onAgentUpdated: () => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  // Conversation state: the active session (null = a fresh, not-yet-saved chat)
  // and this agent's history for the current user.
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement | null>(null)
  const agentId = agent?.id
  // Tracks the currently-targeted agent so in-flight async completions can
  // detect an agent switch and avoid mutating another agent's thread.
  const agentIdRef = useRef(agentId)

  // History is per agent + per rep: refetch the session list whenever the agent
  // changes (server scopes it to this agent and the authenticated user).
  const loadSessions = useCallback(async (targetAgentId: string) => {
    try {
      const response = await fetch(`/api/agents/${targetAgentId}/chat/sessions`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (agentIdRef.current !== targetAgentId) return
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
    } catch {
      if (agentIdRef.current === targetAgentId) setSessions([])
    }
  }, [])

  useEffect(() => {
    agentIdRef.current = agentId
    setHistoryOpen(false)
    // Start every agent on a FRESH chat rather than auto-restoring its most
    // recent conversation. Prior chats aren't lost — they're saved per agent +
    // per rep and reachable from the history (clock) dropdown — they're just
    // not reopened into the view. So a new login always opens a clean chat.
    setMessages([])
    setSessionId(null)
    if (!agentId) {
      setSessions([])
      return
    }
    // Only the history list loads on select; the conversation stays empty.
    void loadSessions(agentId)
  }, [agentId, loadSessions])

  // Close the history dropdown on an outside click.
  useEffect(() => {
    if (!historyOpen) return
    const onClick = (event: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) setHistoryOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [historyOpen])

  const startNewChat = () => {
    setHistoryOpen(false)
    setSessionId(null)
    setMessages([])
    setInput('')
  }

  const selectSession = async (id: string) => {
    setHistoryOpen(false)
    if (!agentId || id === sessionId) return
    const targetAgentId = agentId
    setLoading(true)
    setMessages([])
    try {
      const response = await fetch(`/api/agents/${targetAgentId}/chat?sessionId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (agentIdRef.current !== targetAgentId) return
      setMessages(Array.isArray(data.messages) ? data.messages : [])
      setSessionId(typeof data.sessionId === 'string' ? data.sessionId : id)
    } finally {
      if (agentIdRef.current === targetAgentId) setLoading(false)
    }
  }

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, sending])

  const send = async (preset?: string) => {
    const content = (preset ?? input).trim()
    if (!agentId || !content || sending) return
    const targetAgentId = agentId
    setInput('')
    setSending(true)
    const localId = `local-${Date.now()}`
    setMessages((previous) => [
      ...previous,
      { id: localId, role: 'user', content, createdAt: new Date().toISOString() },
    ])
    // A legacy synthetic thread is read-only; sending from it opens a fresh
    // session rather than appending to the null-session bucket.
    const targetSessionId = sessionId && sessionId !== 'legacy' ? sessionId : undefined
    const pendingId = `pending-${Date.now()}`
    try {
      setMessages((previous) => [
        ...previous,
        { id: pendingId, role: 'assistant', content: '', createdAt: new Date().toISOString(), streaming: true, activity: [] },
      ])
      const outcome = await streamCopilot(
        `/api/agents/${targetAgentId}/chat`,
        { message: content, ...(targetSessionId ? { sessionId: targetSessionId } : {}) },
        {
          onText: (delta) => {
            if (agentIdRef.current !== targetAgentId) return
            setMessages((previous) => previous.map((entry) =>
              entry.id === pendingId ? { ...entry, content: entry.content + delta } : entry))
          },
          onTool: (activity) => {
            if (agentIdRef.current !== targetAgentId) return
            setMessages((previous) => previous.map((entry) =>
              entry.id === pendingId ? { ...entry, activity: [...(entry.activity ?? []), activity.label] } : entry))
          },
        },
      )
      // The user switched agents while the request was in flight; this
      // response belongs to another agent's thread, so leave state alone.
      if (agentIdRef.current !== targetAgentId) return
      if (!outcome.ok) {
        toast.error(outcome.error)
        setMessages((previous) => previous.filter((message) => message.id !== localId && message.id !== pendingId))
        setInput(content)
        return
      }
      // The result payload is authoritative: replace the streamed approximation
      // (covers provider failover, where partial deltas may not match the final
      // text) while carrying the streamed activity labels onto the final reply.
      const result = outcome.result as { sessionId?: string; messages?: ChatMessage[] }
      const finalMessages = Array.isArray(result.messages) ? result.messages : []
      setMessages((previous) => {
        const activity = previous.find((entry) => entry.id === pendingId)?.activity ?? []
        const withActivity = finalMessages.map((entry, index) =>
          index === finalMessages.length - 1 && activity.length ? { ...entry, activity } : entry)
        return [
          ...previous.filter((message) => message.id !== localId && message.id !== pendingId),
          ...withActivity,
        ]
      })
      if (typeof result.sessionId === 'string') setSessionId(result.sessionId)
      // Refresh history so a new chat appears / its title + ordering update.
      void loadSessions(targetAgentId)
    } finally {
      if (agentIdRef.current === targetAgentId) setSending(false)
    }
  }

  const applyProposal = async (message: ChatMessage) => {
    if (!agent || !message.proposal || applyingId) return
    setApplyingId(message.id)
    try {
      // Strip the display-only summary; everything else maps onto the
      // existing PUT /api/agents payload.
      const { summary, ...changes } = message.proposal
      void summary
      const response = await fetch('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agent.id, ...changes }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not apply the changes.')
        return
      }
      // Best-effort: persist the applied marker on the proposal message.
      fetch(`/api/agents/${agent.id}/chat`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id }),
      }).catch(() => undefined)
      setMessages((previous) => previous.map((candidate) =>
        candidate.id === message.id ? { ...candidate, appliedAt: new Date().toISOString() } : candidate,
      ))
      toast.success('Agent configuration updated.')
      notifyAgentsChanged()
      onAgentUpdated()
    } finally {
      setApplyingId(null)
    }
  }

  // Task-oriented starters that reflect what these agents do (research,
  // briefing) plus quick config — not just "what did the last run do".
  const suggestions = agent
    ? [
        'Summarize the key findings from the latest run',
        ...(hasFailedRun
          ? ['Why did the last run fail?']
          : ['Draft a short brief from the most recent run']),
        'What should I follow up on next?',
        'Change the schedule to run daily at 9am',
      ]
    : []

  // Always a chat window: header, scrollable transcript, composer pinned to the
  // bottom. Before an agent is picked the composer stays visible but disabled so
  // the pane reads as a chat surface rather than an empty placeholder.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="eyebrow">Assistant</p>
            <h2 className="mt-1 truncate font-semibold">{agent ? agent.title : 'No agent selected'}</h2>
          </div>
          {agent && (
            <div className="flex shrink-0 items-center gap-1" ref={historyRef}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="New chat"
                title="New chat"
                onClick={startNewChat}
                disabled={sending}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <div className="relative">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Chat history"
                  title="Chat history"
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <Clock className="h-4 w-4" />
                </Button>
                {historyOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-md">
                    <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Chat history</p>
                    {sessions.length === 0 ? (
                      <p className="px-3 pb-3 pt-1 text-sm text-muted-foreground">No past chats yet.</p>
                    ) : (
                      <ul className="max-h-72 overflow-y-auto pb-1">
                        {sessions.map((session) => (
                          <li key={session.id}>
                            <button
                              type="button"
                              onClick={() => selectSession(session.id)}
                              className={cn(
                                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                                session.id === sessionId && 'bg-accent/60',
                              )}
                            >
                              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">{session.title}</span>
                              <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(session.updatedAt)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {agent
            ? 'Ask about run output, debug errors, or change configuration in plain language.'
            : 'Pick an agent to ask about its runs, debug errors, or change its configuration.'}
        </p>
      </div>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!agent && (
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="max-w-sm text-center">
              <MessageSquare className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                This is where you talk to your agents — ask what a run did, walk through an error, or describe a change. Select an agent to begin.
              </p>
            </div>
          </div>
        )}
        {agent && loading && (
          <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        )}
        {/* Empty chat (no output, no messages): center the starters vertically. */}
        {agent && !loading && !runOutput && messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="w-full max-w-sm text-center">
              <MessageSquare className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                Sublime grounds answers in this agent&apos;s configuration and recent runs.
              </p>
              <div className="mt-4 space-y-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={sending}
                    onClick={() => send(suggestion)}
                    className="w-full rounded-lg border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors duration-150 hover:border-indigo-200 hover:bg-indigo-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {/* Content flow: the selected run's output on top, then the conversation. */}
        {agent && !loading && (runOutput || messages.length > 0 || sending) && (
          <div className="space-y-3 p-4">
            {runOutput && (
              <div className={cn('rounded-lg border p-3', runOutput.status === 'failed' ? 'border-red-200 bg-red-50' : 'bg-card')}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="eyebrow">{runOutput.status === 'failed' ? 'Run error' : 'Output'} · {runOutput.title}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">{new Date(runOutput.at).toLocaleString()}</span>
                </div>
                <div className={cn('text-sm', runOutput.status === 'failed' && 'whitespace-pre-wrap text-red-700')}>
                  {runOutput.status === 'failed'
                    ? runOutput.text
                    : looksLikeHtml(runOutput.text)
                      ? <HtmlPreview html={runOutput.text} />
                      : <Markdown>{runOutput.text}</Markdown>}
                </div>
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  'rounded-lg p-3 text-sm transition-colors duration-150',
                  message.role === 'user' ? 'ml-8 bg-indigo-50' : 'mr-8 border bg-muted',
                )}
              >
                {message.streaming && !message.content && !message.activity?.length ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                  </span>
                ) : message.role === 'user'
                  ? <p className="whitespace-pre-wrap">{message.content}</p>
                  : looksLikeHtml(message.content)
                    ? <HtmlPreview html={message.content} />
                    : <Markdown>{message.content}</Markdown>}
                {message.role !== 'user' && message.streaming && message.activity && message.activity.length > 0 && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> {message.activity[message.activity.length - 1]}
                  </p>
                )}
                {message.role !== 'user' && !message.streaming && message.activity && message.activity.length > 0 && (
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                      Investigated {message.activity.length} thing{message.activity.length === 1 ? '' : 's'}
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {message.activity.map((label, index) => <li key={index}>{label}</li>)}
                    </ul>
                  </details>
                )}
                {message.role !== 'user' && message.proposal && (
                  <ProposalCard
                    message={message}
                    applying={applyingId === message.id}
                    onApply={() => applyProposal(message)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* shrink-0: the composer is the one row that must never give up space
          to the transcript above it — a flex item defaults to shrinkable, so
          under any height pressure this is what gets squeezed. */}
      <div className="shrink-0 border-t p-4">
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && send()}
            placeholder={agent ? `Ask about ${agent.title}...` : 'Select an agent to start chatting…'}
            disabled={!agent || sending}
          />
          <Button size="icon" disabled={!agent || sending || !input.trim()} onClick={() => send()} aria-label="Send message">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
