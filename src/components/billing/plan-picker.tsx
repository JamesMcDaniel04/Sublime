import { PricingGrid } from '@/components/billing/pricing-grid'
import { TRIAL_DAYS } from '@/lib/stripe/plans'

/**
 * The paywall. Server-rendered by the (app) layout so a workspace without a
 * card on file never receives app markup at all — the previous client-side
 * gate painted the dashboard first and swapped it out once its status fetch
 * resolved, briefly letting unpaid users into the product.
 *
 * `canManageBilling` is not decoration. This screen is shown to EVERY member
 * of an unpaid workspace, but paying is admin-only (billing:manage), and
 * /settings sits behind this same layout gate — so a member offered a checkout
 * link would be refused by the Stripe route, redirected to /settings, and
 * served this paywall again, looping without ever seeing why. Members get the
 * reason and who to ask instead of a button that cannot work.
 */
export function PlanPicker({ canManageBilling }: Readonly<{ canManageBilling: boolean }>) {
  return (
    <main id="main-content" className="min-h-screen bg-background px-6 py-16 text-foreground">
      <div className="mx-auto max-w-[1200px]">
        <p className="mb-4 text-[13px] uppercase tracking-[0.15em] text-muted-foreground">Pricing</p>
        <h1 className="max-w-[620px] text-[clamp(1.8rem,3vw,2.5rem)] font-[500] leading-[1.15] tracking-[-0.03em]">
          {canManageBilling ? `Start your ${TRIAL_DAYS}-day trial.` : 'This workspace needs a plan.'}
        </h1>
        {canManageBilling ? (
          <>
            <p className="mt-4 max-w-[620px] text-[14px] leading-6 text-muted-foreground">
              Pick a plan and add a card to get in. You won&rsquo;t be charged for {TRIAL_DAYS} days —
              cancel any time before then and you pay nothing.
            </p>
            <div className="mt-12"><PricingGrid /></div>
            <p className="mt-5 text-xs text-muted-foreground">
              Checkout is handled securely by Stripe. Have questions?{' '}
              <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
                hello@trysublime.io
              </a>
            </p>
          </>
        ) : (
          <p className="mt-4 max-w-[620px] text-[14px] leading-6 text-muted-foreground">
            Ask a workspace admin to choose a plan — only admins can start checkout. Once they do,
            everything here opens up for the whole workspace. Need help?{' '}
            <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
              hello@trysublime.io
            </a>
          </p>
        )}
      </div>
    </main>
  )
}

/**
 * Shown when billing state can't be resolved at all. Deliberately distinct
 * from the paywall: a paying customer must never be told to "choose a plan"
 * because the database was briefly unreachable.
 */
export function BillingUnavailable() {
  return (
    <main id="main-content" className="min-h-screen bg-background px-6 py-16 text-foreground">
      <div className="mx-auto max-w-[620px]">
        <p className="mb-4 text-[13px] uppercase tracking-[0.15em] text-muted-foreground">Temporarily unavailable</p>
        <h1 className="text-[clamp(1.5rem,2.5vw,2rem)] font-[500] leading-[1.15] tracking-[-0.03em]">
          We couldn&rsquo;t load your workspace.
        </h1>
        <p className="mt-4 text-[14px] leading-6 text-muted-foreground">
          This is on our side, not yours, and your subscription is unaffected. Reload in a moment —
          if it keeps happening, email{' '}
          <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
            hello@trysublime.io
          </a>.
        </p>
        <a
          href="/dashboard"
          className="mt-8 inline-flex items-center justify-center border border-foreground/40 px-4 py-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground hover:text-background"
        >
          Try again
        </a>
      </div>
    </main>
  )
}
