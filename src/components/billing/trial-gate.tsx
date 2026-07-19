'use client'

import { ReactNode, useEffect, useState } from 'react'
import { CreditCard } from 'lucide-react'
import { Button } from '@/components/ui/button'

type BillingStatus = {
  state: 'paid' | 'payment_required'
  plan: string
  hasSubscription: boolean
}

const PLAN_OPTIONS = [
  { key: 'individual', label: 'Individual', price: '$29.99/mo' },
  { key: 'team', label: 'Team', price: '$299/mo' },
  { key: 'business', label: 'Business', price: '$1,999/mo' },
]

/**
 * Client half of billing enforcement (the server half is the 402 in
 * requireAuthContext). An unpaid workspace sees a non-dismissible plan picker.
 * Fails open on
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

  if (status?.state === 'payment_required') {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg rounded-lg border bg-card p-8 shadow-lg">
          <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <CreditCard className="h-5 w-5 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Choose a plan to start</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sublime is paid from day one. Pick the plan that fits your workspace; your
            subscription starts immediately and you can cancel anytime.
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
            Checkout is handled securely by Stripe. Have questions?{' '}
            <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
              hello@trysublime.io
            </a>
          </p>
        </div>
      </div>
    )
  }

  return children
}
