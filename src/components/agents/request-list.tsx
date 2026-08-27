'use client'

import { cn } from '@/lib/utils'
import type { SerializedAgentRequest } from '@/lib/agents/request-serialize'

/** Statuses still moving — while any request is in one, callers keep polling. */
export const OPEN_REQUEST_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

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
 * The ask-and-answer ledger for an agent. One rendering shared by the goal
 * composer and the agent profile, so a request looks the same wherever the
 * person who asked happens to be looking.
 */
export function RequestList({ requests, showAgent = true }: { requests: SerializedAgentRequest[]; showAgent?: boolean }) {
  if (requests.length === 0) return null
  return (
    <ul className="space-y-2">
      {requests.map((request) => (
        <li key={request.id} className="rounded-lg border border-border/60 bg-card p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              {request.requesterName ?? 'Someone'}
              {showAgent ? ` → ${request.agentName}` : ''}
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
  )
}
