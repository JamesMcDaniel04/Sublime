'use client'

/**
 * "Put agents to work" — the agents that advance this goal, deployable in one
 * click (spec 2026-07-27).
 *
 * Deploy is a single POST to /api/templates/provision, which materializes the
 * agent AND creates the GoalContribution link in the same call. Re-deploying an
 * already-linked seed is idempotent server-side, so a double click cannot
 * produce a duplicate link.
 */
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Bot, Check, Rocket } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { bundleForGoal } from '@/lib/goals/agent-bundle'
import { missingIntegrations } from '@/lib/templates/relevance'
import { cn } from '@/lib/utils'

export function AgentBundleCard({
  goalId,
  templateKey,
  kind,
  source,
  recurrence,
  deployedSeedKeys,
  connectedIntegrations,
  onChanged,
  hideWhenAllDeployed = false,
}: {
  readonly goalId: string
  readonly templateKey: string | null
  readonly kind: string
  readonly source: string | null
  readonly recurrence: string | null
  readonly deployedSeedKeys: string[]
  readonly connectedIntegrations: string[]
  readonly onChanged: () => void | Promise<void>
  /** Collapse the card once nothing is left to deploy. */
  readonly hideWhenAllDeployed?: boolean
}) {
  const [busySeedKey, setBusySeedKey] = useState<string | null>(null)

  const bundle = useMemo(
    () => bundleForGoal({ templateKey, kind, source, recurrence, deployedSeedKeys }),
    [templateKey, kind, source, recurrence, deployedSeedKeys],
  )

  const deploy = async (seedKey: string) => {
    setBusySeedKey(seedKey)
    try {
      const response = await fetch('/api/templates/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seedKey, goalId }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        toast.error(body.error || 'Could not deploy — try again.')
        return
      }
      toast.success('Agent deployed and linked to this goal.')
      await onChanged()
    } finally {
      setBusySeedKey(null)
    }
  }

  if (bundle.length === 0) return null
  if (hideWhenAllDeployed && bundle.every((entry) => entry.deployed)) return null

  return (
    <section aria-label="Agents for this goal" className="space-y-4 rounded-2xl border p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Put agents to work</h2>
        <p className="text-sm text-muted-foreground">
          This goal tracks the number. These do the work.
        </p>
      </div>

      <ul className="space-y-2">
        {bundle.map((entry) => {
          const missing = missingIntegrations(entry.requiredIntegrations, connectedIntegrations)
          const blocked = missing.length > 0
          return (
            <li
              key={entry.seedKey}
              data-blocked={blocked}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-xl border bg-background/60 px-4 py-3',
                blocked && !entry.deployed && 'opacity-70',
              )}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">{entry.name}</p>
                <p className="text-sm text-muted-foreground">{entry.description}</p>
                {blocked && !entry.deployed && (
                  <p className="text-xs text-muted-foreground">
                    Needs {missing.join(', ')} —{' '}
                    <Link
                      href="/integrations"
                      className="font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      connect
                    </Link>
                  </p>
                )}
                {entry.requiredIntegrations.length > 0 && !blocked && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {entry.requiredIntegrations.map((integration) => (
                      <IntegrationChip key={integration} name={integration} />
                    ))}
                  </div>
                )}
              </div>

              {entry.deployed ? (
                <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                  <Check className="h-4 w-4" />
                  <Link href="/agents" className="underline-offset-2 hover:underline">
                    Deployed
                  </Link>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant={blocked ? 'outline' : 'default'}
                  disabled={blocked || busySeedKey === entry.seedKey}
                  onClick={() => void deploy(entry.seedKey)}
                >
                  <Rocket className="mr-1.5 h-4 w-4" />
                  Deploy
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
