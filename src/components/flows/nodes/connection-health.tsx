'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { VerificationState } from '@/lib/connections/verification'
import { VerificationBadge } from './verification-badge'

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
  // A vault credential is probed by CredentialHealth instead — it needs the
  // step's URL as a target, which this component doesn't have.
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
    <VerificationBadge verification={verification}>
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
    </VerificationBadge>
  )
}
