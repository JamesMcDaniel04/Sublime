import { AppShell } from '@/components/layout/app-shell'
import { PlanPicker, BillingUnavailable } from '@/components/billing/plan-picker'
import { resolveBillingAccess, trialDaysRemaining } from '@/lib/billing/access'

/**
 * The entry gate for every authenticated route.
 *
 * Membership in this route group IS the list of gated routes, which replaced a
 * hand-maintained APP_PREFIXES array in AppShell that had already drifted —
 * /skills/[id] was an authenticated page missing from it, so it rendered with
 * no chrome and no gate. A new route now cannot forget the gate.
 *
 * The route group adds no URL segment: /dashboard is still /dashboard.
 */
/**
 * Every route in this group is per-request by construction — the gate below
 * reads the session cookie. Declaring it removes a wall of misleading
 * "Dynamic server usage ... couldn't be rendered statically" lines from the
 * build log, and makes the intent explicit: an app route that ever rendered
 * statically would be served without consulting billing state at all.
 */
export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const access = await resolveBillingAccess()

  if (access.status === 'unavailable') return <BillingUnavailable />
  if (access.status === 'payment_required') return <PlanPicker canManageBilling={access.canManageBilling} />

  return (
    <AppShell trialDaysRemaining={trialDaysRemaining(access.trialEndsAt)}>
      {children}
    </AppShell>
  )
}
