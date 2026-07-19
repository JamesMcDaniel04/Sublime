'use client'

import { ReactNode, useEffect, useState } from 'react'
import { CreditCard } from 'lucide-react'
import { Button } from '@/components/ui/button'

type BillingStatus = {
  state: 'paid' | 'trialing' | 'expired'
  plan: string
  trialEndsAt: string | null
  daysLeft: number
  hasSubscription: boolean
}

const PLAN_OPTIONS = [
  { key: 'individual', label: 'Individual', price: '$29.99/mo' },
  { key: 'team', label: 'Team', price: '$299/mo' },
  { key: 'business', label: 'Business', price: '$1,999/mo' },
]

/**
 * Client half of trial enforcement (the server half is the 402 in
 * requireAuthContext). While trialing it shows a countdown banner; once the
 * trial lapses it covers the app with a non-dismissible paywall. Fails open on
 * fetch errors — a network blip must never lock a paying customer out.
 */
export function TrialGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BillingStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/billing/status', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setStatus(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (status?.state === 'expired') {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg rounded-lg border bg-card p-8 shadow-lg">
          <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <CreditCard className="h-5 w-5 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Your free trial has ended</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your 14-day trial is over. Pick a plan to keep using your agents, flows, and
            connections — everything is saved exactly where you left it.
          </p>
          <div className="mt-6 space-y-2">
            {PLAN_OPTIONS.map((plan) => (
              <Button
                key={plan.key}
                className="w-full justify-between"
                variant={plan.key === 'team' ? 'default' : 'outline'}
                onClick={() => {
                  window.location.href = `/api/stripe/checkout?plan=${plan.key}`
                }}
              >
                <span>{plan.label}</span>
                <span className="text-xs opacity-70">{plan.price}</span>
              </Button>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Checkout is handled securely by Stripe. Need more time or have questions?{' '}
            <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
              hello@trysublime.io
            </a>
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      {status?.state === 'trialing' && !status.hasSubscription && (
        <div className="flex items-center justify-center gap-3 border-b bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
          <span>
            Free trial — {status.daysLeft} {status.daysLeft === 1 ? 'day' : 'days'} left
          </span>
          <a href="/settings?tab=billing" className="font-medium text-foreground underline underline-offset-2 hover:opacity-80">
            Add billing
          </a>
        </div>
      )}
      {children}
    </>
  )
}
