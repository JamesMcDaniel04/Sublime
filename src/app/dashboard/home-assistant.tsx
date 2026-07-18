'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowUp,
  Cable,
  CalendarClock,
  Clock,
  ExternalLink,
  FileText,
  ListChecks,
  Loader2,
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { notifyAgentsChanged } from '@/components/layout/sidebar'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'

/**
 * Home — the workspace-level assistant. A Claude/ChatGPT-style chat surface:
 * hero + composer + preset chips before the first message, then a transcript.
 * The assistant answers oversight questions from server-assembled workspace
 * context, converts assignments (text or uploaded files) into agents after
 * aligning on delivery requirements, and can start runs when asked.
 */

type Attachment = { filename: string; text: string; truncated?: boolean }

type CreatedAgent = { id: string; title: string; icon: string; description: string }

type ExecutedRun = { executionId: string; agentId: string; status: string }

type ChatMessage = {
  id: string
  role: string
  content: string
  createdAt: string
  attachment?: { filename: string; truncated?: boolean } | null
  createdAgent?: CreatedAgent | null
  executedRun?: ExecutedRun | null
  action?: { type: 'execute'; agentId: string } | null
}

type SessionSummary = { id: string; title: string; updatedAt: string; messageCount: number }

type UserSuggestion = {
  id: string
  kind: 'new_flow' | 'enhancement'
  title: string
  description: string
  flowId: string | null
  targetType: string | null
  targetId: string | null
  evidence: string[]
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

// Preset chips are limited to what the assistant can actually do: convert
// assignments, report on runs, report on connections, and build agents.
const PRESETS: Array<{ label: string; icon: typeof FileText; prompt: string; sendNow: boolean }> = [
  {
    label: 'Turn an assignment into an agent',
    icon: FileText,
    prompt: 'I have an assignment I need handled. Here are the details: ',
    sendNow: false,
  },
  {
    label: 'What did my agents do this week?',
    icon: ListChecks,
    prompt: 'Summarize what my agents did recently — completed runs, failures, and anything waiting on me.',
    sendNow: true,
  },
  {
    label: 'Which connections need attention?',
    icon: Cable,
    prompt: 'Check my connections and integrations — is anything disconnected or erroring?',
    sendNow: true,
  },
  {
    label: 'Build me a daily briefing agent',
    icon: CalendarClock,
    prompt: 'Build me an agent that prepares a short daily briefing of my workspace activity every morning at 9am.',
    sendNow: true,
  },
]

// Hero headline CTAs — each one is a task the assistant can genuinely perform
// (assignment conversion, run reporting, connection health, scheduling, runs).
const HEADLINE_CTAS = [
  'What should we take on?',
  'Hand me an assignment and I’ll build the agent.',
  'Ask what your agents did this week.',
  'Check which connections need attention.',
  'Schedule a daily briefing of your workspace.',
  'Tell me to run an agent, and I will.',
]

const TYPE_MS = 34
const DELETE_MS = 16
// Type (~1.5s) + hold + delete (~0.7s) lands each phrase at ≈7.5s on screen.
const HOLD_MS = 5300

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Typewriter headline: types a phrase, holds, deletes, then moves to the next.
 * With reduced motion the phrase swaps whole on the same cadence instead.
 */
function TypedHeadline({ phrases }: { readonly phrases: readonly string[] }) {
  const reduced = usePrefersReducedMotion()
  const [index, setIndex] = useState(0)
  const [length, setLength] = useState(0)
  const [phase, setPhase] = useState<'typing' | 'deleting'>('typing')
  const phrase = phrases[index]

  useEffect(() => {
    if (reduced) {
      const timer = setTimeout(() => setIndex((current) => (current + 1) % phrases.length), 7500)
      return () => clearTimeout(timer)
    }
    let timer: ReturnType<typeof setTimeout>
    if (phase === 'typing') {
      timer =
        length < phrase.length
          ? setTimeout(() => setLength(length + 1), TYPE_MS)
          : setTimeout(() => setPhase('deleting'), HOLD_MS)
    } else if (length > 0) {
      timer = setTimeout(() => setLength(length - 1), DELETE_MS)
    } else {
      timer = setTimeout(() => {
        setIndex((index + 1) % phrases.length)
        setPhase('typing')
      }, 200)
    }
    return () => clearTimeout(timer)
  }, [reduced, phase, length, index, phrase, phrases.length])

  return (
    <h1 className="min-h-16 text-center text-2xl font-semibold text-gray-900 sm:min-h-8">
      {/* Screen readers get one stable sentence; the animation is decorative. */}
      <span className="sr-only">
        What should we take on? Ask about your agents, runs, and connections, or hand me an assignment.
      </span>
      <span aria-hidden="true">
        {reduced ? phrase : phrase.slice(0, length)}
        <span
          className={cn(
            'ml-1 inline-block h-[1.1em] w-[2px] translate-y-[0.18em] rounded-full bg-indigo-400',
            !reduced && 'caret-blink',
          )}
        />
      </span>
    </h1>
  )
}

/** Time-of-day salutation for the hero eyebrow. */
function salutationForHour(hour: number): string {
  if (hour < 5) return 'Working late'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

// Roles the reply can be framed for. Keys must match OUTPUT_STYLE_PROMPTS in
// the chat route, where the actual tailoring happens.
type OutputStyleKey = 'sales' | 'csm' | 'marketing' | 'it'

const OUTPUT_STYLES: Array<{ key: OutputStyleKey; label: string; hint: string }> = [
  { key: 'sales', label: 'Sales', hint: 'Deal impact and next actions' },
  { key: 'csm', label: 'CSM', hint: 'Account health and follow-ups' },
  { key: 'marketing', label: 'Marketing', hint: 'Campaign results and next content' },
  { key: 'it', label: 'IT', hint: 'System status, errors, and fixes' },
]

export function HomeAssistant() {
  const { user } = useAuth()
  const router = useRouter()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<UserSuggestion | null>(null)
  const [suggestionBusy, setSuggestionBusy] = useState(false)
  const [outputStyle, setOutputStyle] = useState<OutputStyleKey | null>(null)
  // Computed after mount so the server-rendered HTML never disagrees with the
  // visitor's local clock.
  const [salutation, setSalutation] = useState('Welcome back')
  useEffect(() => setSalutation(salutationForHour(new Date().getHours())), [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch('/api/assistant/chat/sessions', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
    } catch {
      setSessions([])
    }
  }, [])

  // Fresh chat on every visit; history stays reachable from the dropdown.
  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  // At most one open evidence-backed suggestion exists per user; show it quietly.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/intelligence/user-suggestions', { cache: 'no-store' })
        const data = await response.json().catch(() => ({}))
        if (!cancelled && data?.suggestion) setSuggestion(data.suggestion as UserSuggestion)
      } catch {
        /* the card simply doesn't render */
      }
    })()
    return () => { cancelled = true }
  }, [])

  const actOnSuggestion = async (action: 'accept' | 'dismiss') => {
    if (!suggestion || suggestionBusy) return
    setSuggestionBusy(true)
    try {
      const response = await fetch('/api/intelligence/user-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: suggestion.id, action }),
      })
      if (!response.ok) throw new Error('request failed')
      const accepted = action === 'accept'
      const flowId = suggestion.flowId
      setSuggestion(null)
      if (accepted && flowId) router.push(`/flows/${flowId}`)
      else if (accepted) toast.success('Saved — you can find it on the agent it applies to.')
    } catch {
      toast.error('Could not update the suggestion. Try again.')
    } finally {
      setSuggestionBusy(false)
    }
  }

  // Close the history dropdown on an outside click.
  useEffect(() => {
    if (!historyOpen) return
    const onClick = (event: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) setHistoryOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [historyOpen])

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, sending])

  const startNewChat = () => {
    setHistoryOpen(false)
    setSessionId(null)
    setMessages([])
    setInput('')
    setAttachment(null)
  }

  const selectSession = async (id: string) => {
    setHistoryOpen(false)
    if (id === sessionId) return
    setLoadingSession(true)
    setMessages([])
    try {
      const response = await fetch(`/api/assistant/chat?sessionId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      setMessages(Array.isArray(data.messages) ? data.messages : [])
      setSessionId(typeof data.sessionId === 'string' ? data.sessionId : id)
    } finally {
      setLoadingSession(false)
    }
  }

  /** Persist a started run on its source message so reloads still show it. */
  const recordRun = (messageId: string, executedRun: ExecutedRun) => {
    setMessages((previous) =>
      previous.map((message) => (message.id === messageId ? { ...message, executedRun } : message)),
    )
    fetch('/api/assistant/chat', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, executedRun }),
    }).catch(() => undefined)
  }

  const executeAgent = useCallback(async (agentId: string, messageId: string, title?: string) => {
    setRunningId(agentId)
    try {
      const response = await fetch(`/api/agents/${agentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Run failed')
        return
      }
      if (data.result?.status === 'waiting_for_input') toast(`${title || 'The agent'} needs your input`)
      else toast.success(`${title || 'Agent'} run started`)
      if (data.executionId) {
        recordRun(messageId, {
          executionId: data.executionId,
          agentId,
          status: data.result?.status || data.status || 'pending',
        })
      }
      notifyAgentsChanged()
    } catch {
      toast.error('Could not start the run — check your connection and try again.')
    } finally {
      setRunningId(null)
    }
  }, [])

  const send = async (preset?: string) => {
    const content = (preset ?? input).trim()
    if (!content || sending || uploading) return
    setInput('')
    setSending(true)
    const localId = `local-${Date.now()}`
    const sentAttachment = attachment
    setAttachment(null)
    setMessages((previous) => [
      ...previous,
      {
        id: localId,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        attachment: sentAttachment ? { filename: sentAttachment.filename, truncated: sentAttachment.truncated } : null,
      },
    ])
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          ...(sessionId ? { sessionId } : {}),
          ...(sentAttachment ? { attachment: sentAttachment } : {}),
          ...(outputStyle ? { outputStyle } : {}),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'The assistant is unavailable right now.')
        setMessages((previous) => previous.filter((message) => message.id !== localId))
        setInput(content)
        setAttachment(sentAttachment)
        return
      }
      const returned: ChatMessage[] = Array.isArray(data.messages) ? data.messages : []
      setMessages((previous) => [...previous.filter((message) => message.id !== localId), ...returned])
      if (typeof data.sessionId === 'string') setSessionId(data.sessionId)
      if (returned.some((message) => message.createdAgent)) notifyAgentsChanged()
      // The assistant validated an explicit "run it" request — fire the
      // existing execute endpoint and pin the run onto the message.
      const actionMessage = returned.find((message) => message.action?.type === 'execute')
      if (actionMessage?.action) void executeAgent(actionMessage.action.agentId, actionMessage.id)
      void loadSessions()
    } finally {
      setSending(false)
    }
  }

  const uploadFile = async (file: File) => {
    setUploading(true)
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch('/api/assistant/extract', { method: 'POST', body: form })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not read that file.')
        return
      }
      setAttachment({ filename: data.filename, text: data.text, truncated: data.truncated })
      if (data.truncated) toast('Long file — using the first part of it.')
      textareaRef.current?.focus()
    } catch {
      toast.error('Could not read that file — check your connection and try again.')
    } finally {
      setUploading(false)
    }
  }

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    if (preset.sendNow) {
      void send(preset.prompt)
      return
    }
    setInput(preset.prompt)
    textareaRef.current?.focus()
  }

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const empty = messages.length === 0 && !sending && !loadingSession

  const composer = (
    <div className="w-full">
      {suggestion && (
        <div className="mb-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-3 text-sm shadow-1">
          <p className="text-xs font-medium uppercase tracking-wide text-indigo-500">Noticed a routine</p>
          <p className="mt-1 font-medium text-gray-900">{suggestion.title}</p>
          <p className="mt-0.5 text-gray-600">{suggestion.description}</p>
          {suggestion.evidence.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-indigo-600 hover:text-indigo-800">Why this exists</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-gray-500">
                {suggestion.evidence.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" disabled={suggestionBusy} onClick={() => void actOnSuggestion('accept')}>
              {suggestion.kind === 'new_flow' ? 'Review draft' : 'Accept'}
            </Button>
            <Button size="sm" variant="ghost" disabled={suggestionBusy} onClick={() => void actOnSuggestion('dismiss')}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {attachment && (
        <div className="mb-2 inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1.5 text-sm text-gray-700 shadow-1">
          <FileText className="h-3.5 w-3.5 text-indigo-500" />
          <span className="max-w-[16rem] truncate">{attachment.filename}</span>
          {attachment.truncated && <span className="text-xs text-amber-600">(trimmed)</span>}
          <button
            type="button"
            aria-label="Remove attachment"
            className="rounded-full p-0.5 text-gray-400 transition-colors hover:text-gray-700"
            onClick={() => setAttachment(null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="rounded-3xl border bg-white p-3 shadow-1 transition-shadow focus-within:ring-2 focus-within:ring-indigo-200">
        <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.pdf,.docx,text/*,application/pdf,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void uploadFile(file)
          }}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-10 w-10 shrink-0 rounded-full text-gray-500 hover:text-gray-800"
          aria-label="Attach an assignment file"
          title="Attach an assignment file"
          disabled={uploading || sending}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
        </Button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => {
            setInput(event.target.value)
            event.target.style.height = 'auto'
            event.target.style.height = `${Math.min(event.target.scrollHeight, 192)}px`
          }}
          onKeyDown={onComposerKeyDown}
          placeholder={attachment ? 'What should be done with this assignment?' : 'Ask about your workspace, or describe an assignment…'}
          disabled={sending}
          className="max-h-48 min-h-[3rem] flex-1 resize-none bg-transparent px-1 py-2.5 text-base outline-none placeholder:text-gray-400"
        />
        <Button
          size="icon"
          className="h-10 w-10 shrink-0 rounded-full"
          aria-label="Send message"
          disabled={sending || uploading || !input.trim()}
          onClick={() => void send()}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </Button>
        </div>
        {/* Role framing — the selected key travels with each send and reshapes
            the reply server-side. Clicking the active role clears it. */}
        <fieldset className="mt-2.5 border-t border-gray-100 px-1 pt-2.5">
          <legend className="sr-only">Tailor output for</legend>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">
              Tailor output for
            </span>
            <span className="truncate text-sm text-gray-400">
              {OUTPUT_STYLES.find((style) => style.key === outputStyle)?.hint ?? 'General output'}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-0.5 rounded-xl bg-gray-100 p-1">
            {OUTPUT_STYLES.map((style) => (
              <button
                key={style.key}
                type="button"
                aria-pressed={outputStyle === style.key}
                title={style.hint}
                disabled={sending}
                onClick={() => setOutputStyle((current) => (current === style.key ? null : style.key))}
                className={cn(
                  'rounded-lg px-2 py-1.5 text-[13px] font-medium uppercase tracking-wide transition-colors',
                  outputStyle === style.key
                    ? 'bg-white text-indigo-700 shadow-1'
                    : 'text-gray-500 hover:text-gray-800',
                )}
              >
                {style.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen min-h-0 flex-col bg-slate-50">
      {/* Header: new chat + history, mirroring the per-agent panel. */}
      <div className="flex shrink-0 items-center justify-between border-b bg-white px-4 py-3">
        <div>
          <p className="eyebrow">Home</p>
        </div>
        <div className="flex items-center gap-1" ref={historyRef}>
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
              <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-md border bg-white shadow-popover">
                <p className="px-3 pb-1 pt-2 text-xs font-medium text-gray-500">Chat history</p>
                {sessions.length === 0 ? (
                  <p className="px-3 pb-3 pt-1 text-sm text-gray-500">No past chats yet.</p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto pb-1">
                    {sessions.map((session) => (
                      <li key={session.id}>
                        <button
                          type="button"
                          onClick={() => void selectSession(session.id)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-50',
                            session.id === sessionId && 'bg-indigo-50',
                          )}
                        >
                          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                          <span className="min-w-0 flex-1 truncate">{session.title}</span>
                          <span className="shrink-0 text-xs text-gray-400">{relativeTime(session.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {empty ? (
        /* Hero: greeting + composer + presets, vertically centered. */
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <div className="w-full max-w-4xl">
            <p className="eyebrow text-center">
              <span className="text-indigo-400">{'///'}</span> {salutation}
              {user?.firstName ? `, ${user.firstName}` : ''}
            </p>
            <div className="mt-2">
              <TypedHeadline phrases={HEADLINE_CTAS} />
            </div>
            <div className="mt-6">{composer}</div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  disabled={sending || uploading}
                  onClick={() => applyPreset(preset)}
                  className="flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-sm text-gray-600 shadow-1 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                >
                  <preset.icon className="h-3.5 w-3.5" />
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Transcript */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-3 p-4">
              {loadingSession && (
                <div className="flex items-center justify-center p-6 text-gray-500">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    'rounded-xl p-3 text-sm',
                    message.role === 'user' ? 'ml-12 bg-indigo-50' : 'mr-12 border bg-white',
                  )}
                >
                  {message.role === 'user' ? (
                    <>
                      {message.attachment && (
                        <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-xs text-indigo-700">
                          <FileText className="h-3 w-3" /> {message.attachment.filename}
                        </span>
                      )}
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    </>
                  ) : (
                    <>
                      <Markdown>{message.content}</Markdown>
                      {message.createdAgent && (
                        <div className="mt-3 rounded-lg border bg-gray-50 p-3">
                          <div className="flex items-center gap-2">
                            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-lg shadow-1">
                              {message.createdAgent.icon}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold">{message.createdAgent.title}</p>
                              {message.createdAgent.description && (
                                <p className="truncate text-xs text-gray-500">{message.createdAgent.description}</p>
                              )}
                            </div>
                          </div>
                          <div className="mt-3 flex gap-2">
                            <Button
                              size="sm"
                              disabled={runningId === message.createdAgent.id}
                              onClick={() =>
                                void executeAgent(message.createdAgent!.id, message.id, message.createdAgent!.title)
                              }
                            >
                              {runningId === message.createdAgent.id ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Play className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              Run
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => router.push(`/agents?agent=${message.createdAgent!.id}`)}
                            >
                              <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open in Agents
                            </Button>
                          </div>
                        </div>
                      )}
                      {message.executedRun && (
                        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                          <span>Run started ({message.executedRun.status}).</span>
                          <button
                            type="button"
                            className="font-medium underline-offset-2 hover:underline"
                            onClick={() => router.push(`/agents?run=${message.executedRun!.executionId}`)}
                          >
                            View run
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {sending && (
                <div className="mr-12 flex items-center gap-2 rounded-xl border bg-white p-3 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                </div>
              )}
            </div>
          </div>
          {/* Composer pinned to the bottom */}
          <div className="shrink-0 border-t bg-slate-50 p-4">
            <div className="mx-auto max-w-3xl">{composer}</div>
          </div>
        </>
      )}
    </div>
  )
}
