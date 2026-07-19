'use client'

import { ReactNode, useEffect, useState } from 'react'
import { PricingGrid } from '@/components/billing/pricing-grid'

type BillingStatus = {
  state: 'paid' | 'payment_required'
  plan: string
  hasSubscription: boolean
}

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
      <main className="min-h-screen bg-background px-6 py-16 text-foreground">
        <div className="mx-auto max-w-[1200px]">
          <p className="mb-4 text-[13px] uppercase tracking-[0.15em] text-muted-foreground">Pricing</p>
          <h1 className="max-w-[620px] text-[clamp(1.8rem,3vw,2.5rem)] font-[500] leading-[1.15] tracking-[-0.03em]">
            Choose a plan to start.
          </h1>
          <p className="mt-4 max-w-[620px] text-[14px] leading-6 text-muted-foreground">
            Sublime is paid from day one. Your subscription starts immediately, and you can cancel anytime.
          </p>
          <div className="mt-12"><PricingGrid /></div>
          <p className="mt-5 text-xs text-muted-foreground">
            Checkout is handled securely by Stripe. Have questions?{' '}
            <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
              hello@trysublime.io
            </a>
          </p>
        </div>
      </main>
    )
  }

  return children
}
