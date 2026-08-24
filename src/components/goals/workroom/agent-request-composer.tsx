'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { SerializedAgentRequest } from '@/lib/agents/request-serialize'

type PickableAgent = { id: string; title: string; roleLabel: string | null; avatarSeed: string | null }

/** Statuses still moving — while any request is in one, keep polling. */
const OPEN_STATUSES = new Set(['pending', 'running', 'waiting'])

const STATUS_LABEL: Record<string, string> = {
  pending: 'Queued',
  running: 'Working…',
  waiting: 'Needs you',
  completed: 'Answered',
  declined: 'Declined',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const STATUS_TONE: Record<string, string> = {
  pending: 'text-muted-foreground',
  running: 'text-horizon-700 dark:text-horizon-200',
  waiting: 'text-amber-600 dark:text-amber-400',
  completed: 'text-emerald-700 dark:text-emerald-400',
  // A decline is a correct outcome, so it reads as neutral information —
  // never as the red an actual failure gets.
  declined: 'text-muted-foreground',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
}

/**
 * Ask an agent for something, on the goal it belongs to.
 *
 * This is the in-app half of addressability: every other way to start agent
 * work in Sublime is machine-shaped (a schedule, a webhook, a Run button), so
 * this is the only surface where a person hands an agent a task the way they
 * would hand it to a colleague.
 */
export function AgentRequestComposer({ goalId }: { goalId: string }) {
  const [agents, setAgents] = useState<PickableAgent[]>([])
  const [agentId, setAgentId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [requests, setRequests] = useState<SerializedAgentRequest[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadRequests = useCallback(async () => {
    try {
      const response = await fetch(`/api/goals/${goalId}/requests`, { cache: 'no-store' })
      if (!response.ok) return
      const payload = await response.json()
      setRequests(Array.isArray(payload.items) ? payload.items : [])
    } catch {
      // A failed poll is not worth a toast — the next tick retries.
    }
  }, [goalId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/agents', { cache: 'no-store' })
        if (!response.ok) return
        const payload = await response.json()
        const list: PickableAgent[] = (payload.agents ?? [])
          .filter((agent: { status?: string }) => agent.status === 'active')
          .map((agent: any) => ({
            id: agent.id,
            title: agent.title,
            roleLabel: agent.roleLabel ?? null,
            avatarSeed: agent.avatarSeed ?? null,
          }))
        if (cancelled) return
        setAgents(list)
        setAgentId((current) => current ?? list[0]?.id ?? null)
      } catch {
        // Leaving the picker empty is the honest failure: the composer hides.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    void loadRequests()
  }, [loadRequests])

  // Poll only while something is actually in flight, then stop. Requests are
  // minutes-long, so a permanent timer would be pure waste.
  const hasOpen = useMemo(() => requests.some((request) => OPEN_STATUSES.has(request.status)), [requests])
  useEffect(() => {
    if (!hasOpen) return
    timer.current = setTimeout(() => void loadRequests(), 4000)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [hasOpen, requests, loadRequests])

  const selected = agents.find((agent) => agent.id === agentId) ?? null

  const send = async () => {
    const body = text.trim()
    if (!body || !agentId || sending) return
    setSending(true)
    try {
      const response = await fetch(`/api/agents/${agentId}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body, goalId }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        toast.error(payload.error || 'Could not send that request.')
        return
      }
      setText('')
      await loadRequests()
    } catch {
      toast.error('Could not send that request.')
    } finally {
      setSending(false)
    }
  }

  if (!agents.length) return null

  return (
    <section className="space-y-3" aria-labelledby="goal-ask-heading">
      <h2 id="goal-ask-heading" className="text-sm font-semibold">
        Ask an agent
      </h2>

      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Choose an agent">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            role="radio"
            aria-checked={agentId === agent.id}
            onClick={() => setAgentId(agent.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-xs font-medium transition-colors',
              agentId === agent.id
                ? 'border-horizon-300 bg-horizon-50 text-horizon-700 dark:border-horizon-500/40 dark:bg-horizon-500/15 dark:text-horizon-200'
                : 'border-border/60 bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <AgentAvatar agent={{ id: agent.id, avatarSeed: agent.avatarSeed }} className="h-5 w-5" />
            {agent.title}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border/60 bg-card p-2">
        <label htmlFor="goal-ask-input" className="sr-only">
          What should {selected?.title ?? 'the agent'} do?
        </label>
        <textarea
          id="goal-ask-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder={
            selected?.roleLabel
              ? `Ask ${selected.title} (${selected.roleLabel}) for something specific…`
              : `Ask ${selected?.title ?? 'an agent'} for something specific…`
          }
          className="w-full resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          <p className="px-1.5 text-xs text-muted-foreground">
            Stays within what this agent does — it will say so if the ask is outside its job.
          </p>
          <Button type="button" size="sm" onClick={() => void send()} disabled={!text.trim() || sending}>
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Ask
          </Button>
        </div>
      </div>

      {requests.length > 0 && (
        <ul className="space-y-2">
          {requests.map((request) => (
            <li key={request.id} className="rounded-lg border border-border/60 bg-card p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {request.requesterName ? `${request.requesterName} → ` : ''}
                  {request.agentName}
                </span>
                <span className={cn('text-xs font-medium', STATUS_TONE[request.status] ?? 'text-muted-foreground')}>
                  {STATUS_LABEL[request.status] ?? request.status}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground">{request.text}</p>
              {request.result && <p className="mt-2 whitespace-pre-wrap">{request.result}</p>}
              {request.error && (
                <p className="mt-2 text-muted-foreground">
                  {request.status === 'declined' ? request.error : `Couldn't finish: ${request.error}`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
