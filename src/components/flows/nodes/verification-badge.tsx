'use client'

import { AlertCircle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { verificationLabel, type VerificationState } from '@/lib/connections/verification'

const TONE: Record<VerificationState, { icon: typeof CheckCircle2; className: string }> = {
  verified: { icon: CheckCircle2, className: 'text-emerald-600' },
  stale: { icon: CircleDashed, className: 'text-muted-foreground' },
  failed: { icon: XCircle, className: 'text-red-600' },
  unverified: { icon: AlertCircle, className: 'text-amber-600' },
}

export type VerificationView = { state: VerificationState; checkedAt?: string; error?: string }

/**
 * The shared read-out for "does this credential actually work" — used by both
 * the MCP connection picker and the vault credential picker so the two can't
 * drift into describing the same states differently.
 *
 * `unverified` is stated plainly rather than rendered as a neutral or passing
 * state: a check nobody ran must never look like a check that passed.
 */
export function VerificationBadge({
  verification,
  children,
}: Readonly<{ verification: VerificationView; children?: React.ReactNode }>) {
  const { icon: Icon, className } = TONE[verification.state]
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-4">
      <Icon className={cn('mt-px h-3.5 w-3.5 shrink-0', className)} />
      <span className={cn('min-w-0', className)}>
        {verificationLabel(verification.state)}
        {verification.checkedAt && verification.state !== 'unverified' && (
          <span className="text-muted-foreground"> · {new Date(verification.checkedAt).toLocaleDateString()}</span>
        )}
        {verification.state === 'failed' && verification.error && (
          <span className="block break-words text-muted-foreground">{verification.error}</span>
        )}
      </span>
      {children}
    </div>
  )
}
