'use client'

/**
 * Plan, checkout, portal and usage. PlanUsageCard reads /api/billing/status,
 * which is deliberately ungated so it works even mid-lockout.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BILLING_PLAN_CATALOG } from '@/lib/billing/catalog'

export function BillingTab({ orgPlan, grandfathered }: Readonly<{ orgPlan: string; grandfathered: boolean }>) {
  return (
    <Card className="max-w-2xl"><CardHeader><CardTitle>Plan &amp; billing</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <p className="text-sm font-medium">Current plan</p>
          <p className="text-xs text-muted-foreground">
            {({
              TRIAL: 'Payment required',
              STARTER: `Individual — ${BILLING_PLAN_CATALOG.individual.priceWithCadence}`,
              PROFESSIONAL: `Team — ${BILLING_PLAN_CATALOG.team.priceWithCadence}`,
              BUSINESS: `Business — ${BILLING_PLAN_CATALOG.business.priceWithCadence}`,
              ENTERPRISE: 'Enterprise',
            } as Record<string, string>)[orgPlan] || orgPlan}
          </p>
        </div>
        {orgPlan !== 'TRIAL' && !grandfathered && <Button variant="outline" onClick={() => { window.location.href = '/api/stripe/portal' }}>Manage billing</Button>}
      </div>
      {grandfathered ? (
        <p className="text-sm text-muted-foreground">Grandfathered test account — Enterprise access is permanently included and no payment is required.</p>
      ) : orgPlan === 'TRIAL' ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Pick a plan to start using the platform. Your card is required up front but isn&rsquo;t charged for 14 days — cancel before then and you pay nothing. Payments are handled securely by Stripe.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => { window.location.href = '/api/stripe/checkout?plan=individual' }}>Individual — {BILLING_PLAN_CATALOG.individual.priceWithCadence}</Button>
            <Button onClick={() => { window.location.href = '/api/stripe/checkout?plan=team' }}>Team — {BILLING_PLAN_CATALOG.team.priceWithCadence}</Button>
            <Button onClick={() => { window.location.href = '/api/stripe/checkout?plan=business' }}>Business — {BILLING_PLAN_CATALOG.business.priceWithCadence}</Button>
            <Button variant="outline" onClick={() => { window.location.href = '/contact?reason=enterprise' }}>Enterprise — contact sales</Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Upgrades, downgrades, payment methods, and cancellation are all handled in the Stripe billing portal via “Manage billing”.</p>
      )}
      <PlanUsageCard />
    </CardContent></Card>
  )
}

type BillingLimits = { label: string; seats: string; monthlyCredits: string; maxAgents: string; maxFlows: string; maxIntegrations: string; maxSpecialistAreas: string }
type BillingUsage = { agents: number; flows: number; integrations: number; members: number; creditsUsed: number; topupCredits?: number }

/**
 * What the current plan includes vs. what the workspace is using — the numbers
 * behind the create-time PLAN_LIMIT errors, so hitting a cap is never a
 * surprise. Reads /api/billing/status (ungated: works even mid-lockout).
 */
function PlanUsageCard() {
  const [limits, setLimits] = useState<BillingLimits | null>(null)
  const [usage, setUsage] = useState<BillingUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/billing/status', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data?.success) return
        if (data.limits) setLimits(data.limits)
        if (data.usage) setUsage(data.usage)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!limits || !usage) return null
  const topup = usage.topupCredits ?? 0
  const creditCap = limits.monthlyCredits === 'Unlimited'
    ? 'Unlimited'
    : (Number(limits.monthlyCredits) + topup).toLocaleString() + (topup > 0 ? ` (incl. ${topup.toLocaleString()} extra)` : '')
  const rows = [
    { label: 'Credits this month', used: usage.creditsUsed.toLocaleString(), cap: creditCap },
    { label: 'Agents', used: String(usage.agents), cap: limits.maxAgents },
    { label: 'Flows', used: String(usage.flows), cap: limits.maxFlows },
    { label: 'Integrations', used: String(usage.integrations), cap: limits.maxIntegrations },
    { label: 'Seats', used: String(usage.members), cap: limits.seats },
    { label: 'Core specialist areas', used: 'Plan access', cap: limits.maxSpecialistAreas },
  ]
  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">Usage &amp; limits — {limits.label} plan</p>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="font-medium">{row.used} <span className="text-muted-foreground">/ {row.cap}</span></span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {limits.monthlyCredits !== 'Unlimited' && (
          <Button variant="outline" size="sm" asChild><a href="/api/stripe/topup">Buy additional credits</a></Button>
        )}
        <Button variant="ghost" size="sm" asChild><a href="/contact?reason=billing">Talk to us about custom usage</a></Button>
      </div>
    </div>
  )
}
