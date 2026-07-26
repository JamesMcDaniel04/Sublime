'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { VerificationBadge, type VerificationView } from './verification-badge'

/**
 * Health for a vault credential attached to an HTTP step.
 *
 * The verify endpoint records a result on every save and every flow run, but
 * nothing rendered it — so a credential that had already failed in production
 * still looked identical to a working one in the picker. This surfaces the
 * stored state and lets the user re-run the check without leaving the step.
 *
 * Unlike an MCP connection, a vault credential has no endpoint of its own to
 * probe: it needs the step's URL as a target, which is why this is separate
 * from ConnectionHealth.
 */
export function CredentialHealth({
  credentialId,
  verification,
  requestUrl,
  onRechecked,
}: Readonly<{
  credentialId?: string
  verification?: VerificationView
  requestUrl?: string
  onRechecked?: () => void
}>) {
  const [checking, setChecking] = useState(false)
  if (!credentialId || !verification) return null
  const probeable = Boolean(requestUrl && /^https?:\/\//i.test(requestUrl))

  const recheck = async () => {
    setChecking(true)
    try {
      const response = await fetch(`/api/credentials/${credentialId}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: requestUrl, method: 'GET' }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'This credential is not working.')
      toast.success('Credential verified against this endpoint.')
      onRechecked?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'This credential is not working.')
      onRechecked?.()
    } finally {
      setChecking(false)
    }
  }

  return (
    <VerificationBadge verification={verification}>
      {probeable && verification.state !== 'verified' && (
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
