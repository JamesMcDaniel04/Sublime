'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ClipboardList, GitBranch, HelpCircle, Loader2, Send, Target, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatAge, type NeedsYouItem } from '@/lib/inbox/needs-you'
import { useScopedHref } from '@/lib/client/scoped-href'
import { cn } from '@/lib/utils'

const SHOWN = 6

const ICON = {
  ask: HelpCircle,
  approval: Check,
  flow_wait: GitBranch,
  work: ClipboardList,
  goal_action: Target,
} as const

/**
 * The queue at the top of the bell. Each row is one decision: answer, approve
 * or deny, use, or open. Every action calls the route the full-page surface
 * already uses — the bell is a faster door to the same room, never a second
 * set of rules.
 */
export function NeedsYouSection({ items, onChanged, onNavigate }: { items: NeedsYouItem[]; onChanged: () => void; onNavigate: () => void }) {
  const router = useRouter()
  const href = useScopedHref()
  const [busy, setBusy] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  if (items.length === 0) return null

  const act = async (item: NeedsYouItem, run: () => Promise<Response>, done: string) => {
    if (busy) return
    setBusy(item.id)
    try {
      const response = await run()
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        toast.error(payload.error || "That didn't go through.")
        return
      }
      toast.success(done)
      onChanged()
    } catch {
      toast.error("That didn't go through.")
    } finally {
      setBusy(null)
    }
  }
  const reply = (executionId: string, message: string) =>
    fetch(`/api/executions/${executionId}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) })
  const markWorkUsed = (goalId: string, workId: string) =>
    fetch(`/api/goals/${goalId}/work/${workId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'used' }) })
  const open = (target: string) => {
    onNavigate()
    router.push(href(target))
  }

  return (
    <section aria-labelledby="needs-you-heading" className="border-b">
      <h3 id="needs-you-heading" className="flex items-center justify-between px-3 pt-2.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        Needs you
        <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] tabular-nums">{items.length}</span>
      </h3>
      <ul>
        {items.slice(0, SHOWN).map((item) => {
          const Icon = ICON[item.kind]
          const isBusy = busy === item.id
          return (
            <li key={item.id} className="border-t border-border/50 px-3 py-2 text-sm">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{item.subject}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={new Date(item.waitingSince).toLocaleString()}>{formatAge(item.ageMs)}</span>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{item.detail}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {item.actions.map((action, index) => {
                      if (action.kind === 'reply') {
                        const draft = drafts[item.id] ?? ''
                        return (
                          <form
                            key={index}
                            className="flex w-full items-center gap-1"
                            onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void act(item, () => reply(action.executionId, draft.trim()), 'Answered').then(() => setDrafts((d) => ({ ...d, [item.id]: '' }))) }}
                          >
                            <input
                              value={draft}
                              onChange={(event) => setDrafts((d) => ({ ...d, [item.id]: event.target.value }))}
                              placeholder="Answer…"
                              aria-label={`Answer ${item.subject}`}
                              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
                            />
                            <button type="submit" disabled={isBusy || !draft.trim()} aria-label="Send answer" className="rounded-md border p-1 text-muted-foreground hover:text-foreground disabled:opacity-50">
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                            </button>
                          </form>
                        )
                      }
                      if (action.kind === 'approve') {
                        return (
                          <span key={index} className="flex gap-1">
                            <button type="button" disabled={isBusy} onClick={() => void act(item, () => reply(action.executionId, 'approve'), 'Approved')} className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200')}>
                              {isBusy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : 'Approve'}
                            </button>
                            <button type="button" disabled={isBusy} onClick={() => void act(item, () => reply(action.executionId, 'deny'), 'Denied')} className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                              <X className="mr-0.5 inline h-3 w-3" />Deny
                            </button>
                          </span>
                        )
                      }
                      if (action.kind === 'use_work') {
                        return (
                          <button key={index} type="button" disabled={isBusy} onClick={() => void act(item, () => markWorkUsed(action.goalId, action.workId), 'Marked as used')} className="rounded-full border border-horizon-300 bg-horizon-50 px-2 py-0.5 text-xs font-medium text-horizon-700 hover:bg-horizon-100 dark:border-horizon-500/40 dark:bg-horizon-500/15 dark:text-horizon-200">
                            {isBusy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : 'Use'}
                          </button>
                        )
                      }
                      return (
                        <button key={index} type="button" onClick={() => open(action.href)} className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                          Open
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      {items.length > SHOWN && (
        <p className="px-3 pb-2 pt-1 text-[11px] text-muted-foreground">and {items.length - SHOWN} more — oldest shown first</p>
      )}
    </section>
  )
}
