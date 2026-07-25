'use client'

import { useState } from 'react'
import { AlertCircle, CheckCircle2, CircleDashed, RefreshCw, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { verificationLabel, type VerificationState } from '@/lib/connections/verification'

const TONE: Record<VerificationState, { icon: typeof CheckCircle2; className: string }> = {
  verified: { icon: CheckCircle2, className: 'text-emerald-600' },
  stale: { icon: CircleDashed, className: 'text-muted-foreground' },
  failed: { icon: XCircle, className: 'text-red-600' },
  unverified: { icon: AlertCircle, className: 'text-amber-600' },
}

/**
 * Credential health beside a connection picker.
 *
 * The gap this closes: a connection whose token expired looked identical to a
 * working one, so a user picked a dead connection from a healthy-looking list.
 *
 * `unverified` is stated as "never used successfully", not dressed up as a
 * neutral or passing state — a check nobody ran must never read as a check that
 * passed.
 */
export function ConnectionHealth({
  connectionId,
  verification,
  onRechecked,
}: Readonly<{
  connectionId?: string
  verification?: { state: VerificationState; checkedAt?: string; error?: string }
  onRechecked?: () => void
}>) {
  const [checking, setChecking] = useState(false)
  if (!connectionId || !verification) return null
  const state = verification.state
  const { icon: Icon, className } = TONE[state]
  // A vault credential has no endpoint to probe on its own.
  const probeable = !connectionId.startsWith('credential:')

  const recheck = async () => {
    setChecking(true)
    try {
      const response = await fetch('/api/connections/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not check this connection.')
      toast[body.verification?.state === 'verified' ? 'success' : 'error'](
        body.verification?.state === 'verified'
          ? `Working — ${body.toolCount} action${body.toolCount === 1 ? '' : 's'} available.`
          : body.verification?.error || 'This connection is not working.',
      )
      onRechecked?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not check this connection.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-4">
      <Icon className={cn('mt-px h-3.5 w-3.5 shrink-0', className)} />
      <span className={cn('min-w-0', className)}>
        {verificationLabel(state)}
        {verification.checkedAt && state !== 'unverified' && (
          <span className="text-muted-foreground"> · {new Date(verification.checkedAt).toLocaleDateString()}</span>
        )}
        {state === 'failed' && verification.error && (
          <span className="block break-words text-muted-foreground">{verification.error}</span>
        )}
      </span>
      {probeable && state !== 'verified' && (
        <button
          type="button"
          onClick={recheck}
          disabled={checking}
          className="flex shrink-0 items-center gap-1 font-semibold text-blue-700 hover:text-blue-900 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', checking && 'animate-spin')} /> Check now
        </button>
      )}
    </div>
  )
}
