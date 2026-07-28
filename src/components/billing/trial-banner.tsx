import Link from 'next/link'

/**
 * Trial countdown. A trial that ends in an automatic charge should say so
 * while it's running — this is the minimum honest disclosure, not decoration.
 * Renders nothing outside a trial, so paying workspaces see no chrome change.
 */
export function TrialBanner({ daysRemaining }: { daysRemaining: number | null }) {
  if (daysRemaining == null) return null

  const label =
    daysRemaining <= 0
      ? 'Your trial ends today.'
      : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left in your trial.`

  return (
    <div className="flex shrink-0 items-center justify-center gap-2 border-b border-border bg-accent/40 px-4 py-1.5 text-[12px] text-muted-foreground">
      <span>
        {label} Your card is charged when it ends
        {daysRemaining <= 3 ? ' — cancel before then and you pay nothing.' : '.'}
      </span>
      <Link href="/settings?tab=billing" className="underline hover:text-foreground">
        Manage billing
      </Link>
    </div>
  )
}
