import Link from 'next/link'
import { Bell, CalendarClock, Inbox, LineChart, ShieldAlert, Sparkles, Target, TrendingUp, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { accentFor, TemplateCardShell } from '@/components/templates/template-card-shell'
import { cn } from '@/lib/utils'

function categoryIcon(category: string, kind: 'agent' | 'flow') {
  if (kind === 'flow') return Workflow
  const normalized = category.toLowerCase()
  if (normalized.includes('meet')) return CalendarClock
  if (normalized.includes('risk') || normalized.includes('monitor') || normalized.includes('contract')) return ShieldAlert
  if (normalized.includes('forecast')) return LineChart
  if (normalized.includes('pipeline') || normalized.includes('discov') || normalized.includes('opportun')) return Target
  if (normalized.includes('inbox') || normalized.includes('productiv') || normalized.includes('exec')) return Inbox
  if (normalized.includes('sales') || normalized.includes('digest') || normalized.includes('revenue')) return TrendingUp
  if (normalized.includes('alert') || normalized.includes('notif') || normalized.includes('signal')) return Bell
  return Sparkles
}

type TemplateCatalogueCardProps = {
  href: string
  name: string
  description: string
  category: string
  integrations: readonly string[]
  /** Shown only when nothing is required — these are capabilities, not
   *  prerequisites, so they never receive the missing/blocked treatment.
   *  Without this, a seed that needs "Slack OR Gmail OR a URL" renders no
   *  tool row at all, because expressing that as `required` would demand
   *  every one of them. */
  recommendedIntegrations?: readonly string[]
  kind?: 'agent' | 'flow'
  missingIntegrations?: readonly string[]
  actionLabel?: string
  advancesGoal?: string
}

/** The canonical catalogue card shared by agent and flow starters. */
export function TemplateCatalogueCard({
  href,
  name,
  description,
  category,
  integrations,
  recommendedIntegrations = [],
  kind = 'agent',
  missingIntegrations = [],
  actionLabel = 'Use template',
  advancesGoal,
}: TemplateCatalogueCardProps) {
  const accent = accentFor(category)

  return (
    <Link href={href} className="block h-full">
      <TemplateCardShell
        accent={accent}
        icon={categoryIcon(category, kind)}
        title={name}
        description={description}
        badges={
          <>
            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{category}</Badge>
            {kind === 'flow' && <Badge variant="outline" className="text-[11px] font-medium">Flow</Badge>}
            {advancesGoal && (
              <Badge variant="secondary" className="max-w-full gap-1 text-[11px] font-medium text-indigo-500">
                <Target className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">Advances: {advancesGoal}</span>
              </Badge>
            )}
          </>
        }
        tools={
          integrations.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Requires</p>
              <div className="flex flex-wrap gap-1.5">
                {integrations.map((integration) => (
                  <span key={integration} className={cn(missingIntegrations.includes(integration) && 'saturate-150')}>
                    <IntegrationChip name={integration} />
                  </span>
                ))}
              </div>
            </div>
          ) : recommendedIntegrations.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Works with</p>
              <div className="flex flex-wrap gap-1.5">
                {recommendedIntegrations.map((integration) => (
                  <IntegrationChip key={integration} name={integration} />
                ))}
              </div>
            </div>
          ) : undefined
        }
        cta={
          <Button size="sm" variant={missingIntegrations.length > 0 ? 'outline' : 'default'} className="w-full" asChild>
            <span>{actionLabel}</span>
          </Button>
        }
      />
    </Link>
  )
}
