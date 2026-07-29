'use client'

/**
 * "Get back on track" strip: renders the goal's open AI recovery plan above
 * the widget grid. Deliberately NOT a dashboard widget — layouts are
 * user-editable and the plan must be un-missable while it is open.
 *
 * launch_agent accept is two-phase: this component marks the action
 * accepted, then calls /api/templates/provision, and the SERVER flips the
 * action to done (with resultRef). A crash between the phases leaves the
 * action 'accepted' with a visible Retry — never falsely done.
 */
import { ScopedLink as Link } from '@/components/ui/scoped-link'
import { useState } from 'react'
import { Check, LifeBuoy, Rocket, X } from 'lucide-react'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { RecoveryActionView, RecoveryPlanView } from '@/lib/types'

type ActResponse = {
  success?: boolean
  error?: string
  status?: 'accepted' | 'done' | 'dismissed'
  href?: string
  provision?: { seedKey: string | null; goalId: string; recoveryActionId: string }
}

export function RecoveryPlanStrip({
  goalId,
  plan,
  onChanged,
}: {
  goalId: string
  plan: RecoveryPlanView
  onChanged: () => void | Promise<void>
}) {
  const router = useScopedRouter()
  const [busyActionId, setBusyActionId] = useState<string | null>(null)
  const [failedActionIds, setFailedActionIds] = useState<Set<string>>(new Set())

  const act = async (actionId: string, op: 'accept' | 'dismiss'): Promise<ActResponse | null> => {
    const response = await fetch(`/api/goals/${goalId}/recovery/actions/${actionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op }),
    })
    const body = (await response.json()) as ActResponse
    if (!response.ok) {
      toast.error(body.error || 'Could not update the plan.')
      return null
    }
    return body
  }

  const provision = async (body: {
    seedKey: string | null
    goalId: string
    recoveryActionId: string
  }): Promise<boolean> => {
    if (!body.seedKey) {
      toast.error('This recommendation is missing its template — dismiss it.')
      return false
    }
    const response = await fetch('/api/templates/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seedKey: body.seedKey,
        goalId: body.goalId,
        recoveryActionId: body.recoveryActionId,
      }),
    })
    const responseBody = (await response.json()) as { error?: string }
    if (!response.ok) {
      toast.error(responseBody.error || 'Could not deploy — try again.')
      return false
    }
    toast.success('Agent deployed and linked to this goal.')
    return true
  }

  const markFailed = (actionId: string, failed: boolean) =>
    setFailedActionIds((previous) => {
      const next = new Set(previous)
      if (failed) next.add(actionId)
      else next.delete(actionId)
      return next
    })

  const handleAccept = async (action: RecoveryActionView) => {
    setBusyActionId(action.id)
    try {
      const result = await act(action.id, 'accept')
      if (!result) return
      if (action.kind === 'connect_tool' && result.href) {
        await onChanged()
        router.push(result.href)
        return
      }
      if (action.kind === 'launch_agent' && result.provision) {
        const deployed = await provision(result.provision)
        markFailed(action.id, !deployed)
      }
      await onChanged()
    } finally {
      setBusyActionId(null)
    }
  }

  const handleRetryLaunch = async (action: RecoveryActionView) => {
    setBusyActionId(action.id)
    try {
      const seedKey =
        typeof action.payload.seedKey === 'string' ? action.payload.seedKey : null
      const deployed = await provision({
        seedKey,
        goalId,
        recoveryActionId: action.id,
      })
      markFailed(action.id, !deployed)
      await onChanged()
    } finally {
      setBusyActionId(null)
    }
  }

  const handleDismissAction = async (action: RecoveryActionView) => {
    setBusyActionId(action.id)
    try {
      if (await act(action.id, 'dismiss')) await onChanged()
    } finally {
      setBusyActionId(null)
    }
  }

  const dismissPlan = async () => {
    const response = await fetch(`/api/goals/${goalId}/recovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'dismiss' }),
    })
    const body = (await response.json()) as { error?: string }
    if (!response.ok) {
      toast.error(body.error || 'Could not dismiss the plan.')
      return
    }
    await onChanged()
  }

  const control = (action: RecoveryActionView) => {
    const busy = busyActionId === action.id
    if (action.status === 'done') {
      return (
        <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
          <Check className="h-4 w-4" />
          {action.kind === 'launch_agent' && action.resultRef ? (
            <Link href="/agents" className="underline-offset-2 hover:underline">
              View agent
            </Link>
          ) : (
            'Done'
          )}
        </span>
      )
    }
    if (action.status === 'dismissed') {
      return <span className="text-xs text-muted-foreground">Dismissed</span>
    }
    if (action.kind === 'connect_tool' && action.status === 'accepted') {
      return <span className="text-xs text-muted-foreground">Waiting for connection…</span>
    }
    if (action.kind === 'launch_agent' && action.status === 'accepted') {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void handleRetryLaunch(action)}
        >
          <Rocket className="mr-1.5 h-4 w-4" />
          {failedActionIds.has(action.id) ? 'Retry launch' : 'Launch agent'}
        </Button>
      )
    }
    // proposed
    const label =
      action.kind === 'connect_tool'
        ? 'Connect'
        : action.kind === 'launch_agent'
          ? 'Launch agent'
          : 'Mark done'
    return (
      <span className="flex items-center gap-1">
        <Button
          variant={action.kind === 'manual_step' ? 'outline' : 'default'}
          size="sm"
          disabled={busy}
          onClick={() => void handleAccept(action)}
        >
          {action.kind === 'launch_agent' && <Rocket className="mr-1.5 h-4 w-4" />}
          {label}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Dismiss "${action.title}"`}
          disabled={busy}
          onClick={() => void handleDismissAction(action)}
        >
          <X className="h-4 w-4" />
        </Button>
      </span>
    )
  }

  return (
    <section
      aria-label="Recovery plan"
      className="space-y-4 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <LifeBuoy className="h-5 w-5 text-amber-600" />
        <h2 className="text-sm font-semibold">Get back on track</h2>
        <Badge variant="outline">
          {plan.triggerRiskLevel === 'off_track' ? 'Off track' : 'At risk'}
        </Badge>
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={() => void dismissPlan()}>
            Dismiss plan
          </Button>
        </div>
      </div>

      <p className="text-sm">{plan.diagnosis}</p>
      {plan.evidence.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {plan.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <ul className="space-y-2">
        {plan.actions.map((action) => (
          <li
            key={action.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border bg-background/60 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{action.title}</p>
              <p className="text-sm text-muted-foreground">{action.rationale}</p>
            </div>
            {control(action)}
          </li>
        ))}
      </ul>
    </section>
  )
}
